-- DOC-001 / DOC-002 Package 1: permission vocabulary.
-- Spec: docs/domain/hr-documents.md §6. No account or role assignment is created here.
--
-- documents.read and documents.manage join the human_capital_admin bundle.
-- documents.discipline.manage is deliberately NOT bundled: warning letters are
-- sensitive and are granted through a separate, explicit role assignment (D-13).
-- documents.correct is NOT bundled either, following employment.correct.
-- Super Admin does not receive documents.* through legacy compatibility.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'documents.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'documents.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('documents.read', 'DOC-001/DOC-002: read the HR document register and letter requests'),
  ('documents.manage', 'DOC-001: decide certificate requests and issue certificates'),
  ('documents.discipline.manage', 'DOC-002: issue and read warning letters'),
  ('documents.correct', 'DOC-001/DOC-002: revoke an issued document')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['documents.read', 'documents.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
