-- ATT-014-2 (owner decisions D-14-1 … D-14-4, 2026-10-24): attendance is calculated when an operator
-- presses Kalkulasi for a scope and date range, not automatically. docs/domain/attendance-report-calculation.md §6.2, §9.
--
-- 1. Permission attendance.calculation.run for human_capital_admin and human_capital (D-14-1). It is
--    separate from attendance.reports.read because a calculation writes result versions and uses
--    server time on Mi8VPS.
-- 2. attendance_calculation_runs: one row per Kalkulasi request. At most one run is 'running' across
--    the server; others wait as 'queued'. A run covers at most 93 days (D-14-2).
--
-- Additive only: no existing table, row or permission changes. Result versions written by a run are
-- produced by the unchanged ATT-007 engine and stay valid in any release.
-- Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   An older release ignores the table and the permission. To remove them:
--     DELETE FROM role_permissions WHERE permission_key = 'attendance.calculation.run';
--     DELETE FROM permissions WHERE permission_key = 'attendance.calculation.run';
--     DROP TABLE attendance_calculation_runs;
--   The table holds run history only; dropping it loses no attendance data.

INSERT INTO permissions (permission_key, description) VALUES
  ('attendance.calculation.run', 'ATT-014: menjalankan Kalkulasi kehadiran untuk lingkup dan rentang tanggal')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'attendance.calculation.run'
FROM roles role
WHERE role.role_key IN ('human_capital_admin', 'human_capital')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS attendance_calculation_runs (
  id uuid PRIMARY KEY,
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  unit_id uuid NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
  employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_pairs integer NOT NULL DEFAULT 0 CHECK (total_pairs >= 0),
  processed_pairs integer NOT NULL DEFAULT 0 CHECK (processed_pairs >= 0),
  failed_pairs integer NOT NULL DEFAULT 0 CHECK (failed_pairs >= 0),
  uncovered_pairs integer NOT NULL DEFAULT 0 CHECK (uncovered_pairs >= 0),
  cancel_requested_at timestamptz NULL,
  error_code text NULL CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  CHECK (date_to >= date_from AND date_to - date_from <= 92)
);

-- One running calculation across the server protects Mi8VPS.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_calculation_runs_one_running
  ON attendance_calculation_runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS attendance_calculation_runs_queue_idx
  ON attendance_calculation_runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS attendance_calculation_runs_recent_idx
  ON attendance_calculation_runs (created_at DESC);
