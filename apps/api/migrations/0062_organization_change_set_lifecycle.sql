-- ORG-008-3b: a change set can be discarded, and concurrent edits are detected.
-- docs/domain/organization-designer-ux-spec.md 5.2, 6.
--
-- 1. status gains DISCARDED. A discarded change set keeps its rows and its audit trail; it is never
--    deleted, and it can never become effective structure because loadEffectiveSnapshot selects
--    status = 'PUBLISHED' only. The lifecycle CHECK from 0019 is restated so DISCARDED is allowed
--    with published_at IS NULL: a change set that was published can no longer be discarded.
-- 2. revision counts mutations of a draft, so two operators editing the same change set cannot
--    overwrite each other silently (If-Match, 409 ORGANIZATION_DRAFT_CHANGED).
--
-- Only the change set header is touched. No snapshot row, published structure, approval snapshot,
-- rollout setting, or employee record is read or written here, and nothing is seeded.
--
-- Older releases tolerate both changes: an unknown status string is never selected as effective
-- structure (the query filters PUBLISHED) and is mapped without runtime validation, and the extra
-- column is absent from every column list they write. See the rollback note below.
--
-- Rollback/recovery (no data loss in either direction):
--   1. Discarded change sets must first be moved back, because the old CHECK rejects the value:
--      UPDATE organization_change_sets SET status = 'DRAFT', validated_at = NULL,
--             validation_report = '{}'::jsonb
--      WHERE status = 'DISCARDED';
--   2. ALTER TABLE organization_change_sets DROP CONSTRAINT organization_change_sets_status_check;
--      ALTER TABLE organization_change_sets ADD CONSTRAINT organization_change_sets_status_check
--        CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED'));
--      ALTER TABLE organization_change_sets DROP CONSTRAINT organization_change_sets_lifecycle_check;
--      ALTER TABLE organization_change_sets ADD CHECK (
--        (status = 'DRAFT' AND validated_at IS NULL AND published_at IS NULL)
--        OR (status = 'VALIDATED' AND validated_at IS NOT NULL AND published_at IS NULL)
--        OR (status = 'PUBLISHED' AND validated_at IS NOT NULL AND published_at IS NOT NULL));
--   3. The revision column may stay: it is NOT NULL DEFAULT 0 and older releases never name it.
--      ALTER TABLE organization_change_sets DROP COLUMN revision;  -- only if it must go.
--
-- Idempotent: rerunning changes nothing further.

ALTER TABLE organization_change_sets
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

ALTER TABLE organization_change_sets
  DROP CONSTRAINT IF EXISTS organization_change_sets_status_check;

ALTER TABLE organization_change_sets
  ADD CONSTRAINT organization_change_sets_status_check
  CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DISCARDED'));

-- 0019 declared the lifecycle CHECK without a name, so it is dropped by looking it up rather than
-- by guessing the generated name, then re-added with an explicit name.
DO $$
DECLARE
  lifecycle_constraint text;
BEGIN
  FOR lifecycle_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'organization_change_sets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%validated_at%'
  LOOP
    EXECUTE format('ALTER TABLE organization_change_sets DROP CONSTRAINT %I', lifecycle_constraint);
  END LOOP;
END
$$;

ALTER TABLE organization_change_sets
  ADD CONSTRAINT organization_change_sets_lifecycle_check CHECK (
    (status = 'DRAFT' AND validated_at IS NULL AND published_at IS NULL)
    OR (status = 'VALIDATED' AND validated_at IS NOT NULL AND published_at IS NULL)
    OR (status = 'PUBLISHED' AND validated_at IS NOT NULL AND published_at IS NOT NULL)
    OR (status = 'DISCARDED' AND published_at IS NULL)
  );
