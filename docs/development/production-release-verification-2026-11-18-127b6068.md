# Verifikasi rilis produksi — hcis-127b6068-20261118 (OPS-MI8-REL-001)

**Tanggal:** 2026-11-18 09:04–09:07 UTC (16:04–16:07 WIB), pengamatan sampai 09:12 UTC
**Operator:** Claude Code (sesi R2 Portal Organ Yayasan), di bawah aturan owner 2026-10-27: rilis tanpa konfirmasi, dengan pengaman teknis tetap dijalankan (dry run lebih dulu, backup basis data sebelum migrasi, gate kandidat, rollback bila verifikasi gagal, laporan sesudahnya, tidak pernah pada jam 19 UTC). Kunci rilis perangkat kosong saat preflight, diambil skrip, dan dilepas setelah verify.

| Item | Nilai |
|---|---|
| SHA target | `127b6068360b0931d5f80460c6c2b163b75163a5` (`origin/main`: merge #385) |
| Rilis sebelumnya (sasaran rollback) | `hcis-ee273bc5-20261117` |
| Isi | #380 ORG-015 rute keputusan organ (`GET`/`POST /governance/decisions`, migrasi 0166, di balik `GOVERNANCE_DECISIONS_ENABLED` yang mati); #385 dokumentasi PAY-004 penjagaan honorarium dari kehadiran dan REIMB-002 reimbursement pengadaan (tanpa kode) |
| Konfigurasi | Tidak ada perubahan `final.env`. ORG-015 menambah tiga kunci di `apps/api/src/config/env.ts` — `GOVERNANCE_DECISIONS_ENABLED`, `GOVERNANCE_DECISION_AUDIENCE`, `GOVERNANCE_DECISION_ALLOWED_CLIENTS` — ketiganya punya default dan tidak satu pun wajib, yang dibuktikan oleh proses yang hidup sehat tanpa ada satu pun dari ketiganya di `final.env` |
| Build | run [44271623880](https://github.com/sabilulquran/hcisysq/actions/runs/44271623880), bundel `hcis-127b6068-20261118.tar.gz` sha256 `baf46f540e1c1c52e86caf157a1d3a68c1a8e3fbbca1aaced40901a2721e7599` |
| Migrasi | 145 di bundel; 1 diterapkan: `0166_leave_decision_request_id` |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-127b6068-20261118-20261118T090447Z.dump` (sha256 `836f7e327b49ec3b…ffcdb5ef`, 40.771.872 byte) |
| Launcher / worker | `sq-core-launch.sh` `50a1bd5673e14859` → `a7ed2cadf21d7905`; `sq-core-worker.sh` `b3dd2633b9053d41` → `0f26313a5c805178` (awalan sha256) |
| Worker | direstart dengan KILL: pid 15252 → 19636 |
| Sasaran rollback | `hcis-ee273bc5-20261117`. `0166` hanya menambah satu kolom `uuid` yang boleh kosong pada `leave_request_approval_steps`, jadi rilis lama tetap jalan di skema baru dan rollback cukup di sisi aplikasi |

## Dampak: tidak ada, dan itu memang tujuannya

ORG-015 adalah separuh HCIS dari R2 Portal Organ Yayasan (ORGAN-IMPL-001 §4.2, ADR-0012 D4): rute yang membiarkan anggota organ memutuskan langkah persetujuan dari portal, dengan token keputusan beraudiens sendiri yang sekali pakai. Seluruhnya di balik `GOVERNANCE_DECISIONS_ENABLED`, yang tidak ada di `final.env` dan karena itu mati.

Dibaca sesudah rilis, dari dalam perangkat:

| Permintaan | Hasil | Harapan |
|---|---|---|
| `GET /governance/decisions` | `404` | `404` selama flag mati |
| `POST /governance/decisions/<id>` | `404` | `404` selama flag mati |
| `GET /governance/summary` tanpa token | `401` | `401` — R1 tidak tersentuh |
| `GET /health` | `200` | `200` |

`0166` menambah kolom `decision_request_id uuid NULL` pada `leave_request_approval_steps`. Kolom itu hanya ditulis oleh jalur keputusan yang rutenya masih 404, jadi tidak ada baris yang berubah dan tidak ada perilaku cuti yang bergeser.

## Gate kandidat

Rilis baru dijalankan lebih dulu pada port 3391 (API) dan 3291 (web), dan dihentikan sesudahnya:

```
PASS api /health            PASS web / status
PASS api /ready             PASS web / no-store
PASS web /login             PASS web entry asset immutable
PASS web missing asset 404
candidate_gate=PASS
```

## Verifikasi setelah cutover

```
running_release=hcis-127b6068-20261118 after ~28s
PASS api release      PASS web release        PASS api /health
PASS api /ready       PASS web / no-store     PASS current symlink
PASS worker alive     PASS public /api/health PASS public /login
PASS public /assets/does-not-exist.js
verify OK
release_lock=released
```

Sapuan kesehatan sesudahnya, lewat edge pada 09:12 UTC: `hcis`, `hub`, `organ`, `karir`, `spmb` semuanya `200`. Tidak ada peluncuran ulang layanan di log worker setelah 16:06 WIB.

## Yang belum dikerjakan

R2 belum menyala. Urutan ORGAN-IMPL-001-r2-keycloak.md §5 baru sampai langkah 4:

1. ~~Realm: Level of Authentication~~ — dipasang 2026-11-18, dicatat di SQ-Hub #236
2. ~~Klien dan scope audiens keputusan~~ — dipasang 2026-11-18
3. ~~Rilis HCIS dengan ORG-015, flag mati~~ — rilis ini
4. ~~Rilis SQ Hub dengan R2, flag mati~~ — `hub-9522c429-20261118`
5. Field registry `decision_path` dan `decision_audience` untuk aplikasi `hcis`, lewat Admin Center
6. Probe §4, terutama `acr` yang harus bernilai `"2"` setelah pertukaran token — butuh sesi nyata, jadi langkah owner
7. Menyalakan kedua flag, HCIS lebih dulu

Langkah 6 adalah gerbang ADR-0012 D4: kalau `acr` tidak selamat melewati pertukaran token, kedua flag tetap mati.
