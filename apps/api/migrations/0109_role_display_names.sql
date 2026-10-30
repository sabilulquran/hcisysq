-- AUTH-011 §Nama peran (owner decision 2026-10-30): role names say what the role does.
-- docs/domain/hcis-authorization-modernization.md.
--
-- The owner could not tell "Finance" from "Keuangan" (one only reads reports, the other manages
-- employee loans), nor "Management" from "Unit Manager". Only the displayed name and description
-- change. role_key, permissions and existing assignments are untouched, so nothing that checks
-- access behaves differently.
--
-- Idempotent: rerunning writes the same values.
--
-- Rollback/recovery (restores the previous wording exactly):
--   UPDATE roles SET name = 'Human Capital',
--     description = 'Administrasi Human Capital sesuai permission dan scope yang diberikan.'
--     WHERE role_key = 'human_capital';
--   UPDATE roles SET name = 'Finance',
--     description = 'Akses ke workflow keuangan yang akan dibuka per modul.'
--     WHERE role_key = 'finance';
--   UPDATE roles SET name = 'Keuangan',
--     description = 'PAY-003: mengelola kasbon pegawai dan menyiapkan pembayaran periode payroll yang sudah disahkan.'
--     WHERE role_key = 'finance_officer';
--   UPDATE roles SET name = 'Management',
--     description = 'Dashboard dan report manajemen sesuai mandat.'
--     WHERE role_key = 'management';
--   UPDATE roles SET name = 'Unit Manager',
--     description = 'Akses tambahan untuk pengelolaan tim dan approval pada unit tertentu.'
--     WHERE role_key = 'unit_manager';
--   UPDATE roles SET name = 'Special Approver',
--     description = 'Capability approval tertentu di luar resolver struktur normal.'
--     WHERE role_key = 'special_approver';

UPDATE roles SET name = 'Staf Human Capital',
  description = 'Mengerjakan administrasi kepegawaian sehari-hari. Untuk seluruh organisasi, atau untuk satu unit sebagai petugas HC unit tersebut.'
  WHERE role_key = 'human_capital';

-- finance and management carry reports.read/export.organization, which no screen checks yet. Their
-- descriptions say so, so nobody grants them expecting access they do not give.
UPDATE roles SET name = 'Pembaca Laporan',
  description = 'Disiapkan untuk melihat laporan organisasi. Belum berfungsi: laporan yang ada belum memakai peran ini.'
  WHERE role_key = 'finance';

UPDATE roles SET name = 'Staf Keuangan (Kasbon)',
  description = 'Mengelola kasbon pegawai yang dipotong dari gaji.'
  WHERE role_key = 'finance_officer';

UPDATE roles SET name = 'Pimpinan (Laporan)',
  description = 'Disiapkan untuk melihat dan mengunduh laporan organisasi. Belum berfungsi: laporan yang ada belum memakai peran ini.'
  WHERE role_key = 'management';

UPDATE roles SET name = 'Kepala Unit',
  description = 'Menandai siapa yang memimpin satu unit. Selalu untuk satu unit.'
  WHERE role_key = 'unit_manager';

-- Not "Penyetuju Cuti Khusus": cuti khusus is a leave type, and this role does not approve it.
UPDATE roles SET name = 'Penyetuju Cuti di Luar Jalur',
  description = 'Dapat ditunjuk sebagai penyetuju cuti di luar rantai atasan yang biasa.'
  WHERE role_key = 'special_approver';
