-- EMP-005 / EMP-006 / EMP-010 Package 1, step S2: permission vocabulary.
-- Spec §9. No account or role assignment is created here.
--
-- employment.read and employment.manage join the human_capital_admin bundle.
-- employment.correct (reversal, backdating beyond the window, document
-- correction, baseline re-run) is deliberately NOT bundled: D-16 grants it to
-- a senior HC officer through a separate, explicit role assignment.
-- Super Admin does not receive employment.* through legacy compatibility.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'employment.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'employment.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('employment.read', 'EMP-005/EMP-006: read employment history, PK/SK register, consistency report'),
  ('employment.manage', 'EMP-005/EMP-006: record employment actions and unlinked PK/SK'),
  ('employment.correct', 'EMP-005/EMP-006: reverse actions, backdate beyond window, correct linked PK/SK')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['employment.read', 'employment.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
