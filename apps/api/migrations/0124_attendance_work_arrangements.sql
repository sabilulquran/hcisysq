-- ATT-015 Package 1: tugas luar, WFH/WFA and schedule change requests, APR-001 snapshot, history.
-- Spec: docs/domain/attendance-remote-and-schedule-requests.md §10.
--
-- Nothing here writes attendance_events: an approved arrangement is a disposition that explains a
-- missing punch, never a punch (spec §1.1). The two new result statuses are written by the engine.
--
-- Down:
--   ALTER TABLE attendance_result_versions DROP COLUMN IF EXISTS source_work_arrangement_id;
--   DROP TABLE IF EXISTS attendance_work_arrangement_events;
--   DROP TABLE IF EXISTS attendance_work_arrangement_approval_steps;
--   DROP TABLE IF EXISTS attendance_work_arrangement_requests;
--   -- Only when no result version carries a new status (otherwise keep the wider check and roll
--   -- back code only; the old build reads an unknown status as "·"):
--   ALTER TABLE attendance_result_versions DROP CONSTRAINT attendance_result_versions_status_check;
--   ALTER TABLE attendance_result_versions ADD CONSTRAINT attendance_result_versions_status_check
--     CHECK (status IN ('scheduled', 'pending', 'present', 'late', 'incomplete', 'leave', 'absent', 'off', 'configuration_error'));

-- The migrator runs this file in one transaction, so the DROP holds ACCESS EXCLUSIVE until COMMIT either
-- way; the table is small (one row per employee-day version), and the scan takes well under a second.
ALTER TABLE attendance_result_versions DROP CONSTRAINT IF EXISTS attendance_result_versions_status_check;
ALTER TABLE attendance_result_versions ADD CONSTRAINT attendance_result_versions_status_check
  CHECK (status IN (
    'scheduled', 'pending', 'present', 'late', 'incomplete', 'leave', 'absent', 'off', 'configuration_error',
    'field_assignment', 'remote_work'
  ));

CREATE TABLE IF NOT EXISTS attendance_work_arrangement_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  arrangement_type text NOT NULL CHECK (arrangement_type IN ('FIELD_ASSIGNMENT', 'REMOTE_WORK', 'SCHEDULE_CHANGE')),
  start_on date NOT NULL,
  end_on date NOT NULL,
  location text NULL CHECK (location IS NULL OR char_length(location) BETWEEN 3 AND 200),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 1000),
  status text NOT NULL CHECK (status IN ('IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED')),
  idempotency_key uuid NOT NULL,
  -- APR-001: the resolved chain and the rollout context that explains it.
  approval_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- SCHEDULE_CHANGE (D-09): the shift asked for and the schedule it replaces, as resolved at submission.
  requested_schedule_template_id uuid NULL REFERENCES attendance_schedule_templates(id),
  requested_schedule_version_id uuid NULL REFERENCES attendance_schedule_versions(id),
  schedule_snapshot jsonb NULL,
  applied_roster_id uuid NULL REFERENCES attendance_rosters(id),
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 5 AND 500),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  final_decided_at timestamptz NULL,
  applied_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key),
  CHECK (end_on >= start_on),
  -- D-04: at most 7 calendar days, inclusive.
  CHECK (end_on - start_on <= 6),
  -- D-02, D-09: one day for WFH/WFA and for a schedule change.
  CHECK (arrangement_type = 'FIELD_ASSIGNMENT' OR start_on = end_on),
  CHECK (
    (arrangement_type = 'SCHEDULE_CHANGE'
      AND location IS NULL
      AND requested_schedule_template_id IS NOT NULL
      AND requested_schedule_version_id IS NOT NULL
      AND schedule_snapshot IS NOT NULL)
    OR (arrangement_type <> 'SCHEDULE_CHANGE'
      AND location IS NOT NULL
      AND requested_schedule_template_id IS NULL
      AND requested_schedule_version_id IS NULL
      AND schedule_snapshot IS NULL)
  ),
  CHECK (status <> 'APPLIED' OR (arrangement_type = 'SCHEDULE_CHANGE' AND applied_roster_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS attendance_work_arrangement_requests_employee_idx
  ON attendance_work_arrangement_requests (employee_id, start_on DESC);
CREATE INDEX IF NOT EXISTS attendance_work_arrangement_requests_status_idx
  ON attendance_work_arrangement_requests (status, submitted_at DESC);
-- The engine reads approved tugas luar/WFH per employee and date.
CREATE INDEX IF NOT EXISTS attendance_work_arrangement_requests_effective_idx
  ON attendance_work_arrangement_requests (employee_id, start_on, end_on)
  WHERE status = 'APPROVED' AND arrangement_type IN ('FIELD_ASSIGNMENT', 'REMOTE_WORK');

CREATE TABLE IF NOT EXISTS attendance_work_arrangement_approval_steps (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES attendance_work_arrangement_requests(id),
  step_order integer NOT NULL CHECK (step_order >= 1),
  approver_employee_id uuid NOT NULL REFERENCES employees(id),
  sources text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_by_account_id uuid NULL REFERENCES accounts(id),
  acted_at timestamptz NULL,
  decision_note text NULL,
  UNIQUE (request_id, step_order)
);

-- APR-001-G: one active step per request, so two decisions cannot both advance it.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_work_arrangement_steps_one_pending_idx
  ON attendance_work_arrangement_approval_steps (request_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS attendance_work_arrangement_steps_inbox_idx
  ON attendance_work_arrangement_approval_steps (approver_employee_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS attendance_work_arrangement_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES attendance_work_arrangement_requests(id),
  event_type text NOT NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_work_arrangement_events_request_idx
  ON attendance_work_arrangement_events (request_id, occurred_at ASC);

ALTER TABLE attendance_result_versions
  ADD COLUMN IF NOT EXISTS source_work_arrangement_id uuid NULL
    REFERENCES attendance_work_arrangement_requests(id) ON DELETE RESTRICT;
