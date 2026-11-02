-- LOAN-001 Package 1: employee loans — request, APR-001 approval snapshot, disbursement,
-- instalment schedule, repayments and history.
-- Spec: docs/domain/employee-loans.md §10.
--
-- Money is whole rupiah in bigint columns; nothing here is numeric with a fraction or
-- floating point. Every amount is capped far below 2^53 so the API can carry it as a JSON
-- integer. No interest column exists: Package 1 loans carry no interest (D-02).
--
-- Payroll is untouched: no table, view or trigger here reads or writes payroll_* tables.
-- Automatic deduction through PAY-003 is the Package 2 contract (spec §9).
--
-- Down (only before any loan exists in production; afterwards export first, see spec §10):
--   DROP TABLE IF EXISTS employee_loan_events;
--   DROP TABLE IF EXISTS employee_loan_payments;
--   DROP TABLE IF EXISTS employee_loan_instalments;
--   DROP TABLE IF EXISTS employee_loan_approval_steps;
--   DROP TABLE IF EXISTS employee_loans;
--   DROP FUNCTION IF EXISTS employee_loan_assert_money();
--   DROP FUNCTION IF EXISTS employee_loan_refuse_change();

CREATE TABLE IF NOT EXISTS employee_loans (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  principal_amount bigint NOT NULL CHECK (principal_amount > 0 AND principal_amount <= 1000000000),
  tenor_months integer NOT NULL CHECK (tenor_months BETWEEN 1 AND 60),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 1000),
  status text NOT NULL CHECK (status IN ('IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'DISBURSED', 'PAID_OFF')),
  idempotency_key uuid NOT NULL,
  -- APR-001: the resolved chain and the rollout context that explains it.
  approval_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  final_decided_at timestamptz NULL,
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL,
  disbursed_on date NULL,
  disbursement_method text NULL CHECK (disbursement_method IS NULL OR disbursement_method IN ('CASH', 'TRANSFER')),
  disbursement_reference text NULL CHECK (disbursement_reference IS NULL OR char_length(disbursement_reference) <= 200),
  first_due_month date NULL CHECK (first_due_month IS NULL OR extract(day FROM first_due_month) = 1),
  disbursed_by_account_id uuid NULL REFERENCES accounts(id),
  disbursed_at timestamptz NULL,
  -- Sum of the payments still in force; the deferred trigger below proves it.
  paid_total bigint NOT NULL DEFAULT 0,
  paid_off_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key),
  CHECK (paid_total >= 0 AND paid_total <= principal_amount),
  -- Money moves only after disbursement, and the loan is paid off exactly when it is all repaid.
  CHECK ((status IN ('DISBURSED', 'PAID_OFF')) = (disbursed_on IS NOT NULL)),
  CHECK (disbursed_on IS NULL OR (disbursement_method IS NOT NULL AND first_due_month IS NOT NULL
    AND disbursed_by_account_id IS NOT NULL AND disbursed_at IS NOT NULL)),
  CHECK (paid_total = 0 OR status IN ('DISBURSED', 'PAID_OFF')),
  CHECK ((status = 'PAID_OFF') = (paid_total = principal_amount)),
  CHECK ((status = 'PAID_OFF') = (paid_off_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);

-- D-06: one open loan per employee, held by the database as well as by the route.
CREATE UNIQUE INDEX IF NOT EXISTS employee_loans_one_open_idx
  ON employee_loans (employee_id) WHERE status IN ('IN_REVIEW', 'APPROVED', 'DISBURSED');
CREATE INDEX IF NOT EXISTS employee_loans_employee_idx
  ON employee_loans (employee_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS employee_loans_status_idx
  ON employee_loans (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS employee_loan_approval_steps (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES employee_loans(id),
  step_order integer NOT NULL CHECK (step_order >= 1),
  approver_employee_id uuid NOT NULL REFERENCES employees(id),
  sources text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_by_account_id uuid NULL REFERENCES accounts(id),
  acted_at timestamptz NULL,
  decision_note text NULL,
  UNIQUE (loan_id, step_order)
);

-- APR-001-G: one active step per loan, so two decisions cannot both advance it.
CREATE UNIQUE INDEX IF NOT EXISTS employee_loan_approval_steps_one_pending_idx
  ON employee_loan_approval_steps (loan_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS employee_loan_approval_steps_inbox_idx
  ON employee_loan_approval_steps (approver_employee_id) WHERE status = 'pending';

-- Written once, at disbursement. Never updated or deleted (trigger below).
CREATE TABLE IF NOT EXISTS employee_loan_instalments (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES employee_loans(id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  due_month date NOT NULL CHECK (extract(day FROM due_month) = 1),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  UNIQUE (loan_id, sequence),
  UNIQUE (loan_id, due_month)
);

-- Append-only. A mistaken payment is reversed (status REVERSED, with reason), never deleted.
CREATE TABLE IF NOT EXISTS employee_loan_payments (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES employee_loans(id),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  paid_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH', 'TRANSFER', 'PAYROLL_DEDUCTION')),
  reference text NULL CHECK (reference IS NULL OR char_length(reference) <= 200),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  idempotency_key uuid NOT NULL,
  recorded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reversed_by_account_id uuid NULL REFERENCES accounts(id),
  reversed_at timestamptz NULL,
  reverse_reason text NULL,
  UNIQUE (loan_id, idempotency_key),
  CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversed_by_account_id IS NOT NULL AND reverse_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS employee_loan_payments_loan_idx
  ON employee_loan_payments (loan_id, paid_on ASC, recorded_at ASC);

-- History and audit. Metadata never carries an amount (spec §7).
CREATE TABLE IF NOT EXISTS employee_loan_events (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES employee_loans(id),
  event_type text NOT NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_loan_events_loan_idx
  ON employee_loan_events (loan_id, occurred_at ASC);

-- The schedule is fixed at disbursement and nothing in the loan history disappears.
CREATE OR REPLACE FUNCTION employee_loan_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'employee loan history is append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS employee_loan_instalments_immutable ON employee_loan_instalments;
CREATE TRIGGER employee_loan_instalments_immutable
  BEFORE UPDATE OR DELETE ON employee_loan_instalments
  FOR EACH ROW EXECUTE FUNCTION employee_loan_refuse_change();
DROP TRIGGER IF EXISTS employee_loan_payments_no_delete ON employee_loan_payments;
CREATE TRIGGER employee_loan_payments_no_delete
  BEFORE DELETE ON employee_loan_payments
  FOR EACH ROW EXECUTE FUNCTION employee_loan_refuse_change();
DROP TRIGGER IF EXISTS employee_loans_no_delete ON employee_loans;
CREATE TRIGGER employee_loans_no_delete
  BEFORE DELETE ON employee_loans
  FOR EACH ROW EXECUTE FUNCTION employee_loan_refuse_change();
DROP TRIGGER IF EXISTS employee_loan_events_immutable ON employee_loan_events;
CREATE TRIGGER employee_loan_events_immutable
  BEFORE UPDATE OR DELETE ON employee_loan_events
  FOR EACH ROW EXECUTE FUNCTION employee_loan_refuse_change();

-- Money invariants checked at COMMIT, after every write of the transaction has landed:
--   a disbursed loan has exactly tenor_months instalments that sum to the principal;
--   a loan that was never disbursed has no instalment and no payment;
--   paid_total equals the sum of the loan's ACTIVE payments.
-- The message names the rule, never an amount.
CREATE OR REPLACE FUNCTION employee_loan_assert_money() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  loan record;
  schedule_count integer;
  schedule_sum bigint;
  payment_count integer;
  payment_sum bigint;
BEGIN
  -- Only INSERT and UPDATE fire this, so NEW is always set.
  IF TG_TABLE_NAME = 'employee_loans' THEN
    target := NEW.id;
  ELSE
    target := NEW.loan_id;
  END IF;
  SELECT principal_amount, tenor_months, status, paid_total INTO loan FROM employee_loans WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO schedule_count, schedule_sum
    FROM employee_loan_instalments WHERE loan_id = target;
  SELECT count(*), COALESCE(sum(amount) FILTER (WHERE status = 'ACTIVE'), 0) INTO payment_count, payment_sum
    FROM employee_loan_payments WHERE loan_id = target;
  IF loan.status IN ('DISBURSED', 'PAID_OFF') THEN
    IF schedule_count <> loan.tenor_months OR schedule_sum <> loan.principal_amount THEN
      RAISE EXCEPTION 'employee loan schedule does not match its principal' USING ERRCODE = '23514';
    END IF;
  ELSIF schedule_count > 0 OR payment_count > 0 THEN
    RAISE EXCEPTION 'employee loan has money movement before disbursement' USING ERRCODE = '23514';
  END IF;
  IF payment_sum <> loan.paid_total THEN
    RAISE EXCEPTION 'employee loan paid total does not match its payments' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS employee_loans_money ON employee_loans;
CREATE CONSTRAINT TRIGGER employee_loans_money
  AFTER INSERT OR UPDATE ON employee_loans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION employee_loan_assert_money();
DROP TRIGGER IF EXISTS employee_loan_instalments_money ON employee_loan_instalments;
CREATE CONSTRAINT TRIGGER employee_loan_instalments_money
  AFTER INSERT ON employee_loan_instalments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION employee_loan_assert_money();
DROP TRIGGER IF EXISTS employee_loan_payments_money ON employee_loan_payments;
CREATE CONSTRAINT TRIGGER employee_loan_payments_money
  AFTER INSERT OR UPDATE ON employee_loan_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION employee_loan_assert_money();
