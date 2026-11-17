-- REIMB-001 section 9 / PAY-003: the payroll side of REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED.
-- Specification: docs/domain/reimbursement.md section 9,
-- docs/domain/payroll-calculation-v1.md section 3.6
--
-- Additive only, and nothing here turns the handoff on. While
-- REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED=0 (the default, and production) no
-- handoff row is ever written and the calculation reads none, so every period
-- calculates exactly as before. The new component only appears on a slip that
-- carries a handed-off reimbursement.
--
-- reimbursement_payments stays immutable (one per claim, written once). What a
-- payroll reopen reverses is the handoff row, never the payment: see section 9.
--
-- Down (only while the table is empty; otherwise export it first, it is the
-- link between a claim and the payroll period that paid it):
--   DROP TABLE IF EXISTS reimbursement_payroll_handoffs;
--   DELETE FROM payroll_components WHERE code = 'REIMBURSE'
--     AND NOT EXISTS (SELECT 1 FROM payroll_result_lines WHERE component_code = 'REIMBURSE');

SET LOCAL lock_timeout = '5s';

-- Penggantian biaya: an earning on the slip, outside the PPh21 base (it repays
-- an expense, it is not income) and not a fixed allowance for the BPJS base.
INSERT INTO payroll_components
  (code, display_name, category, is_fixed_allowance, in_pph21_base, display_order) VALUES
  ('REIMBURSE', 'Penggantian biaya', 'EARNING', false, false, 170)
ON CONFLICT (code) DO NOTHING;

-- One row per handoff. Lifecycle:
--   PENDING   Finance handed a VERIFIED claim to payroll month M (claim stays VERIFIED);
--             the calculation of the period of month M binds it (period_id) and pays it.
--   SETTLED   the period was approved: the claim became PAID with its one immutable
--             PAYROLL payment (payment_id).
--   REVERSED  the period was reopened: this row is closed with a reason and a new
--             PENDING row for the same claim and period carries the reimbursement into
--             the recalculation. The payment stays, as every payroll payment does
--             (payroll-calculation-v1.md section 6).
--   WITHDRAWN Finance paid the claim in cash or by transfer instead, before settlement.
CREATE TABLE IF NOT EXISTS reimbursement_payroll_handoffs (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES reimbursement_claims(id) ON DELETE RESTRICT,
  payroll_month date NOT NULL CHECK (extract(day FROM payroll_month) = 1),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  status text NOT NULL CHECK (status IN ('PENDING', 'SETTLED', 'REVERSED', 'WITHDRAWN')),
  period_id uuid NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  payment_id uuid NULL REFERENCES reimbursement_payments(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz NULL,
  closed_by_account_id uuid NULL REFERENCES accounts(id),
  closed_at timestamptz NULL,
  close_reason text NULL CHECK (close_reason IS NULL OR char_length(close_reason) BETWEEN 10 AND 500),
  UNIQUE (claim_id, idempotency_key),
  CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL AND payment_id IS NOT NULL AND period_id IS NOT NULL)
         OR status = 'REVERSED'),
  CHECK ((status IN ('REVERSED', 'WITHDRAWN')) = (closed_at IS NOT NULL AND close_reason IS NOT NULL
                                                  AND closed_by_account_id IS NOT NULL))
);

-- At most one live handoff per claim, so a claim is never paid twice through payroll.
CREATE UNIQUE INDEX IF NOT EXISTS reimbursement_payroll_handoffs_one_live_idx
  ON reimbursement_payroll_handoffs (claim_id) WHERE status IN ('PENDING', 'SETTLED');
CREATE INDEX IF NOT EXISTS reimbursement_payroll_handoffs_month_idx
  ON reimbursement_payroll_handoffs (payroll_month) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS reimbursement_payroll_handoffs_period_idx
  ON reimbursement_payroll_handoffs (period_id) WHERE period_id IS NOT NULL;

-- Append-only history: rows are never deleted, and a closed row never changes.
CREATE OR REPLACE FUNCTION reimbursement_payroll_handoff_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reimbursement payroll handoff history is append-only' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REVERSED', 'WITHDRAWN')
     OR NEW.id <> OLD.id OR NEW.claim_id <> OLD.claim_id OR NEW.amount <> OLD.amount
     OR NEW.payroll_month <> OLD.payroll_month OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_by_account_id <> OLD.created_by_account_id OR NEW.created_at <> OLD.created_at
     OR (OLD.status = 'SETTLED' AND NEW.status NOT IN ('SETTLED', 'REVERSED'))
     OR (OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id) THEN
    RAISE EXCEPTION 'reimbursement payroll handoff may only move forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_payroll_handoffs_guard ON reimbursement_payroll_handoffs;
CREATE TRIGGER reimbursement_payroll_handoffs_guard
  BEFORE UPDATE OR DELETE ON reimbursement_payroll_handoffs
  FOR EACH ROW EXECUTE FUNCTION reimbursement_payroll_handoff_guard();
