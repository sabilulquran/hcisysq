-- DOC-001 / DOC-002 Package 1: HR document register.
-- Spec: docs/domain/hr-documents.md §9.
--
-- Number allocation increments hr_document_number_counters with ON CONFLICT DO UPDATE
-- inside the issuing transaction. That takes an exclusive row lock, so a second issue for
-- the same code and year blocks until the first transaction ends and the two never receive
-- the same number (spec DOC-001-D); the UNIQUE below is the backstop. Numbers are never
-- recycled: a revoked document keeps its number and moves to status REVOKED (D-03).
--
-- Down:
--   DROP TABLE IF EXISTS hr_document_audit_events;
--   DROP TABLE IF EXISTS hr_disciplinary_letters;
--   DROP TABLE IF EXISTS hr_document_requests;
--   DROP TABLE IF EXISTS hr_issued_documents;
--   DROP TABLE IF EXISTS hr_document_number_counters;
--   DROP TABLE IF EXISTS hr_document_types;

CREATE TABLE IF NOT EXISTS hr_document_types (
  code text PRIMARY KEY,
  label text NOT NULL,
  number_code text NOT NULL,
  -- D-06: whose employment state this letter describes.
  requires_active_employment boolean NOT NULL DEFAULT true,
  requires_ended_employment boolean NOT NULL DEFAULT false,
  -- An ended employee no longer has an active account, so paklaring is issued by
  -- HC directly rather than self-requested.
  self_requestable boolean NOT NULL DEFAULT true,
  -- Package 2 types stay in the catalog but cannot be used yet (DOC-001-I).
  available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO hr_document_types (code, label, number_code, requires_active_employment, requires_ended_employment, self_requestable, available, sort_order) VALUES
  ('KETERANGAN_KERJA', 'Surat Keterangan Kerja', 'SKK', true, false, true, true, 1),
  ('PAKLARING', 'Surat Keterangan Pengalaman Kerja', 'SKPK', false, true, false, true, 2),
  ('KETERANGAN_PENGHASILAN', 'Surat Keterangan Penghasilan', 'SKP', true, false, true, false, 3)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS hr_document_number_counters (
  number_code text NOT NULL,
  number_year integer NOT NULL,
  last_sequence integer NOT NULL DEFAULT 0,
  PRIMARY KEY (number_code, number_year)
);

CREATE TABLE IF NOT EXISTS hr_issued_documents (
  id uuid PRIMARY KEY,
  document_kind text NOT NULL CHECK (document_kind IN ('CERTIFICATE', 'DISCIPLINARY')),
  document_code text NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id),
  number_code text NOT NULL,
  number_year integer NOT NULL,
  number_sequence integer NOT NULL,
  document_number text NOT NULL UNIQUE,
  -- Filtered facts only; never salary, account numbers or home address (D-15).
  content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  signer jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'REVOKED')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by_account_id uuid NOT NULL REFERENCES accounts(id),
  revoked_at timestamptz NULL,
  revoked_by_account_id uuid NULL REFERENCES accounts(id),
  revoke_reason text NULL,
  UNIQUE (number_code, number_year, number_sequence)
);

CREATE INDEX IF NOT EXISTS hr_issued_documents_employee_idx
  ON hr_issued_documents (employee_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS hr_document_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  document_code text NOT NULL REFERENCES hr_document_types(code),
  purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ISSUED')),
  decided_by_account_id uuid NULL REFERENCES accounts(id),
  decided_at timestamptz NULL,
  decision_note text NULL,
  issued_document_id uuid NULL REFERENCES hr_issued_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hr_document_requests_employee_idx
  ON hr_document_requests (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hr_document_requests_open_idx
  ON hr_document_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_disciplinary_letters (
  id uuid PRIMARY KEY,
  issued_document_id uuid NOT NULL UNIQUE REFERENCES hr_issued_documents(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  level text NOT NULL CHECK (level IN ('SP1', 'SP2', 'SP3')),
  subject text NOT NULL,
  narrative text NOT NULL,
  effective_date date NOT NULL,
  -- D-10: expiry is stored as a date and evaluated on read; no scheduled job (DOC-002-D).
  expires_on date NOT NULL,
  acknowledged_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on >= effective_date)
);

CREATE INDEX IF NOT EXISTS hr_disciplinary_letters_employee_idx
  ON hr_disciplinary_letters (employee_id, effective_date DESC);

CREATE TABLE IF NOT EXISTS hr_document_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  request_id uuid NULL REFERENCES hr_document_requests(id),
  issued_document_id uuid NULL REFERENCES hr_issued_documents(id),
  employee_id uuid NULL REFERENCES employees(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  -- Never the disciplinary narrative (spec §7).
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hr_document_audit_events_occurred_idx
  ON hr_document_audit_events (occurred_at DESC);
