-- ORG-008-6 (decision O-9): link a structural unit to the imported unit that role scopes point at.
-- docs/domain/organization-designer-ux-spec.md 5.4; ATT-011 D-11.
--
-- Why: HC notification for overtime has to reach the staff who look after "the employee's unit or
-- the unit above it" (ATT-011 D-11). Role scopes point at organizational_units, which is a flat
-- list with no parent, while the ORG-004 structure is the thing that actually has a hierarchy and
-- is not connected to it at all. Without a link, "the unit above" cannot be computed and a
-- notification can reach the wrong people.
--
-- Decision O-9 is to link rather than to move role scopes onto the structure: this column is
-- nullable, and a unit with no link simply falls back to the organisation-wide recipients ATT-011
-- already uses. Nothing is inferred and nothing is seeded.
--
-- ON DELETE SET NULL: removing an imported unit must never delete structure or published history,
-- it only drops the link.
--
-- Rollback/recovery:
--   ALTER TABLE organization_nodes DROP COLUMN legacy_unit_id;
--   Structure, published history, approval snapshots and rollout are untouched either way. An older
--   release ignores the column; it is absent from every column list such a release writes, so a
--   change set edited by an older release simply loses the links it did not know about. Re-link
--   through the unit screen if that happens.
--
-- Idempotent: rerunning changes nothing further.

ALTER TABLE organization_nodes
  ADD COLUMN IF NOT EXISTS legacy_unit_id uuid NULL
  REFERENCES organizational_units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS organization_nodes_legacy_unit_idx
  ON organization_nodes (legacy_unit_id)
  WHERE legacy_unit_id IS NOT NULL;
