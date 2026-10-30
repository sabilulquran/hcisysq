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

-- NOT VALID first, then VALIDATE: a plain ADD CONSTRAINT CHECK scans the whole table under
-- ACCESS EXCLUSIVE. Both tables already hold production rows, and every existing row has NULL
-- here anyway, so that scan is pure cost.
--
-- The existence check is scoped by conrelid, not by conname alone. Constraint names are unique
-- per table, not per database, and the recovery rehearsal applies this file to more than one
-- schema in the same database: a bare `conname = ...` test sees the first schema's constraint,
-- skips the ADD in the second, and the VALIDATE below then fails on a constraint that is not
-- there. Scoping by relation keeps each schema independent, and `to_regclass` returns NULL
-- rather than raising when a table is absent.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT unnest(ARRAY['organization_positions', 'employment_placements']) AS table_name
  LOOP
    CONTINUE WHEN to_regclass(target.table_name) IS NULL;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass(target.table_name)
         AND conname = target.table_name || '_job_classification_code_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (job_classification_code IS NULL'
        || ' OR job_classification_code ~ ''^[A-Z][A-Z0-9_]{0,47}$'') NOT VALID',
        target.table_name, target.table_name || '_job_classification_code_check');
    END IF;

    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
      target.table_name, target.table_name || '_job_classification_code_check');
  END LOOP;
END
$$;

-- No index on job_classification_code. The resolver reaches positions through
-- (change_set_id, stable_key) and placements through employment_id, both already indexed;
-- an index nothing queries is only write cost. Package 3 adds one if a catalog screen needs
-- "who holds this classification".
