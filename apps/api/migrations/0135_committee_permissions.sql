-- ORG-012 Package 1: permission vocabulary.
-- Spec: docs/domain/committees.md §6 (D-18 DRAFT). No account assignment is created here.
--
-- Both permissions join human_capital_admin. They are organization-scoped, so a unit-scoped
-- HC role grants nothing, and Super Admin does not receive them through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign
-- human_capital_admin. Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'committees.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'committees.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('committees.read', 'ORG-012: read committees, their members, decrees, history and participation'),
  ('committees.manage', 'ORG-012: record committees, manage members, issue or record decrees, complete and cancel')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['committees.read', 'committees.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
