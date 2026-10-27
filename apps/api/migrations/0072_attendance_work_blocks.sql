-- ATT-013 (docs/domain/attendance-work-blocks.md): a shift may have up to three work blocks per day.
-- Block 1 stays in attendance_schedule_versions.start_time/end_time; blocks 2-3 are rows here. A version
-- without rows is a single-block shift, so every existing shift keeps its meaning.
-- Additive: the previous release never reads these tables. Rollback (once unused):
--   DROP TABLE attendance_result_blocks; DROP TABLE attendance_schedule_version_blocks;
CREATE TABLE IF NOT EXISTS attendance_schedule_version_blocks (
  id uuid PRIMARY KEY,
  schedule_version_id uuid NOT NULL REFERENCES attendance_schedule_versions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence BETWEEN 2 AND 3),
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_version_id, sequence),
  CHECK (end_time > start_time)
);

-- One row per block of a multi-block day; single-block days write none.
CREATE TABLE IF NOT EXISTS attendance_result_blocks (
  id uuid PRIMARY KEY,
  attendance_result_version_id uuid NOT NULL REFERENCES attendance_result_versions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  first_check_in_at timestamptz NULL,
  last_check_out_at timestamptz NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'pending', 'present', 'late', 'incomplete', 'absent')),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_leave_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  UNIQUE (attendance_result_version_id, sequence)
);
