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
--   DELETE FROM schema_migrations WHERE name = '0107_employee_management_scope.sql';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS management_scope text NOT NULL DEFAULT 'MANAGED',
  ADD COLUMN IF NOT EXISTS management_scope_reason text NULL,
  ADD COLUMN IF NOT EXISTS management_scope_note text NULL,
  ADD COLUMN IF NOT EXISTS management_scope_marked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS management_scope_marked_by_account_id uuid NULL
    REFERENCES accounts(id) ON DELETE SET NULL;

-- Constraint-nya dijatuhkan dulu lalu dipasang lagi, bukan dilewati bila
-- namanya sudah ada. Migrasi ini belum pernah masuk production, jadi
-- definisinya masih bisa berubah; dengan pola "IF NOT EXISTS" sebuah basis
-- data yang sudah menjalankan versi sebelumnya akan diam-diam menyimpan
-- aturan yang lama — dan itulah yang membuat CI gagal sekali.
ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_management_scope_check,
  DROP CONSTRAINT IF EXISTS employees_management_scope_reason_check,
  DROP CONSTRAINT IF EXISTS employees_management_scope_marked_check;

ALTER TABLE employees
  ADD CONSTRAINT employees_management_scope_check
    CHECK (management_scope IN ('MANAGED', 'OUTSIDE_HCIS')),
  -- Alasan hanya ada pada baris yang ditandai, dan selalu ada di sana: tanpa
  -- ini sebuah baris dapat berakhir di luar pengelolaan tanpa seorang pun
  -- tahu kenapa.
  ADD CONSTRAINT employees_management_scope_reason_check
    CHECK (
      (management_scope = 'MANAGED' AND management_scope_reason IS NULL)
      OR (management_scope = 'OUTSIDE_HCIS'
          AND management_scope_reason IN ('BUMY', 'PENGURUS_YAYASAN'))
    ),
  -- Siapa menandai dan kapan, pada baris yang ditandai — dan tidak ada sisa
  -- penanda pada baris yang kembali dikelola. Separuh aturan saja membuat
  -- sebuah baris `MANAGED` dapat menyimpan tanggal penandaan lama yang tidak
  -- berarti apa-apa lagi.
  --
  -- `management_scope_note` sengaja di luar aturan ini: catatan terakhir —
  -- termasuk alasan membuka tanda — adalah satu-satunya tempat alasan itu
  -- tersimpan, karena audit hanya memuat panjangnya (spec §8.7).
  ADD CONSTRAINT employees_management_scope_marked_check
    CHECK (
      (management_scope = 'OUTSIDE_HCIS'
        AND management_scope_marked_at IS NOT NULL
        AND management_scope_note IS NOT NULL)
      OR (management_scope = 'MANAGED'
        AND management_scope_marked_at IS NULL
        AND management_scope_marked_by_account_id IS NULL)
    );

-- Indeks parsial pada baris yang ditandai saja: jumlahnya sedikit, dan daftar
-- "di luar pengelolaan HCIS" membacanya langsung. Kolomnya mengikuti urutan
-- daftar itu (`ORDER BY full_name, employee_number`), bukan alasannya, yang
-- tidak pernah dipakai sebagai filter.
--
-- Predikatnya sengaja tidak menyebut removed_at. Kolom itu datang dari migrasi
-- 0022, yang termasuk himpunan "recovered" pada rehearsal pemulihan riwayat
-- migrasi (scripts/rehearse-organization-migration-recovery.mjs): pada
-- skenario kanonikal migrasi itu belum dijalankan, sehingga berkas ini akan
-- gagal. Daftar admin pun tidak menyaring removed_at, jadi predikat itu justru
-- membuat indeksnya tidak terpakai.
CREATE INDEX IF NOT EXISTS employees_management_scope_idx
  ON employees (full_name, employee_number)
  WHERE management_scope = 'OUTSIDE_HCIS';
