-- Explicit requester-reporting anchor for rangkap jabatan. Existing data is
-- intentionally left false: it is never guessed from title or creation order.
ALTER TABLE organization_incumbencies
  ADD COLUMN IF NOT EXISTS is_primary_structural boolean NOT NULL DEFAULT false;

ALTER TABLE organization_incumbencies
  ADD CONSTRAINT organization_incumbencies_primary_structural_employee_check
  CHECK (NOT is_primary_structural OR (kind = 'PRIMARY' AND employee_id IS NOT NULL));

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE organization_incumbencies
  ADD CONSTRAINT organization_incumbencies_one_primary_structural_period
  EXCLUDE USING gist (
    change_set_id WITH =,
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (is_primary_structural);
