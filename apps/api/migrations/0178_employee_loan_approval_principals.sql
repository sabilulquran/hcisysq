-- LOAN-002 / ORG-013-5: principal akun Organ Yayasan pada langkah approval pinjaman.
-- Spec: docs/domain/employee-loans.md §16, docs/domain/organ-account-approver.md (amandemen 2026-11-18).
--
-- Cermin persis migrasi 0023 untuk cuti. Keputusan pemilik 18 Nov 2026 memasukkan Ketua Yayasan,
-- Bendahara Yayasan, dan Pembina ke rantai kasbon. Mereka tidak pernah menjadi pegawai HCIS: di
-- struktur ORG-004 kursinya dipegang akun (`holderSource = 'ACCOUNT'`), sehingga langkah approval
-- pinjaman harus dapat menunjuk akun, bukan hanya pegawai.
--
-- 1. employee_loan_approval_steps.approver_employee_id menjadi NULL-able dan mendapat pasangan
--    approver_account_id, dengan CHECK XOR: tepat satu principal per langkah. Baris lama tidak
--    ditulis ulang.
-- 2. Indeks inbox untuk principal akun, sejajar dengan indeks pegawai yang sudah ada (0122).
-- 3. Permission `loans.governance.approve` dan role sistem `governance_loan_approver`, sejajar
--    dengan `leave.governance.approve` / `governance_leave_approver`. Memegang kursi tidak pernah
--    memberi capability (ORG-013-1): akun harus aktif DAN memegang role ini.
--
-- Aditif. Tidak ada langkah approval lama yang berubah, dan tanpa rollout `STRUCTURE` untuk LOAN
-- tidak ada langkah milik akun yang pernah dibuat.
--
-- Rollback (hanya selama belum ada langkah milik akun; cek dulu
-- `SELECT count(*) FROM employee_loan_approval_steps WHERE approver_account_id IS NOT NULL`):
--   ALTER TABLE employee_loan_approval_steps DROP CONSTRAINT employee_loan_approval_steps_exactly_one_principal;
--   DROP INDEX IF EXISTS employee_loan_approval_steps_account_inbox_idx;
--   ALTER TABLE employee_loan_approval_steps DROP COLUMN approver_account_id;
--   ALTER TABLE employee_loan_approval_steps ALTER COLUMN approver_employee_id SET NOT NULL;
--   DELETE FROM role_permissions WHERE permission_key = 'loans.governance.approve';
--   DELETE FROM roles WHERE role_key = 'governance_loan_approver';
--   DELETE FROM permissions WHERE permission_key = 'loans.governance.approve';
--
-- Idempotent: menjalankan ulang tidak mengubah apa pun lagi.

ALTER TABLE employee_loan_approval_steps
  ALTER COLUMN approver_employee_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS approver_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employee_loan_approval_steps_exactly_one_principal'
  ) THEN
    ALTER TABLE employee_loan_approval_steps
      ADD CONSTRAINT employee_loan_approval_steps_exactly_one_principal
      CHECK (num_nonnulls(approver_employee_id, approver_account_id) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employee_loan_approval_steps_account_inbox_idx
  ON employee_loan_approval_steps (approver_account_id)
  WHERE approver_account_id IS NOT NULL AND status = 'pending';

INSERT INTO permissions (permission_key, description)
VALUES ('loans.governance.approve', 'Approve an explicitly snapshotted governance employee-loan step')
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO roles (id, role_key, name, description, is_system)
VALUES (
  '10000000-0000-4000-8000-000000000017',
  'governance_loan_approver',
  'Governance Loan Approver',
  'Minimum capability for an explicitly selected Foundation Board employee-loan authority.',
  true
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'loans.governance.approve' FROM roles WHERE role_key = 'governance_loan_approver'
ON CONFLICT DO NOTHING;
