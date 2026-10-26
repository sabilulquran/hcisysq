-- PAY-003 v1: the payroll period transition log.
-- Specification: docs/domain/payroll-calculation-v1.md section 6
--
-- Section 6 makes a reason mandatory for returning a period, requesting a reopen
-- and rejecting one. The reason is the content of a decision, so it has to be
-- readable afterwards: human capital must see why the director sent a period
-- back. It belongs here rather than in the audit payload, which carries
-- identifiers and aggregates only (section 8), and rather than in a column on the
-- period, which would keep only the latest one.
--
-- Down (safe while no period exists): DROP TABLE payroll_period_transitions;

CREATE TABLE IF NOT EXISTS payroll_period_transitions (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'start_collecting', 'calculate', 'submit', 'return', 'approve',
    'confirm_payment', 'publish', 'request_reopen', 'approve_reopen', 'reject_reopen'
  )),
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text NULL,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- The same three actions the lifecycle requires a reason for.
  CONSTRAINT payroll_period_transitions_reason_required
    CHECK (
      action NOT IN ('return', 'request_reopen', 'reject_reopen')
      OR length(trim(coalesce(reason, ''))) > 0
    )
);

CREATE INDEX IF NOT EXISTS payroll_period_transitions_period_idx
  ON payroll_period_transitions (period_id, occurred_at DESC);
