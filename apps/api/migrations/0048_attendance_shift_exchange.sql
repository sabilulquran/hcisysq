-- ATT-008 Shift Exchange Workflow
-- Same-date, same-unit employee shift exchange with counterpart consent and HC approval.

INSERT INTO permissions (permission_key, description)
VALUES (
  'attendance.shift_swap.manage',
  'ATT-008: review and decide employee shift exchange requests'
)
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'attendance.shift_swap.manage'
FROM roles role
WHERE role.role_key IN ('human_capital_admin', 'human_capital')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS attendance_shift_swap_requests (
  id uuid PRIMARY KEY,
  requester_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  counterpart_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,

  requester_schedule_template_id uuid NOT NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  requester_schedule_version_id uuid NOT NULL REFERENCES attendance_schedule_versions(id) ON DELETE RESTRICT,
  requester_roster_id uuid NULL REFERENCES attendance_rosters(id) ON DELETE RESTRICT,
  requester_scheduled_start_at timestamptz NOT NULL,
  requester_scheduled_end_at timestamptz NOT NULL,

  counterpart_schedule_template_id uuid NOT NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  counterpart_schedule_version_id uuid NOT NULL REFERENCES attendance_schedule_versions(id) ON DELETE RESTRICT,
  counterpart_roster_id uuid NULL REFERENCES attendance_rosters(id) ON DELETE RESTRICT,
  counterpart_scheduled_start_at timestamptz NOT NULL,
  counterpart_scheduled_end_at timestamptz NOT NULL,

  note text NULL CHECK (note IS NULL OR char_length(note) <= 2000),
  status text NOT NULL DEFAULT 'awaiting_counterpart'
    CHECK (status IN (
      'awaiting_counterpart',
      'awaiting_hc',
      'approved',
      'rejected_by_counterpart',
      'rejected_by_hc',
      'cancelled'
    )),

  counterpart_decision text NULL CHECK (counterpart_decision IN ('accepted', 'rejected')),
  counterpart_decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  counterpart_decision_note text NULL CHECK (
    counterpart_decision_note IS NULL OR char_length(counterpart_decision_note) <= 2000
  ),
  counterpart_decided_at timestamptz NULL,

  hc_decision text NULL CHECK (hc_decision IN ('approved', 'rejected')),
  hc_decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  hc_decision_note text NULL CHECK (
    hc_decision_note IS NULL OR char_length(hc_decision_note) <= 2000
  ),
  hc_decided_at timestamptz NULL,

  published_roster_id uuid NULL REFERENCES attendance_rosters(id) ON DELETE RESTRICT,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (requester_employee_id <> counterpart_employee_id),
  CHECK (requester_schedule_version_id <> counterpart_schedule_version_id),
  CHECK (
    (status = 'awaiting_counterpart'
      AND counterpart_decision IS NULL
      AND counterpart_decided_by_account_id IS NULL
      AND counterpart_decided_at IS NULL
      AND hc_decision IS NULL
      AND hc_decided_by_account_id IS NULL
      AND hc_decided_at IS NULL
      AND published_roster_id IS NULL)
    OR
    (status = 'awaiting_hc'
      AND counterpart_decision = 'accepted'
      AND counterpart_decided_by_account_id IS NOT NULL
      AND counterpart_decided_at IS NOT NULL
      AND hc_decision IS NULL
      AND hc_decided_by_account_id IS NULL
      AND hc_decided_at IS NULL
      AND published_roster_id IS NULL)
    OR
    (status = 'rejected_by_counterpart'
      AND counterpart_decision = 'rejected'
      AND counterpart_decided_by_account_id IS NOT NULL
      AND counterpart_decided_at IS NOT NULL
      AND hc_decision IS NULL
      AND hc_decided_by_account_id IS NULL
      AND hc_decided_at IS NULL
      AND published_roster_id IS NULL)
    OR
    (status = 'approved'
      AND counterpart_decision = 'accepted'
      AND counterpart_decided_by_account_id IS NOT NULL
      AND counterpart_decided_at IS NOT NULL
      AND hc_decision = 'approved'
      AND hc_decided_by_account_id IS NOT NULL
      AND hc_decided_at IS NOT NULL
      AND published_roster_id IS NOT NULL)
    OR
    (status = 'rejected_by_hc'
      AND counterpart_decision = 'accepted'
      AND counterpart_decided_by_account_id IS NOT NULL
      AND counterpart_decided_at IS NOT NULL
      AND hc_decision = 'rejected'
      AND hc_decided_by_account_id IS NOT NULL
      AND hc_decided_at IS NOT NULL
      AND published_roster_id IS NULL)
    OR
    (status = 'cancelled'
      AND hc_decision IS NULL
      AND hc_decided_by_account_id IS NULL
      AND hc_decided_at IS NULL
      AND published_roster_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS attendance_shift_swap_requester_idx
  ON attendance_shift_swap_requests (requester_employee_id, work_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_shift_swap_counterpart_idx
  ON attendance_shift_swap_requests (counterpart_employee_id, work_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_shift_swap_status_idx
  ON attendance_shift_swap_requests (status, work_date, created_at);

CREATE TABLE IF NOT EXISTS attendance_shift_swap_events (
  id uuid PRIMARY KEY,
  shift_swap_request_id uuid NOT NULL
    REFERENCES attendance_shift_swap_requests(id) ON DELETE RESTRICT,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'submitted',
    'counterpart_accepted',
    'counterpart_rejected',
    'hc_approved',
    'hc_rejected',
    'cancelled'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_shift_swap_events_request_idx
  ON attendance_shift_swap_events (shift_swap_request_id, created_at);

DROP TRIGGER IF EXISTS attendance_shift_swap_events_immutable ON attendance_shift_swap_events;
CREATE TRIGGER attendance_shift_swap_events_immutable
BEFORE UPDATE OR DELETE ON attendance_shift_swap_events
FOR EACH ROW EXECUTE FUNCTION reject_attendance_engine_fact_mutation();

COMMENT ON TABLE attendance_shift_swap_requests IS
  'ATT-008 same-date shift exchange snapshot. Counterpart consent precedes HC approval; approved requests publish a new roster version.';
COMMENT ON TABLE attendance_shift_swap_events IS
  'ATT-008 append-only audit lifecycle for shift exchange.';
