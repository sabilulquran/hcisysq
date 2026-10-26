-- ORG-005-1 (DRAFT, docs/domain/organization-sites-work-locations.md D-5-1, D-5-2): which work
-- location a structural unit works at.
--
-- The work-location list already exists as attendance_work_locations (ATT-003, name and geofence);
-- it becomes the organisation's single list of places instead of a second table (D-5-1). A unit
-- links to one location; units below inherit it unless they name their own (D-5-3, read-side only).
--
-- The column lives on organization_nodes, so a link is versioned with the change set like every
-- other part of the structure: it has an effective date, history, and the second pair of eyes at
-- publish. Nullable; nothing is inferred from a unit's name and nothing is seeded.
--
-- ON DELETE RESTRICT: published structure is history, and a location it names must not vanish from
-- under it. Locations are deactivated, never deleted, by every route that exists today.
--
-- Rollback/recovery:
--   ALTER TABLE organization_nodes DROP COLUMN work_location_id;
--   Structure, published history, approval snapshots, rollout and attendance are untouched. An older
--   release ignores the column; a change set it edits loses the links it does not know about, which
--   are redone on the unit panel.
--
-- Idempotent: rerunning changes nothing further.

ALTER TABLE organization_nodes
  ADD COLUMN IF NOT EXISTS work_location_id uuid NULL
  REFERENCES attendance_work_locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS organization_nodes_work_location_idx
  ON organization_nodes (work_location_id)
  WHERE work_location_id IS NOT NULL;
