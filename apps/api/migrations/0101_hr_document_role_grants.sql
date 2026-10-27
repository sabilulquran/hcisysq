-- DOC-002 follow-up: make the warning-letter and revocation permissions reachable.
-- Spec: docs/domain/hr-documents.md §6 (D-13 revised, D-16 new).
--
-- Migration 0094 created documents.discipline.manage and documents.correct but gave them
-- to no role, and role-to-permission mapping only happens in migrations. The result was a
-- capability advertised as available that returned 403 for every account.
--
-- Two separate decisions:
--   1. documents.discipline.manage joins human_capital_admin. At YSQ the HC administrator
--      is the one who issues warning letters; D-13's concern is that line managers must not
--      see them, and they still cannot: the permission stays out of every unit-scoped role,
--      and /admin/documents/register never returns DISCIPLINARY rows.
--   2. documents.correct stays out of every bundle and gets its own role, so revoking an
--      issued document is a deliberate, separately granted act. The role also carries
--      documents.read, because revoking a document you cannot see is not a workflow.
--
-- Deployment order: the application build that knows these permission keys must already be
-- running when this migration applies. canDelegateRole refuses a role holding a permission
-- outside its allowlist, so an older build would briefly refuse to assign or revoke
-- human_capital_admin. See docs/development/mi8vps-hcis-release.md.
--
-- Down:
--   DELETE FROM role_permissions
--    WHERE permission_key = 'documents.discipline.manage'
--      AND role_id IN (SELECT id FROM roles WHERE role_key = 'human_capital_admin');
--   DELETE FROM role_permissions
--    WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'document_corrector');
--   DELETE FROM roles WHERE role_key = 'document_corrector';
--   (Revoke live assignments through DELETE /admin/access/role-assignments/:assignmentId first,
--    so the removal is audited. Audit rows are never deleted.)

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'documents.discipline.manage'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;

INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000015', 'document_corrector', 'Korektor Dokumen Kepegawaian',
   'DOC-001/DOC-002: membatalkan surat keterangan atau surat peringatan yang sudah terbit, dengan alasan tertulis. Nomor surat tetap terpakai dan tidak pernah didaur ulang. Hanya Super Admin yang memberikan; scope organisasi dan alasan penugasan wajib.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'documents.read',
  'documents.correct'
]::text[]) AS permission_key
WHERE role.role_key = 'document_corrector'
ON CONFLICT DO NOTHING;
