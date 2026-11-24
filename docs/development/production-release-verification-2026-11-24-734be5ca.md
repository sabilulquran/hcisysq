# Verifikasi rilis produksi — hcis-734be5ca-20261124 (OPS-MI8-REL-001)

**Tanggal:** 2026-11-24 03:18–03:21 UTC (10:18–10:21 WIB)
**Operator:** Claude Code, di bawah aturan owner 2026-10-27 (rilis tanpa konfirmasi, pengaman teknis tetap
dijalankan: dry-run bersih dulu, backup sebelum migrasi, gerbang kandidat wajib lolos, rollback bila
verifikasi gagal, tidak pernah pada jam 19 UTC).

| Item | Nilai |
|---|---|
| SHA target | `734be5cadcc2f71829fa54dfdd61db4d9a350052` (`origin/main`: merge #398) |
| Rilis sebelumnya (sasaran rollback) | `hcis-127b6068-20261118` |
| Build | run [45317317257](https://github.com/sabilulquran/hcisysq/actions/runs/45317317257), bundel `hcis-734be5ca-20261124.tar.gz` sha256 `df87d10d1d9f472f31ab…`, 155 migrasi |
| Terpasang di perangkat | `/srv/hcis/releases/hcis-734be5ca-20261124` |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-734be5ca-20261124-20261124T031907Z.dump`, 40.774.423 byte, 2026-11-24 10:19 WIB |
| Migrasi | 155 di bundel; **10 diterapkan**: `0172`, `0174`, `0175`, `0176`, `0177`, `0178`, `0180`, `0181`, `0182`, `0183` |
| Launcher / worker | `sq-core-launch.sh` `03e7e54acb227922` → `ea3308101690ed76`; `sq-core-worker.sh` `478fe698af76b4b6` → `ec9779db1ba121c3` (empat dan dua baris, hanya baris yang menyebut path rilis) |
| Worker | direstart: pid 5943 → 22257 |
| Sehat kembali | `running_release=hcis-734be5ca-20261124` setelah ±28 detik |
| Lock rilis | diambil saat `--apply`, dilepas sesudah `verify` |

Isi rilis: dua puluh tiga PR yang menunggu sejak `127b6068` — di antaranya LEAVE-009 C1 / TRIP-001 C4 /
NOTIF-003 D18 (#386), tarif uang saku SK 01.111/YSQ/VII/2026 (#389), PERF-001 rubrik berversi dan jalur
keberatan (#387, #390), LOAN-002 rantai persetujuan berbasis kursi (#384, #391), ADR-0008 B5 di balik
`GOVERNANCE_PAYROLL_READ_ENABLED` yang tetap mati (#383), ORG-001 penetapan atasan langsung massal (#395),
ORG-004 perbaikan saklar rollout dan D-R5 (#399, #405, #406), EMP-005 S2B §8.7 (#400), LEAVE-UX-001 wizard
(#396), dan TRIP-002 D-22 (#398).

## Gerbang TRIP-002 pada rilis ini

Rilis ini adalah yang pertama menjalankan gerbang bentuk baru (TRIP-002 D-22, keputusan owner 2026-11-24).
Yang tercatat di log:

```
[10:18:11] trip-002 gate: trip_per_diem_rates is empty, 0172_trip_per_diem_decree.sql may run
[10:18:18] trip-002 gate: trip_per_diem_golongan_map does not exist on the device yet
           (0172_trip_per_diem_decree.sql has not run), so there is nothing to check   <- dry run
[10:19:44] trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded;
           the golongan map is checked in full when someone turns it on (TRIP-002 D-22)
```

Baris terakhir adalah inti keputusannya: katalog klasifikasi jabatan masih **nol** di production, dan dulu
itu akan menghentikan rilis apa pun. Sekarang yang ditahannya adalah penyalaan fitur uang saku, bukan
rilisnya, sehingga perbaikan cuti berbasis bagan dapat keluar sementara uang saku tetap terkunci.

## Gate kandidat

Rilis baru dijalankan lebih dulu pada port 3391 (API) dan 3291 (web), lalu dihentikan:

```
PASS api /health            PASS web / status
PASS api /ready             PASS web / no-store
                            PASS web /login
                            PASS web entry asset immutable
                            PASS web missing asset 404
candidate_gate=PASS
```

## Verifikasi sesudah cutover

```
PASS api release      PASS api /health     PASS current symlink
PASS web release      PASS api /ready      PASS worker alive
                      PASS web / no-store
PASS public /api/health   PASS public /login   PASS public /assets/does-not-exist.js
```

Dibaca sesudahnya, baca-saja dari dalam perangkat:

| Pertanyaan | Hasil | Harapan |
|---|---|---|
| `cwd` proses `hcis-web` | `/srv/hcis/releases/hcis-734be5ca-20261124/apps/web/dist` | rilis baru |
| Migrasi tertinggi | `0183_trip_per_diem_activation.sql` | `0183` |
| Jumlah migrasi terpasang | 155 | 155 |
| `trip_per_diem_activation` | **0 baris** | 0 — uang saku mendarat terkunci |
| `trip_per_diem_golongan_map` | 0 baris | 0 — katalog memang belum diisi HC |
| `trip_per_diem_rates` | 6 baris | 6 — disemai `0172` dari Lampiran 1 SK |
| `trip_advances` | 0 baris | 0 — fitur belum pernah dipakai |
| `https://hcis.sabilulquran.or.id/api/health` | 200 | 200 |
| `https://hcis.sabilulquran.or.id/login` | 200 | 200 |

## Dampak bagi pengguna

Tidak ada, dan itu memang tujuannya. HCIS belum dibuka ke seluruh pegawai (OPS-CLOSE-001): tidak ada akun
yang diaktifkan, tidak ada undangan yang dikirim, dan tidak ada pilot yang dinyalakan pada rilis ini.
Uang saku perjalanan dinas mendarat dalam keadaan **terkunci** — perkiraan uang harian dan pengajuan uang
muka menjawab 409 `TRIP_PER_DIEM_NOT_ACTIVE` sampai HC menyalakannya, dan penyalaan itu ditolak selama
katalog klasifikasi, pemetaan golongan, atau tarifnya belum lengkap. `GOVERNANCE_PAYROLL_READ_ENABLED`
tetap mati. Mode rollout ORG-004 tetap `LEGACY` di mana-mana (`organization_rollout_settings` kosong).

## Rollback

Sasaran `hcis-127b6068-20261118`, lewat fase `rollback` skrip rilis. Kesepuluh migrasi yang diterapkan
membawa tabel dan kolom baru, tidak membongkar yang lama, sehingga rilis lama tetap dapat berjalan di atas
skema baru; backup pra-rilis di atas adalah jalur mundur penuh bila diperlukan. Tidak dipakai: verifikasi
lulus pada percobaan pertama.
