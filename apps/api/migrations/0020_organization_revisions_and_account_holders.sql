-- ORG-004 production-UAT corrections. Additive and backward-compatible:
-- published snapshots remain immutable, same-day revisions become possible,
-- and every existing position/incumbency remains employee-held.

DROP INDEX IF EXISTS organization_change_sets_one_published_date_idx;

CREATE INDEX IF NOT EXISTS organization_change_sets_effective_revision_idx
  ON organization_change_sets (
    effective_on DESC,
    published_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE status = 'PUBLISHED';

ALTER TABLE organization_positions
  ADD COLUMN IF NOT EXISTS holder_source text NOT NULL DEFAULT 'EMPLOYEE';

ALTER TABLE organization_positions
  DROP CONSTRAINT IF EXISTS organization_positions_holder_source_check;

ALTER TABLE organization_positions
  ADD CONSTRAINT organization_positions_holder_source_check
  CHECK (holder_source IN ('EMPLOYEE', 'ACCOUNT'));

ALTER TABLE organization_incumbencies
  ADD COLUMN IF NOT EXISTS account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT;

ALTER TABLE organization_incumbencies
  ALTER COLUMN employee_id DROP NOT NULL;

ALTER TABLE organization_incumbencies
  DROP CONSTRAINT IF EXISTS organization_incumbencies_holder_check;

ALTER TABLE organization_incumbencies
  ADD CONSTRAINT organization_incumbencies_holder_check
  CHECK ((employee_id IS NOT NULL) <> (account_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS organization_incumbencies_account_idx
  ON organization_incumbencies (change_set_id, account_id, effective_from, effective_to)
  WHERE account_id IS NOT NULL;
