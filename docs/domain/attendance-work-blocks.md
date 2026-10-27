# ATT-013 Blok Kerja ganda

**Status:** `DRAFT` — keputusan bisnis belum tertulis diambil dengan default paling masuk akal
(aturan owner 2026-10-27: "ambil default paling masuk akal, tandai DRAFT, jalan terus"). Setiap baris
bertanda `DRAFT` di bawah perlu dikonfirmasi owner; mengubahnya tidak memerlukan migration baru.
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

| # | Pertanyaan | Default yang dipakai |
|---|---|---|
| B-1 | Pilihan §2 kelayakan: SK menyesuaikan, HCIS menyesuaikan, atau tunda | **HCIS menyesuaikan** (pilihan 2), karena ATT-014 sudah merencanakan ATT-013 dan kelompok dua blok sudah bekerja sekarang. `DRAFT` |
| B-2 | Di mana blok didefinisikan | Pada **shift**: satu shift punya 1–3 blok. Satu pegawai tetap punya satu pola jadwal per hari, sehingga tidak ada pola yang bertumpuk. `DRAFT` |
| B-3 | Toleransi terlambat dan pulang cepat | Berlaku sama untuk **setiap blok** (nilai shift). `DRAFT` |
| B-4 | Scan milik blok yang mana | Scan di antara dua blok dibagi di **titik tengah jeda** antara akhir blok sebelumnya dan awal blok berikutnya. Scan sebelum titik tengah milik blok sebelumnya. `DRAFT` |
| B-5 | Status hari | Semua blok tidak dihadiri → **Tidak hadir**. Ada blok tidak dihadiri atau tidak lengkap sementara blok lain dihadiri → **Tidak lengkap**. Semua blok dihadiri, ada yang terlambat → **Terlambat**. Selainnya **Hadir**. `DRAFT` |
| B-6 | Normal/Riil | Normal 1 per hari terjadwal. Riil = blok yang dihadiri (Hadir/Terlambat) ÷ jumlah blok, dua desimal. `DRAFT` |
| B-7 | Menit terlambat, pulang cepat, jam kerja | Dijumlahkan dari semua blok. Jeda antarblok bukan jam kerja dan bukan istirahat. `DRAFT` |

## 3. Model

- **Shift** (`attendance_schedule_versions`) tetap menyimpan blok pertama di `start_time`/`end_time`.
  Blok ke-2 dan ke-3 disimpan di tabel baru `attendance_schedule_version_blocks`
  (`schedule_version_id`, `sequence` 2–3, `start_time`, `end_time`), pada tanggal yang sama dengan blok
  pertama. Blok tidak boleh tumpang tindih dan harus berurutan; jeda minimal 1 menit. Shift berbeberapa blok
  tidak boleh melewati tengah malam.
- Versi shift tetap immutable: mengubah blok membuat versi baru, sama seperti mengubah jam.
- `resolveSchedule` mengembalikan `blocks` (urut) di samping `scheduledStartAt` (awal blok pertama) dan
  `scheduledEndAt` (akhir blok terakhir), sehingga konsumen lama tetap melihat rentang hari.
- **Hasil:** `attendance_result_versions` tetap satu baris per hari. Baris per blok disimpan di tabel baru
  `attendance_result_blocks` (`attendance_result_version_id`, `sequence`, jadwal, scan pertama/terakhir,
  status blok, menit terlambat, pulang cepat, jam kerja). Shift satu blok tidak menulis baris blok.

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
  pulang cepat). Laporan Normal/Riil memakai B-6.

## 6. Catatan implementasi (2026-10-27)

- Migration `0072`: `attendance_schedule_version_blocks` dan `attendance_result_blocks`, aditif; rilis lama
  tidak membacanya. Rollback di header migration.
- `resolveSchedule` membaca blok versi shift dalam query yang sama; `scheduledStartAt`/`EndAt` mencakup
  semua blok. Engine menilai tiap blok dengan `evaluateSessions` yang sama (B-3), lalu menggulung hari (B-5,
  B-7). Hash input hanya memuat blok untuk shift berbeberapa blok, jadi hari satu blok tidak berubah.
- Cuti, ketidakhadiran hasil penyelesaian cuti, dan Libur tetap dinilai untuk seluruh hari.
- `POST/PATCH /admin/attendance/schedules` menerima `extraBlocks`; validasi §4 menghasilkan `422
  SCHEDULE_BLOCKS_INVALID`. PATCH tanpa `extraBlocks` mempertahankan blok versi berjalan.
- Laporan Normal/Riil memakai B-6 dari `attendance_result_blocks`. Panel satu hari menampilkan baris per
  blok. `TBD`: baris per blok di tab Harian dan model Detail Harian; sekarang satu baris per hari dengan
  status hasil gulungan.
- `TBD`: mengubah blok shift yang sudah ada dari layar (sekarang lewat API atau buat shift baru).
- Selama hari berjalan, blok yang terlambat langsung membuat hari Terlambat; Riil per blok baru dihitung
  setelah hari lewat (baris hari ini sementara).
- `TBD`: Pantauan Hari Ini masih menilai selisih masuk terhadap awal blok pertama. Pegawai yang hanya hadir di
  blok kedua tampil terlambat di layar itu sampai Kalkulasi; hasil Kalkulasi dan laporan sudah benar.

## 7. Di luar cakupan

Blok dengan toleransi berbeda per blok, blok yang berbeda per hari dalam satu shift (pakai dua shift dan
pola per hari), dan jeda antarblok yang dibayar (PAY-003).
