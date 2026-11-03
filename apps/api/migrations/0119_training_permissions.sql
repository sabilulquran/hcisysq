-- TRAIN-001 Package 1: permission vocabulary.
-- Spec: docs/domain/training.md §8. No account assignment is created here.
--
-- Both permissions join human_capital_admin. They are organization-scoped, so a unit-scoped
-- HC role grants nothing, and Super Admin does not receive them through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign
-- human_capital_admin. Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'training.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'training.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('training.read', 'TRAIN-001: read training programs, attendance, records, certificates and hours'),
  ('training.manage', 'TRAIN-001: manage training programs, participants, attendance and verify records')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['training.read', 'training.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
