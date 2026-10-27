-- ORG-005-2 (DRAFT, docs/domain/organization-sites-work-locations.md D-5-4): which work location an
-- attendance machine stands at.
--
-- Machines carry a free-text worksite_label today, which is connected to nothing. This links each
-- machine to the organisation's single list of places (attendance_work_locations, D-5-1). The old
-- label is kept as a historical note; nothing is inferred from it and nothing is seeded.
--
-- ON DELETE RESTRICT: locations are deactivated, never deleted, and a location still in use by an
-- active machine cannot be deactivated (D-5-7, enforced by the route).
--
-- Numbered 0090 to stay clear of the ranges other packages are using (attendance 0073-0079,
-- payroll 0080+); gaps in the sequence are allowed by migrations:check.
--
-- Rollback/recovery:
--   ALTER TABLE attendance_adms_devices DROP COLUMN work_location_id;
--   Devices, punches, mappings and attendance results are untouched; only the link goes. An older
--   release ignores the column.
--
-- Idempotent: rerunning changes nothing further.

ALTER TABLE attendance_adms_devices
  ADD COLUMN IF NOT EXISTS work_location_id uuid NULL
  REFERENCES attendance_work_locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS attendance_adms_devices_work_location_idx
  ON attendance_adms_devices (work_location_id)
  WHERE work_location_id IS NOT NULL;
