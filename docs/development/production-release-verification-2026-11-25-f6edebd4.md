# Verifikasi rilis produksi — hcis-f6edebd4-20261125 (OPS-MI8-REL-001)

**Tanggal:** 2026-11-25 02:26–02:28 UTC (09:26–09:28 WIB)
**Operator:** Claude Code, di bawah aturan owner 2026-10-27 (rilis tanpa konfirmasi, pengaman teknis tetap
dijalankan: dry-run bersih dulu, backup sebelum migrasi, gerbang kandidat wajib lolos, rollback bila
verifikasi gagal, tidak pernah pada jam 19 UTC). Owner meminta rilis ini secara eksplisit pada
2026-11-25, menjawab pertanyaan penutup audit kesiapan 24 November.

| Item | Nilai |
|---|---|
| SHA target | `f6edebd4a44b302f4c91a60870b48753be411221` (`origin/main`: merge #412) |
| Rilis sebelumnya (sasaran rollback) | `hcis-b3adc898-20261124` |
| Build | run [45532450283](https://github.com/sabilulquran/hcisysq/actions/runs/45532450283), bundel `hcis-f6edebd4-20261125.tar.gz` sha256 `5d926a4d7f8360e56dfdd23ba3b58591a8f7c4ae985ea8022be2587ff1cb8fcb`, 156 migrasi |
| Validasi PR | #412 "Typecheck, lint, test, build, migrate" lulus 5m57s ([run 45359741267](https://github.com/sabilulquran/hcisysq/actions/runs/45359741267)) |
| Terpasang di perangkat | `/srv/hcis/releases/hcis-f6edebd4-20261125` (134 MB) |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-f6edebd4-20261125-20261125T022639Z.dump`, 41.572.169 byte, sha256 `dfc9bbca3c0ef2f88ef1bbd509663a335b3b2bb40168decfb762a07b6fc65c13` |
| Migrasi | 156 di bundel; **nol diterapkan** — tidak ada yang tertunda, `migrate` no-op. `0184_adms_mapping_reassigned.sql` sudah masuk pada rilis `b3adc898` kemarin |
| Launcher / worker | `sq-core-launch.sh` `bbe2b5b692138583` → `c55ffd16a6b53dc5`; `sq-core-worker.sh` `849aee85c559241d` → `7f4a52ec9fc43819` (empat dan dua baris, hanya baris yang menyebut path rilis) |
| Worker | direstart dengan KILL: pid 30165 → 16758 |
| Sehat kembali | `running_release=hcis-f6edebd4-20261125` setelah ±30 detik |
| Lock rilis | diambil saat `--apply`, dilepas sesudah `verify` |

Isi rilis: **satu PR fitur** (#412) dan satu PR dokumen (#413) — perbaikan yang lahir dari audit kesiapan
pembukaan 24 November. Tidak ada perubahan skema, jadi jalur mundurnya murni aplikasi.

## Mengapa rilis ini tidak membawa migrasi

Rilis `b3adc898` (24 Nov 15:07 WIB, ADMS-R2d #411) sudah menerapkan `0184`, satu-satunya migrasi dalam
garis ini. Yang keluar hari ini seluruhnya kode dan dokumen. `preflight` menuliskannya apa adanya:

```
[09:26:16] pending migrations: none
[09:27:04] no pending migrations; migrate is a no-op
```

Backup `pg_dump -Fc` tetap diambil sebelum fase `migrate` sesuai §4.4 — pengaman itu tidak dilewati hanya
karena daftar migrasinya kosong; ia juga jalur mundur penuh bila sesuatu di luar dugaan terjadi.

## Gerbang TRIP-002

```
[09:27:10] trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded;
           the golongan map is checked in full when someone turns it on (TRIP-002 D-22)
```

Katalog klasifikasi jabatan masih nol di production dan uang saku dinas tetap terkunci; tidak ada uang
muka yang sedang berjalan, sehingga tidak ada yang tertahan. Tidak ada peringatan
`CLASSIFICATION_UNMAPPED_FUTURE` pada rilis ini.

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
| `cmdline` proses `hcis` | `cd /srv/hcis/releases/hcis-f6edebd4-20261125/apps/api; exec node dist/server.js` | rilis baru |
| `cmdline` proses `hcis-web` | `cd /srv/hcis/releases/hcis-f6edebd4-20261125/apps/web/dist; exec python3 spa_static_server.py` | rilis baru |
| Jumlah migrasi terpasang | 156 | 156 |
| Migrasi tertinggi | `0184_adms_mapping_reassigned.sql` | `0184` |
| `organization_rollout_settings` | **0 baris** | 0 — seluruh alur tetap `LEGACY` |
| `trip_per_diem_activation` | **0 baris** | 0 — uang saku tetap terkunci |

Pembuktian bahwa kode baru benar-benar melayani, lewat jalur publik tanpa login:

| Permintaan | Jawaban | Arti |
|---|---|---|
| `GET /api/health` | 200 | API hidup |
| `GET /api/me/services` | **401** | route SVC-001 terdaftar (sebelum rilis ini: 404) dan menolak tanpa sesi |
| `POST /api/admin/leave/approvals/<uuid>/reassign` | **401** | route APR-001 reassignment terdaftar dan menolak tanpa sesi |
| `GET /login` | 200 | shell SPA |
| `GET /app/leave` | 200 | deep-link refresh dilayani fallback SPA |
| `GET /assets/does-not-exist.js` | 404 | aset hilang tidak dijawab shell |

Login lewat peramban dengan akun sungguhan **tidak** dilakukan: agent tidak pernah mengetik kredensial.
Yang membuktikan sisi berkepentingan di sini adalah 401 pada dua route baru di atas plus gate kandidat,
bukan sesi nyata. Alur fungsionalnya sendiri sudah dibuktikan pada lingkungan uji terisolasi — 98
skenario sintetis, `docs/development/hcis-opening-readiness-evidence-2026-11-24.md` (OPS-EVID-001).

## Pengawasan 10 menit

`sq-corectl.sh status` dibaca sebelas kali dengan jarak satu menit, 02:28–02:38 UTC (09:28–09:38 WIB).
Sepanjang jendela itu `sq-core-worker.log` tidak menambah satu baris `launch service=hcis*` pun sesudah
dua baris cutover:

```
[2026-11-25 09:27:45] launch service=hcis     attempt=1 backoff=15s
[2026-11-25 09:28:01] launch service=hcis-web attempt=2 backoff=30s
```

Tepat satu peluncuran per layanan, sesuai §4.8 — tidak ada peluncuran berulang yang menandakan layanan
yang jatuh lalu dibangunkan worker. Pid layanan (`hcis` 17532, `hcis-web` 17840) tidak berubah.

## Dampak bagi pengguna

HCIS belum dibuka ke seluruh pegawai (OPS-CLOSE-001): tidak ada akun yang diaktifkan, tidak ada undangan
yang dikirim, tidak ada pilot yang dinyalakan pada rilis ini. Yang berubah di production:

1. Penyetuju unit yang mengajukan cutinya sendiri tidak lagi ditolak `409 UNIT_APPROVER_MISSING`
   (ORG-004 D-R6). Di production ini mengenai delapan dari sembilan penyetuju unit.
2. Pemohon cuti menerima tepat satu notifikasi dalam aplikasi saat keputusan akhirnya turun, disetujui
   maupun ditolak (LEAVE-010-F). Sebelumnya hanya penyetuju yang diberi tahu.
3. Human Capital dapat mengalihkan satu langkah persetujuan yang tersangkut lewat
   `POST /admin/leave/approvals/:stepId/reassign`, teraudit — sebelumnya hanya lewat sunting basis data.
   Langkah milik akun Organ Yayasan ditolak (`409 APPROVAL_STEP_ACCOUNT_HELD`).
4. Layar "Semua Layanan" memakai label dari server (`GET /me/services`); Uang Muka Dinas tidak lagi
   tertulis "Tersedia" sementara server menguncinya.
5. Indikator "Atasan langsung siap" di Konfigurasi Cuti menghitung pegawai yang dirutekan bagan sebagai
   siap **untuk Cuti Tahunan**, sehingga layar berhenti menyuruh HC mengisi kolom yang tidak dibaca.
6. Tautan "Masuk dengan Akun SQ" pada halaman aktivasi tidak lagi menuju `/login` yang menjawab 404.

Mode rollout ORG-004 tetap `LEGACY` di mana-mana, `GOVERNANCE_PAYROLL_READ_ENABLED` tetap mati, dan uang
saku dinas tetap terkunci. Nomor 1–3 baru terasa setelah akun pegawai diaktifkan.

## Rollback

Sasaran `hcis-b3adc898-20261124`, lewat fase `rollback` skrip rilis. Karena rilis ini **tidak membawa
migrasi**, jalur mundurnya murni aplikasi dan tidak ada pertanyaan tentang skema: rilis lama berjalan di
atas basis data yang sama persis. Backup pra-rilis di atas tersedia sebagai jalur mundur penuh. Tidak
dipakai: verifikasi lulus pada percobaan pertama.
