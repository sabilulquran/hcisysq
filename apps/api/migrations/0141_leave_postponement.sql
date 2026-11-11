-- LEAVE-008: a line approver proposes other dates instead of approving or rejecting; the
-- employee accepts (a new replacement request is submitted) or declines.
-- Spec: docs/domain/leave-postponement.md.
--
-- Additive only: two request statuses, one step status, a nullable link column, and a new
-- table. No row is changed and no permission is granted.
--
-- The status CHECKs on leave_requests (0006) and leave_request_approval_steps (0136) are
-- looked up by definition, as 0136 did, and the migration fails loudly if a table does not
-- have exactly one such CHECK.
--
-- Down (normally unnecessary: older code never writes the new values and treats them as
-- "not open"). Only after rewriting the rows that use them, in this order:
--   UPDATE leave_requests SET status = 'cancelled', updated_at = now()
--    WHERE status IN ('postponement_proposed', 'postponed');
--   UPDATE leave_request_approval_steps SET status = 'rejected', acted_at = coalesce(acted_at, now())
--    WHERE status = 'postponed';
--   DROP TABLE leave_postponement_proposals;
--   DROP INDEX leave_requests_replaces_request_idx;
--   ALTER TABLE leave_requests DROP COLUMN replaces_request_id;
--   then restore leave_requests_status_check to
--     CHECK (status IN ('in_review', 'approved', 'rejected', 'cancelled'))
--   and leave_request_approval_steps_status_check to
--     CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')).
-- The rewrite loses the postponement history; take the pre-migration backup instead when the
-- history matters.

DO $$
DECLARE
  target record;
  found_name text;
  found_count integer;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('leave_requests',
       '''in_review''',
       'CHECK (status IN (''in_review'', ''approved'', ''rejected'', ''cancelled'', ''postponement_proposed'', ''postponed''))'),
      ('leave_request_approval_steps',
       '''waiting''',
       'CHECK (status IN (''waiting'', ''pending'', ''approved'', ''rejected'', ''cancelled'', ''postponed''))')
    ) AS t(table_name, marker, definition)
  LOOP
    SELECT min(c.conname), count(*)
      INTO found_name, found_count
      FROM pg_constraint c
     WHERE c.conrelid = target.table_name::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%status%'
       AND pg_get_constraintdef(c.oid) LIKE '%' || target.marker || '%';
    IF found_count <> 1 THEN
      RAISE EXCEPTION 'LEAVE-008: expected one status CHECK on %, found %', target.table_name, found_count;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.table_name, found_name);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s',
      target.table_name, target.table_name || '_status_check', target.definition);
  END LOOP;
END
$$;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS replaces_request_id uuid NULL REFERENCES leave_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS leave_requests_replaces_request_idx
  ON leave_requests (replaces_request_id)
  WHERE replaces_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS leave_postponement_proposals (
  id uuid PRIMARY KEY,
  leave_request_id uuid NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  approval_step_id uuid NOT NULL UNIQUE REFERENCES leave_request_approval_steps(id) ON DELETE CASCADE,
  proposed_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  proposed_by_employee_id uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  proposed_start_on date NOT NULL,
  proposed_end_on date NOT NULL,
  proposed_working_days integer NOT NULL CHECK (proposed_working_days > 0),
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'declined')),
  response_note text NULL CHECK (response_note IS NULL OR char_length(response_note) <= 500),
  responded_at timestamptz NULL,
  replacement_request_id uuid NULL UNIQUE REFERENCES leave_requests(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (proposed_end_on >= proposed_start_on),
  CHECK ((status = 'proposed') = (responded_at IS NULL)),
  CHECK ((status = 'accepted') = (replacement_request_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS leave_postponement_one_open_idx
  ON leave_postponement_proposals (leave_request_id)
  WHERE status = 'proposed';

CREATE INDEX IF NOT EXISTS leave_postponement_request_idx
  ON leave_postponement_proposals (leave_request_id, created_at DESC);
