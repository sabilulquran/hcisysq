-- RPT-001 Package 1: the two report roles now open the HR reports.
-- Spec: docs/domain/hr-reports.md §3 D-01, D-02, §9.
--
-- Migration 0109 described finance ("Pembaca Laporan") and management ("Pimpinan (Laporan)") as
-- "Belum berfungsi", because no screen checked reports.read/export.organization. RPT-001 wires
-- them to /admin/reports/hr, so only the descriptions change. role_key, names, permissions and
-- assignments are untouched; the permissions have been on these roles since migration 0004.
-- Unit scope for both roles is code (ROLE_SCOPES in role-assignment.ts), not data.
--
-- Deployment order: harmless in either order. An older build shows the new wording and still
-- grants nothing; this build works with the old wording.
--
-- Idempotent: rerunning writes the same values.
--
-- Rollback/recovery (restores the 0109 wording exactly):
--   UPDATE roles SET description = 'Disiapkan untuk melihat laporan organisasi. Belum berfungsi: laporan yang ada belum memakai peran ini.'
--     WHERE role_key = 'finance';
--   UPDATE roles SET description = 'Disiapkan untuk melihat dan mengunduh laporan organisasi. Belum berfungsi: laporan yang ada belum memakai peran ini.'
--     WHERE role_key = 'management';

UPDATE roles SET description = 'Melihat Laporan HR (daftar pegawai, rekap cuti, lembur, perjalanan dinas, pelatihan) tanpa mengunduh. Untuk seluruh organisasi atau satu unit.'
  WHERE role_key = 'finance';

UPDATE roles SET description = 'Melihat dan mengunduh Laporan HR (CSV/XLSX); setiap unduhan tercatat di audit. Untuk seluruh organisasi atau satu unit.'
  WHERE role_key = 'management';
