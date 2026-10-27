-- EMP-005 langkah S2B: penanda "di luar pengelolaan HCIS".
-- Spec: docs/domain/employment-administration-package1.md §8.7, EMP-005-L.
--
-- Keputusan owner 2026-10-16: data staf BUMY dan Pengurus Yayasan yang sudah
-- terlanjur ada di `employees` **tidak dihapus**. Keduanya ditandai di luar
-- pengelolaan HCIS: tetap dapat dibaca, tidak dapat diubah, dan tidak ikut
-- dalam daftar, hitungan, maupun kelayakan proses apa pun.
--
-- Penanda ini sengaja berdiri sendiri, bukan menumpang kolom yang sudah ada:
--
--   * `removed_at` berarti baris itu keluar dari populasi (EMP-001);
--   * `status` berarti status kepegawaiannya;
--   * `management_scope` berarti siapa yang mengelolanya.
--
-- Menggabungkannya akan membuat ketiganya tidak dapat dibedakan lagi di
-- kemudian hari.
--
-- Down (sah kapan pun; defaultnya membuat semua baris MANAGED lagi):
--   ALTER TABLE employees
--     DROP CONSTRAINT IF EXISTS employees_management_scope_reason_check,
--     DROP CONSTRAINT IF EXISTS employees_management_scope_marked_check,
--     DROP COLUMN IF EXISTS management_scope,
--     DROP COLUMN IF EXISTS management_scope_reason,
--     DROP COLUMN IF EXISTS management_scope_marked_at,
--     DROP COLUMN IF EXISTS management_scope_marked_by_account_id,
--     DROP COLUMN IF EXISTS management_scope_note;
--   DELETE FROM schema_migrations WHERE name = '0107_employee_management_scope';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS management_scope text NOT NULL DEFAULT 'MANAGED',
  ADD COLUMN IF NOT EXISTS management_scope_reason text NULL,
  ADD COLUMN IF NOT EXISTS management_scope_note text NULL,
  ADD COLUMN IF NOT EXISTS management_scope_marked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS management_scope_marked_by_account_id uuid NULL
    REFERENCES accounts(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_management_scope_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_management_scope_check
      CHECK (management_scope IN ('MANAGED', 'OUTSIDE_HCIS'));
  END IF;

  -- Alasan hanya ada pada baris yang ditandai, dan selalu ada di sana: tanpa
  -- ini sebuah baris dapat berakhir di luar pengelolaan tanpa seorang pun
  -- tahu kenapa.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_management_scope_reason_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_management_scope_reason_check
      CHECK (
        (management_scope = 'MANAGED' AND management_scope_reason IS NULL)
        OR (management_scope = 'OUTSIDE_HCIS'
            AND management_scope_reason IN ('BUMY', 'PENGURUS_YAYASAN'))
      );
  END IF;

  -- Siapa menandai dan kapan ikut tercatat pada baris yang ditandai.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_management_scope_marked_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_management_scope_marked_check
      CHECK (management_scope = 'MANAGED' OR management_scope_marked_at IS NOT NULL);
  END IF;
END
$$;

-- Indeks parsial pada baris yang ditandai saja: jumlahnya sedikit, dan daftar
-- "di luar pengelolaan HCIS" membacanya langsung.
--
-- Predikatnya sengaja tidak menyebut removed_at. Kolom itu datang dari migrasi
-- 0022, yang termasuk himpunan "recovered" pada rehearsal pemulihan riwayat
-- migrasi (scripts/rehearse-organization-migration-recovery.mjs): pada
-- skenario kanonikal migrasi itu belum dijalankan, sehingga berkas ini akan
-- gagal. Baris yang ditandai pun hanya segelintir, jadi menyaring removed_at
-- di indeks tidak memberi apa-apa.
CREATE INDEX IF NOT EXISTS employees_management_scope_idx
  ON employees (management_scope_reason, full_name)
  WHERE management_scope = 'OUTSIDE_HCIS';
