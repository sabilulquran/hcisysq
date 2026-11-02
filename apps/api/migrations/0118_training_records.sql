-- TRAIN-001 Package 1: training programs, scheduled sessions, participants, attendance,
-- training records (internal and external), encrypted certificates and audit.
-- Spec: docs/domain/training.md §12.
--
-- Additive only: no existing table or row is touched. Certificates follow the encrypted
-- supporting-document pattern of leave_request_evidence (0007); no new storage (D-10).
-- training_employee_busy is the read contract for CAL-001 time blocking (§7.3).
--
-- Down (no other data is affected; only TRAIN-001 code reads these objects):
--   DROP VIEW IF EXISTS training_employee_busy;
--   DROP TABLE IF EXISTS training_audit_events;
--   ALTER TABLE IF EXISTS training_records DROP CONSTRAINT IF EXISTS training_records_certificate_fk;
--   DROP TABLE IF EXISTS training_certificates;
--   DROP TABLE IF EXISTS training_records;
--   DROP TABLE IF EXISTS training_attendance;
--   DROP TABLE IF EXISTS training_participants;
--   DROP TABLE IF EXISTS training_sessions;
--   DROP TABLE IF EXISTS training_programs;

CREATE TABLE IF NOT EXISTS training_programs (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  -- D-02 DRAFT categories (discovery §7.2).
  category text NOT NULL CHECK (category IN (
    'QURANIC', 'PEDAGOGY', 'CAREGIVING', 'SOP_ADMIN', 'ORIENTATION', 'COACHING', 'OTHER'
  )),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 2000),
  organizer text NOT NULL CHECK (char_length(organizer) BETWEEN 3 AND 200),
  capacity integer NULL CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 500),
  -- D-06 DRAFT: attended share of session hours needed to complete the program.
  min_attendance_percent integer NOT NULL DEFAULT 80 CHECK (min_attendance_percent BETWEEN 50 AND 100),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 10 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS training_programs_status_idx
  ON training_programs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS training_sessions (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES training_programs(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  location text NULL CHECK (location IS NULL OR char_length(location) <= 200),
  speaker_employee_id uuid NULL REFERENCES employees(id),
  speaker_name text NULL CHECK (speaker_name IS NULL OR char_length(speaker_name) BETWEEN 2 AND 150),
  status text NOT NULL CHECK (status IN ('SCHEDULED', 'CANCELLED')),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 5 AND 500),
  busy tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- D-17 DRAFT: 15 minutes to 12 hours.
  CHECK (end_at - start_at >= interval '15 minutes'),
  CHECK (end_at - start_at <= interval '12 hours'),
  CHECK (speaker_employee_id IS NULL OR speaker_name IS NULL),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS training_sessions_program_idx
  ON training_sessions (program_id, start_at ASC);
CREATE INDEX IF NOT EXISTS training_sessions_busy_idx
  ON training_sessions USING gist (busy) WHERE status = 'SCHEDULED';

CREATE TABLE IF NOT EXISTS training_participants (
  program_id uuid NOT NULL REFERENCES training_programs(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL CHECK (status IN ('ENROLLED', 'WITHDRAWN', 'COMPLETED', 'INCOMPLETE')),
  withdraw_reason text NULL CHECK (withdraw_reason IS NULL OR char_length(withdraw_reason) BETWEEN 5 AND 500),
  attended_hours numeric(7, 2) NULL CHECK (attended_hours IS NULL OR attended_hours >= 0),
  enrolled_by_account_id uuid NOT NULL REFERENCES accounts(id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, employee_id),
  CHECK ((status = 'WITHDRAWN') = (withdraw_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS training_participants_employee_idx
  ON training_participants (employee_id, program_id);

CREATE TABLE IF NOT EXISTS training_attendance (
  session_id uuid NOT NULL REFERENCES training_sessions(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL CHECK (status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 300),
  recorded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, employee_id)
);

CREATE TABLE IF NOT EXISTS training_records (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  source text NOT NULL CHECK (source IN ('INTERNAL', 'EXTERNAL')),
  role text NOT NULL CHECK (role IN ('PARTICIPANT', 'SPEAKER')),
  program_id uuid NULL REFERENCES training_programs(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  category text NOT NULL CHECK (category IN (
    'QURANIC', 'PEDAGOGY', 'CAREGIVING', 'SOP_ADMIN', 'ORIENTATION', 'COACHING', 'OTHER'
  )),
  organizer text NOT NULL CHECK (char_length(organizer) BETWEEN 3 AND 200),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 2000),
  start_on date NOT NULL,
  end_on date NOT NULL,
  -- D-07 DRAFT: attended hours (internal) or declared hours (external, 0.5 to 200).
  hours numeric(7, 2) NOT NULL CHECK (hours >= 0 AND hours <= 1000),
  -- D-06: internal participants only; null for speakers and external records.
  completed boolean NULL,
  status text NOT NULL CHECK (status IN ('SUBMITTED', 'VERIFIED', 'REJECTED', 'WITHDRAWN')),
  idempotency_key uuid NULL,
  certificate_id uuid NULL,
  decided_by_account_id uuid NULL REFERENCES accounts(id),
  decided_at timestamptz NULL,
  reject_reason text NULL CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 5 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_on >= start_on),
  CHECK ((source = 'INTERNAL') = (program_id IS NOT NULL)),
  CHECK (source = 'EXTERNAL' OR (status = 'VERIFIED' AND idempotency_key IS NULL)),
  CHECK (source = 'INTERNAL' OR (role = 'PARTICIPANT' AND idempotency_key IS NOT NULL AND completed IS NULL
    AND hours >= 0.5 AND hours <= 200)),
  CHECK (role = 'PARTICIPANT' OR completed IS NULL),
  CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
  UNIQUE (employee_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS training_records_internal_idx
  ON training_records (program_id, employee_id, role) WHERE source = 'INTERNAL';
CREATE INDEX IF NOT EXISTS training_records_employee_idx
  ON training_records (employee_id, end_on DESC);
CREATE INDEX IF NOT EXISTS training_records_status_idx
  ON training_records (status, created_at DESC);

CREATE TABLE IF NOT EXISTS training_certificates (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES training_records(id),
  original_filename text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  uploaded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_certificates_record_idx
  ON training_certificates (record_id, created_at DESC);

ALTER TABLE training_records DROP CONSTRAINT IF EXISTS training_records_certificate_fk;
ALTER TABLE training_records ADD CONSTRAINT training_records_certificate_fk
  FOREIGN KEY (certificate_id) REFERENCES training_certificates(id);

CREATE TABLE IF NOT EXISTS training_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  program_id uuid NULL REFERENCES training_programs(id),
  session_id uuid NULL REFERENCES training_sessions(id),
  record_id uuid NULL REFERENCES training_records(id),
  employee_id uuid NULL REFERENCES employees(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_audit_events_program_idx
  ON training_audit_events (program_id, occurred_at ASC) WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS training_audit_events_record_idx
  ON training_audit_events (record_id, occurred_at ASC) WHERE record_id IS NOT NULL;

-- §7.3: who is busy in which scheduled session. Participants and internal speakers of
-- active programs only; a cancelled session, withdrawn participant or closed program frees time.
CREATE OR REPLACE VIEW training_employee_busy AS
  SELECT participant.employee_id, session.id AS session_id, session.program_id,
         program.title || ' — ' || session.title AS title, session.busy
    FROM training_sessions session
    JOIN training_programs program ON program.id = session.program_id
    JOIN training_participants participant ON participant.program_id = session.program_id
   WHERE session.status = 'SCHEDULED' AND program.status = 'ACTIVE' AND participant.status = 'ENROLLED'
  UNION
  SELECT session.speaker_employee_id, session.id, session.program_id,
         program.title || ' — ' || session.title, session.busy
    FROM training_sessions session
    JOIN training_programs program ON program.id = session.program_id
   WHERE session.status = 'SCHEDULED' AND program.status = 'ACTIVE' AND session.speaker_employee_id IS NOT NULL;
