-- PAY-003: payslips published from a payroll period, and revised slips.
-- Specification: docs/domain/payroll-calculation-v1.md sections 6, 7 and 10 item 8
--
-- PAY-001 slips come from an import batch, and payslips.source_batch_id is NOT
-- NULL because that was the only source. A slip calculated in HCIS has a payroll
-- period instead, so the column becomes nullable and a check keeps exactly one
-- source on every row: an existing slip keeps its batch, a new one carries its
-- period, and no row can claim both or neither.
--
-- Section 10 item 8: a published slip is never edited. A correction after a
-- reopen publishes a revision that points at the slip it replaces, and the
-- earlier slip stays readable by the employee. The UNIQUE (employee_id, period)
-- constraint would forbid that second row, so it is replaced by a partial unique
-- index over the slips that have not been superseded: exactly one current slip
-- per employee and period, revisions beside it.
--
-- Down, and what it costs. This migration comes down cleanly only while no slip
-- has been published from a payroll period:
--   1. SELECT count(*) FROM payslips WHERE source_period_id IS NOT NULL;  -- must be 0
--      If it is not, stop. Restoring source_batch_id NOT NULL would have nothing
--      to put in it, and dropping source_period_id would erase the only record of
--      where those slips came from. Withdraw the payroll endpoints instead and
--      leave the columns in place.
--   2. The revision pair references itself, so break the links first:
--        UPDATE payslips SET superseded_by_id = NULL WHERE superseded_by_id IS NOT NULL;
--        UPDATE payslips SET revision_of = NULL WHERE revision_of IS NOT NULL;
--   3. DROP TRIGGER payslips_one_current_per_period ON payslips;
--      DROP FUNCTION enforce_one_current_payslip;
--      DROP INDEX payslips_current_per_period_idx;
--      ALTER TABLE payslips ADD CONSTRAINT payslips_employee_id_period_key UNIQUE (employee_id, period);
--      The last step succeeds only once every revision row is gone, since two
--      rows would share (employee_id, period).
--   4. Restore the 0018 immutability guard, which this migration narrows:
--        see apps/api/migrations/0018_payslip_published_immutability.sql.
--   5. ALTER TABLE payslips DROP CONSTRAINT payslips_exactly_one_source,
--        DROP CONSTRAINT payslips_superseded_by_fk, DROP CONSTRAINT payslips_revision_is_not_itself,
--        DROP COLUMN superseded_by_id, DROP COLUMN revision_of, DROP COLUMN source_period_id,
--        ALTER COLUMN source_batch_id SET NOT NULL;

ALTER TABLE payslips
  ALTER COLUMN source_batch_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_period_id uuid NULL
    REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revision_of uuid NULL
    REFERENCES payslips(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid NULL;

-- The slip being superseded has to step aside before its replacement can be
-- inserted, or both would be current at once and the partial unique index below
-- would refuse the pair. So the reference points at a row written later in the
-- same transaction and is checked at commit, as 0056 does for employments.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payslips_superseded_by_fk') THEN
    ALTER TABLE payslips
      ADD CONSTRAINT payslips_superseded_by_fk
      FOREIGN KEY (superseded_by_id) REFERENCES payslips(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payslips_exactly_one_source') THEN
    ALTER TABLE payslips
      ADD CONSTRAINT payslips_exactly_one_source
      CHECK ((source_batch_id IS NULL) <> (source_period_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payslips_revision_is_not_itself') THEN
    ALTER TABLE payslips
      ADD CONSTRAINT payslips_revision_is_not_itself
      CHECK (revision_of IS DISTINCT FROM id AND superseded_by_id IS DISTINCT FROM id);
  END IF;
END;
$$;

-- One current slip per employee and period.
--
-- A partial unique index cannot express this. Replacing a slip means updating the
-- old row out of the index and inserting the new one in the same transaction, and
-- PostgreSQL refuses that: the old index entry still points at a tuple this
-- transaction has only just superseded, so the insert reads as a duplicate.
--
-- A deferred constraint trigger says the same thing and checks it where it is
-- actually true, at commit: by then the old row carries its successor and only
-- the replacement is current. A plain index serves the lookups.
ALTER TABLE payslips DROP CONSTRAINT IF EXISTS payslips_employee_id_period_key;

CREATE INDEX IF NOT EXISTS payslips_current_per_period_idx
  ON payslips (employee_id, period)
  WHERE superseded_by_id IS NULL;

CREATE OR REPLACE FUNCTION enforce_one_current_payslip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_count integer;
BEGIN
  SELECT count(*) INTO current_count
  FROM payslips
  WHERE employee_id = NEW.employee_id
    AND period = NEW.period
    AND superseded_by_id IS NULL;

  IF current_count > 1 THEN
    RAISE EXCEPTION 'more than one current payslip for employee % period %',
      NEW.employee_id, NEW.period
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payslips_one_current_per_period ON payslips;
CREATE CONSTRAINT TRIGGER payslips_one_current_per_period
AFTER INSERT OR UPDATE ON payslips
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_one_current_payslip();

CREATE INDEX IF NOT EXISTS payslips_source_period_idx
  ON payslips (source_period_id)
  WHERE source_period_id IS NOT NULL;

COMMENT ON COLUMN payslips.source_period_id IS
  'PAY-003: the payroll period this slip was published from. Exactly one of source_batch_id and source_period_id is set.';
COMMENT ON COLUMN payslips.revision_of IS
  'PAY-003 section 10 item 8: the published slip this one replaces after an approved reopen.';
COMMENT ON COLUMN payslips.superseded_by_id IS
  'PAY-003: set on a slip that a revision replaced. It stays readable; it is no longer the current slip.';

-- PAYSLIP-001 makes a published slip immutable, which is exactly right: the
-- content an employee was shown must never change. Marking a slip as replaced is
-- not a change to that content, though, and without it a correction could never
-- be recorded at all. The guard is narrowed to allow that one transition and
-- nothing else: superseded_by_id going from NULL to a value, with every other
-- column identical. A published slip still cannot be edited or deleted.
CREATE OR REPLACE FUNCTION prevent_published_payslip_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.superseded_by_id IS NULL
       AND NEW.superseded_by_id IS NOT NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
       AND NEW.period IS NOT DISTINCT FROM OLD.period
       AND NEW.lines IS NOT DISTINCT FROM OLD.lines
       AND NEW.source_format IS NOT DISTINCT FROM OLD.source_format
       AND NEW.source_batch_id IS NOT DISTINCT FROM OLD.source_batch_id
       AND NEW.source_period_id IS NOT DISTINCT FROM OLD.source_period_id
       AND NEW.revision_of IS NOT DISTINCT FROM OLD.revision_of
       AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
       AND NEW.published_by_account_id IS NOT DISTINCT FROM OLD.published_by_account_id
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published payslip is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
