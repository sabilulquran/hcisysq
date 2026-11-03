-- EMP-012 Package 1: permission vocabulary.
-- Spec: docs/domain/employee-id-card.md §6. No account assignment is created here.
--
-- Viewing one's own card needs no permission (EMPLOYEE session linked to an employee). Managing
-- photos, issuing, reissuing, revoking and printing cards needs employee_cards.manage, granted to
-- human_capital_admin only. Super Admin does not receive it through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows this key must already be running
-- when this migration applies, or the old build briefly refuses to assign human_capital_admin.
-- Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key = 'employee_cards.manage';
--       DELETE FROM permissions WHERE permission_key = 'employee_cards.manage';
INSERT INTO permissions (permission_key, description) VALUES
  ('employee_cards.manage', 'EMP-012: manage employee card photos, issue, reissue, revoke and print employee ID cards, and read their history')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'employee_cards.manage'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
