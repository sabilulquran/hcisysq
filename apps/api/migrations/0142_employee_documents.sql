-- EMP-011 Package 1: employee document archive and the employee-document storage boundary.
-- Spec: docs/domain/employee-documents.md §8 (D-01).
--
-- Adds tables, indexes and constraints only; no existing data changes.
--
-- employee_document_files is the storage boundary for every employee-document file: the EMP-011
-- archive and the EMP-010 Perjanjian Kerja / Surat Keputusan attachments. Files use the
-- encrypted-in-database pattern of training certificates (TRAIN-001 D-10) and card photos
-- (EMP-012 D-03): AES-256-GCM with AUTH_ENCRYPTION_KEY, base64url ciphertext/iv/auth_tag columns.
-- The original file name is never stored (D-03). Purging a file empties the ciphertext and sets
-- purged_at; the metadata row and its audit stay (D-12, D-13).
--
-- Document numbers (NIK, KK, NPWP, ...) are stored encrypted with the same key; only the last
-- four characters are kept in clear for the masked display (D-05).
--
-- Down (after the previous build runs again; destroys every uploaded file):
--   DROP TABLE IF EXISTS employee_document_audit_events, employee_document_files, employee_documents;
--   DELETE FROM schema_migrations WHERE name = '0142_employee_documents.sql';

CREATE TABLE IF NOT EXISTS employee_documents (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  document_type text NOT NULL CHECK (document_type IN (
    'KTP', 'KK', 'NPWP', 'BPJS_KESEHATAN', 'BPJS_KETENAGAKERJAAN', 'IJAZAH', 'TRANSKRIP',
    'SERTIFIKAT', 'SIM', 'PASPOR', 'SKCK', 'SURAT_SEHAT', 'LAINNYA'
  )),
  title text NULL CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  issuer text NULL CHECK (issuer IS NULL OR char_length(issuer) BETWEEN 1 AND 200),
  issued_on date NULL,
  expires_on date NULL,
  number_ciphertext text NULL,
  number_iv text NULL,
  number_auth_tag text NULL,
  number_last4 text NULL CHECK (number_last4 IS NULL OR char_length(number_last4) BETWEEN 1 AND 4),
  status text NOT NULL CHECK (status IN ('PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'WITHDRAWN', 'REPLACED', 'REMOVED')),
  source text NOT NULL CHECK (source IN ('HC', 'EMPLOYEE')),
  replaces_document_id uuid NULL REFERENCES employee_documents(id),
  submitted_by_account_id uuid NOT NULL REFERENCES accounts(id),
  decided_by_account_id uuid NULL REFERENCES accounts(id),
  decided_at timestamptz NULL,
  decision_reason text NULL CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 300),
  ended_by_account_id uuid NULL REFERENCES accounts(id),
  ended_at timestamptz NULL,
  end_reason text NULL CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 300),
  notes text NULL CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_documents_period_check
    CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT employee_documents_number_triplet_check
    CHECK ((number_ciphertext IS NULL) = (number_iv IS NULL)
      AND (number_iv IS NULL) = (number_auth_tag IS NULL)
      AND (number_auth_tag IS NULL) = (number_last4 IS NULL)),
  CONSTRAINT employee_documents_other_title_check
    CHECK (document_type <> 'LAINNYA' OR title IS NOT NULL),
  CONSTRAINT employee_documents_not_self_replacing_check
    CHECK (replaces_document_id IS NULL OR replaces_document_id <> id)
);

CREATE INDEX IF NOT EXISTS employee_documents_employee_idx
  ON employee_documents (employee_id, created_at DESC);

-- D-15: the expiry worklist reads VERIFIED documents by expiry date.
CREATE INDEX IF NOT EXISTS employee_documents_expiring_idx
  ON employee_documents (expires_on) WHERE status = 'VERIFIED' AND expires_on IS NOT NULL;

-- D-06: the pending worklist and the per-employee open-proposal limit.
CREATE INDEX IF NOT EXISTS employee_documents_pending_idx
  ON employee_documents (created_at, employee_id) WHERE status = 'PENDING_REVIEW';

CREATE TABLE IF NOT EXISTS employee_document_files (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('EMPLOYEE_DOCUMENT', 'DECISION_DOCUMENT')),
  employee_document_id uuid NULL REFERENCES employee_documents(id),
  decision_document_id uuid NULL REFERENCES employment_decision_documents(id),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 4194304),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext text NULL,
  iv text NULL,
  auth_tag text NULL,
  uploaded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz NULL,
  purged_at timestamptz NULL,
  CONSTRAINT employee_document_files_owner_check CHECK (
    (purpose = 'EMPLOYEE_DOCUMENT' AND employee_document_id IS NOT NULL AND decision_document_id IS NULL)
    OR (purpose = 'DECISION_DOCUMENT' AND decision_document_id IS NOT NULL AND employee_document_id IS NULL)
  ),
  CONSTRAINT employee_document_files_purge_check CHECK (
    (purged_at IS NULL AND ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)
    OR (purged_at IS NOT NULL AND ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL)
  )
);

-- One file per archive document: a new version is a new document (D-14).
CREATE UNIQUE INDEX IF NOT EXISTS employee_document_files_one_per_document_idx
  ON employee_document_files (employee_document_id) WHERE employee_document_id IS NOT NULL;

-- One current file per register document; replaced files stay as history (D-16).
CREATE UNIQUE INDEX IF NOT EXISTS employee_document_files_one_current_decision_idx
  ON employee_document_files (decision_document_id) WHERE decision_document_id IS NOT NULL AND replaced_at IS NULL;

CREATE INDEX IF NOT EXISTS employee_document_files_decision_idx
  ON employee_document_files (decision_document_id, created_at DESC) WHERE decision_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_document_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'employee_document.uploaded', 'employee_document.verified', 'employee_document.rejected',
    'employee_document.withdrawn', 'employee_document.replaced', 'employee_document.removed',
    'employee_document.updated', 'employee_document.file_read', 'employee_document.list_read',
    'employee_document.worklist_read'
  )),
  employee_id uuid NULL REFERENCES employees(id),
  document_id uuid NULL REFERENCES employee_documents(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS employee_document_audit_events_employee_idx
  ON employee_document_audit_events (employee_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS employee_document_audit_events_document_idx
  ON employee_document_audit_events (document_id, occurred_at DESC);
