-- ORG-004 (DRAFT D-R1, 2026-11-20): `organization_rollout_settings.workflow_key` hanya boleh
-- berisi kunci workflow yang benar-benar dicari runtime.
-- Spec: docs/domain/dynamic-organization-structure.md "Kunci workflow rollout".
--
-- Migrasi 0019 hanya mensyaratkan kuncinya tidak kosong. Route admin bahkan memberi default
-- `"LEAVE"`, sementara runtime mencari `leave.annual`, `leave.unpaid`, `LOAN`, `OVERTIME`, dan
-- seterusnya. Akibatnya baris dengan kunci yang tidak cocok dengan apa pun diterima tanpa keluhan,
-- dan `resolveRolloutSetting` jatuh diam-diam ke `LEGACY`: operator mengira satu unit sudah
-- dipindahkan ke `STRUCTURE` padahal tidak. Kegagalan diam pada saklar kewenangan adalah bentuk
-- terburuk yang bisa diambil bug ini, jadi databaselah yang menolaknya — bukan hanya route, supaya
-- jalur penulisan lain (psql, skrip, perbaikan data) ikut tertolak.
--
-- Daftar di bawah wajib sama persis dengan `ORGANIZATION_WORKFLOW_KEYS` di
-- `apps/api/src/modules/organization/workflow-keys.ts`; `workflow-keys.test.ts` membandingkan
-- keduanya. Menambah workflow baru berarti menambah entri di sana dan satu migrasi baru di sini.
--
-- Aditif dan tidak menulis ulang baris mana pun. Produksi tidak punya satu pun baris rollout
-- (ORG-004 sengaja tidak menyemai apa pun, dan hasil operasionalnya tetap `LEGACY`), sehingga
-- constraint ini pasti terpasang. Bila sebuah environment ternyata punya baris dengan kunci asing,
-- `ALTER TABLE ... ADD CONSTRAINT` akan gagal dan menyebut barisnya — itu memang yang diinginkan:
-- baris seperti itu tidak pernah berpengaruh dan harus ditinjau, bukan dibiarkan.
--
-- Rollback:
--   ALTER TABLE organization_rollout_settings
--     DROP CONSTRAINT organization_rollout_settings_workflow_key_known;
--
-- Idempotent: menjalankan ulang tidak mengubah apa pun lagi.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_rollout_settings_workflow_key_known'
  ) THEN
    ALTER TABLE organization_rollout_settings
      ADD CONSTRAINT organization_rollout_settings_workflow_key_known
      CHECK (workflow_key IN (
        'leave.annual',
        'leave.employee_marriage',
        'leave.child_marriage',
        'leave.child_circumcision',
        'leave.hajj',
        'leave.unpaid',
        'LOAN',
        'OVERTIME',
        'PERF',
        'REIMBURSEMENT',
        'TRAINING',
        'TRIP',
        'WORK_ARRANGEMENT'
      ));
  END IF;
END $$;
