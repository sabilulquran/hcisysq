-- HELP-001 Package 1: permission vocabulary.
-- Spec: docs/domain/help-center.md §6 (D-08 DRAFT). No account assignment is created here.
--
-- Reading the help center needs no permission (any EMPLOYEE session, D-07). Managing it needs
-- help.manage, granted to human_capital_admin only. Super Admin does not receive it through
-- legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows this key must already be running
-- when this migration applies, or the old build briefly refuses to assign human_capital_admin.
-- Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key = 'help.manage';
--       DELETE FROM permissions WHERE permission_key = 'help.manage';
INSERT INTO permissions (permission_key, description) VALUES
  ('help.manage', 'HELP-001: manage help center articles and HC contacts, and read their history')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'help.manage'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
