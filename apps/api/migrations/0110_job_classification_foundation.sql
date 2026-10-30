-- ORG-011 Package 1: job classification and grade catalogs.
-- Spec: docs/domain/job-classification-grade.md. ADR: ADR-0004.
--
-- These catalogs are compensation reference data, so they deliberately live OUTSIDE the
-- ORG-004 change sets: publishing a structure revision must not republish the catalog, and
-- editing the catalog must not require a change set. Nothing here reads or grants authority.
--
-- ADR-0004 forbids monetary values in this migration. job_grades.rank_order is display order
-- only; the salary scale stays in PAY-003 policy tables (education x MKG), and the allowance
-- tables keep their own rupiah amounts keyed by classification code.
--
-- Codes are permanent (spec §2.6): versioned payroll policy stores the code verbatim and past
-- periods read it back, so a wrong classification is deactivated and replaced, never renamed.
-- The exclusion constraints below enforce that one code means one thing over any given date.
--
-- Down:
--   DROP TABLE IF EXISTS job_classification_audit_events;
--   DROP TABLE IF EXISTS job_classifications;
--   DROP TABLE IF EXISTS job_grades;
--   DELETE FROM role_permissions WHERE permission_key LIKE 'job_classifications.%';
--   DELETE FROM permissions WHERE permission_key LIKE 'job_classifications.%';

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS job_grades (
  id uuid PRIMARY KEY,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- Display and report ordering only. ADR-0004: never a pay multiplier.
  rank_order integer NOT NULL CHECK (rank_order >= 0),
  active boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  effective_to date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_grades_date_order_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT job_grades_code_no_overlap
    EXCLUDE USING gist (
      code WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS job_grades_code_idx ON job_grades (code, effective_from DESC);

CREATE TABLE IF NOT EXISTS job_classifications (
  id uuid PRIMARY KEY,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,47}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- FUNCTIONAL and STRUCTURAL map one-to-one onto the two payroll slots
  -- (payroll_compensation_profiles.functional_position_ref / structural_position_ref).
  -- SUPPORT carries neither allowance and exists so non-teaching staff can be classified
  -- without being forced into a slot payroll would then look up.
  family text NOT NULL CHECK (family IN ('FUNCTIONAL', 'STRUCTURAL', 'SUPPORT')),
  -- Optional: YSQ has no numeric grades today (spec §8). A grade adds ordering, never money.
  grade_code text NULL CHECK (grade_code IS NULL OR grade_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  active boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  effective_to date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_classifications_date_order_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT job_classifications_code_no_overlap
    EXCLUDE USING gist (
      code WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    )
);

-- grade_code is validated by the service against job_grades effective on the same date rather
-- than by a foreign key: both sides are effective-dated, and a plain FK would compare rows
-- without regard to their dates while blocking a grade from ever being superseded.
CREATE INDEX IF NOT EXISTS job_classifications_code_idx
  ON job_classifications (code, effective_from DESC);
CREATE INDEX IF NOT EXISTS job_classifications_family_idx
  ON job_classifications (family, active);
CREATE INDEX IF NOT EXISTS job_classifications_grade_idx
  ON job_classifications (grade_code) WHERE grade_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_classification_audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('JOB_GRADE', 'JOB_CLASSIFICATION')),
  entity_id uuid NULL,
  entity_code text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_classification_audit_events_time_idx
  ON job_classification_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS job_classification_audit_events_entity_idx
  ON job_classification_audit_events (entity_type, entity_code, occurred_at DESC);

-- Both permissions join human_capital_admin: at YSQ Human Capital owns the catalog
-- (spec §5, DRAFT default). They are organization-scoped, so a unit-scoped HC role grants
-- nothing, and Super Admin does not receive them through legacy compatibility.
--
-- Deployment order: the build that knows these keys must already be running when this
-- migration applies, or the old build briefly refuses to assign human_capital_admin.
-- See docs/development/mi8vps-hcis-release.md §4.5.
INSERT INTO permissions (permission_key, description) VALUES
  ('job_classifications.read', 'ORG-011: read the job classification and grade catalogs'),
  ('job_classifications.manage', 'ORG-011: create, amend and deactivate classifications and grades')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role
CROSS JOIN unnest(ARRAY['job_classifications.read', 'job_classifications.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
