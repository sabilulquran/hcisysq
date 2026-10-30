-- ORG-011 Package 2: bind a classification to a seat and to a placement.
-- Spec: docs/domain/job-classification-grade.md §3.3 and §4. ADR: ADR-0004.
--
-- Two layers, as the spec defines them:
--   organization_positions.job_classification_code  the seat's default, inside the change set,
--     because what changes is the seat, not the catalog;
--   employment_placements.job_classification_code   the person's own, set through an
--     employment action (EMP-006), and it wins when both are present.
--
-- Both are nullable and nothing reads them for money yet: PAY-003 keeps using
-- functional_position_ref / structural_position_ref until its own parallel run passes.
-- Adding these columns therefore changes no payslip.
--
-- No foreign key to job_classifications, for the same reason the catalog carries none to
-- job_grades: both sides are effective-dated, and a plain FK would compare rows without
-- regard to their dates while blocking a classification from ever being superseded. The
-- resolver validates the code against the version in force on the date it is asked about.
--
-- Down:
--   ALTER TABLE employment_placements DROP COLUMN IF EXISTS job_classification_code;
--   ALTER TABLE organization_positions DROP COLUMN IF EXISTS job_classification_code;

ALTER TABLE organization_positions
  ADD COLUMN IF NOT EXISTS job_classification_code text NULL;

ALTER TABLE employment_placements
  ADD COLUMN IF NOT EXISTS job_classification_code text NULL;

-- NOT VALID first: a plain ADD CONSTRAINT CHECK scans the whole table under ACCESS
-- EXCLUSIVE. Both tables already hold production rows, and every existing row has NULL here
-- anyway, so the scan is pure cost. VALIDATE takes a weaker lock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_positions_job_classification_code_check'
  ) THEN
    ALTER TABLE organization_positions
      ADD CONSTRAINT organization_positions_job_classification_code_check
      CHECK (job_classification_code IS NULL OR job_classification_code ~ '^[A-Z][A-Z0-9_]{0,47}$')
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employment_placements_job_classification_code_check'
  ) THEN
    ALTER TABLE employment_placements
      ADD CONSTRAINT employment_placements_job_classification_code_check
      CHECK (job_classification_code IS NULL OR job_classification_code ~ '^[A-Z][A-Z0-9_]{0,47}$')
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE organization_positions
  VALIDATE CONSTRAINT organization_positions_job_classification_code_check;
ALTER TABLE employment_placements
  VALIDATE CONSTRAINT employment_placements_job_classification_code_check;

-- No index on job_classification_code. The resolver reaches positions through
-- (change_set_id, stable_key) and placements through employment_id, both already indexed;
-- an index nothing queries is only write cost. Package 3 adds one if a catalog screen needs
-- "who holds this classification".
