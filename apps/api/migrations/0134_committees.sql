-- ORG-012 Package 1: committees (kepanitiaan), their members, and audit.
-- Spec: docs/domain/committees.md §8.
--
-- Additive only. Committees never touch organization_*, employment_* or approval tables (§2).
-- A committee decree issued in HCIS is a row in the DOC-001 register, document_kind
-- 'COMMITTEE', number code 'SKP', so it shares the counter lock and the never-recycle rule
-- (same pattern as the TRIP-001 assignment letter in 0115).
--
-- Down (no other module reads these objects):
--   DROP TABLE IF EXISTS committee_audit_events;
--   DROP TABLE IF EXISTS committee_members;
--   DROP TABLE IF EXISTS committees;
--   -- Only when no COMMITTEE row exists (otherwise keep the wider check; numbers are never recycled):
--   ALTER TABLE hr_issued_documents DROP CONSTRAINT hr_issued_documents_document_kind_check;
--   ALTER TABLE hr_issued_documents ADD CONSTRAINT hr_issued_documents_document_kind_check
--     CHECK (document_kind IN ('CERTIFICATE', 'DISCIPLINARY', 'ASSIGNMENT'));

ALTER TABLE hr_issued_documents DROP CONSTRAINT IF EXISTS hr_issued_documents_document_kind_check;
ALTER TABLE hr_issued_documents ADD CONSTRAINT hr_issued_documents_document_kind_check
  CHECK (document_kind IN ('CERTIFICATE', 'DISCIPLINARY', 'ASSIGNMENT', 'COMMITTEE'));

CREATE TABLE IF NOT EXISTS committees (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 200),
  -- D-01 DRAFT categories.
  category text NOT NULL CHECK (category IN ('ADMISSION', 'EXAM', 'GRADUATION', 'RAMADAN', 'EVENT', 'OTHER')),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 2000),
  organizer text NULL CHECK (organizer IS NULL OR char_length(organizer) BETWEEN 2 AND 200),
  start_on date NOT NULL,
  end_on date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- D-08: ISSUED = numbered in the DOC-001 register; EXTERNAL = signed outside HCIS.
  decree_mode text NULL CHECK (decree_mode IN ('ISSUED', 'EXTERNAL')),
  issued_document_id uuid NULL UNIQUE REFERENCES hr_issued_documents(id),
  external_decree_number text NULL CHECK (external_decree_number IS NULL OR char_length(external_decree_number) BETWEEN 3 AND 100),
  external_decree_date date NULL,
  activated_at timestamptz NULL,
  completed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 10 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- D-04 DRAFT: at most 366 days.
  CHECK (end_on >= start_on AND end_on - start_on <= 365),
  CHECK ((decree_mode IS NULL) = (activated_at IS NULL)),
  CHECK (status = 'DRAFT' OR status = 'CANCELLED' OR activated_at IS NOT NULL),
  CHECK (status <> 'DRAFT' OR activated_at IS NULL),
  CHECK ((decree_mode = 'ISSUED') = (issued_document_id IS NOT NULL)),
  CHECK ((decree_mode = 'EXTERNAL') = (external_decree_number IS NOT NULL AND external_decree_date IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS committees_status_idx ON committees (status, start_on DESC, id);

CREATE TABLE IF NOT EXISTS committee_members (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  -- D-05 DRAFT roles.
  role text NOT NULL CHECK (role IN ('CHAIR', 'VICE_CHAIR', 'SECRETARY', 'TREASURER', 'SECTION_COORDINATOR', 'MEMBER')),
  section text NULL CHECK (section IS NULL OR char_length(section) BETWEEN 2 AND 100),
  joined_on date NOT NULL,
  left_on date NULL,
  end_reason text NULL CHECK (end_reason IS NULL OR char_length(end_reason) <= 300),
  added_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_on IS NULL OR left_on >= joined_on),
  CHECK (role <> 'SECTION_COORDINATOR' OR section IS NOT NULL)
);

-- D-05: one open membership per employee, one open chair per committee.
CREATE UNIQUE INDEX IF NOT EXISTS committee_members_open_employee_idx
  ON committee_members (committee_id, employee_id) WHERE left_on IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS committee_members_open_chair_idx
  ON committee_members (committee_id) WHERE role = 'CHAIR' AND left_on IS NULL;
CREATE INDEX IF NOT EXISTS committee_members_employee_idx
  ON committee_members (employee_id, joined_on DESC);
CREATE INDEX IF NOT EXISTS committee_members_committee_idx
  ON committee_members (committee_id, joined_on, id);

CREATE TABLE IF NOT EXISTS committee_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  committee_id uuid NOT NULL REFERENCES committees(id),
  employee_id uuid NULL REFERENCES employees(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS committee_audit_events_committee_idx
  ON committee_audit_events (committee_id, occurred_at DESC);
