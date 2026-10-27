# ATT-013 Blok Kerja ganda

**Status:** `DRAFT` — catatan implementasi ATT-013. Rancangan dan keputusan: `attendance-multi-block-schedule.md`
(D-13-1 sampai D-13-7 dipakai sebagai default `DRAFT`, aturan owner 2026-10-27).
**Spesifikasi terkait:** `attendance-schedule-intake-feasibility.md` §2 (asal masalah),
`attendance-report-calculation.md` §6.3 dan §11 (Normal/Riil per blok), `attendance-operational-simplification-spec.md`
§1 (non-goal "multi-shift per pegawai per hari", yang dibatalkan oleh spesifikasi ini untuk blok kerja).

## 1. Masalah

Draf SK jadwal YSQ memakai **Blok Kerja**: presensi masuk di awal dan pulang di akhir setiap blok.
Beberapa kelompok punya dua blok sehari yang dipisahkan jeda berjam-jam:

| Kelompok | Blok |
|---|---|
| Pesantren — Guru Tahfizh | 04.00–08.30 + 14.30–19.30 |
| Pesantren — Mudir | 03.30–05.00 + 15.00–21.00/22.00 |
| Pesantren — Wakil Kepala Tahfizh | dua blok setiap hari kerja |
| SDIT — Guru Tahfizh Putra | Rabu 07.00–12.30 + 16.00–17.00 |

HCIS hanya mengenal satu rentang per hari. Dua pola jadwal pada tanggal yang sama menjadi "Jadwal
bermasalah" (`ambiguous_default_assignment`), dan satu rentang 04.00–19.30 menilai pegawai yang hanya
hadir satu blok sebagai Hadir dengan pulang cepat.

## 2. Keputusan (DRAFT)

Rancangan dan keputusan ATT-013 ada di `attendance-multi-block-schedule.md` (owner 2026-10-24: HCIS
menyesuaikan). Dokumen ini mencatat implementasinya. Sejak penyelarasan **ATT-013-1b** (2026-10-27)
implementasi mengikuti usulan D-13-1 sampai D-13-7 di sana:

| # | Aturan yang berlaku |
|---|---|
| D-13-1 | Blok pagi hadir, blok sore tidak → hari **Tidak lengkap**, baris menampilkan "Blok 2 tidak hadir" dan hari kerja "0,5 dari 1". Tidak ada status baru. |
| D-13-2 | Jeda Antarblok minimal **30 menit**; lebih pendek adalah istirahat di dalam satu blok. |
| D-13-3 | Maksimal 3 blok; total blok ≤ 20 jam. |
| D-13-4 | Toleransi terlambat dan pulang cepat sama untuk semua blok. |
| D-13-5 | Scan di Jeda Antarblok bukan jam kerja dan bukan lembur. |
| D-13-6 | **Hitungan hari** per blok berjumlah 1,00. Bila operator mengosongkan semuanya, tiap blok mendapat bagian sama rata (tambahan `DRAFT` implementasi). |
| D-13-7 | Riil blok = Hitungan harinya bila Hadir/Terlambat, 0 bila Tidak hadir, **kosong** bila Tidak lengkap atau belum lewat; Riil hari = jumlah yang terisi. |

Status hari mengikuti tabel §5.4 rancangan, termasuk **Menunggu** selama blok yang sudah lewat dihadiri
tepat waktu dan masih ada blok yang belum mulai. Sesi kerja masuk ke blok yang memuat jam check-in-nya
(§5.2 aturan 3), sehingga sesi yang melewati titik tengah jeda tetap milik blok tempat ia dimulai.

Perbedaan implementasi dari rancangan (tidak mengubah perilaku yang terlihat HC):

- Blok 1 tetap di kolom `start_time`/`end_time` versi shift (Hitungan harinya di
  `first_block_workday_weight`); `attendance_schedule_version_blocks` hanya menyimpan blok 2–3, jadi tidak
  ada backfill.
- `attendance_result_sessions` belum mendapat `block_sequence`; blok sesi dapat diturunkan dari jam
  check-in. `TBD` bila PAY-003 membutuhkannya tersimpan.
- Pesan validasi memakai `422 SCHEDULE_BLOCKS_INVALID` (bukan 400), sejalan dengan validasi bisnis lain di
  modul ini.

## 3. Model

- **Shift** (`attendance_schedule_versions`) tetap menyimpan blok pertama di `start_time`/`end_time`.
  Blok ke-2 dan ke-3 disimpan di tabel baru `attendance_schedule_version_blocks`
  (`schedule_version_id`, `sequence` 2–3, `start_time`, `end_time`), pada tanggal yang sama dengan blok
  pertama, dengan Hitungan hari masing-masing. Blok tidak boleh tumpang tindih dan harus berurutan; jeda minimal 30 menit. Shift berbeberapa blok
  tidak boleh melewati tengah malam.
- Versi shift tetap immutable: mengubah blok membuat versi baru, sama seperti mengubah jam.
- `resolveSchedule` mengembalikan `blocks` (urut) di samping `scheduledStartAt` (awal blok pertama) dan
  `scheduledEndAt` (akhir blok terakhir), sehingga konsumen lama tetap melihat rentang hari.
- **Hasil:** `attendance_result_versions` tetap satu baris per hari. Baris per blok disimpan di tabel baru
  `attendance_result_blocks` (`attendance_result_version_id`, `sequence`, jadwal, scan pertama/terakhir,
  status blok, menit terlambat, pulang cepat, jam kerja, hari kerja Normal/Riil). Shift satu blok tidak menulis baris blok.

## 4. Workflow

| Aktor | Langkah | Izin | Audit |
|---|---|---|---|
| HC Admin | Membuat shift dengan 2–3 blok di layar Shift (tombol "Tambah blok"). | `attendance.schedule.manage` | `attendance.schedule.created` berisi blok |
| HC Admin | Memasang pola jadwal seperti biasa. | `attendance.schedule.manage` | tetap |
| HC | Kalkulasi seperti biasa; hasil per blok tersimpan. | `attendance.calculation.run` | tetap |

**Precondition:** blok berurutan, tidak tumpang tindih, maksimal 3. **Failure:** blok tidak valid → 422
`SCHEDULE_BLOCKS_INVALID`, tidak ada yang tersimpan.

## 5. Tampilan

- Shift: jam tampil "04:00–08:30 + 14:30–19:30".
- Detail Harian dan panel satu hari: satu baris per blok di bawah baris hari (scan, status, terlambat,
  pulang cepat). Laporan Normal/Riil memakai D-13-7.

## 6. Catatan implementasi (2026-10-27)

- Migration `0072`: `attendance_schedule_version_blocks` dan `attendance_result_blocks`, aditif; rilis lama
  tidak membacanya. Rollback di header migration.
- `resolveSchedule` membaca blok versi shift dalam query yang sama; `scheduledStartAt`/`EndAt` mencakup
  semua blok. Engine menilai tiap blok dengan `evaluateSessions` yang sama (D-13-4), lalu menggulung hari (§5.4
  rancangan). Hash input hanya memuat blok untuk shift berbeberapa blok, jadi hari satu blok tidak berubah.
- Cuti, ketidakhadiran hasil penyelesaian cuti, dan Libur tetap dinilai untuk seluruh hari.
- `POST/PATCH /admin/attendance/schedules` menerima `extraBlocks`; validasi §4 menghasilkan `422
  SCHEDULE_BLOCKS_INVALID`. PATCH tanpa `extraBlocks` mempertahankan blok versi berjalan.
- Migration `0081` (ATT-013-1b): Hitungan hari (`first_block_workday_weight`, `workday_weight`) dan
  `expected_workday`/`credited_workday` pada `attendance_result_blocks`. Aditif; rollback di header.
- Laporan Normal/Riil memakai D-13-7. Tab Harian menampilkan teks per blok di bawah baris hari ("Blok 1
  04.02–08.28 · Blok 2 tidak hadir") dan Riil sebagai "0,5 dari 1"; panel satu hari menampilkan tiap blok
  dengan hari kerjanya. `TBD`: baris tersendiri per blok di model cetak Detail Harian.
- `TBD`: mengubah blok shift yang sudah ada dari layar (sekarang lewat API atau buat shift baru).
- Selama hari berjalan, blok yang terlambat langsung membuat hari Terlambat; Riil per blok baru dihitung
  setelah hari lewat (baris hari ini sementara).
- `TBD`: Pantauan Hari Ini masih menilai selisih masuk terhadap awal blok pertama. Pegawai yang hanya hadir di
  blok kedua tampil terlambat di layar itu sampai Kalkulasi; hasil Kalkulasi dan laporan sudah benar.

## 7. Di luar cakupan

Blok dengan toleransi berbeda per blok, blok yang berbeda per hari dalam satu shift (pakai dua shift dan
pola per hari), dan jeda antarblok yang dibayar (PAY-003).
