# Verifikasi rilis produksi — hcis-b3adc898-20261124 (OPS-MI8-REL-001)

**Tanggal:** 2026-11-24 08:05–08:07 UTC (15:05–15:07 WIB)
**Operator:** Claude Code, di bawah aturan owner 2026-10-27 (rilis tanpa konfirmasi, pengaman teknis tetap
dijalankan: dry-run bersih dulu, backup sebelum migrasi, gerbang kandidat wajib lolos, rollback bila
verifikasi gagal, tidak pernah pada jam 19 UTC).

| Item | Nilai |
|---|---|
| SHA target | `b3adc898f83b903b7e58be20f67b904c68930542` (`origin/main`: merge #411) |
| Rilis sebelumnya (sasaran rollback) | `hcis-734be5ca-20261124` |
| Build | run [45352464148](https://github.com/sabilulquran/hcisysq/actions/runs/45352464148), bundel `hcis-b3adc898-20261124.tar.gz` sha256 `76b1713bc039fc7fe0cd…`, 156 migrasi |
| Terpasang di perangkat | `/srv/hcis/releases/hcis-b3adc898-20261124` |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-b3adc898-20261124-20261124T080605Z.dump`, 40.848.024 byte, 2026-11-24 15:06 WIB |
| Migrasi | 156 di bundel; **1 diterapkan**: `0184_adms_mapping_reassigned.sql` (aditif, hanya constraint audit) |
| Launcher / worker | `sq-core-launch.sh` `2f4759a7be256223` → `bbe2b5b692138583`; `sq-core-worker.sh` `4f34e546ab4c6398` → `849aee85c559241d` |
| Worker | direstart: pid 29025 → 30165 |
| Sehat kembali | `running_release=hcis-b3adc898-20261124` setelah ±28 detik |
| Lock rilis | diambil saat `--apply`, dilepas sesudah `verify` |

Isi rilis: ADMS-R2d "Ganti pegawai (salah petakan)" (#411, ATT-014 §20.13) dan dokumen rilis sebelumnya (#410).
Pemicunya kasus nyata hari ini: PIN 110122042 di mesin Taman Tahfizh terhubung ke pegawai yang salah.

## Hasil

- Dry-run `all` bersih; satu migrasi tertunda (`0184`).
- Gerbang TRIP-002: uang saku dinas tetap OFF, tidak ada uang muka yang tertinggal.
- Gerbang kandidat 7/7 PASS (`/health`, `/ready`, web status, no-store, `/login`, aset immutable, aset hilang 404).
- Verify sesudah cutover 10/10 PASS, termasuk `public /api/health` dan `public /login`.

## Rollback

`scripts/mi8/release-mi8.sh rollback --sha 734be5cadcc2f71829fa54dfdd61db4d9a350052 --bundle <bundel 734be5ca>`.
Migrasi `0184` tidak perlu dibalik: rilis `734be5ca` tidak menulis aksi audit baru dan berjalan di skema ini.
