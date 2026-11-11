-- EMP-011 Package 1: permission vocabulary.
-- Spec: docs/domain/employee-documents.md §6 (D-08, D-09, D-10). No account assignment is created.
--
-- Reading, downloading, proposing and withdrawing one's own documents needs no permission
-- (EMPLOYEE session linked to an employee). Reading another employee's archive needs
-- employee_documents.read; uploading, verifying, rejecting, replacing, removing and editing needs
-- employee_documents.manage. Both go to human_capital_admin only; no unit-scoped role carries
-- them, so managers never read their staff's documents by default. Super Admin does not receive
-- them through legacy compatibility.
--
-- Deployment order (DOC-001/DOC-002 D-17, OPS-MI8-REL-001 §4.5): between migrate and cutover the
-- old build does not know these keys and refuses to grant or revoke human_capital_admin.
--
-- Down: DELETE FROM role_permissions WHERE permission_key IN ('employee_documents.read', 'employee_documents.manage');
--       DELETE FROM permissions WHERE permission_key IN ('employee_documents.read', 'employee_documents.manage');
--       DELETE FROM schema_migrations WHERE name = '0142_employee_document_permissions.sql';
INSERT INTO permissions (permission_key, description) VALUES
  ('employee_documents.read', 'EMP-011: read employee document archives, download document files, and read the expiry and pending worklists'),
  ('employee_documents.manage', 'EMP-011: upload, verify, reject, replace, remove and edit employee documents')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission.key
FROM roles role
CROSS JOIN (VALUES ('employee_documents.read'), ('employee_documents.manage')) AS permission(key)
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
