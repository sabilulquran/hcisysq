-- LEAVE-003 R2: the Cuti Tahunan usage limit moves from 3 working days per three-month period to
-- 6 working days per calendar semester (Januari-Juni, Juli-Desember). The annual right stays 12
-- working days. Spec: docs/domain/leave-policy-ysq.md §"LEAVE-003 R2".
--
-- Additive and data-free. Nothing is rewritten: a request recorded under the old rule keeps its
-- quarter key (JAN_MAR/APR_JUN/JUL_SEP/OCT_DEC) and stays readable exactly as it is, including the
-- requests still waiting for a decision. Only the set of keys a NEW row may carry widens, so the
-- running release — which never writes a semester key — runs unchanged on this constraint.
--
-- Usage is read from `start_on`, not from this column, and a quarter never straddles a semester, so
-- a semester's usage is the sum of its two quarters and no working day is counted twice.
--
-- Rollback: re-add the 0006 list once no row carries a semester key.
--   UPDATE: none needed. DELETE: none needed.
--   ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_annual_period_key_check;
--   ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_annual_period_key_check
--     CHECK (annual_period_key IS NULL
--            OR annual_period_key IN ('JAN_MAR', 'APR_JUN', 'JUL_SEP', 'OCT_DEC'));
--   Rows written under the semester rule would fail that constraint, so before rolling back check
--   that none exists:
--     SELECT count(*) FROM leave_requests WHERE annual_period_key IN ('JAN_JUN', 'JUL_DEC');

ALTER TABLE leave_requests
  DROP CONSTRAINT IF EXISTS leave_requests_annual_period_key_check;
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_annual_period_key_check
    CHECK (
      annual_period_key IS NULL
      OR annual_period_key IN (
        -- Kept forever: the rule in force until the semester scheme starts, and the history it wrote.
        'JAN_MAR', 'APR_JUN', 'JUL_SEP', 'OCT_DEC',
        -- LEAVE-003 R2.
        'JAN_JUN', 'JUL_DEC'
      )
    );

-- The quota is now read by date range rather than by key, so give that read its own index. The 0006
-- index stays: it still serves lookups that filter on a stored key.
CREATE INDEX IF NOT EXISTS leave_requests_annual_usage_by_date_idx
  ON leave_requests (employee_id, start_on)
  WHERE policy_key = 'annual' AND status IN ('in_review', 'approved');
