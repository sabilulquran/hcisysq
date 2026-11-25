# Verifikasi rilis production — `hcis-27f10ccd-20261125`

**Spec ID:** OPS-MI8-REL-001 (catatan pelaksanaan)
**Tanggal:** 2026-11-25
**Operator:** agen, atas permintaan owner (keputusan owner 2026-10-27: `--apply` berjalan tanpa menunggu persetujuan, dengan gate teknis yang tetap wajib)
**Hasil:** **berhasil**, verify lulus pada percobaan pertama, tanpa rollback.

| | |
|---|---|
| SHA | `27f10ccd51d5e1aaaceb51ad0bb4e80fb8f7782a` (merge PR #415) |
| Rilis sebelumnya / sasaran rollback | `hcis-f6edebd4-20261125` |
| Build | run 45551906954, bundle `hcis-27f10ccd-20261125.tar.gz`, sha256 `6e023a33fbf7492f5aa3bec0d178b78469b666c92f7178811ccdc54acad299d3`, 156 migrasi |
| Validasi PR | pass 5m45s (run 45550940404, HEAD `46b38e2f`) |
| Terpasang di | `/srv/hcis/releases/hcis-27f10ccd-20261125` (134 MB) |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-27f10ccd-20261125-20261125T051618Z.dump`, 41.646.510 byte, sha256 `89a4ee63ecf0c3b498369e83319b69e524eabb98993426864da81e666812d919` |
| Migrasi diterapkan | **nol** (tidak ada yang tertunda) |
| Cutover | 25 Nov 2026 **12:17 WIB** (05:17 UTC) |
| Launcher / worker | `c55ffd16a6b53dc5` → `7a6a263eea6e74c9`; `7f4a52ec9fc43819` → `7009e6dbd4b505cf` |
| Worker pid | 16758 → 25158 |
| Sehat kembali | ~28 detik |
| Lock | diambil dan dilepas; `release_lock=released` |

## Mengapa tanpa migrasi

PR #415 tidak membawa satu migrasi pun. `preflight` membacanya langsung dari perangkat —
`pending migrations: none` — dan fase `migrate` berhenti sebagai no-op. Backup `pg_dump -Fc`
tetap diambil sesuai §4.4, karena yang menentukan adalah fase yang dijalankan, bukan dugaan
tentang isinya. Akibatnya jalur rollback rilis ini murni urusan aplikasi: mengembalikan
launcher dan worker ke `hcis-f6edebd4-20261125` cukup, tanpa menyentuh basis data.

## Gerbang TRIP-002

```
trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded;
the golongan map is checked in full when someone turns it on (TRIP-002 D-22)
```

Katalog klasifikasi jabatan masih kosong, tetapi dengan uang saku dinas mati hanya
`ADVANCE_UNRESOLVED` yang menghentikan rilis, dan tidak ada advance yang tersangkut.

## Gerbang kandidat — 7/7 PASS

```
PASS api /health            PASS web / no-store
PASS api /ready             PASS web /login
PASS web / status           PASS web entry asset immutable
                            PASS web missing asset 404
```

Kedua kandidat dihentikan dan portnya ditutup kembali sebelum cutover.

## Verifikasi sesudah cutover

```
running_release=hcis-27f10ccd-20261125 after ~28s
PASS api release        PASS api /health        PASS current symlink
PASS web release        PASS api /ready         PASS worker alive
                        PASS web / no-store
PASS public /api/health   PASS public /login   PASS public /assets/does-not-exist.js
verify OK
```

## Pembacaan baca-saja sesudah rilis

| Yang diperiksa | Hasil |
|---|---|
| Proses `hcis` | pid 25891, `cmdline` di `/srv/hcis/releases/hcis-27f10ccd-20261125/apps/api` |
| Proses `hcis-web` | pid 26327, `cmdline` di `…/apps/web` |
| `current` symlink | `releases/hcis-27f10ccd-20261125` |
| Migrasi terpasang | 156, tertinggi `0184_adms_mapping_reassigned.sql` — tidak berubah |
| `organization_rollout_settings` | **0 baris** — seluruh yayasan tetap `LEGACY` |
| `account_activation_invitations` | **0 baris** — belum pernah ada satu undangan pun |
| Akun berstatus `active` | 4 — tidak bertambah |
| `leave_requests` | 0 |
| `trip_per_diem_activation` | 0 baris — uang saku dinas tetap terkunci |

## Bukti bahwa kode barunya benar-benar dilayani

Rilis ini tidak menambah satu route baru pun, sehingga pembuktian lewat kode status tidak
tersedia. Yang dipakai sebagai gantinya adalah **berkas yang benar-benar dikirim ke pengguna**:
entry bundle yang ditunjuk `/login` di jalur publik `https://hcis.sabilulquran.or.id` adalah
`/assets/index-Dz-6TamZ.js` (2.383.442 byte), dan di dalamnya ada keempat kalimat yang hanya
lahir pada PR #415:

| Kalimat | Ada |
|---|---|
| `Mode persetujuan per unit` | ya |
| `Pindahkan unit ke struktur` | ya |
| `— pilih unit —` | ya |
| `Tolak pengajuan cuti` | ya |

Diambil tanpa sesi dan tanpa kredensial apa pun. **Tidak ada penelusuran lewat login dengan
akun sungguhan**, karena agen tidak pernah mengetik kata sandi; yang dibuktikan di sini adalah
berkasnya terkirim, bukan layarnya pernah dibuka orang.

## Pengawasan 10 menit

Dibaca pukul 12:28 WIB, sebelas menit sesudah cutover.

**Pid kedua layanan tidak berubah** sejak pembacaan tepat sesudah cutover — `hcis` 25891 dan
`hcis-web` 26327 — sehingga tidak ada lingkaran mati-hidup. Log worker memperlihatkan **tepat
satu** peluncuran per layanan di bawah worker 25158, dan tidak ada baris baru sesudahnya:

```
SQ Core worker started Wed Nov 25 12:17:01 WIB 2026, pid=25158
[2026-11-25 12:17:22] launch service=hcis     attempt=1 backoff=15s
[2026-11-25 12:17:38] launch service=hcis-web attempt=2 backoff=30s
```

Baris `Hub dependency gate: HCIS unavailable` yang menyertainya adalah keadaan beberapa detik
saat layanan sedang naik, dan berhenti begitu keduanya sehat.

Pemeriksaan ulang pada saat yang sama:

| Jalur | Hasil |
|---|---|
| API di perangkat, `http://127.0.0.1:3301/health` | 200 |
| API di perangkat, `/ready` | 200 |
| Publik `https://hcis.sabilulquran.or.id/api/health` | 200, badan `{"status":"ok"}` |
| Publik `/` dan `/login` | 200 |
| Publik `/app/approvals` (deep link, SPA fallback) | 200 |

## Dampak bagi pengguna

1. **Mode persetujuan per unit dapat dinyalakan dan diakhiri dari layar** (Admin → Struktur
   Organisasi), oleh pemegang `approvals.policy.manage`. Sebelum rilis ini kedua route yang
   melakukannya tidak dipanggil dari mana pun, sehingga saklar routing hanya dapat disentuh
   lewat `psql`, dan jalan mundur pilot tidak punya tombol.
2. **`GET /admin/organization/rollout` membawa `id` dan `reason`** tiap baris yang berlaku, yang
   dibutuhkan untuk memanggil jalur mengakhiri.
3. **Tombol Tolak pada layar Persetujuan meminta alasannya di dalam halaman**, bukan lewat
   `window.prompt`. Alasannya dibaca pemohon.
4. Ketiganya **belum terasa siapa pun** sampai akun pegawai diaktifkan: hari ini hanya 4 akun
   berstatus aktif dan belum ada satu undangan pun yang dikirim.

Tidak ada perubahan perilaku untuk pegawai di luar itu, tidak ada saklar yang dinyalakan, dan
tidak ada baris rollout yang ditulis.

## Jalan mundur bila dibutuhkan

`scripts/mi8/release-mi8.sh rollback --sha 27f10ccd51d5e1aaaceb51ad0bb4e80fb8f7782a --bundle
rel/hcis-27f10ccd-20261125.tar.gz` mengembalikan launcher dan worker ke
`hcis-f6edebd4-20261125` dari salinan `*.pre-hcis-27f10ccd-20261125`. Karena rilis ini tidak
menerapkan satu migrasi pun, basis data tidak perlu disentuh; dump pra-rilis di atas tetap ada
sebagai jaring pengaman.

## Hubungan dengan dokumen lain

- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) — prosedurnya.
- `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001) — isi rilis ini
  adalah prasyarat nomor 6 di §5.6-nya.
- `docs/development/production-release-verification-2026-11-25-f6edebd4.md` — rilis sebelumnya.
