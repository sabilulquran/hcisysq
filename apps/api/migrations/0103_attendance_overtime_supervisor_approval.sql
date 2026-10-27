-- ATT-011-6b-1 §7.2/§7.3 overtime approval by the direct supervisor (D-5, D-5a).
-- A request records who started it and, snapshotted at submit, the supervisor who must decide (flow A,
-- employee or HC on the employee's behalf) or who gave the order the employee must agree to (flow B).
-- The status values stay submitted | approved | rejected | cancelled so older reports keep reading.
-- Requests from before this migration are 'hc_legacy' and are still decided by HC (no chain rewrite).
-- Additive. Rollback (once no row uses the new values):
--   ALTER TABLE attendance_overtime_events DROP CONSTRAINT attendance_overtime_events_event_type_check;
--   ALTER TABLE attendance_overtime_events ADD CONSTRAINT attendance_overtime_events_event_type_check
--     CHECK (event_type IN ('submitted', 'approved', 'rejected', 'cancelled'));
--   DROP INDEX attendance_overtime_requests_supervisor_idx;
--   ALTER TABLE attendance_overtime_requests DROP CONSTRAINT attendance_overtime_requests_supervisor_required;
--   ALTER TABLE attendance_overtime_requests DROP COLUMN approver_snapshot, DROP COLUMN supervisor_employee_id,
--     DROP COLUMN initiated_by;
ALTER TABLE attendance_overtime_requests
  ADD COLUMN IF NOT EXISTS initiated_by text NOT NULL DEFAULT 'hc_legacy'
    CHECK (initiated_by IN ('employee', 'supervisor', 'hc_legacy')),
  ADD COLUMN IF NOT EXISTS supervisor_employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approver_snapshot jsonb NULL;

ALTER TABLE attendance_overtime_requests
  DROP CONSTRAINT IF EXISTS attendance_overtime_requests_supervisor_required;
ALTER TABLE attendance_overtime_requests
  ADD CONSTRAINT attendance_overtime_requests_supervisor_required
  CHECK (initiated_by = 'hc_legacy' OR (supervisor_employee_id IS NOT NULL AND supervisor_employee_id <> employee_id));

CREATE INDEX IF NOT EXISTS attendance_overtime_requests_supervisor_idx
  ON attendance_overtime_requests (supervisor_employee_id, status, work_date DESC)
  WHERE supervisor_employee_id IS NOT NULL;

ALTER TABLE attendance_overtime_events
  DROP CONSTRAINT IF EXISTS attendance_overtime_events_event_type_check;
ALTER TABLE attendance_overtime_events
  ADD CONSTRAINT attendance_overtime_events_event_type_check CHECK (event_type IN (
    'submitted', 'approved', 'rejected', 'cancelled',
    'ordered', 'employee_agreed', 'employee_declined', 'admin_voided', 'reassigned'
  ));
