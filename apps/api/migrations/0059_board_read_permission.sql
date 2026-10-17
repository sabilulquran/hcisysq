-- ORG-010 (ACCEPTED 2026-10-17): board view for Employees and HCIS governance summary for SQ Hub.
-- docs/domain/foundation-board-governance-summary.md §1, §8, §10.
--
-- 1. Permission board.read and the system role foundation_board_viewer ("Panel Organ Yayasan", D11)
--    carrying only board.read. board.read is outside every HC bundle and outside legacy Super Admin
--    compatibility (ADMIN_PERMISSIONS); only Super Admin grants the role, organization scope only (D1).
-- 2. Two nullable audit columns on auth_audit_events so governance.summary.denied can carry its
--    reason code (§7) and auth.oidc.identity_handed_over can name the previous account (§5).
--    reason_code is restricted to an upper-case code, so no token, claim or free text fits in it.
--
-- No assignment is seeded, no account is changed, and no real identity appears here.
-- Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   1. Remove every foundation_board_viewer assignment through the reviewed route
--      DELETE /admin/access/role-assignments/:assignmentId (writes role.assignment.removed).
--   2. DELETE FROM role_permissions WHERE permission_key = 'board.read';
--      DELETE FROM roles WHERE role_key = 'foundation_board_viewer';
--      DELETE FROM permissions WHERE permission_key = 'board.read';
--   The audit columns may stay (nullable, unused by older code). Audit rows are never deleted.

INSERT INTO permissions (permission_key, description) VALUES
  ('board.read', 'Membaca Panel Organ Yayasan (agregat)')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000010', 'foundation_board_viewer', 'Panel Organ Yayasan',
   'ORG-010: membaca Panel Organ Yayasan (agregat) untuk anggota organ Yayasan yang juga pegawai. Hanya Super Admin yang memberikan; scope organisasi.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'board.read' FROM roles WHERE role_key = 'foundation_board_viewer'
ON CONFLICT DO NOTHING;

ALTER TABLE auth_audit_events
  ADD COLUMN IF NOT EXISTS reason_code text NULL,
  ADD COLUMN IF NOT EXISTS related_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_audit_events_reason_code_format') THEN
    ALTER TABLE auth_audit_events
      ADD CONSTRAINT auth_audit_events_reason_code_format
      CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z_]{0,63}$');
  END IF;
END $$;
