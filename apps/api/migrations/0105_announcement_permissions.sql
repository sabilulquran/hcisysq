-- NOTIF-002 Package 1: permission vocabulary.
-- Spec: docs/domain/announcements-and-reminders.md §5. No account assignment is created here.
--
-- Both permissions join human_capital_admin: at YSQ Human Capital is who announces. They are
-- organization-scoped, so a unit-scoped HC role grants nothing, and Super Admin does not
-- receive them through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign
-- human_capital_admin. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'announcements.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'announcements.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('announcements.read', 'NOTIF-002: read the announcement register and its reach'),
  ('announcements.manage', 'NOTIF-002: compose, publish, correct and archive announcements')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['announcements.read', 'announcements.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
