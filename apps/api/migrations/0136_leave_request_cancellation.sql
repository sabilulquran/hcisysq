-- LEAVE-010: an employee may cancel their own line-approval leave while it is still in_review.
-- Spec: docs/domain/workflows/leave-request.md "LEAVE-010".
--
-- leave_requests already allows 'cancelled' (0006). This migration only lets the open parts of
-- a cancelled request say so: line approval steps, the HC task, and the LEAVE-009 critical
-- review gain the status 'cancelled'. No row is changed, no permission is granted.
--
-- The column CHECKs were declared inline, so PostgreSQL named them <table>_status_check. They
-- are looked up by definition rather than by name, and the migration fails loudly if a table
-- does not have exactly one such CHECK, instead of leaving an old CHECK that would still
-- refuse 'cancelled'.
--
-- Down (only after every 'cancelled' step, task and review is gone or rewritten; older code
-- never writes the value and reads it as "not open"):
--   UPDATE leave_request_approval_steps SET status = 'rejected' WHERE status = 'cancelled';  -- review first
--   ALTER TABLE leave_request_approval_steps DROP CONSTRAINT leave_request_approval_steps_status_check,
--     ADD CONSTRAINT leave_request_approval_steps_status_check
--       CHECK (status IN ('waiting', 'pending', 'approved', 'rejected'));
--   (same for leave_request_hc_tasks and leave_request_critical_reviews with their 0007/0128 lists)

DO $$
DECLARE
  target record;
  found_name text;
  found_count integer;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('leave_request_approval_steps',
       'CHECK (status IN (''waiting'', ''pending'', ''approved'', ''rejected'', ''cancelled''))'),
      ('leave_request_hc_tasks',
       'CHECK (status IN (''waiting'', ''pending'', ''needs_correction'', ''validated'', ''approved'', ''rejected'', ''cancelled''))'),
      ('leave_request_critical_reviews',
       'CHECK (status IN (''waiting'', ''pending'', ''approved'', ''rejected'', ''cancelled''))')
    ) AS t(table_name, definition)
  LOOP
    -- The status list CHECK: mentions status and 'pending', but not acted_at (0128 also has
    -- a table CHECK tying approved/rejected to acted_at, which stays untouched).
    SELECT min(c.conname), count(*)
      INTO found_name, found_count
      FROM pg_constraint c
     WHERE c.conrelid = target.table_name::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%status%'
       AND pg_get_constraintdef(c.oid) LIKE '%''pending''%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%acted_at%';
    IF found_count <> 1 THEN
      RAISE EXCEPTION 'LEAVE-010: expected one status CHECK on %, found %', target.table_name, found_count;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.table_name, found_name);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s',
      target.table_name, target.table_name || '_status_check', target.definition);
  END LOOP;
END
$$;
