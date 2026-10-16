-- AUTH-011: owner decision 2026-10-16 — only Super Admin grants or removes roles; Human Capital
-- may not delegate its role or permissions. The API already returns 403 ROLE_GRANT_SUPER_ADMIN_ONLY
-- to every non-Super-Admin principal, so access.roles.assign grants nothing to human_capital_admin.
-- Remove it from that role so stored grants match the decision.
--
-- Scope: one role_permissions row. The permission key stays in the catalog because legacy Super Admin
-- compatibility (ADMIN_PERMISSIONS) still requires it. No account assignment is touched.
-- Idempotent: rerunning deletes nothing further.
--
-- Rollback/recovery (only on a new explicit owner decision; it does not let HC grant roles,
-- because assertRoleGrantor still requires a Super Admin principal):
--   INSERT INTO role_permissions (role_id, permission_key)
--   SELECT id, 'access.roles.assign' FROM roles WHERE role_key = 'human_capital_admin'
--   ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
WHERE permission_key = 'access.roles.assign'
  AND role_id IN (SELECT id FROM roles WHERE role_key = 'human_capital_admin');
