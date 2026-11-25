# Verifikasi rilis production — `hcis-df406452-20261125`

**Spec ID:** OPS-MI8-REL-001 (catatan pelaksanaan)
**Tanggal:** 2026-11-25
**Operator:** agen, atas permintaan owner (keputusan owner 2026-10-27: `--apply` berjalan tanpa menunggu persetujuan, dengan gate teknis yang tetap wajib)
**Hasil:** **berhasil**, verify lulus pada percobaan pertama, tanpa rollback.

| | |
|---|---|
| SHA | `df406452ba9afda91c0259468711adf622343284` (merge PR #418, LEAVE-003 R2) |
| Rilis sebelumnya / sasaran rollback | `hcis-27f10ccd-20261125` |
| Build | run 45627854718, bundle `hcis-df406452-20261125.tar.gz`, sha256 `a12cba63aa06364871ddd4b1625f291aea6d6898bf931c449e567b22c8c94a5b`, 158 migrasi |
| Terpasang di | `/srv/hcis/releases/hcis-df406452-20261125` (134 MB) |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-df406452-20261125-20261125T135603Z.dump`, 41.879.346 byte, sha256 `55b3bf452865fc78384dbdec067d6bbeb6cb01629cf2aae581ab61418ab82b02` |
| Migrasi diterapkan | `0185_annual_leave_semester_quota.sql`, `0186_help_center_annual_leave_quota.sql` |
| Cutover | 25 Nov 2026 **20:56 WIB** (13:56 UTC) |
| Launcher / worker | `7a6a263eea6e74c9` → `ce26d6da5d670430`; `7009e6dbd4b505cf` → `16dca458069252cc` |
| Worker pid | 25158 → 28515 |
| Sehat kembali | ~28 detik |
| Lock | diambil dan dilepas; `release_lock=released` |

## Dry-run

`preflight` membaca dua migrasi tertunda dari perangkat, keduanya kompatibel dengan rilis yang
sedang berjalan: `0185` melebarkan constraint `annual_period_key` dan menambah satu indeks,
`0186` memperbarui satu artikel Pusat Bantuan. Rilis lama tidak pernah menulis kunci semester dan
tidak membaca indeks itu.

## Gerbang TRIP-002

```
trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded;
the golongan map is checked in full when someone turns it on (TRIP-002 D-22)
```

## Gerbang kandidat — 7/7 PASS

```
PASS api /health            PASS web / no-store
PASS api /ready             PASS web /login
PASS web / status           PASS web entry asset immutable
                            PASS web missing asset 404
```

## Verifikasi sesudah cutover

```
running_release=hcis-df406452-20261125 after ~28s
PASS api release        PASS api /health        PASS current symlink
PASS web release        PASS api /ready         PASS worker alive
                        PASS web / no-store
PASS public /api/health   PASS public /login   PASS public /assets/does-not-exist.js
verify OK
```

## Pembacaan baca-saja sesudah rilis

| Yang diperiksa | Hasil |
|---|---|
| Migrasi terpasang | 158, tertinggi `0186_help_center_annual_leave_quota.sql` |
| Constraint `leave_requests_annual_period_key_check` | enam nilai: empat triwulan, `JAN_JUN`, `JUL_DEC` |
| Indeks `leave_requests_annual_usage_by_date_idx` | ada |
| Artikel Pusat Bantuan `33b7ee82…` | **benar-benar berubah**: 1269 karakter, memuat "6 hari kerja per semester", diperbarui 20:56 WIB; status tetap `DRAFT` seperti sebelumnya |
| `leave_requests` | 0 baris — tidak ada pengajuan lama yang perlu direkonsiliasi di production |

Pemeriksaan artikel itu sengaja dilakukan karena pada pengujian lokal migrasi `0186` versi awal
sempat tercatat terpasang tanpa mengubah apa pun (beda akhir baris CRLF). Di production
artikelnya berubah.

## Tanggal efektif dipasang sesudah rilis

Keputusan owner 25 November 2026: aturan semester berlaku untuk cuti yang **mulai 1 Januari 2027**.

| Langkah | Hasil |
|---|---|
| Salinan sebelum diubah | `/srv/hcis/shared/final.env.pre-leave-semester-20261125T135802Z` |
| Perubahan | satu baris ditambahkan di akhir: `ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM=2027-01-01`; tidak ada baris lain yang berubah (`diff` hanya menunjukkan baris itu) |
| Mulai ulang | hanya `hcis` (API), 20:58 WIB |
| Lingkungan proses API baru | memuat `ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM=2027-01-01`, cwd di `hcis-df406452-20261125/apps/api` |
| API di perangkat | `/health` 200, `/ready` 200 |
| Publik | `/api/health` 200, `/login` 200 |

Pembacaan tanggal itu gagal tertutup saat start, jadi API yang sehat berarti nilainya terbaca
sebagai tanggal yang sah. Jalan mundurnya: kembalikan salinan di atas dan mulai ulang API.

## Bukti bahwa kode barunya benar-benar dilayani

Entry bundle yang ditunjuk `/login` di jalur publik adalah `/assets/index-BJhr-rUx.js`
(2.375.116 byte), dan di dalamnya ada kedua kalimat petunjuk yang hanya lahir pada PR #418:

| Kalimat | Ada |
|---|---|
| `hari kerja per semester. Satu pengajuan harus berada dalam satu semester` | ya |
| `batasnya berpindah ke per semester` | ya |

Diambil tanpa sesi dan tanpa kredensial. **Tidak ada penelusuran lewat login dengan akun
sungguhan**; Admin → Konfigurasi Cuti dan layar Cuti Tahunan pegawai belum dibuka orang.

## Dampak bagi pengguna

1. Cuti yang **mulai sebelum 1 Januari 2027** tetap dibatasi 3 hari kerja per triwulan, sama
   seperti sebelum rilis.
2. Cuti yang **mulai 1 Januari 2027 atau sesudahnya** dibatasi 6 hari kerja per semester, kapan pun
   diajukan — termasuk pengajuan yang dikirim hari ini untuk tanggal Januari. Hak tahunan tetap 12.
3. Layar Cuti Tahunan menyebut batas yang berlaku untuk tanggal yang dipilih, dan sebelum tanggal
   dipilih menyebut bahwa aturan berpindah mulai 1 Januari 2027.
4. Semua itu **belum terasa siapa pun** sampai akun pegawai diaktifkan.

## Jalan mundur bila dibutuhkan

- Aturan saja: kembalikan `final.env` dari salinan di atas, mulai ulang API.
- Rilis: `scripts/mi8/release-mi8.sh rollback --sha df406452ba9afda91c0259468711adf622343284
  --bundle rel/hcis-df406452-20261125.tar.gz` mengembalikan launcher dan worker ke
  `hcis-27f10ccd-20261125`. Kedua migrasi aditif dan aman dibiarkan untuk rilis lama; pembalikannya
  tertulis di kepala berkas migrasinya, dan dump pra-rilis di atas tetap ada.

## Hubungan dengan dokumen lain

- `docs/development/leave-003-r2-semester-quota-2026-11-25.md` (LEAVE-003 R2) — isi rilis ini.
- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) — prosedurnya.
- `docs/development/production-release-verification-2026-11-25-27f10ccd.md` — rilis sebelumnya.
