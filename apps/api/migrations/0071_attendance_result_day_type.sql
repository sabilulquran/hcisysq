-- ATT-011-6a (§5.6, §7.5): the kind of day on each attendance result version, so payroll (PAY-003)
-- can tell a working day, a rest day and a public holiday apart, and whether a holiday was scheduled
-- work. Additive and nullable: versions written before this release stay NULL (unknown) and are not
-- backfilled; the next Kalkulasi writes a new version when its inputs change.
-- Rollback: the previous release ignores both columns; they can be dropped once unused:
--   ALTER TABLE attendance_result_versions DROP COLUMN holiday_scheduled_work, DROP COLUMN day_type;
ALTER TABLE attendance_result_versions
  ADD COLUMN IF NOT EXISTS day_type text NULL
    CHECK (day_type IS NULL OR day_type IN ('working_day', 'rest_day', 'public_holiday')),
  ADD COLUMN IF NOT EXISTS holiday_scheduled_work boolean NULL;
