-- TRAIN-001 R3: training evaluation (four-level framework).
-- Spec: docs/domain/training-evaluation.md §10.
--
-- Additive only. The one change to a Package 1 table is a new column with a default on
-- training_programs. No permission is added (E-17): training.read / training.manage cover R3,
-- so this migration can ship with the build that reads it.
--
-- Anonymous reaction responses (E-11) keep neither respondent nor time of day: who has answered
-- lives in training_evaluation_completions with a date only, and the anonymous response row has a
-- date only, so the two cannot be joined back by timestamp.
--
-- Down (only TRAIN-001 R3 code reads these objects):
--   DROP TABLE IF EXISTS training_evaluation_responses;
--   DROP TABLE IF EXISTS training_evaluation_completions;
--   DROP TABLE IF EXISTS training_evaluation_assessors;
--   DROP TABLE IF EXISTS training_evaluation_components;
--   DROP TABLE IF EXISTS training_instruments;
--   ALTER TABLE training_programs DROP COLUMN IF EXISTS evaluation_passing_score;

-- E-07 DRAFT: passing score per program, default 75.
ALTER TABLE training_programs
  ADD COLUMN IF NOT EXISTS evaluation_passing_score integer NOT NULL DEFAULT 75
    CHECK (evaluation_passing_score BETWEEN 0 AND 100);

CREATE TABLE IF NOT EXISTS training_instruments (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('FORM', 'TEST', 'RUBRIC')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 1000),
  -- E-02: 1-50 items, validated by the API; numbered q1..qN.
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 50),
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_account_id uuid NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_system = (created_by_account_id IS NULL))
);

CREATE INDEX IF NOT EXISTS training_instruments_list_idx
  ON training_instruments (status, kind, created_at DESC);

-- E-10: the standard reaction questionnaire (discovery §7.5), fixed id, read-only.
INSERT INTO training_instruments (id, kind, title, description, items, is_system, status)
VALUES (
  '00000000-0000-4000-8000-0000000000e1', 'FORM', 'Kuesioner reaksi standar',
  'Butir tetap dari sistem agar hasil dapat dibandingkan antarprogram. Skala 1 (sangat tidak setuju) sampai 5 (sangat setuju).',
  '[
    {"id": "q1", "type": "SCALE", "prompt": "Materi relevan dengan pekerjaan saya.", "required": true},
    {"id": "q2", "type": "SCALE", "prompt": "Narasumber menguasai materi.", "required": true},
    {"id": "q3", "type": "SCALE", "prompt": "Metode penyampaian membantu saya memahami.", "required": true},
    {"id": "q4", "type": "SCALE", "prompt": "Waktu pelaksanaan memadai.", "required": true},
    {"id": "q5", "type": "SCALE", "prompt": "Fasilitas dan sarana mendukung.", "required": true},
    {"id": "q6", "type": "SCALE", "prompt": "Saya akan merekomendasikan pelatihan ini kepada rekan.", "required": true},
    {"id": "q7", "type": "TEXT", "prompt": "Komentar atau saran.", "required": false}
  ]'::jsonb,
  true, 'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS training_evaluation_components (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES training_programs(id),
  kind text NOT NULL CHECK (kind IN ('REACTION', 'PRE_POST_TEST', 'TEST', 'RUBRIC', 'FORM', 'RESULT')),
  level integer NOT NULL CHECK (level BETWEEN 1 AND 4),
  respondent text NOT NULL CHECK (respondent IN ('PARTICIPANT', 'SUPERVISOR', 'HC')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  instrument_id uuid NOT NULL REFERENCES training_instruments(id),
  instrument_kind text NOT NULL CHECK (instrument_kind IN ('FORM', 'TEST', 'RUBRIC')),
  -- E-03: the instrument's items copied when the component was added.
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  anonymous boolean NOT NULL DEFAULT false,
  weight integer NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 100),
  required boolean NOT NULL DEFAULT true,
  opens_at timestamptz NULL,
  closes_at timestamptz NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  archive_reason text NULL CHECK (archive_reason IS NULL OR char_length(archive_reason) BETWEEN 5 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
  CHECK ((status = 'ARCHIVED') = (archive_reason IS NOT NULL)),
  -- E-06 pairs, enforced again here so a bad write cannot slip past the API.
  CHECK (
    (kind = 'REACTION' AND instrument_kind = 'FORM' AND level = 1 AND respondent = 'PARTICIPANT' AND anonymous AND weight = 0)
    OR (kind IN ('PRE_POST_TEST', 'TEST') AND instrument_kind = 'TEST' AND level = 2 AND respondent = 'PARTICIPANT' AND NOT anonymous)
    OR (kind = 'RUBRIC' AND instrument_kind = 'RUBRIC' AND level IN (2, 3) AND respondent IN ('HC', 'SUPERVISOR') AND NOT anonymous
        AND (level = 2 OR weight = 0))
    OR (kind = 'FORM' AND instrument_kind = 'FORM' AND level IN (1, 2, 3) AND respondent IN ('PARTICIPANT', 'SUPERVISOR')
        AND weight = 0 AND (respondent = 'PARTICIPANT' OR NOT anonymous))
    OR (kind = 'RESULT' AND instrument_kind = 'FORM' AND level = 4 AND respondent = 'HC' AND NOT anonymous AND weight = 0)
  )
);

CREATE INDEX IF NOT EXISTS training_evaluation_components_program_idx
  ON training_evaluation_components (program_id, status, created_at);

-- E-14: who assesses each participant for a SUPERVISOR component.
CREATE TABLE IF NOT EXISTS training_evaluation_assessors (
  component_id uuid NOT NULL REFERENCES training_evaluation_components(id),
  subject_employee_id uuid NOT NULL REFERENCES employees(id),
  assessor_employee_id uuid NULL REFERENCES employees(id),
  source text NOT NULL CHECK (source IN ('DIRECT_MANAGER', 'GOVERNANCE_APPROVER', 'UNRESOLVED', 'HC_ASSIGNED')),
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_by_account_id uuid NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component_id, subject_employee_id),
  CHECK (assessor_employee_id IS NULL OR assessor_employee_id <> subject_employee_id),
  CHECK ((source = 'UNRESOLVED') = (assessor_employee_id IS NULL))
);

CREATE INDEX IF NOT EXISTS training_evaluation_assessors_assessor_idx
  ON training_evaluation_assessors (assessor_employee_id);

-- E-13: one submission per (component, stage, subject, respondent). Date only (E-11).
CREATE TABLE IF NOT EXISTS training_evaluation_completions (
  id uuid PRIMARY KEY,
  component_id uuid NOT NULL REFERENCES training_evaluation_components(id),
  stage text NOT NULL CHECK (stage IN ('SINGLE', 'PRE', 'POST')),
  subject_employee_id uuid NULL REFERENCES employees(id),
  respondent_employee_id uuid NULL REFERENCES employees(id),
  respondent_account_id uuid NULL REFERENCES accounts(id),
  submitted_on date NOT NULL,
  CHECK (respondent_employee_id IS NOT NULL OR respondent_account_id IS NOT NULL)
);

-- A program-level HC form (RESULT) is answered once, whoever answers it.
CREATE UNIQUE INDEX IF NOT EXISTS training_evaluation_completions_once_idx
  ON training_evaluation_completions (
    component_id, stage,
    COALESCE(subject_employee_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(respondent_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE IF NOT EXISTS training_evaluation_responses (
  id uuid PRIMARY KEY,
  component_id uuid NOT NULL REFERENCES training_evaluation_components(id),
  stage text NOT NULL CHECK (stage IN ('SINGLE', 'PRE', 'POST')),
  -- NULL for anonymous responses (E-11) and for program-level forms.
  subject_employee_id uuid NULL REFERENCES employees(id),
  respondent_employee_id uuid NULL REFERENCES employees(id),
  respondent_account_id uuid NULL REFERENCES accounts(id),
  anonymous boolean NOT NULL,
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  score numeric(5, 2) NULL CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  points_earned numeric(6, 2) NULL,
  points_max numeric(6, 2) NULL,
  submitted_on date NOT NULL,
  -- Exact time only for named responses; anonymous rows keep the date alone.
  submitted_at timestamptz NULL,
  CHECK (NOT anonymous OR (subject_employee_id IS NULL AND respondent_employee_id IS NULL
                           AND respondent_account_id IS NULL AND submitted_at IS NULL)),
  CHECK (anonymous OR submitted_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS training_evaluation_responses_named_idx
  ON training_evaluation_responses (
    component_id, stage,
    COALESCE(subject_employee_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(respondent_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE NOT anonymous;

CREATE INDEX IF NOT EXISTS training_evaluation_responses_subject_idx
  ON training_evaluation_responses (subject_employee_id, component_id);

CREATE INDEX IF NOT EXISTS training_evaluation_responses_component_idx
  ON training_evaluation_responses (component_id, stage);
