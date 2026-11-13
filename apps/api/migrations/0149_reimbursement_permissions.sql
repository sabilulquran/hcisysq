-- REIMB-001 Package 1: permission vocabulary.
-- Spec: docs/domain/reimbursement.md §6. No account assignment is created here.
--
-- D-12 DRAFT: Finance owns the money. finance_officer receives both; human_capital_admin reads
-- the register only. Both are organization-scoped, and Super Admin does not receive them through
-- legacy compatibility.
--
-- Deployment order (OPS-MI8-REL-001 §4.5): between migrate and cutover the old build sees these
-- keys on two roles it cannot yet delegate; nothing widens and the window ends at cutover.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'reimbursements.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'reimbursements.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('reimbursements.read', 'REIMB-001: read the reimbursement register, receipts, summary and export'),
  ('reimbursements.manage', 'REIMB-001: verify, reject and record payment of approved reimbursement claims')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['reimbursements.read', 'reimbursements.manage']::text[]) AS permission_key
WHERE role.role_key = 'finance_officer'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'reimbursements.read'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
