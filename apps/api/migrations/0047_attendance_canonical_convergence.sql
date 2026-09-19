-- ATT-008 Canonical Attendance Convergence
-- Non-destructive extension of ATT-007. Legacy ATT-001 storage remains for compatibility.

INSERT INTO permissions (permission_key, description) VALUES
  ('attendance.overtime.manage', 'ATT-008: review and decide explicit attendance overtime requests')
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'attendance.overtime.manage'
FROM roles role
WHERE role.role_key IN ('human_capital_admin', 'human_capital')
ON CONFLICT DO NOTHING;

ALTER TABLE attendance_schedule_templates
  ADD COLUMN IF NOT EXISTS end_day_offset integer NOT NULL DEFAULT 0
    CHECK (end_day_offset BETWEEN 0 AND 1);

UPDATE attendance_schedule_templates
SET end_day_offset = 1
WHERE end_time <= start_time
  AND end_day_offset = 0;

CREATE TABLE IF NOT EXISTS attendance_schedule_versions (
  id uuid PRIMARY KEY,
  schedule_template_id uuid NOT NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset integer NOT NULL CHECK (end_day_offset BETWEEN 0 AND 1),
  late_grace_minutes integer NOT NULL DEFAULT 0 CHECK (late_grace_minutes BETWEEN 0 AND 240),
  early_leave_tolerance_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_tolerance_minutes BETWEEN 0 AND 240),
  work_location_id uuid NULL REFERENCES attendance_work_locations(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_template_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_schedule_versions_one_current_idx
  ON attendance_schedule_versions (schedule_template_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS attendance_schedule_versions_effective_idx
  ON attendance_schedule_versions (schedule_template_id, effective_from DESC, effective_to);

INSERT INTO attendance_schedule_versions (
  id, schedule_template_id, version, name, start_time, end_time, end_day_offset,
  late_grace_minutes, early_leave_tolerance_minutes, work_location_id,
  effective_from, created_by_account_id
)
SELECT
  gen_random_uuid(), schedule.id, 1, schedule.name, schedule.start_time, schedule.end_time,
  schedule.end_day_offset, schedule.late_grace_minutes, schedule.early_leave_tolerance_minutes,
  schedule.work_location_id, schedule.created_at, schedule.created_by_account_id
FROM attendance_schedule_templates schedule
WHERE NOT EXISTS (
  SELECT 1 FROM attendance_schedule_versions version
  WHERE version.schedule_template_id = schedule.id
);

ALTER TABLE attendance_roster_entries
  ADD COLUMN IF NOT EXISTS schedule_version_id uuid NULL
    REFERENCES attendance_schedule_versions(id) ON DELETE RESTRICT;

UPDATE attendance_roster_entries entry
SET schedule_version_id = version.id
FROM LATERAL (
  SELECT candidate.id
  FROM attendance_schedule_versions candidate
  WHERE candidate.schedule_template_id = entry.schedule_template_id
  ORDER BY candidate.version DESC
  LIMIT 1
) version
WHERE entry.schedule_template_id IS NOT NULL
  AND entry.schedule_version_id IS NULL;

ALTER TABLE attendance_result_versions
  ADD COLUMN IF NOT EXISTS schedule_version_id uuid NULL
    REFERENCES attendance_schedule_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS late_justified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS early_leave_justified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outside_geofence_justified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overtime_minutes integer NOT NULL DEFAULT 0
    CHECK (overtime_minutes >= 0),
  ADD COLUMN IF NOT EXISTS source_attendance_resolution_case_id uuid NULL
    REFERENCES attendance_resolution_cases(id) ON DELETE RESTRICT;

UPDATE attendance_result_versions result
SET schedule_version_id = version.id
FROM LATERAL (
  SELECT candidate.id
  FROM attendance_schedule_versions candidate
  WHERE candidate.schedule_template_id = result.schedule_template_id
    AND candidate.effective_from <= coalesce(result.scheduled_start_at, result.created_at)
    AND (candidate.effective_to IS NULL OR candidate.effective_to > coalesce(result.scheduled_start_at, result.created_at))
  ORDER BY candidate.version DESC
  LIMIT 1
) version
WHERE result.schedule_template_id IS NOT NULL
  AND result.schedule_version_id IS NULL;

CREATE TABLE IF NOT EXISTS attendance_result_sessions (
  id uuid PRIMARY KEY,
  attendance_result_version_id uuid NOT NULL REFERENCES attendance_result_versions(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  check_in_at timestamptz NOT NULL,
  check_out_at timestamptz NULL,
  worked_minutes integer NULL CHECK (worked_minutes IS NULL OR worked_minutes >= 0),
  complete boolean NOT NULL,
  source_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attendance_result_version_id, sequence)
);

CREATE INDEX IF NOT EXISTS attendance_result_sessions_employee_date_idx
  ON attendance_result_sessions (employee_id, work_date DESC, sequence);

DROP TRIGGER IF EXISTS attendance_result_sessions_immutable ON attendance_result_sessions;
CREATE TRIGGER attendance_result_sessions_immutable
BEFORE UPDATE OR DELETE ON attendance_result_sessions
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

CREATE TABLE IF NOT EXISTS attendance_overtime_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  requested_minutes integer NOT NULL CHECK (requested_minutes BETWEEN 1 AND 1440),
  approved_minutes integer NULL CHECK (approved_minutes IS NULL OR approved_minutes BETWEEN 0 AND 1440),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 2000),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled')),
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  decision_note text NULL CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_minutes IS NULL OR approved_minutes <= requested_minutes),
  CHECK (
    status = 'submitted'
    OR status = 'cancelled'
    OR (status IN ('approved', 'rejected') AND decided_by_account_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS attendance_overtime_requests_employee_date_idx
  ON attendance_overtime_requests (employee_id, work_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_overtime_requests_status_idx
  ON attendance_overtime_requests (status, work_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_overtime_events (
  id uuid PRIMARY KEY,
  overtime_request_id uuid NOT NULL REFERENCES attendance_overtime_requests(id) ON DELETE RESTRICT,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('submitted', 'approved', 'rejected', 'cancelled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS attendance_overtime_events_immutable ON attendance_overtime_events;
CREATE TRIGGER attendance_overtime_events_immutable
BEFORE UPDATE OR DELETE ON attendance_overtime_events
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS manual_actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS manual_reason text NULL CHECK (
    manual_reason IS NULL OR char_length(btrim(manual_reason)) BETWEEN 3 AND 1000
  );

COMMENT ON TABLE attendance_schedule_versions IS
  'ATT-008 immutable/effective-dated schedule meaning. Published rosters pin a concrete version.';
COMMENT ON TABLE attendance_result_sessions IS
  'ATT-008 immutable sessions owned by one attendance result version.';
COMMENT ON TABLE attendance_overtime_requests IS
  'ATT-008 explicit overtime workflow. Approved minutes are policy input; late checkout alone is not overtime.';
