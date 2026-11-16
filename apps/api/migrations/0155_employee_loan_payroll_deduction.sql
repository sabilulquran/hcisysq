-- LOAN-001 Package 2 / PAY-003: LOAN-001 instalments deducted through payroll.
-- Specification: docs/domain/employee-loans.md section 9,
-- docs/domain/payroll-calculation-v1.md section 3.5
--
-- Additive only. Nothing here turns the deduction on: the calculation proposes
-- LOAN-001 instalments only while LOAN_PAYROLL_DEDUCTION_ENABLED=1 (default 0),
-- so after this migration every existing row reads exactly as before:
--   * payroll_loans.employee_loan_id is NULL for every kasbon already recorded;
--   * payroll_loan_deductions.origin is MANUAL, which is what every deduction
--     typed by Finance has always been;
--   * employee_loan_payments.source_payroll_period_id is NULL for every
--     payment Finance recorded by hand.
--
-- Down (only while no row uses the new columns; otherwise export them first,
-- because they are the link between a payroll period and a loan payment):
--   DROP INDEX IF EXISTS employee_loan_payments_one_active_per_period_idx;
--   ALTER TABLE employee_loan_payments
--     DROP CONSTRAINT IF EXISTS employee_loan_payments_payroll_source_method,
--     DROP COLUMN IF EXISTS source_payroll_period_id;
--   DELETE FROM payroll_loan_deductions WHERE amount = 0;
--   ALTER TABLE payroll_loan_deductions DROP CONSTRAINT payroll_loan_deductions_amount_check,
--     ADD CONSTRAINT payroll_loan_deductions_amount_check CHECK (amount > 0);
--   ALTER TABLE payroll_loan_deductions DROP COLUMN IF EXISTS origin;
--   ALTER TABLE payroll_loans DROP COLUMN IF EXISTS employee_loan_id;
--   then re-run the employee_loan_payment_only_reversal() body from 0122.

SET LOCAL lock_timeout = '5s';

-- One mirror per LOAN-001 loan (contract item 1: one source, never typed twice).
ALTER TABLE payroll_loans
  ADD COLUMN IF NOT EXISTS employee_loan_id uuid NULL REFERENCES employee_loans(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_loans_employee_loan_idx
  ON payroll_loans (employee_loan_id);

-- PROPOSED: written by the calculation from the LOAN-001 schedule and refreshed
-- on every recalculation. MANUAL: set by Finance and never overwritten.
ALTER TABLE payroll_loan_deductions
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'MANUAL';
ALTER TABLE payroll_loan_deductions
  DROP CONSTRAINT IF EXISTS payroll_loan_deductions_origin_check;
ALTER TABLE payroll_loan_deductions
  ADD CONSTRAINT payroll_loan_deductions_origin_check CHECK (origin IN ('MANUAL', 'PROPOSED'));

-- A MANUAL zero on a LOAN-001 mirror is Finance skipping that month's
-- instalment; without it the next recalculation would propose it again.
-- Every existing row is > 0, so the new CHECK cannot fail on old data.
ALTER TABLE payroll_loan_deductions
  DROP CONSTRAINT payroll_loan_deductions_amount_check;
ALTER TABLE payroll_loan_deductions
  ADD CONSTRAINT payroll_loan_deductions_amount_check
  CHECK (amount > 0 OR (amount = 0 AND origin = 'MANUAL'));

-- The approved payroll period a PAYROLL_DEDUCTION payment came from
-- (contract item 3). Unique while ACTIVE: approving twice cannot double it,
-- and a reopen reverses it so the re-approval may write a new one.
ALTER TABLE employee_loan_payments
  ADD COLUMN IF NOT EXISTS source_payroll_period_id uuid NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT;
ALTER TABLE employee_loan_payments
  DROP CONSTRAINT IF EXISTS employee_loan_payments_payroll_source_method;
ALTER TABLE employee_loan_payments
  ADD CONSTRAINT employee_loan_payments_payroll_source_method
  CHECK (source_payroll_period_id IS NULL OR method = 'PAYROLL_DEDUCTION');
CREATE UNIQUE INDEX IF NOT EXISTS employee_loan_payments_one_active_per_period_idx
  ON employee_loan_payments (loan_id, source_payroll_period_id)
  WHERE status = 'ACTIVE' AND source_payroll_period_id IS NOT NULL;

-- The only-reversal trigger compares named columns; the source must not move either.
CREATE OR REPLACE FUNCTION employee_loan_payment_only_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVERSED'
     OR NEW.id <> OLD.id OR NEW.loan_id <> OLD.loan_id OR NEW.amount <> OLD.amount
     OR NEW.paid_on <> OLD.paid_on OR NEW.method <> OLD.method
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.recorded_by_account_id <> OLD.recorded_by_account_id OR NEW.recorded_at <> OLD.recorded_at
     OR NEW.source_payroll_period_id IS DISTINCT FROM OLD.source_payroll_period_id THEN
    RAISE EXCEPTION 'employee loan payment may only be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
