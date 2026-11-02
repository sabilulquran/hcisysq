-- LOAN-001 Package 1: permission vocabulary.
-- Spec: docs/domain/employee-loans.md §6. No account assignment is created here.
--
-- D-13 DRAFT: Finance owns the money. finance_officer ("Staf Keuangan (Kasbon)", which already
-- keeps the PAY-003 kasbon register) receives both; human_capital_admin reads the register.
-- Both are organization-scoped, and Super Admin does not receive them through legacy
-- compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17): the build that knows these keys must already be
-- running when this migration applies, or the old build briefly refuses to assign the roles
-- that carry them. Release this on its own. See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'loans.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'loans.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('loans.read', 'LOAN-001: read the employee loan register, schedules, repayments and history'),
  ('loans.manage', 'LOAN-001: disburse approved loans, record and reverse repayments, cancel loans')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['loans.read', 'loans.manage']::text[]) AS permission_key
WHERE role.role_key = 'finance_officer'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'loans.read'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
