-- TRAIN-001 R4: online modules with server-hosted video, server-credited watch progress and quizzes.
-- Spec: docs/domain/training-online-modules.md §9.
--
-- Additive only; the one change to an existing table is training_programs.delivery with a default.
-- No permission is added (M-17). Video bytes live in ObjectStorage (ADR-0002), never here: these
-- tables hold object keys, sizes, durations and hashes only. The feature is off by default
-- (TRAINING_ONLINE_ENABLED=0), so these tables stay empty until the owner turns it on.
--
-- Down (only TRAIN-001 R4 code reads these objects; remove the media directory separately):
--   DROP TABLE IF EXISTS training_quiz_attempts;
--   DROP TABLE IF EXISTS training_playbacks;
--   DROP TABLE IF EXISTS training_material_progress;
--   DROP TABLE IF EXISTS training_materials;
--   DROP TABLE IF EXISTS training_modules;
--   ALTER TABLE training_programs DROP COLUMN IF EXISTS delivery;

-- M-01 DRAFT.
ALTER TABLE training_programs
  ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'CLASSROOM' CHECK (delivery IN ('CLASSROOM', 'ONLINE'));

CREATE TABLE IF NOT EXISTS training_modules (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES training_programs(id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 2000),
  -- M-02 DRAFT: 0.25-40 hours in quarters.
  credit_hours numeric(5, 2) NOT NULL CHECK (credit_hours BETWEEN 0.25 AND 40 AND (credit_hours * 4) = floor(credit_hours * 4)),
  -- M-13: a copy of a TEST instrument's items (R3 snapshot-on-attach), or none.
  quiz_instrument_id uuid NULL REFERENCES training_instruments(id),
  quiz_items jsonb NULL CHECK (quiz_items IS NULL OR jsonb_typeof(quiz_items) = 'array'),
  quiz_passing_score integer NOT NULL DEFAULT 70 CHECK (quiz_passing_score BETWEEN 0 AND 100),
  quiz_max_attempts integer NOT NULL DEFAULT 3 CHECK (quiz_max_attempts BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  archive_reason text NULL CHECK (archive_reason IS NULL OR char_length(archive_reason) BETWEEN 5 AND 500),
  published_at timestamptz NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiz_items IS NULL) = (quiz_instrument_id IS NULL)),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
  CHECK ((status = 'ARCHIVED') = (archive_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS training_modules_program_idx ON training_modules (program_id, status, position);

CREATE TABLE IF NOT EXISTS training_materials (
  id uuid PRIMARY KEY,
  module_id uuid NOT NULL REFERENCES training_modules(id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
  kind text NOT NULL CHECK (kind IN ('VIDEO', 'TEXT')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  body text NULL CHECK (body IS NULL OR char_length(body) <= 20000),
  -- Object key in ObjectStorage; never a host path.
  object_key text NULL,
  byte_size bigint NULL CHECK (byte_size IS NULL OR byte_size > 0),
  duration_seconds numeric(9, 3) NULL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  sha256 text NULL CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'VIDEO' OR (object_key IS NULL AND body IS NOT NULL)),
  CHECK ((object_key IS NULL) = (byte_size IS NULL) AND (object_key IS NULL) = (duration_seconds IS NULL)
         AND (object_key IS NULL) = (sha256 IS NULL) AND (object_key IS NULL) = (uploaded_at IS NULL))
);

CREATE INDEX IF NOT EXISTS training_materials_module_idx ON training_materials (module_id, status, position);

CREATE TABLE IF NOT EXISTS training_material_progress (
  material_id uuid NOT NULL REFERENCES training_materials(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  -- M-10: the furthest contiguous position the server has credited, and the last reported one.
  credited_seconds numeric(9, 3) NOT NULL DEFAULT 0 CHECK (credited_seconds >= 0),
  last_position_seconds numeric(9, 3) NOT NULL DEFAULT 0 CHECK (last_position_seconds >= 0),
  completed_at timestamptz NULL,
  completed_via text NULL CHECK (completed_via IS NULL OR completed_via IN ('WATCHED', 'READ', 'HC_MANUAL')),
  manual_reason text NULL CHECK (manual_reason IS NULL OR char_length(manual_reason) BETWEEN 5 AND 500),
  completed_by_account_id uuid NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, employee_id),
  CHECK ((completed_at IS NULL) = (completed_via IS NULL)),
  CHECK ((completed_via = 'HC_MANUAL') = (manual_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS training_playbacks (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES training_materials(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
);

-- M-08: one active watch session per participant per material.
CREATE UNIQUE INDEX IF NOT EXISTS training_playbacks_active_idx
  ON training_playbacks (material_id, employee_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS training_quiz_attempts (
  id uuid PRIMARY KEY,
  module_id uuid NOT NULL REFERENCES training_modules(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 10),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  score numeric(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed boolean NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_id, employee_id, attempt_no)
);
