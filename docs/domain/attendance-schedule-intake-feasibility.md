# Kelayakan Input Jadwal Kerja Draf SK ke HCIS

**Status:** DISCOVERY — hasil pemeriksaan, bukan keputusan produk.
**Tanggal:** 2026-10-23
**Sumber draf:** Google Drive — "RINGKASAN - Daftar Jadwal Kerja Pegawai YSQ (Bahan Presentasi)",
"Jadwal Kerja Yayasan Sabilul Qur'an - Draft HCM", folder "DRAF - SK Induk dan Jadwal Kerja per Unit YSQ"
(DRAF 01–08). Semua bertanda draf; ringkasan menyatakan dirinya **"bukan dokumen penetapan"**.
**Terkait:** ATT-003/ATT-007 (model jadwal), ATT-011 §1 non-goal, ATT-011-2, ATT-011-4/5

## 1. Keadaan HCIS production (read-only, 2026-10-23)

| Objek | Nilai |
|---|---|
| Pegawai aktif | 99 (97 punya unit, 2 tanpa unit) |
| Shift (template) | 1 — "Regular" 08:00–16:00, toleransi telat **1 menit**, lokasi Pesantren |
| Lokasi kerja | 2 — Pesantren Tahfizh, SDIT Tahfizh (radius 60 m) |
| Assignment jadwal aktif | 1 pegawai |
| Roster published | 0 |
| Hari libur di kalender | 1 entri |

Sebaran pegawai aktif per unit: SDIT Tahfizh 46, Pesantren Tahfizh 22, General Affair 12,
Taman Tahfizh 9, Keuangan 2, Yayasan Sabilul Quran 2, Bidang Pendidikan 2, Human Capital
Management 1, Divisi Media 1, tanpa unit 2. **Tidak ada pegawai di unit SMPIT maupun PKBM**,
padahal draf memuat kelompok untuk keduanya.

## 2. Konflik model yang paling menentukan: Blok Kerja ganda

Draf membangun jadwal di atas konsep **Blok Kerja**, dan tab audit di spreadsheet menyatakan
prinsip presensinya: *presensi masuk pada awal dan presensi pulang pada akhir setiap Blok Kerja*.
Beberapa kelompok punya **dua Blok Kerja dalam satu hari** yang dipisahkan Jeda Antarblok
berjam-jam.

HCIS tidak dapat menyatakan itu:

- `resolveSchedule` (`apps/api/src/modules/attendance/engine.ts`) mengambil assignment yang cocok
  dengan `LIMIT 2`; bila lebih dari satu cocok untuk satu tanggal, hasilnya
  **`configuration_error`** (`ambiguous_default_assignment`) — di layar: "Jadwal bermasalah".
- ATT-011 §1 mencantumkan **"multi-shift per pegawai per hari" sebagai non-goal** eksplisit.

Kelompok yang terdampak:

| Kelompok | Blok | Perkiraan pegawai |
|---|---|---|
| Pesantren — Guru Tahfizh | 04.00–08.30 + 14.30–19.30, setiap hari kerja | 5 (`Guru Tahfizh Pes`) |
| Pesantren — Wakil Kepala Tahfizh | 2 blok setiap hari kerja | 1 |
| Pesantren — Mudir | 03.30–05.00 + 15.00–21.00/22.00 | 1 |
| SDIT — Guru Tahfizh Putra | Rabu 07.00–12.30 + 16.00–17.00 | sebagian dari 26 guru tahfizh SDIT |

**Ini keputusan owner, bukan detail teknis.** Tiga pilihan:

1. **SK menyesuaikan**: hari dua blok dinyatakan sebagai satu rentang kerja (misal Guru Tahfizh
   Pesantren 04.00–19.30) dengan Jeda Antarblok diperlakukan sebagai istirahat panjang. Jam kerja
   efektif di SK tetap seperti sekarang, tetapi HCIS akan menilai kehadiran dari scan pertama dan
   scan terakhir. Risiko: pegawai yang hanya hadir satu blok tetap terlihat "Hadir" dengan label
   pulang cepat, bukan sebagai blok yang terlewat.
2. **HCIS menyesuaikan**: dukungan multi-blok per hari dibuat sebagai spesifikasi baru. Ini
   membatalkan satu non-goal ATT-011 dan menyentuh resolver, engine, serta UI — paket tersendiri,
   bukan bagian ATT-011-2/4/5.
3. **Kelompok dua blok ditunda** dari HCIS sampai salah satu di atas diputuskan; kelompok satu
   blok tetap jalan lebih dulu.

Rekomendasi: pilihan 3 sekarang, dengan pilihan 1 atau 2 diputuskan dalam forum pembahasan SK,
karena pilihan 1 mengubah makna SK dan pilihan 2 menambah paket pekerjaan.

> **Keputusan owner 2026-10-24: pilihan 2 — HCIS yang menyesuaikan.** SK tidak diubah; HCIS
> mendapat dukungan Blok Kerja ganda. Spesifikasinya **ATT-013**
> (`attendance-multi-block-schedule.md`), dan non-goal "multi-shift per pegawai per hari" di
> ATT-011 §1 dibatalkan. Keputusan ini **tidak memblokir** pengisian jadwal gelombang 1: kelompok
> satu blok tetap dapat diisi sekarang (`attendance-schedule-intake-batch1.md`). Empat kelompok
> dua blok di tabel §3 terbuka setelah ATT-013-1 dirilis.

## 3. Pemetaan 17 kelompok draf ke HCIS

Status: **Siap** = satu blok per hari, jam jelas, pegawai dapat diidentifikasi.
**Terblokir** = tidak dapat dinyatakan di model HCIS. **Belum lengkap** = datanya belum ada.

| # | Kelompok draf | Pola | Status di HCIS | Catatan |
|---|---|---|---|---|
| 1 | Yayasan Umum | Sen/Sel/Kam 07–16, Rab 07–17, Jum 07–16 | Siap | 2 shift + 2 assignment. Pegawai belum dipastikan (lihat §4). |
| 2 | Taman Tahfizh | Sen–Kam 07.45–12.00, Jum 07.45–13.00 | **Siap** | 9 pegawai, satu unit penuh termasuk KS & TU. |
| 3 | SDIT Guru Kelas | Sen–Jum 07–16 | **Siap** | 12 pegawai berlabel `Guru Kelas`. Beda Selasa hanya pada istirahat, tidak memengaruhi status. |
| 4 | SDIT Guru Tahfizh Putra | Sen/Sel/Kam/Jum 07–12.30; **Rabu 2 blok** | Terblokir (Rabu) | Hari lain bisa; Rabu butuh keputusan §2. |
| 5 | SDIT Guru Tahfizh Putri | Sen/Sel/Kam/Jum 07–13, Rab 07–12.30 | Siap | Pemisahan putra/putri tidak ada di data pegawai. |
| 6 | SDIT Guru Pendamping | Sen–Jum 07–16 | Belum lengkap | Tidak ada pegawai berlabel ini. |
| 7 | SDIT Guru Mata Pelajaran | Sen–Jum 07–16 | Siap | Kandidat: `Guru PAI` 2, `Guru PJOK` 1 — perlu konfirmasi. |
| 8 | SMPIT | Sen/Sel/Kam 07–16, Rab 07–17, Jum 07–16 | Tidak relevan | Belum ada pegawai di unit ini. |
| 9 | PKBM | sama dengan SMPIT | Tidak relevan | Belum ada pegawai di unit ini. |
| 10 | Pesantren Mudir | 2 blok | **Terblokir** + menunggu verifikasi pimpinan | |
| 11 | Pesantren Waka Kesantrian | Sesuai roster | Belum lengkap | Roster belum ada. Lembur Ahad 19–21 lewat alur lembur. |
| 12 | Pesantren Musyrif | Sesuai roster | Belum lengkap | Menunggu persetujuan pimpinan (2 hari libur). 3 pegawai. |
| 13 | Pesantren Waka Tahfizh | 2 blok | **Terblokir** | |
| 14 | Pesantren Guru Tahfizh | 2 blok | **Terblokir** + menunggu verifikasi kepala unit | 5 pegawai. |
| 15 | GA Tenaga Keamanan | Shift/roster | Belum lengkap | WIP, mungkin SK tersendiri. |
| 16 | GA Tenaga Kebersihan | Sen–Sab, roster per area | Belum lengkap | Jam masuk/pulang belum ditetapkan. |
| 17 | GA Tim Dapur | Roster layanan dapur | Belum lengkap | WIP, mungkin SK tersendiri. |

Ringkasan: **4 kelompok siap** (≈ 24–32 pegawai), **4 terblokir model**, **6 belum lengkap**,
**2 tidak relevan**, 1 sebagian.

## 4. Hambatan data pegawai

`functional_position` terisi hanya pada 59 dari 99 pegawai aktif; `structural_position` 18.
Yang kosong seluruhnya: **General Affair 12 dari 12**, Taman Tahfizh 7 dari 9, Pesantren 8 dari 22,
SDIT 4 dari 46.

Dampak:

- Kelompok yang dipetakan **per unit** tetap bisa (Taman Tahfizh, Yayasan Umum), karena satu unit
  satu jadwal.
- Kelompok yang dipetakan **per jabatan** butuh label yang bersih. Label sekarang tidak sepadan
  dengan nama kelompok di draf, misalnya `Guru Tahfizh SD Half Day II` (23 pegawai) tidak
  menyatakan putra atau putri, padahal draf memisahkan keduanya dengan jam berbeda.
- General Affair tidak dapat dipetakan sama sekali ke Keamanan / Kebersihan / Dapur dari data HCIS.

## 5. Hal lain yang perlu diketahui sebelum input

- **Istirahat tidak dapat disimpan.** HCIS tidak punya model jam istirahat; `breakMinutes` hanya
  dihitung dari jeda antarsesi scan. Jam istirahat di draf tidak memengaruhi status Hadir/Terlambat,
  jadi ini tidak memblokir, tetapi "jam kerja efektif" di HCIS tidak akan sama dengan angka FTE di SK.
- **Toleransi telat shift "Regular" saat ini 1 menit.** Terlalu ketat untuk dipakai produksi; nilai
  per shift harus ditetapkan dalam SK atau oleh HC.
- **Kalender libur praktis kosong** (1 entri). Libur nasional akan tampil sebagai hari kerja sampai
  diisi. Sabtu/Ahad aman karena ditangani `weekday_mask`.
- **Lokasi kerja** baru 2 (Pesantren, SDIT), radius 60 m. Shift tanpa lokasi membuat absen HP selalu
  "perlu ditinjau".
- **Tidak ada jalur impor massal.** Assignment dibuat satu per satu lewat
  `POST /admin/attendance/schedule-assignments` atau UI "Pola jadwal". Untuk ±32 pegawai dengan
  2–3 assignment per orang, sekitar 60–90 operasi.

## 6. Cara input yang dapat dipertanggungjawabkan

| Cara | Penilaian |
|---|---|
| **HC melalui UI "Pola jadwal"** | Disarankan. Validasi dan audit berjalan di akun HC, tidak ada akses production tambahan. Agen menyiapkan daftar shift dan pemetaan pegawai agar pengisian bersifat mekanis. |
| CLI impor jadwal (baru) | Mengikuti pola `employees:import` yang sudah ada. Layak bila jumlahnya bertambah besar, tetapi ini fitur baru: butuh specification ID, PR, dan test (AGENTS.md §3, §7). |
| Agen menulis langsung ke database | Tidak disarankan. Melewati validasi aplikasi dan jejak audit untuk data kepegawaian, dan membutuhkan persetujuan owner eksplisit. |
| Agen memakai API production | Tidak dapat dilakukan agen: memerlukan kredensial admin production. |

## 7. Urutan yang disarankan

1. Owner memutuskan perkara Blok Kerja ganda (§2).
2. HC melengkapi `functional_position`, terutama General Affair dan Taman Tahfizh, dan memastikan
   pemisahan guru tahfizh putra/putri (§4).
3. Setelah SK kelompok satu blok ditetapkan, HC mengisi Taman Tahfizh, SDIT Guru Kelas, Yayasan
   Umum, dan SDIT Guru Mapel lebih dulu; kelompok roster menyusul setelah rosternya ada.
4. Kalender libur nasional diisi.
5. ATT-011-2 dirilis setelah jadwal terisi, agar hasil kehadiran mulai mengikuti scan
   (lihat risiko R9/R10 di `attendance-auto-recompute-implementation-plan.md`).
