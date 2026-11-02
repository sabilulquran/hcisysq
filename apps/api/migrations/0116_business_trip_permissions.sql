-- TRIP-001 Package 1: permission vocabulary.
-- Spec: docs/domain/business-travel.md §6. No account assignment is created here.
--
-- Both permissions join human_capital_admin: at YSQ Human Capital issues the assignment
-- letter. They are organization-scoped, so a unit-scoped HC role grants nothing, and Super
-- Admin does not receive them through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign
-- human_capital_admin. Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'trips.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'trips.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('trips.read', 'TRIP-001: read the business travel register and its history'),
  ('trips.manage', 'TRIP-001: issue assignment letters and cancel business trips')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['trips.read', 'trips.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
