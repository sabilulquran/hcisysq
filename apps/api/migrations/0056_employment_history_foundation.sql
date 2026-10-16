-- EMP-005 / EMP-006 / EMP-010 Package 1, step S1: additive employment-history
-- foundation. Spec: docs/domain/employment-administration-package1.md.
--
-- No row is seeded and no existing table is changed. Absence of an
-- employment_rollout_settings row means mode OFF, so EMP-004 import remains
-- the only writer of employee employment fields until a later step and an
-- explicit owner-approved mode change.
--
-- Records are append-oriented: a later action closes or voids a row, it never
-- deletes it. Down script (valid only while the tables are empty):
--   DROP TABLE employment_audit_events, employment_action_documents,
--     employment_decision_document_corrections, employment_placements,
--     employment_terms, employment_decision_documents CASCADE;
--   ALTER TABLE employments DROP CONSTRAINT employments_opened_by_action_fk;
--   DROP TABLE employment_actions, employments, employment_rollout_settings CASCADE;
--   DROP FUNCTION employment_history_guard_delete();
--   DELETE FROM schema_migrations WHERE name = '0056_employment_history_foundation.sql';

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS employment_rollout_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  mode text NOT NULL CHECK (mode IN ('OFF', 'SHADOW', 'AUTHORITATIVE')),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  changed_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employments (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  -- Reserved for ORG-007; NULL is the implicit YSQ default legal entity.
  legal_entity_key uuid NULL,
  staff_type text NULL CHECK (staff_type IN ('PENDIDIK', 'KEPENDIDIKAN')),
  started_on date NULL,
  start_basis text NOT NULL CHECK (start_basis IN ('RECORDED', 'UNKNOWN')),
  service_start_on date NULL,
  ended_on date NULL,
  end_basis text NULL CHECK (end_basis IN ('RECORDED', 'UNKNOWN')),
  end_precision text NULL CHECK (end_precision IN ('DAY', 'MONTH')),
  end_reason text NULL CHECK (end_reason IN (
    'RESIGN', 'KONTRAK_BERAKHIR', 'PENSIUN', 'PEMBERHENTIAN', 'MENINGGAL_DUNIA',
    'LAINNYA', 'LAINNYA_DARI_MASTER'
  )),
  source text NOT NULL CHECK (source IN ('BASELINE_FROM_MASTER', 'BASELINE_FROM_IMPORT', 'ACTION')),
  opened_by_action_id uuid NOT NULL,
  voided_by_action_id uuid NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employments_start_basis_check
    CHECK ((start_basis = 'UNKNOWN') = (started_on IS NULL)),
  CONSTRAINT employments_end_consistency_check
    CHECK (
      (end_basis IS NULL AND ended_on IS NULL AND end_reason IS NULL AND end_precision IS NULL)
      OR (end_basis = 'RECORDED' AND ended_on IS NOT NULL AND end_reason IS NOT NULL AND end_precision IS NOT NULL)
      OR (end_basis = 'UNKNOWN' AND ended_on IS NULL AND end_reason IS NOT NULL)
    ),
  CONSTRAINT employments_date_order_check
    CHECK (started_on IS NULL OR ended_on IS NULL OR ended_on >= started_on),
  -- One effective employment per employee and legal entity. An ended
  -- employment whose end date is unknown is excluded here and guarded by the
  -- domain planner, which refuses a new HIRE until HC resolves the end date.
  CONSTRAINT employments_no_overlap
    EXCLUDE USING gist (
      employee_id WITH =,
      (COALESCE(legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
      daterange(
        COALESCE(started_on, '-infinity'::date),
        COALESCE(ended_on + 1, 'infinity'::date),
        '[)'
      ) WITH &&
    ) WHERE (voided_by_action_id IS NULL AND end_basis IS DISTINCT FROM 'UNKNOWN')
);

CREATE INDEX IF NOT EXISTS employments_employee_idx ON employments (employee_id);

CREATE TABLE IF NOT EXISTS employment_actions (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  action_type text NOT NULL CHECK (action_type IN (
    'BASELINE', 'HIRE', 'CONTRACT_EXTENSION', 'CATEGORY_CHANGE', 'PLACEMENT',
    'TRANSFER', 'PROMOTION', 'DEMOTION', 'TERMINATION', 'REVERSAL'
  )),
  effective_on date NULL,
  reason_code text NULL,
  reason_note text NULL,
  previous_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Structured list of rows opened and fields changed; the source for exact reversal.
  row_changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(row_changes) = 'array'),
  acknowledged_warning_codes text[] NOT NULL DEFAULT '{}'::text[],
  state text NOT NULL DEFAULT 'RECORDED' CHECK (state IN ('RECORDED', 'REVERSED')),
  reverses_action_id uuid NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  idempotency_key text NULL,
  source_import_job_id uuid NULL REFERENCES employee_import_jobs(id) ON DELETE RESTRICT,
  source_snapshot_id uuid NULL REFERENCES employee_import_source_snapshots(id) ON DELETE RESTRICT,
  recorded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_actions_effective_on_check
    CHECK (action_type = 'BASELINE' OR effective_on IS NOT NULL),
  CONSTRAINT employment_actions_reversal_check
    CHECK ((action_type = 'REVERSAL') = (reverses_action_id IS NOT NULL)),
  CONSTRAINT employment_actions_reversal_terminal_check
    CHECK (action_type <> 'REVERSAL' OR state = 'RECORDED'),
  CONSTRAINT employment_actions_reason_required_check
    CHECK (action_type NOT IN ('TERMINATION', 'DEMOTION', 'REVERSAL') OR reason_code IS NOT NULL),
  CONSTRAINT employment_actions_baseline_source_check
    CHECK (action_type = 'BASELINE' OR (source_import_job_id IS NULL AND source_snapshot_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS employment_actions_one_reversal_idx
  ON employment_actions (reverses_action_id) WHERE reverses_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employment_actions_idempotency_idx
  ON employment_actions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS employment_actions_employment_idx
  ON employment_actions (employment_id, effective_on, recorded_at);
CREATE INDEX IF NOT EXISTS employment_actions_employee_idx
  ON employment_actions (employee_id, recorded_at DESC);

-- Employment and its opening action are inserted in one transaction, so these
-- circular references are checked at commit (NO ACTION; RESTRICT cannot defer).
ALTER TABLE employments
  ADD CONSTRAINT employments_opened_by_action_fk
  FOREIGN KEY (opened_by_action_id) REFERENCES employment_actions(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE employments
  ADD CONSTRAINT employments_voided_by_action_fk
  FOREIGN KEY (voided_by_action_id) REFERENCES employment_actions(id)
  DEFERRABLE INITIALLY DEFERRED;

-- EMP-010: Perjanjian Kerja and Surat Keputusan are separate document kinds.
CREATE TABLE IF NOT EXISTS employment_decision_documents (
  id uuid PRIMARY KEY,
  document_kind text NOT NULL CHECK (document_kind IN ('PERJANJIAN_KERJA', 'SURAT_KEPUTUSAN')),
  document_number text NOT NULL CHECK (length(trim(document_number)) > 0),
  signed_on date NOT NULL,
  signed_year integer GENERATED ALWAYS AS (date_part('year', signed_on)::integer) STORED,
  external_reference text NULL,
  notes text NULL,
  -- Perjanjian Kerja fields
  pk_type text NULL CHECK (pk_type IN ('PK_BARU', 'PK_PERPANJANGAN')),
  employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  contract_from date NULL,
  contract_to date NULL,
  category text NULL CHECK (category IN ('KONTRAK', 'KONTRAK_HONORER', 'MAGANG', 'PERCOBAAN', 'LEPAS')),
  signatory_employer_label text NULL,
  previous_pk_id uuid NULL REFERENCES employment_decision_documents(id) ON DELETE RESTRICT,
  -- Surat Keputusan fields
  sk_type text NULL CHECK (sk_type IN (
    'SK_PENGANGKATAN', 'SK_MUTASI', 'SK_PROMOSI', 'SK_DEMOSI', 'SK_PEMBERHENTIAN',
    'SK_PENEMPATAN', 'SK_LAINNYA'
  )),
  subject text NULL,
  issuing_authority_label text NULL,
  issuing_authority_position_key uuid NULL,
  effective_on date NULL,
  effective_to date NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_decision_documents_kind_fields_check
    CHECK (
      (document_kind = 'PERJANJIAN_KERJA'
        AND pk_type IS NOT NULL AND employee_id IS NOT NULL
        AND contract_from IS NOT NULL AND contract_to IS NOT NULL AND contract_to >= contract_from
        AND category IS NOT NULL
        AND sk_type IS NULL AND subject IS NULL AND issuing_authority_label IS NULL
        AND issuing_authority_position_key IS NULL AND effective_on IS NULL AND effective_to IS NULL)
      OR
      (document_kind = 'SURAT_KEPUTUSAN'
        AND sk_type IS NOT NULL AND subject IS NOT NULL AND issuing_authority_label IS NOT NULL
        AND effective_on IS NOT NULL AND (effective_to IS NULL OR effective_to >= effective_on)
        AND pk_type IS NULL AND employee_id IS NULL AND contract_from IS NULL AND contract_to IS NULL
        AND category IS NULL AND signatory_employer_label IS NULL AND previous_pk_id IS NULL)
    ),
  CONSTRAINT employment_decision_documents_previous_pk_check
    CHECK (previous_pk_id IS NULL OR pk_type = 'PK_PERPANJANGAN')
);

-- PK and SK numbers are separate series: unique per kind, number and signing year.
CREATE UNIQUE INDEX IF NOT EXISTS employment_decision_documents_number_idx
  ON employment_decision_documents (document_kind, lower(trim(document_number)), signed_year);
CREATE INDEX IF NOT EXISTS employment_decision_documents_employee_idx
  ON employment_decision_documents (employee_id) WHERE employee_id IS NOT NULL;

-- D-09: an audited correction keeps the previous values.
CREATE TABLE IF NOT EXISTS employment_decision_document_corrections (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES employment_decision_documents(id) ON DELETE RESTRICT,
  previous_values jsonb NOT NULL CHECK (jsonb_typeof(previous_values) = 'object'),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  corrected_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  corrected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employment_decision_document_corrections_document_idx
  ON employment_decision_document_corrections (document_id, corrected_at DESC);

CREATE TABLE IF NOT EXISTS employment_terms (
  id uuid PRIMARY KEY,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  category text NOT NULL CHECK (category IN (
    'TETAP', 'KONTRAK', 'KONTRAK_HONORER', 'MAGANG', 'PERCOBAAN', 'LEPAS',
    'BELUM_DIKLASIFIKASIKAN'
  )),
  effective_from date NULL,
  effective_to date NULL,
  contract_reference text NULL,
  opened_by_action_id uuid NOT NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  closed_by_action_id uuid NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  voided_by_action_id uuid NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employment_id, sequence),
  CONSTRAINT employment_terms_date_order_check
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employment_terms_no_overlap
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(
        COALESCE(effective_from, '-infinity'::date),
        COALESCE(effective_to + 1, 'infinity'::date),
        '[)'
      ) WITH &&
    ) WHERE (voided_by_action_id IS NULL)
);

CREATE TABLE IF NOT EXISTS employment_placements (
  id uuid PRIMARY KEY,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('PRIMARY', 'ADDITIONAL')),
  -- Exactly one unit reference: ORG-004 node stable key or legacy unit.
  org_node_key uuid NULL,
  legacy_unit_id uuid NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
  -- At most one position reference: ORG-004 position stable key or legacy position.
  org_position_key uuid NULL,
  legacy_position_id uuid NULL REFERENCES positions(id) ON DELETE RESTRICT,
  job_title_label text NOT NULL CHECK (length(trim(job_title_label)) > 0),
  functional_label text NULL,
  structural_label text NULL,
  work_location_key uuid NULL,
  effective_from date NOT NULL,
  effective_to date NULL,
  effective_from_basis text NOT NULL CHECK (effective_from_basis IN ('RECORDED', 'BASELINE_ASSUMED')),
  opened_by_action_id uuid NOT NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  closed_by_action_id uuid NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  voided_by_action_id uuid NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_placements_unit_ref_check
    CHECK ((org_node_key IS NULL) <> (legacy_unit_id IS NULL)),
  CONSTRAINT employment_placements_position_ref_check
    CHECK (org_position_key IS NULL OR legacy_position_id IS NULL),
  CONSTRAINT employment_placements_date_order_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employment_placements_one_primary
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (kind = 'PRIMARY' AND voided_by_action_id IS NULL),
  CONSTRAINT employment_placements_additional_position_once
    EXCLUDE USING gist (
      employment_id WITH =,
      (COALESCE(org_position_key, legacy_position_id)) WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (
      kind = 'ADDITIONAL'
      AND voided_by_action_id IS NULL
      AND COALESCE(org_position_key, legacy_position_id) IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS employment_placements_employment_idx
  ON employment_placements (employment_id, effective_from);

CREATE TABLE IF NOT EXISTS employment_action_documents (
  action_id uuid NOT NULL REFERENCES employment_actions(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES employment_decision_documents(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, document_id)
);

CREATE INDEX IF NOT EXISTS employment_action_documents_document_idx
  ON employment_action_documents (document_id);

-- Payloads carry ids, codes, and dates only: no reason notes, contact data,
-- or identity numbers (spec §10).
CREATE TABLE IF NOT EXISTS employment_audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NULL,
  employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employment_audit_events_time_idx
  ON employment_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS employment_audit_events_employee_idx
  ON employment_audit_events (employee_id, occurred_at DESC) WHERE employee_id IS NOT NULL;

-- History rows are never deleted by application code. The only exception is
-- the S2 baseline purge, which must opt in explicitly inside its transaction:
--   SET LOCAL hcis.employment_baseline_purge = 'on';
CREATE OR REPLACE FUNCTION employment_history_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('hcis.employment_baseline_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'EMPLOYMENT_HISTORY_DELETE_FORBIDDEN: % rows are append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER employments_guard_delete
  BEFORE DELETE ON employments
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_actions_guard_delete
  BEFORE DELETE ON employment_actions
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_terms_guard_delete
  BEFORE DELETE ON employment_terms
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_placements_guard_delete
  BEFORE DELETE ON employment_placements
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_action_documents_guard_delete
  BEFORE DELETE ON employment_action_documents
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_decision_documents_guard_delete
  BEFORE DELETE ON employment_decision_documents
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_decision_document_corrections_guard_delete
  BEFORE DELETE ON employment_decision_document_corrections
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
CREATE TRIGGER employment_audit_events_guard_delete
  BEFORE DELETE ON employment_audit_events
  FOR EACH ROW EXECUTE FUNCTION employment_history_guard_delete();
