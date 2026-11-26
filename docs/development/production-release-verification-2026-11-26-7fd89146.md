# Verifikasi rilis production — `hcis-7fd89146-20261126`

**Spec ID:** OPS-MI8-REL-001 (catatan pelaksanaan)
**Tanggal:** 2026-11-26
**Operator:** agen, atas permintaan owner (keputusan owner 2026-10-27: `--apply` berjalan tanpa menunggu persetujuan, dengan gate teknis yang tetap wajib)
**Hasil:** **berhasil**, tanpa rollback. Fase verify pertama berhenti pada satu cek publik karena perangkat sesaat gagal me-resolve nama host; fase verify diulang dan lulus seluruhnya.

| | |
|---|---|
| SHA | `7fd89146c6fd0b3e80280c3b0991d572b6e3b834` (merge PR #421, OPS-PILOT-TT-001) |
| Rilis sebelumnya / sasaran rollback | `hcis-df406452-20261125` |
| Build | run 45789719181, bundle `hcis-7fd89146-20261126.tar.gz`, sha256 `abc00c04ac14c1209379037826b14cb856f04e3975ae639980b8e70634277fde`, 158 migrasi |
| Validasi PR | pass 5m39s (run 45788665017) |
| Terpasang di | `/srv/hcis/releases/hcis-7fd89146-20261126` (134 MB) |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-7fd89146-20261126-20261126T091605Z.dump`, 42.425.641 byte, sha256 `286bf3fa7b403f3988a9469de0691901d991679c4dba64e4049e1bcd0f0e7698` |
| Migrasi diterapkan | **nol** (tidak ada yang tertunda) |
| Cutover | 26 Nov 2026 **16:16 WIB** (09:16 UTC) |
| Launcher / worker | `ce26d6da5d670430` → `9e56294d4e90405a`; `16dca458069252cc` → `dcf8a2c4d33f742e` |
| Worker pid | 28515 → 9349 |
| Sehat kembali | ~30 detik |
| Lock | dilepas oleh verify kedua; `release_lock=released` |

## Gerbang

- `preflight`: `pending migrations: none`, dry-run `all` bersih.
- TRIP-002: uang saku dinas OFF, tidak ada advance yang tersangkut.
- Kandidat 7/7 PASS (`api /health`, `api /ready`, `web /` status dan `no-store`, `web /login`, aset entry `immutable`, aset hilang 404).

## Verifikasi sesudah cutover

Percobaan pertama:

```
PASS api release  PASS web release  PASS api /health  PASS api /ready
PASS web / no-store  PASS current symlink  PASS worker alive
curl: (6) Could not resolve host: hcis.sabilulquran.or.id
FAIL public /api/health (got 000, want 200)
PASS public /login   PASS public /assets/does-not-exist.js
STOP: public verification failed
```

Kegagalan itu adalah resolver DNS pada perangkat untuk satu permintaan, bukan layanannya: semua cek
di perangkat lulus, dan dua cek publik yang dijalankan sedetik kemudian lewat nama host yang sama
lulus. Karena itu fase `verify` diulang, bukan langsung rollback; keputusan rollback disiapkan bila
percobaan kedua gagal. Percobaan kedua:

```
PASS public /api/health   PASS public /login   PASS public /assets/does-not-exist.js
verify OK
release_lock=released
```

## Perbaikan benar-benar ada di rilis yang berjalan

Dibaca dari `dist/` rilis yang ditunjuk `cwd` proses API (pid 10864), tanpa sesi dan tanpa basis data:

| Pemeriksaan | Hasil |
| --- | --- |
| Kelompok hak cuti kosong | `AnnualLeaveRequestPolicyError UNSUPPORTED_ENTITLEMENT_GROUP` (dipetakan route ke 409): "Kelompok hak cuti Anda belum ditetapkan oleh Human Capital, …" |
| Kelompok `education` | kode yang sama, pesan "hanya berlaku untuk kelompok tenaga non-pendidikan" |
| `isoCalendarDate` untuk `2026-02-30` / `2026-02-28` | ditolak / diterima |
| `ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM` di lingkungan proses API | `2027-01-01` — tetap terbaca setelah cutover |

## Pengawasan 10 menit

Dibaca pukul 16:23 dan 16:27 WIB. Pid kedua layanan sama pada kedua pembacaan (`hcis` 10864,
`hcis-web` 12354), log worker hanya memuat satu peluncuran per layanan di bawah worker 9349
(16:17:13 dan 16:17:29), dan `/health` serta `/ready` di perangkat menjawab 200. Tidak ada
lingkaran mati-hidup.

## Dampak bagi pengguna

- Pegawai yang kelompok hak cutinya belum ditetapkan mendapat penjelasan dan arahan ke Human
  Capital, bukan galat server.
- Tanggal yang tidak ada di kalender ditolak sebagai isian tidak sah pada semua layar cuti.
- Aturan kuota tidak berubah. Belum terasa siapa pun sampai akun pegawai diaktifkan.

## Jalan mundur bila dibutuhkan

`scripts/mi8/release-mi8.sh rollback --sha 7fd89146c6fd0b3e80280c3b0991d572b6e3b834 --bundle
rel/hcis-7fd89146-20261126.tar.gz` mengembalikan launcher dan worker ke `hcis-df406452-20261125`.
Tanpa migrasi, basis data tidak perlu disentuh.

## Hubungan dengan dokumen lain

- `docs/operations/pilot-tt-readiness-evidence-2026-11-26.md` — isi rilis ini (§7) dan langkah P4.
- `docs/development/production-release-verification-2026-11-25-df406452.md` — rilis sebelumnya.
