-- PERF-001 Package 1: permission vocabulary.
-- Spec: docs/domain/performance-review.md §8. No account assignment is created here.
--
-- Both permissions join human_capital_admin: at YSQ Human Capital runs the cycle and validates
-- the result. They are organization-scoped, so a unit-scoped HC role grants nothing, and Super
-- Admin does not receive them through legacy compatibility. Performance results are personal data.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign
-- human_capital_admin. Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'performance.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'performance.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('performance.read', 'PERF-001: read performance cycles, every review and the per-employee history'),
  ('performance.manage', 'PERF-001: run performance cycles, assign raters, validate or return results')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['performance.read', 'performance.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
