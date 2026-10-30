-- AUTH-014 F2 (ADR-0006): the Module Administrator role, and the audit columns the SQ Hub channel
-- needs. docs/domain/sq-core-administrator-layers.md §4, §2.7, §6.
--
-- Owner decision 2026-10-27: SQ Core has three administrator layers, not four. Platform Admin (in
-- SQ Hub) owns people and access, including every role grant in every module. Module Admin owns
-- module configuration only and never grants roles or touches accounts. Work roles stay inside
-- each module.
--
-- This migration is purely additive and changes no behaviour on its own:
--   * nobody holds hcis_module_admin after it runs — granting is a separate, reviewed action;
--   * the two audit columns are nullable, so every existing writer keeps working unchanged;
--   * no existing role, permission mapping, assignment, account or session is touched. In
--     particular human_capital_admin keeps every permission it has today. Narrowing that bundle is
--     F6, a separate migration, run only after this role is granted and observed (§4.4).
--
-- What is deliberately NOT here:
--   * access.read and organization.role_seat_links.manage (§4.2, §8.1). Both exist to re-guard
--     routes that are guarded differently today; creating them before their guards change would
--     add permission keys that nothing checks. They land with those guard changes.
--
-- The role UUID continues the series: ...015 is the last one taken (0102). ON CONFLICT names
-- role_key, which does NOT cover a duplicate primary key, so a reused id aborts the whole
-- migration with 23505 on roles_pkey rather than doing nothing. ...012 is finance_officer (0069).
--
-- Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   1. Remove every assignment of this role through the reviewed route
--      DELETE /admin/access/role-assignments/:assignmentId (writes role.assignment.removed).
--   2. Verify none remain, because account_role_assignments.role_id is a foreign key:
--      SELECT count(*) FROM account_role_assignments a JOIN roles r ON r.id = a.role_id
--       WHERE r.role_key = 'hcis_module_admin';
--      Only when that count is 0:
--      DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'hcis_module_admin');
--      DELETE FROM roles WHERE role_key = 'hcis_module_admin';
--   3. The attendance.devices.technical catalog row is left in place: it describes a permission the
--      application really guards, and removing it would break nothing but would restore the gap.
--   4. DROP INDEX IF EXISTS access_audit_events_hub_request_idx;
--      ALTER TABLE access_audit_events DROP COLUMN IF EXISTS hub_request_id;
--      ALTER TABLE access_audit_events DROP COLUMN IF EXISTS actor_source;
--   Audit rows are never deleted.

-- 1. Audit columns for the SQ Hub channel (§2.7).
--
-- actor_account_id already exists (migration 0004) and is already written; only these two are new.
-- actor_source stays nullable rather than defaulting to a value: a NULL means "written before
-- AUTH-014", which is the truth, and backfilling a guess would make old rows claim a provenance
-- nobody verified.
ALTER TABLE access_audit_events
  ADD COLUMN IF NOT EXISTS actor_source text NULL,
  ADD COLUMN IF NOT EXISTS hub_request_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'access_audit_events_actor_source_check'
  ) THEN
    ALTER TABLE access_audit_events
      ADD CONSTRAINT access_audit_events_actor_source_check
      CHECK (actor_source IS NULL OR actor_source IN ('sq_hub', 'hcis_break_glass'));
  END IF;
END $$;

-- §2.3: one SQ Hub request produces at most one HCIS event *per action*, so a grant and a later
-- revocation may share a requestId while neither can be replayed. Without this, a captured request
-- replayed while the machine token is still valid would re-create a just-revoked assignment, and
-- two-sided reconciliation by requestId would read the duplicate as a match.
--
-- Not CONCURRENTLY: the migration runner wraps each file in a transaction, and CREATE INDEX
-- CONCURRENTLY cannot run inside one. The build takes a lock that blocks audit writes for its
-- duration; on today's table that is milliseconds, but it is a real consideration as it grows.
CREATE UNIQUE INDEX IF NOT EXISTS access_audit_events_hub_request_idx
  ON access_audit_events (hub_request_id, action)
  WHERE hub_request_id IS NOT NULL;

-- 2. One permission key that the catalog never had.
--
-- attendance.devices.technical is declared in ADMIN_PERMISSIONS and really guards routes
-- (physical-parity-extended-routes, physical-mode-permissions), but no migration ever inserted it
-- into `permissions`. So it could not be granted to anyone: role_permissions has a foreign key to
-- that table, and only legacy Super Admin compatibility — which reads the TypeScript list, not the
-- table — ever satisfied those guards. Granting it below without this insert fails with 23503.
--
-- Adding it grants nothing new to the Module Administrator beyond what it already holds. The routes
-- that read it require ALL of the listed permissions (requirePermissionsFromCookie uses `every`),
-- and they pair it with attendance.devices.firmware, which stays outside this role (§4.3). Where
-- physicalModePermissions adds it, it is the canary/dry-run path, which costs *more* permissions
-- than mode: "execute" — and execute needs only attendance.devices.operate, which the role has.
INSERT INTO permissions (permission_key, description)
VALUES (
  'attendance.devices.technical',
  'AUTH-011/ADMS: operasi teknis perangkat absensi, termasuk jalur canary; selalu dipakai bersama izin perangkat lain'
)
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

-- 3. The Module Administrator role (§4.1, §4.2).
--
-- Every permission below already exists in the catalog and is already carried by
-- human_capital_admin. The point of the role is not new capability; it is the line between
-- configuring the module and doing the work inside it. Nothing here touches people's data:
-- employees.*, employment.*, documents.*, leave decisions, payroll runs and every access.* key
-- stay outside it on purpose (§4.3).
INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000016', 'hcis_module_admin', 'Admin Modul HCIS',
   'AUTH-014: mengatur isi dan jalannya modul HCIS — shift dan jadwal, kebijakan kehadiran, perangkat absensi, jenis cuti, komponen gaji dan periode payroll. Tidak memberi peran dan tidak menyentuh akun orang. Diberikan oleh Admin Platform dengan scope organisasi dan alasan penugasan.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  -- jadwal dan kebijakan kehadiran
  'attendance.schedule.manage',
  'attendance.policy.manage',
  'attendance.shift_swap.manage',
  'attendance.calculation.run',
  -- perangkat absensi, yang non-destruktif saja; destructive/biometrics/firmware tetap terpisah
  'attendance.devices.read',
  'attendance.devices.configure',
  'attendance.devices.operate',
  'attendance.devices.export',
  'attendance.devices.technical',
  -- konfigurasi cuti
  'leave.configuration.manage',
  -- konfigurasi payroll: bentuk perhitungannya, bukan angka seorang pegawai
  'payroll.policies.manage',
  'payroll.periods.manage'
]::text[]) AS permission_key
WHERE role.role_key = 'hcis_module_admin'
ON CONFLICT DO NOTHING;
