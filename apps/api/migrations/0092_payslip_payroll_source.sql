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
-- Down:
--   DROP INDEX payslips_current_per_period_idx;
--   ALTER TABLE payslips ADD CONSTRAINT payslips_employee_id_period_key UNIQUE (employee_id, period);
--     (only possible while no superseded slip exists)
--   ALTER TABLE payslips DROP CONSTRAINT payslips_exactly_one_source,
--     DROP CONSTRAINT payslips_superseded_by_fk,
--     DROP COLUMN superseded_by_id, DROP COLUMN revision_of, DROP COLUMN source_period_id,
--     ALTER COLUMN source_batch_id SET NOT NULL;

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

-- One current slip per employee and period; a superseded one steps aside.
ALTER TABLE payslips DROP CONSTRAINT IF EXISTS payslips_employee_id_period_key;

CREATE UNIQUE INDEX IF NOT EXISTS payslips_current_per_period_idx
  ON payslips (employee_id, period)
  WHERE superseded_by_id IS NULL;

CREATE INDEX IF NOT EXISTS payslips_source_period_idx
  ON payslips (source_period_id)
  WHERE source_period_id IS NOT NULL;

COMMENT ON COLUMN payslips.source_period_id IS
  'PAY-003: the payroll period this slip was published from. Exactly one of source_batch_id and source_period_id is set.';
COMMENT ON COLUMN payslips.revision_of IS
  'PAY-003 section 10 item 8: the published slip this one replaces after an approved reopen.';
COMMENT ON COLUMN payslips.superseded_by_id IS
  'PAY-003: set on a slip that a revision replaced. It stays readable; it is no longer the current slip.';
