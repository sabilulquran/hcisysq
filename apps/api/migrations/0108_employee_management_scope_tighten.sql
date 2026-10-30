-- EMP-005 S2B: mengetatkan constraint penanda "di luar pengelolaan HCIS".
-- Spec: docs/domain/employment-administration-package1.md §8.7.
--
-- Kenapa berkas tersendiri, bukan menyunting 0107: begitu sebuah migrasi
-- tercatat di `schema_migrations`, runner tidak pernah menjalankannya lagi.
-- Basis data yang sudah memakai 0107 versi pertama akan menyimpan aturan yang
-- lama selamanya, dan suntingan pada berkas itu hanya berlaku untuk basis data
-- yang benar-benar baru — dua kenyataan yang berbeda dari satu berkas yang
-- sama. Yang ditambahkan di sini:
--
--   1. baris yang ditandai wajib punya catatan — tanpa itu tidak ada tempat
--      alasannya tersimpan, karena audit hanya memuat panjangnya;
--   2. baris yang kembali dikelola tidak boleh menyisakan penanda lama
--      (`marked_at`, `marked_by`), yang sebelumnya hanya diatur satu arah.
--
-- Aman dijalankan pada basis data yang sudah memakai 0107 versi akhir:
-- constraint-nya dijatuhkan lalu dipasang kembali dengan definisi yang sama.
--
-- Down (sah kapan pun; mengembalikan aturan 0107 versi pertama):
--   ALTER TABLE employees
--     DROP CONSTRAINT IF EXISTS employees_management_scope_marked_check;
--   ALTER TABLE employees
--     ADD CONSTRAINT employees_management_scope_marked_check
--     CHECK (management_scope = 'MANAGED' OR management_scope_marked_at IS NOT NULL);
--   DELETE FROM schema_migrations WHERE name = '0108_employee_management_scope_tighten.sql';

-- Tidak ada baris yang ditandai di luar lingkungan pengembangan, tetapi bila
-- ada, baris itu dirapikan dulu supaya constraint di bawah dapat dipasang:
-- yang MANAGED kehilangan sisa penandanya, dan yang OUTSIDE_HCIS tanpa catatan
-- mendapat catatan penanda bahwa alasannya memang tidak tercatat.
UPDATE employees
SET management_scope_marked_at = NULL,
    management_scope_marked_by_account_id = NULL
WHERE management_scope = 'MANAGED'
  AND (management_scope_marked_at IS NOT NULL OR management_scope_marked_by_account_id IS NOT NULL);

UPDATE employees
SET management_scope_note = 'Alasan tidak tercatat saat penandaan.'
WHERE management_scope = 'OUTSIDE_HCIS' AND management_scope_note IS NULL;

ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_management_scope_marked_check;

ALTER TABLE employees
  ADD CONSTRAINT employees_management_scope_marked_check
  CHECK (
    (management_scope = 'OUTSIDE_HCIS'
      AND management_scope_marked_at IS NOT NULL
      AND management_scope_note IS NOT NULL)
    OR (management_scope = 'MANAGED'
      AND management_scope_marked_at IS NULL
      AND management_scope_marked_by_account_id IS NULL)
  );
