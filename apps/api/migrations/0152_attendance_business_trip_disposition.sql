-- TRIP-001 Package 2: an issued business trip is an attendance disposition.
-- Spec: docs/domain/business-travel.md §9.2, docs/domain/attendance-report-calculation.md.
--
-- Nothing here writes attendance_events: a trip explains a missing punch, never becomes one
-- (anti-copy guardrail). The new result status is written by the engine; the new column names
-- the trip that decided the day, the same way source_work_arrangement_id does for ATT-015.
--
-- Down:
--   ALTER TABLE attendance_result_versions DROP COLUMN IF EXISTS source_business_trip_id;
--   -- Only when no result version carries the new status (otherwise keep the wider check and roll
--   -- back code only; the old build reads an unknown status as "·"):
--   ALTER TABLE attendance_result_versions DROP CONSTRAINT attendance_result_versions_status_check;
--   ALTER TABLE attendance_result_versions ADD CONSTRAINT attendance_result_versions_status_check
--     CHECK (status IN ('scheduled', 'pending', 'present', 'late', 'incomplete', 'leave', 'absent', 'off',
--       'configuration_error', 'field_assignment', 'remote_work'));

-- The migrator runs this file in one transaction, so the DROP holds ACCESS EXCLUSIVE until COMMIT; the
-- table is small (one row per employee-day version) and the re-check scan takes well under a second.
ALTER TABLE attendance_result_versions DROP CONSTRAINT IF EXISTS attendance_result_versions_status_check;
ALTER TABLE attendance_result_versions ADD CONSTRAINT attendance_result_versions_status_check
  CHECK (status IN (
    'scheduled', 'pending', 'present', 'late', 'incomplete', 'leave', 'absent', 'off', 'configuration_error',
    'field_assignment', 'remote_work', 'business_trip'
  ));

ALTER TABLE attendance_result_versions
  ADD COLUMN IF NOT EXISTS source_business_trip_id uuid NULL REFERENCES business_trip_requests(id);

-- Payroll (PAY-003) and the exceptions tab look a trip's days up by the trip; most rows carry NULL.
CREATE INDEX IF NOT EXISTS attendance_result_versions_business_trip_idx
  ON attendance_result_versions (source_business_trip_id)
  WHERE source_business_trip_id IS NOT NULL;
