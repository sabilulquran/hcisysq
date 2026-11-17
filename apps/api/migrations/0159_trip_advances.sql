-- TRIP-002: business-trip advances (uang muka dinas) and per diem (uang harian) — versioned rates,
-- APR-001 approval snapshot copied from the trip, Finance disbursement outside payroll,
-- settlement against REIMB-001 claims, top-up and refunds, history; plus the permission keys.
-- Spec: docs/domain/trip-advance-per-diem.md §9.
--
-- Additive except one widened CHECK: reimbursement_payments.method also accepts 'ADVANCE' (a claim
-- settled against a trip advance, spec D-10). No existing row changes.
--
-- Money is whole rupiah in bigint columns, capped far below 2^53. Payroll is untouched: nothing
-- here reads or writes payroll_* tables. The rate table starts empty (D-02): no amount is guessed.
--
-- Down (only before any advance or rate exists in production; afterwards export first):
--   DROP TRIGGER IF EXISTS reimbursement_payments_advance_guard ON reimbursement_payments;
--   DROP FUNCTION IF EXISTS reimbursement_advance_payment_guard();
--   DROP TABLE IF EXISTS trip_advance_events;
--   DROP TABLE IF EXISTS trip_advance_settlement_claims;
--   DROP TABLE IF EXISTS trip_advance_transactions;
--   DROP TABLE IF EXISTS trip_advance_approval_steps;
--   DROP TABLE IF EXISTS trip_advances;
--   DROP TABLE IF EXISTS trip_per_diem_rates;
--   DROP FUNCTION IF EXISTS trip_advance_assert_money();
--   DROP FUNCTION IF EXISTS trip_advance_refuse_change();
--   -- Only when no reimbursement payment uses ADVANCE:
--   ALTER TABLE reimbursement_payments DROP CONSTRAINT reimbursement_payments_method_check;
--   ALTER TABLE reimbursement_payments ADD CONSTRAINT reimbursement_payments_method_check
--     CHECK (method IN ('CASH', 'TRANSFER', 'PAYROLL'));
--   DELETE FROM role_permissions WHERE permission_key IN ('trip_advances.read', 'trip_advances.manage', 'trip_per_diem.manage');
--   DELETE FROM permissions WHERE permission_key IN ('trip_advances.read', 'trip_advances.manage', 'trip_per_diem.manage');
--   DELETE FROM schema_migrations WHERE name = '0159_trip_advances.sql';

CREATE OR REPLACE FUNCTION trip_advance_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip advance history is append-only' USING ERRCODE = '23514';
END;
$$;

-- D-02: versioned per diem rates, append-only. The rate for a trip is the latest row of its zone
-- effective on the departure date; a same-day correction is a newer row.
CREATE TABLE IF NOT EXISTS trip_per_diem_rates (
  id uuid PRIMARY KEY,
  zone text NOT NULL CHECK (zone IN ('LOCAL', 'PROVINCIAL', 'NATIONAL', 'INTERNATIONAL')),
  effective_from date NOT NULL,
  daily_amount bigint NOT NULL CHECK (daily_amount >= 0 AND daily_amount <= 5000000),
  note text NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS trip_per_diem_rates_lookup_idx
  ON trip_per_diem_rates (zone, effective_from DESC, created_at DESC);

DROP TRIGGER IF EXISTS trip_per_diem_rates_immutable ON trip_per_diem_rates;
CREATE TRIGGER trip_per_diem_rates_immutable
  BEFORE UPDATE OR DELETE ON trip_per_diem_rates
  FOR EACH ROW EXECUTE FUNCTION trip_advance_refuse_change();

CREATE TABLE IF NOT EXISTS trip_advances (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  business_trip_id uuid NOT NULL REFERENCES business_trip_requests(id),
  zone text NOT NULL CHECK (zone IN ('LOCAL', 'PROVINCIAL', 'NATIONAL', 'INTERNATIONAL')),
  -- The approved advance; 0 means per diem only, nothing is disbursed (D-04).
  amount bigint NOT NULL CHECK (amount >= 0 AND amount <= 1000000000),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 1000),
  status text NOT NULL CHECK (status IN (
    'IN_REVIEW', 'APPROVED', 'DISBURSED', 'SETTLEMENT_SUBMITTED',
    'AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED', 'REJECTED', 'CANCELLED'
  )),
  idempotency_key uuid NOT NULL,
  approval_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  final_decided_at timestamptz NULL,
  disbursed_at timestamptz NULL,
  settlement_submitted_at timestamptz NULL,
  settlement_note text NULL CHECK (settlement_note IS NULL OR char_length(settlement_note) BETWEEN 1 AND 1000),
  -- Settlement (D-10): written once by Finance.
  settlement_key uuid NULL,
  per_diem_days integer NULL CHECK (per_diem_days IS NULL OR per_diem_days BETWEEN 0 AND 30),
  per_diem_rate_id uuid NULL REFERENCES trip_per_diem_rates(id),
  per_diem_rate bigint NULL CHECK (per_diem_rate IS NULL OR (per_diem_rate >= 0 AND per_diem_rate <= 5000000)),
  per_diem_amount bigint NULL CHECK (per_diem_amount IS NULL OR (per_diem_amount >= 0 AND per_diem_amount <= 1000000000)),
  claims_total bigint NULL CHECK (claims_total IS NULL OR (claims_total >= 0 AND claims_total <= 1000000000)),
  -- per diem + claims - amount: positive is owed to the employee, negative is owed by them.
  settlement_balance bigint NULL CHECK (settlement_balance IS NULL OR settlement_balance BETWEEN -1000000000 AND 1000000000),
  settlement_finance_note text NULL CHECK (settlement_finance_note IS NULL OR char_length(settlement_finance_note) BETWEEN 1 AND 500),
  settled_at timestamptz NULL,
  settled_by_account_id uuid NULL REFERENCES accounts(id),
  closed_at timestamptz NULL,
  rejected_by text NULL CHECK (rejected_by IS NULL OR rejected_by IN ('APPROVER', 'FINANCE')),
  reject_reason text NULL CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 1000),
  rejected_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key),
  CHECK (status <> 'DISBURSED' OR amount > 0),
  CHECK ((disbursed_at IS NOT NULL) = (amount > 0 AND status IN (
    'DISBURSED', 'SETTLEMENT_SUBMITTED', 'AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED'))),
  CHECK ((settlement_submitted_at IS NOT NULL) = (status IN (
    'SETTLEMENT_SUBMITTED', 'AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED'))),
  CHECK ((settled_at IS NOT NULL) = (status IN ('AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED'))),
  CHECK (settled_at IS NULL OR (
    settlement_key IS NOT NULL AND settled_by_account_id IS NOT NULL AND per_diem_days IS NOT NULL
    AND per_diem_amount IS NOT NULL AND claims_total IS NOT NULL AND settlement_balance IS NOT NULL)),
  CHECK (settled_at IS NOT NULL OR (
    settlement_key IS NULL AND per_diem_days IS NULL AND per_diem_rate_id IS NULL AND per_diem_rate IS NULL
    AND per_diem_amount IS NULL AND claims_total IS NULL AND settlement_balance IS NULL)),
  -- D-10: per diem is days x rate; a day of per diem needs a rate.
  CHECK (per_diem_days IS NULL OR per_diem_days = 0 OR (per_diem_rate IS NOT NULL AND per_diem_rate_id IS NOT NULL)),
  CHECK (per_diem_amount IS NULL OR per_diem_amount = per_diem_days::bigint * COALESCE(per_diem_rate, 0)),
  CHECK (settlement_balance IS NULL OR settlement_balance = per_diem_amount + claims_total - amount),
  CHECK (status <> 'AWAITING_TOP_UP' OR settlement_balance > 0),
  CHECK (status <> 'AWAITING_REFUND' OR settlement_balance < 0),
  CHECK ((closed_at IS NOT NULL) = (status = 'SETTLED')),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejected_by IS NOT NULL AND reject_reason IS NOT NULL))
);

-- D-04: one live advance per trip.
CREATE UNIQUE INDEX IF NOT EXISTS trip_advances_one_live_per_trip_idx
  ON trip_advances (business_trip_id) WHERE status NOT IN ('REJECTED', 'CANCELLED');
CREATE INDEX IF NOT EXISTS trip_advances_employee_idx ON trip_advances (employee_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS trip_advances_status_idx ON trip_advances (status, submitted_at DESC);

DROP TRIGGER IF EXISTS trip_advances_no_delete ON trip_advances;
CREATE TRIGGER trip_advances_no_delete
  BEFORE DELETE ON trip_advances
  FOR EACH ROW EXECUTE FUNCTION trip_advance_refuse_change();

CREATE TABLE IF NOT EXISTS trip_advance_approval_steps (
  id uuid PRIMARY KEY,
  advance_id uuid NOT NULL REFERENCES trip_advances(id),
  step_order integer NOT NULL CHECK (step_order >= 1),
  approver_employee_id uuid NOT NULL REFERENCES employees(id),
  sources text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_by_account_id uuid NULL REFERENCES accounts(id),
  acted_at timestamptz NULL,
  decision_note text NULL,
  UNIQUE (advance_id, step_order)
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_advance_approval_steps_one_pending_idx
  ON trip_advance_approval_steps (advance_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trip_advance_approval_steps_inbox_idx
  ON trip_advance_approval_steps (approver_employee_id, status);

-- D-07, D-11, D-12: money out (disbursement, top-up) and money in (refunds). Written once.
CREATE TABLE IF NOT EXISTS trip_advance_transactions (
  id uuid PRIMARY KEY,
  advance_id uuid NOT NULL REFERENCES trip_advances(id),
  kind text NOT NULL CHECK (kind IN ('DISBURSEMENT', 'TOP_UP', 'REFUND')),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  transacted_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH', 'TRANSFER')),
  reference text NULL CHECK (reference IS NULL OR char_length(reference) <= 200),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  idempotency_key uuid NOT NULL,
  recorded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (advance_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_advance_transactions_one_disbursement_idx
  ON trip_advance_transactions (advance_id) WHERE kind = 'DISBURSEMENT';
CREATE UNIQUE INDEX IF NOT EXISTS trip_advance_transactions_one_top_up_idx
  ON trip_advance_transactions (advance_id) WHERE kind = 'TOP_UP';

DROP TRIGGER IF EXISTS trip_advance_transactions_immutable ON trip_advance_transactions;
CREATE TRIGGER trip_advance_transactions_immutable
  BEFORE UPDATE OR DELETE ON trip_advance_transactions
  FOR EACH ROW EXECUTE FUNCTION trip_advance_refuse_change();

-- D-10: the REIMB-001 claims a settlement counted; one claim settles at most one advance.
CREATE TABLE IF NOT EXISTS trip_advance_settlement_claims (
  advance_id uuid NOT NULL REFERENCES trip_advances(id),
  claim_id uuid NOT NULL UNIQUE REFERENCES reimbursement_claims(id),
  verified_total bigint NOT NULL CHECK (verified_total > 0 AND verified_total <= 1000000000),
  PRIMARY KEY (advance_id, claim_id)
);

DROP TRIGGER IF EXISTS trip_advance_settlement_claims_immutable ON trip_advance_settlement_claims;
CREATE TRIGGER trip_advance_settlement_claims_immutable
  BEFORE UPDATE OR DELETE ON trip_advance_settlement_claims
  FOR EACH ROW EXECUTE FUNCTION trip_advance_refuse_change();

-- History and audit; metadata never carries an amount (D-17).
CREATE TABLE IF NOT EXISTS trip_advance_events (
  id uuid PRIMARY KEY,
  advance_id uuid NULL REFERENCES trip_advances(id),
  event_type text NOT NULL CHECK (event_type ~ '^trip_advance\.[a-z_]+(\.[a-z_]+)?$'),
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (advance_id IS NOT NULL OR event_type IN ('trip_advance.register.exported', 'trip_advance.rate.created'))
);

CREATE INDEX IF NOT EXISTS trip_advance_events_advance_idx
  ON trip_advance_events (advance_id, occurred_at ASC) WHERE advance_id IS NOT NULL;

DROP TRIGGER IF EXISTS trip_advance_events_immutable ON trip_advance_events;
CREATE TRIGGER trip_advance_events_immutable
  BEFORE UPDATE OR DELETE ON trip_advance_events
  FOR EACH ROW EXECUTE FUNCTION trip_advance_refuse_change();

-- Money invariants checked at COMMIT (spec §9). Messages name the rule, never an amount.
CREATE OR REPLACE FUNCTION trip_advance_assert_money() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  advance record;
  disbursement_count integer;
  disbursement_sum bigint;
  top_up_count integer;
  top_up_sum bigint;
  refund_count integer;
  refund_sum bigint;
  claim_count integer;
  claim_sum bigint;
  foreign_claims integer;
BEGIN
  IF TG_TABLE_NAME = 'trip_advances' THEN
    target := NEW.id;
  ELSE
    target := NEW.advance_id;
  END IF;
  SELECT id, employee_id, business_trip_id, status, amount, claims_total, settlement_balance
    INTO advance FROM trip_advances WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*) FILTER (WHERE kind = 'DISBURSEMENT'), COALESCE(sum(amount) FILTER (WHERE kind = 'DISBURSEMENT'), 0),
         count(*) FILTER (WHERE kind = 'TOP_UP'), COALESCE(sum(amount) FILTER (WHERE kind = 'TOP_UP'), 0),
         count(*) FILTER (WHERE kind = 'REFUND'), COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0)
    INTO disbursement_count, disbursement_sum, top_up_count, top_up_sum, refund_count, refund_sum
    FROM trip_advance_transactions WHERE advance_id = target;

  IF advance.amount > 0 AND advance.status IN ('DISBURSED', 'SETTLEMENT_SUBMITTED', 'AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED') THEN
    IF disbursement_count <> 1 OR disbursement_sum <> advance.amount THEN
      RAISE EXCEPTION 'trip advance disbursement does not match the approved amount' USING ERRCODE = '23514';
    END IF;
  ELSIF disbursement_count > 0 THEN
    RAISE EXCEPTION 'trip advance has a disbursement without being disbursed' USING ERRCODE = '23514';
  END IF;

  SELECT count(*), COALESCE(sum(settled.verified_total), 0),
         count(*) FILTER (WHERE claim.employee_id <> advance.employee_id
                             OR claim.business_trip_id IS DISTINCT FROM advance.business_trip_id
                             OR claim.status <> 'PAID'
                             OR claim.verified_total IS DISTINCT FROM settled.verified_total
                             OR NOT EXISTS (SELECT 1 FROM reimbursement_payments payment
                                             WHERE payment.claim_id = claim.id AND payment.method = 'ADVANCE'
                                               AND payment.amount = settled.verified_total))
    INTO claim_count, claim_sum, foreign_claims
    FROM trip_advance_settlement_claims settled
    JOIN reimbursement_claims claim ON claim.id = settled.claim_id
   WHERE settled.advance_id = target;
  IF advance.status IN ('AWAITING_TOP_UP', 'AWAITING_REFUND', 'SETTLED') THEN
    IF claim_sum <> advance.claims_total OR foreign_claims > 0 THEN
      RAISE EXCEPTION 'trip advance settlement does not match its claims' USING ERRCODE = '23514';
    END IF;
  ELSIF claim_count > 0 THEN
    RAISE EXCEPTION 'trip advance has settled claims without being settled' USING ERRCODE = '23514';
  END IF;

  IF advance.status = 'SETTLED' AND advance.settlement_balance > 0 THEN
    IF top_up_count <> 1 OR top_up_sum <> advance.settlement_balance THEN
      RAISE EXCEPTION 'trip advance top-up does not match the balance' USING ERRCODE = '23514';
    END IF;
  ELSIF top_up_count > 0 THEN
    RAISE EXCEPTION 'trip advance has a top-up without a balance owed to the employee' USING ERRCODE = '23514';
  END IF;

  IF advance.status IN ('AWAITING_REFUND', 'SETTLED') AND advance.settlement_balance < 0 THEN
    IF refund_sum > -advance.settlement_balance THEN
      RAISE EXCEPTION 'trip advance refunds exceed the amount owed' USING ERRCODE = '23514';
    END IF;
    IF advance.status = 'SETTLED' AND refund_sum <> -advance.settlement_balance THEN
      RAISE EXCEPTION 'trip advance closed before the refund was complete' USING ERRCODE = '23514';
    END IF;
    IF advance.status = 'AWAITING_REFUND' AND refund_sum = -advance.settlement_balance THEN
      RAISE EXCEPTION 'trip advance refund is complete but the advance is still open' USING ERRCODE = '23514';
    END IF;
  ELSIF refund_count > 0 THEN
    RAISE EXCEPTION 'trip advance has a refund without an amount owed' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trip_advances_money ON trip_advances;
CREATE CONSTRAINT TRIGGER trip_advances_money
  AFTER INSERT OR UPDATE ON trip_advances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trip_advance_assert_money();
DROP TRIGGER IF EXISTS trip_advance_transactions_money ON trip_advance_transactions;
CREATE CONSTRAINT TRIGGER trip_advance_transactions_money
  AFTER INSERT ON trip_advance_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trip_advance_assert_money();
DROP TRIGGER IF EXISTS trip_advance_settlement_claims_money ON trip_advance_settlement_claims;
CREATE CONSTRAINT TRIGGER trip_advance_settlement_claims_money
  AFTER INSERT ON trip_advance_settlement_claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trip_advance_assert_money();

-- REIMB-001 D-19: a claim paid through an advance settlement.
ALTER TABLE reimbursement_payments DROP CONSTRAINT IF EXISTS reimbursement_payments_method_check;
ALTER TABLE reimbursement_payments ADD CONSTRAINT reimbursement_payments_method_check
  CHECK (method IN ('CASH', 'TRANSFER', 'PAYROLL', 'ADVANCE'));

-- An ADVANCE payment exists only for a claim a settlement counted, and only for that amount.
CREATE OR REPLACE FUNCTION reimbursement_advance_payment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.method = 'ADVANCE' AND NOT EXISTS (
    SELECT 1 FROM trip_advance_settlement_claims settled
     WHERE settled.claim_id = NEW.claim_id AND settled.verified_total = NEW.amount
  ) THEN
    RAISE EXCEPTION 'reimbursement advance payment has no trip advance settlement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_payments_advance_guard ON reimbursement_payments;
CREATE CONSTRAINT TRIGGER reimbursement_payments_advance_guard
  AFTER INSERT ON reimbursement_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reimbursement_advance_payment_guard();

-- D-15: permission vocabulary. Deployment order (OPS-MI8-REL-001 §4.5): between migrate and
-- cutover the old build sees these keys on roles it cannot yet delegate; nothing widens.
INSERT INTO permissions (permission_key, description) VALUES
  ('trip_advances.read', 'TRIP-002: read the trip advance register, detail and export'),
  ('trip_advances.manage', 'TRIP-002: reject, disburse, settle, pay top-ups and record refunds of trip advances'),
  ('trip_per_diem.manage', 'TRIP-002: record versioned per diem rates')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['trip_advances.read', 'trip_advances.manage', 'trip_per_diem.manage']::text[]) AS permission_key
WHERE role.role_key = 'finance_officer'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['trip_advances.read', 'trip_per_diem.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
