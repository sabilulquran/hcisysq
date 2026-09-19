-- ATT-002 / ATT-003 / ATT-006 / ATT-007
-- Integrated attendance scheduling, evidence, clarification, and result engine.

INSERT INTO permissions (permission_key, description) VALUES
  ('attendance.schedule.manage', 'ATT-003: manage schedules, rosters, and work locations'),
  ('attendance.policy.manage', 'ATT-007: manage attendance evaluation/finalization policy'),
  ('attendance.clarification.manage', 'ATT-002: decide attendance clarification requests'),
  ('attendance.reports.read', 'ATT-007: read organization attendance reports')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role
CROSS JOIN unnest(ARRAY[
  'attendance.schedule.manage',
  'attendance.policy.manage',
  'attendance.clarification.manage',
  'attendance.reports.read'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role
CROSS JOIN unnest(ARRAY[
  'attendance.clarification.manage',
  'attendance.reports.read'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital'
ON CONFLICT DO NOTHING;

CREATE TABLE attendance_work_locations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_meters integer NOT NULL CHECK (radius_meters BETWEEN 10 AND 5000),
  active boolean NOT NULL DEFAULT true,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_schedule_templates (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  start_time time NOT NULL,
  end_time time NOT NULL,
  late_grace_minutes integer NOT NULL DEFAULT 0 CHECK (late_grace_minutes BETWEEN 0 AND 240),
  early_leave_tolerance_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_tolerance_minutes BETWEEN 0 AND 240),
  work_location_id uuid NULL REFERENCES attendance_work_locations(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_schedule_assignments (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  schedule_template_id uuid NOT NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  weekday_mask integer NOT NULL CHECK (weekday_mask BETWEEN 1 AND 127),
  effective_from date NOT NULL,
  effective_to date NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX attendance_schedule_assignments_employee_date_idx
  ON attendance_schedule_assignments (employee_id, effective_from DESC, effective_to);

CREATE TABLE attendance_rosters (
  id uuid PRIMARY KEY,
  week_start date NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED')),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  published_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, version),
  CHECK (
    (status = 'DRAFT' AND published_by_account_id IS NULL AND published_at IS NULL)
    OR
    (status = 'PUBLISHED' AND published_by_account_id IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE attendance_roster_entries (
  roster_id uuid NOT NULL REFERENCES attendance_rosters(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  schedule_template_id uuid NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  is_off boolean NOT NULL DEFAULT false,
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  PRIMARY KEY (roster_id, employee_id, work_date),
  CHECK (
    (is_off = true AND schedule_template_id IS NULL)
    OR
    (is_off = false AND schedule_template_id IS NOT NULL)
  )
);
CREATE INDEX attendance_roster_entries_employee_date_idx
  ON attendance_roster_entries (employee_id, work_date);

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('adms', 'mobile', 'manual')),
  event_kind text NOT NULL CHECK (event_kind IN ('punch', 'check_in', 'check_out', 'correction')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 300),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_reference)
);
CREATE INDEX attendance_events_employee_time_idx
  ON attendance_events (employee_id, occurred_at, id);

CREATE TABLE attendance_mobile_evidence (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL UNIQUE REFERENCES attendance_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  action text NOT NULL CHECK (action IN ('check_in', 'check_out')),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters >= 0 AND accuracy_meters <= 100000),
  work_location_id uuid NULL REFERENCES attendance_work_locations(id) ON DELETE RESTRICT,
  distance_meters double precision NULL CHECK (distance_meters IS NULL OR distance_meters >= 0),
  geofence_status text NOT NULL CHECK (
    geofence_status IN ('inside', 'outside', 'uncertain_accuracy', 'unassigned_location')
  ),
  review_state text NOT NULL CHECK (review_state IN ('accepted', 'needs_review')),
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  photo_byte_length integer NOT NULL CHECK (photo_byte_length BETWEEN 1 AND 5242880),
  encryption_key_id text NOT NULL CHECK (char_length(encryption_key_id) BETWEEN 1 AND 80),
  photo_ciphertext bytea NOT NULL,
  photo_iv bytea NOT NULL,
  photo_auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key)
);
CREATE INDEX attendance_mobile_evidence_employee_created_idx
  ON attendance_mobile_evidence (employee_id, created_at DESC);

CREATE TABLE attendance_clarifications (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('missing_check_in', 'missing_check_out', 'machine_issue', 'lateness', 'early_leave', 'outside_geofence', 'other')
  ),
  mode text NOT NULL CHECK (mode IN ('correction', 'justification')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  proposed_check_in_at timestamptz NULL,
  proposed_check_out_at timestamptz NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled')),
  decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  decision_note text NULL CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    mode <> 'correction'
    OR proposed_check_in_at IS NOT NULL
    OR proposed_check_out_at IS NOT NULL
  ),
  CHECK (
    (status = 'submitted' AND decided_by_account_id IS NULL AND decided_at IS NULL)
    OR status = 'cancelled'
    OR (status IN ('approved', 'rejected') AND decided_by_account_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);
CREATE INDEX attendance_clarifications_employee_date_idx
  ON attendance_clarifications (employee_id, work_date DESC, created_at DESC);
CREATE INDEX attendance_clarifications_status_idx
  ON attendance_clarifications (status, work_date DESC, created_at);

CREATE TABLE attendance_clarification_events (
  id uuid PRIMARY KEY,
  clarification_id uuid NOT NULL REFERENCES attendance_clarifications(id) ON DELETE RESTRICT,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (
    event_type IN ('submitted', 'approved', 'rejected', 'cancelled')
  ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_result_versions (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (
    status IN ('scheduled', 'pending', 'present', 'late', 'incomplete', 'leave', 'absent', 'off', 'configuration_error')
  ),
  schedule_template_id uuid NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  roster_id uuid NULL REFERENCES attendance_rosters(id) ON DELETE RESTRICT,
  scheduled_start_at timestamptz NULL,
  scheduled_end_at timestamptz NULL,
  first_check_in_at timestamptz NULL,
  last_check_out_at timestamptz NULL,
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_leave_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  incomplete_session boolean NOT NULL DEFAULT false,
  justified boolean NOT NULL DEFAULT false,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_clarification_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_leave_request_id uuid NULL REFERENCES leave_requests(id) ON DELETE RESTRICT,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date, version),
  UNIQUE (employee_id, work_date, input_hash)
);
CREATE INDEX attendance_result_versions_employee_date_idx
  ON attendance_result_versions (employee_id, work_date DESC, version DESC);
CREATE INDEX attendance_result_versions_date_status_idx
  ON attendance_result_versions (work_date, status);

CREATE OR REPLACE FUNCTION reject_attendance_engine_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'attendance engine evidence is append-only';
END;
$$;

CREATE TRIGGER attendance_events_immutable
BEFORE UPDATE OR DELETE ON attendance_events
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

CREATE TRIGGER attendance_mobile_evidence_immutable
BEFORE UPDATE OR DELETE ON attendance_mobile_evidence
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

CREATE TRIGGER attendance_clarification_events_immutable
BEFORE UPDATE OR DELETE ON attendance_clarification_events
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

CREATE TRIGGER attendance_result_versions_immutable
BEFORE UPDATE OR DELETE ON attendance_result_versions
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();
