# Production release verification — hcis-aa1a5ded-20261027

- Spesifikasi: OPS-MI8-REL-001 (`docs/development/mi8vps-hcis-release.md`)
- Rilis: `hcis-aa1a5ded-20261027`, dari `main` `aa1a5ded764a22cb6421e3459f78c3423eec0a26`
- Bundle: build run 40465961515, `sha256=340baeb7ba297d31afb46c5b8061add49d52184164b52f686957d50d3f7fc62e`
- Operator: sesi PAY-003 (worktree `epic-bardeen-0c6e92`), lock perangkat diambil skrip
- Jendela: 2026-10-27 07:17–07:20 UTC (bukan jam 19 UTC)
- Rilis sebelumnya / sasaran rollback: `hcis-fcec4e6a-20261027`

## Isi

| PR | Perubahan |
|---|---|
| #219 | PAY-003 layar operator payroll (daftar periode berhalaman, tindakan dari server, daftar transfer) |
| #216 | EMP-S5A penonaktifan akun dan reaktivasi sementara |
| #221 | PAG-10 akses halaman, slip milik sendiri, jurnal organisasi |

## Migrasi

| Berkas | Sifat | Hasil |
|---|---|---|
| `0101_account_temporary_reactivation.sql` | aditif (tabel baru, indeks, permission) | applied |

Backup sebelum migrasi: `/srv/hcis/backups/pre-release/hcis-aa1a5ded-20261027-20261027T071817Z.dump`
(`sha256=057a76022a6c08bb3f98b0fed725366203676c2e59180c0df81baef424aac406`, 34 MB, `root:root 0600`,
terbaca oleh `pg_restore --list`).

## Gate kandidat

`PASS` untuk `/health`, `/ready`, web `/` (status dan `no-store`), `/login`, aset entry `immutable`,
dan aset hilang `404`. Kedua kandidat dihentikan dan port 3391/3291 kembali tertutup.

## Cutover

- `sq-core-launch.sh` 4 baris, `sq-core-worker.sh` 2 baris berubah; keduanya lolos `sh -n`.
- Worker dihentikan dengan KILL (OPS-MI8-SUP-001), pid 30227 → 15901.
- `hcis` dan `hcis-web` berjalan dari rilis baru setelah ~26 detik.

## Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| `127.0.0.1:3301/health`, `/ready` | PASS |
| `127.0.0.1:3201/` `no-store` | PASS |
| `cwd` proses `hcis` dan `hcis-web` di dalam rilis baru | PASS |
| `current` menunjuk rilis baru, worker hidup | PASS |
| Publik `/api/health`, `/login`, `/assets/does-not-exist.js` 404 | PASS |
| Pantauan ~38 menit setelah cutover: tidak ada peluncuran ulang | PASS |
| `hub.sabilulquran.or.id`, `aset.sabilulquran.or.id` | 200 |

Rollback tidak dijalankan. Lock perangkat dilepas setelah verify.

Belum dilakukan: login browser dan refresh deep-link oleh operator manusia — agent tidak mengisi
kredensial. Pemeriksaan HTTP di atas menutupi shell `/login` dan perilaku aset, bukan sesi nyata.
