-- ADR-0008 (keputusan owner 2026-11-18, butir B5): Pengurus Yayasan boleh membaca gaji per orang.
-- Spec: docs/architecture/adr/0008-pengurus-yayasan-membaca-gaji-per-orang.md.
--
-- Migrasi ini hanya membuat kosakata: satu permission dan satu role untuk akun Organ Yayasan
-- (`FOUNDATION_BOARD`). TIDAK ADA akun yang menerima role ini di sini; pemberiannya lewat kanal
-- pemberian role (ORG-013-2) dengan alasan SK, scope organisasi, dan tanggal berakhir.
--
-- payroll.governance.results.read — membaca hasil payroll per orang dan baris slip untuk periode
--   yang sudah APPROVED atau sesudahnya, lewat route Portal Organ Yayasan. Tidak membuka daftar
--   transfer (payroll.transfers.read.organization), tidak membuka input, kebijakan, atau aksi
--   siklus periode, dan tidak memberi akses ke /app maupun /admin.
--
-- governance_payroll_reader — hanya membawa permission itu. Seperti BOARD_READ_PERMISSION, role ini
--   berada di luar seluruh bundel HC dan di luar kompatibilitas legacy Super Admin (ADR-0003):
--   tidak ada role HC, modul admin, atau Super Admin yang memperolehnya dari migrasi ini.
--   Akun pegawai tidak boleh menerimanya (ADR-0008 D-3, ditegakkan di role-assignment.ts).
--
-- Kepemilikan jabatan tidak pernah memberi capability (ORG-013-1 butir 3): role ini tidak pernah
-- ditautkan ke jabatan (AUTH-015 / ADR-0007 G-2 menolak role governance Organ Yayasan).
--
-- Urutan deploy (OPS-MI8-REL-001 §4.5): antara migrate dan cutover build lama melihat satu
-- permission dan satu role yang tidak dipakai siapa pun. Tidak ada yang melebar, dan jendelanya
-- berakhir di cutover.
--
-- Down: DELETE FROM account_role_assignments WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'governance_payroll_reader');
--       DELETE FROM role_permissions WHERE permission_key = 'payroll.governance.results.read';
--       DELETE FROM roles WHERE role_key = 'governance_payroll_reader';
--       DELETE FROM permissions WHERE permission_key = 'payroll.governance.results.read';
--       lalu deploy ulang build sebelumnya, yang tidak mengenal kunci ini.
INSERT INTO permissions (permission_key, description)
VALUES (
  'payroll.governance.results.read',
  'ADR-0008: Organ Yayasan membaca hasil payroll per orang dan baris slip untuk periode yang sudah disahkan'
)
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO roles (id, role_key, name, description, is_system)
VALUES (
  '10000000-0000-4000-8000-000000000007',
  'governance_payroll_reader',
  'Governance Payroll Reader',
  'Pembacaan gaji per orang oleh akun Pengurus Yayasan (ADR-0008). Hanya membawa payroll.governance.results.read.',
  true
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'payroll.governance.results.read' FROM roles WHERE role_key = 'governance_payroll_reader'
ON CONFLICT DO NOTHING;
