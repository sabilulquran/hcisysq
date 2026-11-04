-- OPS-CLEANUP-2026-11-04 (legacy cleanup, stage 1): drop attendance_daily_audit_events.
--
-- 0010 created this table for manual daily-attendance edits. Nothing in apps/api/src reads or
-- writes it any more: manual changes are recorded as canonical attendance events and clarifications,
-- and test/attendance-routes-regression.test.ts asserts that the manual-record route never touches it.
-- Production held 0 rows on 2026-11-04 (read-only check). Nothing references it: no foreign key,
-- view or trigger points at the table; it only points at employees and accounts.
--
-- Guard: the drop refuses to run if any row exists, so a database that did record events keeps
-- them and the migration fails loudly instead of discarding history.
--
-- Down (recreates the empty table exactly as 0010 defined it; there is no data to restore):
--   CREATE TABLE IF NOT EXISTS attendance_daily_audit_events (
--     id uuid PRIMARY KEY,
--     employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
--     attendance_date date NOT NULL,
--     actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
--     action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
--     before_record jsonb NULL,
--     after_record jsonb NULL,
--     created_at timestamptz NOT NULL DEFAULT now()
--   );
--   CREATE INDEX IF NOT EXISTS attendance_daily_audit_events_employee_idx
--     ON attendance_daily_audit_events (employee_id, attendance_date DESC, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.attendance_daily_audit_events') IS NOT NULL THEN
    -- Nested so the row check is only planned when the table exists.
    IF EXISTS (SELECT 1 FROM attendance_daily_audit_events) THEN
      RAISE EXCEPTION 'attendance_daily_audit_events is not empty; refusing to drop it';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS attendance_daily_audit_events;
