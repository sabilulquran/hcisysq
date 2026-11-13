-- REIMB-001 Package 1: employee reimbursement claims — draft, receipts, APR-001 approval
-- snapshot, Finance verification, payment outside payroll, history.
-- Spec: docs/domain/reimbursement.md §10.
--
-- Additive only: new tables, functions and triggers; no existing data changes.
--
-- Money is whole rupiah in bigint columns, capped far below 2^53 so the API carries it as a
-- JSON integer. Payroll is untouched: nothing here reads or writes payroll_* tables (D-11, §9).
--
-- Receipts use the encrypted-in-database pattern of EMP-011/TRAIN-001: AES-256-GCM with
-- AUTH_ENCRYPTION_KEY, base64url ciphertext/iv/auth_tag. The original file name is never stored.
--
-- Down (only before any claim exists in production; afterwards export first, see spec §10):
--   DROP TABLE IF EXISTS reimbursement_events;
--   DROP TABLE IF EXISTS reimbursement_payments;
--   DROP TABLE IF EXISTS reimbursement_approval_steps;
--   DROP TABLE IF EXISTS reimbursement_receipts;
--   DROP TABLE IF EXISTS reimbursement_items;
--   DROP TABLE IF EXISTS reimbursement_claims;
--   DROP FUNCTION IF EXISTS reimbursement_assert_money();
--   DROP FUNCTION IF EXISTS reimbursement_refuse_change();
--   DROP FUNCTION IF EXISTS reimbursement_item_guard();
--   DROP FUNCTION IF EXISTS reimbursement_receipt_guard();
--   DELETE FROM schema_migrations WHERE name = '0148_reimbursements.sql';

CREATE TABLE IF NOT EXISTS reimbursement_claims (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 200),
  business_trip_id uuid NULL REFERENCES business_trip_requests(id),
  status text NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'VERIFIED', 'PAID', 'REJECTED', 'CANCELLED')),
  -- Sum of the items; the deferred trigger below proves it.
  claimed_total bigint NOT NULL DEFAULT 0 CHECK (claimed_total >= 0 AND claimed_total <= 1000000000),
  idempotency_key uuid NOT NULL,
  -- APR-001: the resolved chain and the rollout context that explains it.
  approval_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL,
  final_decided_at timestamptz NULL,
  verified_total bigint NULL CHECK (verified_total IS NULL OR (verified_total > 0 AND verified_total <= claimed_total)),
  verified_by_account_id uuid NULL REFERENCES accounts(id),
  verified_at timestamptz NULL,
  verification_note text NULL CHECK (verification_note IS NULL OR char_length(verification_note) BETWEEN 1 AND 500),
  paid_at timestamptz NULL,
  rejected_by text NULL CHECK (rejected_by IS NULL OR rejected_by IN ('APPROVER', 'FINANCE')),
  reject_reason text NULL CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 1000),
  rejected_by_account_id uuid NULL REFERENCES accounts(id),
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key),
  -- A discarded draft is CANCELLED without ever having been submitted.
  CHECK (status <> 'DRAFT' OR submitted_at IS NULL),
  CHECK (submitted_at IS NOT NULL OR status IN ('DRAFT', 'CANCELLED')),
  -- Verification sets the payable total; a verified claim Finance later rejects keeps it as history.
  CHECK (status NOT IN ('VERIFIED', 'PAID') OR verified_total IS NOT NULL),
  CHECK (verified_total IS NULL OR status IN ('VERIFIED', 'PAID', 'REJECTED')),
  CHECK (verified_total IS NULL OR (verified_by_account_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejected_by IS NOT NULL AND reject_reason IS NOT NULL))
);

-- D-07: the open-draft limit and the employee list read drafts by employee.
CREATE INDEX IF NOT EXISTS reimbursement_claims_employee_idx
  ON reimbursement_claims (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reimbursement_claims_status_idx
  ON reimbursement_claims (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS reimbursement_claims_trip_idx
  ON reimbursement_claims (business_trip_id) WHERE business_trip_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reimbursement_items (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES reimbursement_claims(id),
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 10),
  category text NOT NULL CHECK (category IN ('TRANSPORT', 'ACCOMMODATION', 'MEALS', 'OPERATIONAL', 'OTHER')),
  expense_date date NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 300),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  approved_amount bigint NULL CHECK (approved_amount IS NULL OR (approved_amount >= 0 AND approved_amount <= amount)),
  UNIQUE (claim_id, line_no)
);

CREATE TABLE IF NOT EXISTS reimbursement_receipts (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES reimbursement_claims(id),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 4194304),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext text NULL,
  iv text NULL,
  auth_tag text NULL,
  uploaded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  purged_at timestamptz NULL,
  CHECK (
    (purged_at IS NULL AND ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)
    OR (purged_at IS NOT NULL AND ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS reimbursement_receipts_claim_idx
  ON reimbursement_receipts (claim_id, created_at ASC);
-- D-16: the duplicate-receipt signal looks receipts up by content hash.
CREATE INDEX IF NOT EXISTS reimbursement_receipts_sha_idx
  ON reimbursement_receipts (sha256) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS reimbursement_approval_steps (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES reimbursement_claims(id),
  step_order integer NOT NULL CHECK (step_order >= 1),
  approver_employee_id uuid NOT NULL REFERENCES employees(id),
  sources text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_by_account_id uuid NULL REFERENCES accounts(id),
  acted_at timestamptz NULL,
  decision_note text NULL,
  UNIQUE (claim_id, step_order)
);

-- APR-001-G: one active step per claim, so two decisions cannot both advance it.
CREATE UNIQUE INDEX IF NOT EXISTS reimbursement_approval_steps_one_pending_idx
  ON reimbursement_approval_steps (claim_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reimbursement_approval_steps_inbox_idx
  ON reimbursement_approval_steps (approver_employee_id, status);

-- D-10: exactly one payment per claim; written once, never changed.
CREATE TABLE IF NOT EXISTS reimbursement_payments (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL UNIQUE REFERENCES reimbursement_claims(id),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  paid_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH', 'TRANSFER', 'PAYROLL')),
  payroll_month date NULL CHECK (payroll_month IS NULL OR extract(day FROM payroll_month) = 1),
  reference text NULL CHECK (reference IS NULL OR char_length(reference) <= 200),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  idempotency_key uuid NOT NULL,
  recorded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((method = 'PAYROLL') = (payroll_month IS NOT NULL))
);

-- History and audit. Metadata never carries an amount (spec §7). Only the register export has
-- no claim.
CREATE TABLE IF NOT EXISTS reimbursement_events (
  id uuid PRIMARY KEY,
  claim_id uuid NULL REFERENCES reimbursement_claims(id),
  event_type text NOT NULL CHECK (event_type ~ '^reimbursement\.[a-z_]+(\.[a-z_]+)?$'),
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (claim_id IS NOT NULL OR event_type = 'reimbursement.register.exported')
);

CREATE INDEX IF NOT EXISTS reimbursement_events_claim_idx
  ON reimbursement_events (claim_id, occurred_at ASC) WHERE claim_id IS NOT NULL;

-- Nothing in the money history disappears.
CREATE OR REPLACE FUNCTION reimbursement_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reimbursement history is append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_claims_no_delete ON reimbursement_claims;
CREATE TRIGGER reimbursement_claims_no_delete
  BEFORE DELETE ON reimbursement_claims
  FOR EACH ROW EXECUTE FUNCTION reimbursement_refuse_change();
DROP TRIGGER IF EXISTS reimbursement_payments_immutable ON reimbursement_payments;
CREATE TRIGGER reimbursement_payments_immutable
  BEFORE UPDATE OR DELETE ON reimbursement_payments
  FOR EACH ROW EXECUTE FUNCTION reimbursement_refuse_change();
DROP TRIGGER IF EXISTS reimbursement_events_immutable ON reimbursement_events;
CREATE TRIGGER reimbursement_events_immutable
  BEFORE UPDATE OR DELETE ON reimbursement_events
  FOR EACH ROW EXECUTE FUNCTION reimbursement_refuse_change();

-- Items change only while the claim is a draft. While the claim is APPROVED, Finance verification
-- may set approved_amount and nothing else.
CREATE OR REPLACE FUNCTION reimbursement_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claim_status text;
BEGIN
  SELECT status INTO claim_status FROM reimbursement_claims
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END;
  IF claim_status = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.approved_amount IS NOT NULL THEN
      RAISE EXCEPTION 'reimbursement draft item cannot carry an approved amount' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.claim_id <> OLD.claim_id THEN
      RAISE EXCEPTION 'reimbursement item cannot move between claims' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND claim_status = 'APPROVED'
     AND NEW.id = OLD.id AND NEW.claim_id = OLD.claim_id AND NEW.line_no = OLD.line_no
     AND NEW.category = OLD.category AND NEW.expense_date = OLD.expense_date
     AND NEW.description = OLD.description AND NEW.amount = OLD.amount
     AND OLD.approved_amount IS NULL AND NEW.approved_amount IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reimbursement items are fixed once the claim is submitted' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_items_guard ON reimbursement_items;
CREATE TRIGGER reimbursement_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reimbursement_items
  FOR EACH ROW EXECUTE FUNCTION reimbursement_item_guard();

-- Receipts are added only to drafts, never deleted; the one allowed change is erasing the content.
CREATE OR REPLACE FUNCTION reimbursement_receipt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reimbursement history is append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM reimbursement_claims WHERE id = NEW.claim_id AND status = 'DRAFT') THEN
      RAISE EXCEPTION 'reimbursement receipts are added to drafts only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.ciphertext IS NULL
     AND NEW.id = OLD.id AND NEW.claim_id = OLD.claim_id AND NEW.content_type = OLD.content_type
     AND NEW.byte_size = OLD.byte_size AND NEW.uploaded_by_account_id = OLD.uploaded_by_account_id
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reimbursement receipt may only be purged' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_receipts_guard ON reimbursement_receipts;
CREATE TRIGGER reimbursement_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reimbursement_receipts
  FOR EACH ROW EXECUTE FUNCTION reimbursement_receipt_guard();

-- Money invariants checked at COMMIT, after every write of the transaction has landed:
--   claimed_total equals the sum of the items; a submitted claim has 1-10 items;
--   no approved_amount before verification; once verified (verified_total set) every item has
--   one and their sum is verified_total;
--   a PAID claim has exactly one payment of verified_total; any other claim has no payment.
-- The message names the rule, never an amount.
CREATE OR REPLACE FUNCTION reimbursement_assert_money() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  claim record;
  item_count integer;
  item_sum bigint;
  approved_count integer;
  approved_sum bigint;
  payment_count integer;
  payment_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'reimbursement_claims' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.claim_id;
  ELSE
    target := NEW.claim_id;
  END IF;
  SELECT status, claimed_total, verified_total INTO claim FROM reimbursement_claims WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(amount), 0), count(approved_amount), COALESCE(sum(approved_amount), 0)
    INTO item_count, item_sum, approved_count, approved_sum
    FROM reimbursement_items WHERE claim_id = target;
  SELECT count(*), COALESCE(sum(amount), 0) INTO payment_count, payment_sum
    FROM reimbursement_payments WHERE claim_id = target;
  IF item_sum <> claim.claimed_total THEN
    RAISE EXCEPTION 'reimbursement claimed total does not match its items' USING ERRCODE = '23514';
  END IF;
  IF claim.status NOT IN ('DRAFT', 'CANCELLED') AND (item_count < 1 OR item_count > 10) THEN
    RAISE EXCEPTION 'reimbursement claim must have one to ten items' USING ERRCODE = '23514';
  END IF;
  IF claim.verified_total IS NOT NULL THEN
    IF approved_count <> item_count OR approved_sum <> claim.verified_total THEN
      RAISE EXCEPTION 'reimbursement verified total does not match its items' USING ERRCODE = '23514';
    END IF;
  ELSIF approved_count > 0 THEN
    RAISE EXCEPTION 'reimbursement item approved before verification' USING ERRCODE = '23514';
  END IF;
  IF claim.status = 'PAID' THEN
    IF payment_count <> 1 OR payment_sum <> claim.verified_total THEN
      RAISE EXCEPTION 'reimbursement payment does not match its verified total' USING ERRCODE = '23514';
    END IF;
  ELSIF payment_count > 0 THEN
    RAISE EXCEPTION 'reimbursement has a payment without being paid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reimbursement_claims_money ON reimbursement_claims;
CREATE CONSTRAINT TRIGGER reimbursement_claims_money
  AFTER INSERT OR UPDATE ON reimbursement_claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reimbursement_assert_money();
DROP TRIGGER IF EXISTS reimbursement_items_money ON reimbursement_items;
CREATE CONSTRAINT TRIGGER reimbursement_items_money
  AFTER INSERT OR UPDATE OR DELETE ON reimbursement_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reimbursement_assert_money();
DROP TRIGGER IF EXISTS reimbursement_payments_money ON reimbursement_payments;
CREATE CONSTRAINT TRIGGER reimbursement_payments_money
  AFTER INSERT ON reimbursement_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reimbursement_assert_money();
