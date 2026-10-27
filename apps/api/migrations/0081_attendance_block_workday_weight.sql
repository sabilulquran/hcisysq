-- ATT-013 D-13-6/D-13-7 (docs/domain/attendance-multi-block-schedule.md §4, §5.3): "Hitungan hari" per
-- block. Block 1 lives on attendance_schedule_versions, so it gets its own nullable weight; blocks 2-3
-- get theirs on the block rows. A single-block version keeps NULL (= 1,00). The API keeps the sum at 1,00.
-- Result blocks record the expected (Normal) and credited (Riil, NULL while unknown) day share.
-- Additive: the previous release never reads these columns. Rollback (once unused):
--   ALTER TABLE attendance_result_blocks DROP COLUMN credited_workday, DROP COLUMN expected_workday;
--   ALTER TABLE attendance_schedule_version_blocks DROP COLUMN workday_weight;
--   ALTER TABLE attendance_schedule_versions DROP COLUMN first_block_workday_weight;
ALTER TABLE attendance_schedule_versions
  ADD COLUMN IF NOT EXISTS first_block_workday_weight numeric(3,2) NULL
    CHECK (first_block_workday_weight IS NULL OR (first_block_workday_weight > 0 AND first_block_workday_weight <= 1));

ALTER TABLE attendance_schedule_version_blocks
  ADD COLUMN IF NOT EXISTS workday_weight numeric(3,2) NULL
    CHECK (workday_weight IS NULL OR (workday_weight > 0 AND workday_weight <= 1));

ALTER TABLE attendance_result_blocks
  ADD COLUMN IF NOT EXISTS expected_workday numeric(3,2) NULL,
  ADD COLUMN IF NOT EXISTS credited_workday numeric(3,2) NULL;
