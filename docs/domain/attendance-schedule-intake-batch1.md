# Jadwal Siap Input — Gelombang 1

**Status:** **DIINPUT ke production 2026-10-24** (§7). Toleransi telat dan lokasi kerja ditetapkan owner (§1).
**Tanggal:** 2026-10-23
**Sumber:** DRAF 01–08 SK Jadwal Kerja per Unit YSQ dan "RINGKASAN - Daftar Jadwal Kerja Pegawai YSQ".
**Analisis lengkap:** `attendance-schedule-intake-feasibility.md`

Dokumen ini hanya memuat kelompok yang **jamnya sudah pasti di draf SK dan pegawainya dapat
dipilih dari data HCIS tanpa menebak**. Tidak memuat data pribadi: pegawai dipilih dengan filter,
bukan daftar nama.

## 1. Keputusan owner (2026-10-23)

Kedua hal ini langsung menentukan siapa yang tercatat **Terlambat**, karena itu ditetapkan owner
dan bukan ditebak saat input.

| # | Hal | Keputusan |
|---|---|---|
| K-1 | **Toleransi telat** | **1 menit** untuk seluruh shift gelombang ini, sama dengan shift "Regular" yang sudah ada. Toleransi pulang cepat **0**. Draf SK tidak menyebut angka, jadi ini kebijakan operasional, bukan kutipan SK; bila SK final menyebut angka berbeda, shift diperbarui lewat versi baru. |
| K-2 | **Lokasi kerja per shift** | **Dikosongkan untuk seluruh shift**, termasuk shift SDIT. Aturan owner: **tempat scan tetap tercatat, tetapi shift tidak mengikat tempat absen** — pegawai shift SDIT boleh scan di mesin mana pun. HCIS sudah memenuhi ini tanpa perubahan: setiap scan mesin menyimpan mesin asalnya, dan kolom "Sumber"/mesin di Kehadiran harian serta laporan Data Scan menampilkannya. Lokasi pada shift hanya dipakai untuk mencocokkan titik GPS absen lewat HP. |

Konsekuensi yang perlu diketahui HC:

- **K-1.** Dengan toleransi 1 menit, scan pukul 07.01.30 pada shift 07.00 sudah tercatat
  **Terlambat 1 menit**. Angka ini memang ketat; menaikkannya nanti cukup dengan membuat versi
  shift baru, dan hasil kehadiran yang sudah terbentuk tidak berubah.
- **K-2.** Untuk shift tanpa lokasi, absen lewat **HP** selalu masuk antrean "perlu ditinjau"
  karena tidak ada titik yang dapat dicocokkan. Absen lewat **mesin fingerprint tidak
  terpengaruh**, dan itu jalur yang dipakai sekarang. Bila kelak absen HP dipakai serius, lokasi
  tinggal diisi di menu Lokasi kerja dan shift diperbarui.

## 2. Shift yang perlu dibuat (menu Shift)

Nilai di bawah sudah lengkap; tinggal disalin apa adanya.

| Shift | Jam masuk | Jam pulang | Toleransi telat | Toleransi pulang cepat | Lokasi |
|---|---|---|---|---|---|
| Yayasan Umum — Reguler | 07.00 | 16.00 | 1 menit | 0 | *(kosongkan)* |
| Yayasan Umum — Rabu | 07.00 | 17.00 | 1 menit | 0 | *(kosongkan)* |
| Taman Tahfizh — Senin–Kamis | 07.45 | 12.00 | 1 menit | 0 | *(kosongkan)* |
| Taman Tahfizh — Jumat | 07.45 | 13.00 | 1 menit | 0 | *(kosongkan)* |
| SDIT — Hari Penuh | 07.00 | 16.00 | 1 menit | 0 | *(kosongkan)* |

Tidak ada yang melewati tengah malam, jadi semuanya shift biasa.

Shift "Regular" 08.00–16.00 yang sudah ada **jangan dipakai** untuk kelompok ini: jamnya tidak
cocok dengan draf SK mana pun dan toleransi telatnya 1 menit. Biarkan saja; ia hanya dipakai oleh
1 assignment yang ada sekarang.

## 3. Pola jadwal yang perlu dibuat (menu Pola jadwal)

Kolom "Pilih pegawai" adalah filter yang dipakai di layar, bukan daftar nama.

| # | Pilih pegawai | Shift | Hari | Perkiraan jumlah |
|---|---|---|---|---|
| 1 | Unit **Taman Tahfizh** (seluruh unit, termasuk Kepala Sekolah dan Tata Usaha) | Taman Tahfizh — Senin–Kamis | Sen, Sel, Rab, Kam | 9 |
| 2 | Unit **Taman Tahfizh** (seluruh unit) | Taman Tahfizh — Jumat | Jum | 9 |
| 3 | Unit **SDIT Tahfizh**, jabatan **Guru Kelas** | SDIT — Hari Penuh | Sen–Jum | 12 |
| 4 | Unit **SDIT Tahfizh**, jabatan **Guru PAI** dan **Guru PJOK** | SDIT — Hari Penuh | Sen–Jum | 3 |
| 5 | Unit **Keuangan**, **Bidang Pendidikan**, **Human Capital Management**, **Divisi Media**, **Yayasan Sabilul Quran** | Yayasan Umum — Reguler | Sen, Sel, Kam, Jum | 8 |
| 6 | Unit yang sama dengan baris 5 | Yayasan Umum — Rabu | Rab | 8 |

Total sekitar **32 pegawai** dari 99.

Hari yang tidak dicentang otomatis menjadi Libur, jadi Sabtu dan Ahad tidak perlu diatur.

**Berlaku mulai:** draf SK menyebut 17 September 2026. Tanggal itu sudah lewat, dan jadwal yang
berlaku mundur akan langsung mengubah tampilan kehadiran hari-hari yang sudah lewat. Usul: isi
**tanggal hari ini** saat input, lalu mundurkan setelah SK ditandatangani, agar tidak ada hasil
lampau yang berubah sebelum SK sah.

### Catatan untuk baris 4 dan 5

- Baris 4: draf memisahkan "Guru Mata Pelajaran" dan "Guru Pendamping", tetapi jam keduanya sama
  persis, 07.00–16.00. Jadi walaupun pengelompokannya belum pas, jam yang tercatat tetap benar.
- Baris 5: draf tidak merinci unit mana saja yang termasuk "Yayasan Umum". Lima unit di atas adalah
  unit tingkat yayasan, bukan unit sekolah. **Mohon dikonfirmasi HC sebelum input.**

## 4. Yang sengaja tidak dimasukkan

| Kelompok | Alasan |
|---|---|
| SDIT Guru Tahfizh Putra & Putri (±26 pegawai) | Jam putra dan putri berbeda, dan data HCIS tidak memisahkannya. Label jabatan yang ada (`Guru Tahfizh SD Half Day II` dan sejenisnya) tidak menyatakan putra atau putri. Menebak di sini membuat ±26 pegawai punya jam pulang yang salah. Butuh daftar pemisahan dari HC. |
| Pesantren: Mudir, Waka Tahfizh, Guru Tahfizh | Dua Blok Kerja sehari; HCIS belum mendukung dan akan menampilkan "Jadwal bermasalah". Lihat §2 dokumen kelayakan. |
| Pesantren: Waka Kesantrian, Musyrif | Jadwalnya "sesuai roster" dan rosternya belum ada. Musyrif juga masih menunggu persetujuan pimpinan. |
| General Affair: Keamanan, Kebersihan, Dapur (12 pegawai) | Jadwal belum final di draf, dan seluruh 12 pegawai General Affair belum punya data jabatan sehingga tidak dapat dipilah. |
| SMPIT dan PKBM | Belum ada pegawai di unit tersebut. |

## 5. Setelah input

1. Buka **Waktu & Kehadiran → Kehadiran harian**. Pegawai dalam daftar di atas mestinya tidak lagi
   tampil "Libur", melainkan Terjadwal / Belum absen / Hadir / Terlambat sesuai jam.
2. Hari yang sudah lewat belum ikut berubah sampai dihitung ulang. Sampai ATT-011-2 dirilis,
   gunakan **Pengaturan → Finalisasi ulang** per tanggal.
3. Begitu jadwal terisi, hari dengan satu scan saja akan tampil **Tidak lengkap**. Itu benar menurut
   aturan: jam pulang tidak pernah diisi dari jadwal. Perkiraan dari data: sekitar 29% hari-pegawai.
4. Kalender libur nasional masih kosong (1 entri). Selama belum diisi, tanggal merah akan tampil
   sebagai hari kerja biasa.

## 6. Membatalkan

Pola jadwal dapat diakhiri dari layar dengan mengisi tanggal akhir; tidak ada data kehadiran yang
hilang karena bukti scan tidak tersentuh. Shift yang terlanjur dibuat tidak bisa dihapus bila sudah
dipakai, tetapi dapat dinonaktifkan setelah pola jadwalnya diakhiri.

## 7. Pelaksanaan 2026-10-24

Diinput lewat layar HCIS production (`/admin/attendance/shifts` dan `/admin/attendance/schedules`)
oleh agen di panel browser yang login-nya dilakukan owner sendiri; agen tidak memegang kredensial.
Seluruh perubahan tercatat di audit aplikasi atas nama akun yang login (Administrator HCIS).
Tidak ada akses database langsung.

**Shift dibuat (5):** Yayasan Umum — Reguler 07.00–16.00, Yayasan Umum — Rabu 07.00–17.00,
Taman Tahfizh — Senin–Kamis 07.45–12.00, Taman Tahfizh — Jumat 07.45–13.00, SDIT — Hari Penuh
07.00–16.00. Semua toleransi telat 1 menit, pulang cepat 0, tanpa lokasi, selesai hari yang sama.

**Pola jadwal dibuat (49), berlaku mulai 2026-10-24 tanpa tanggal akhir:**

| Kelompok | Shift | Hari | Pegawai | Pola |
|---|---|---|---|---|
| SDIT Guru Kelas + Guru PAI/PJOK | SDIT — Hari Penuh | Sen–Jum | 15 | 15 |
| Taman Tahfizh | Senin–Kamis / Jumat | Sen–Kam / Jum | 9 | 18 |
| Yayasan Umum (5 unit, dikonfirmasi owner) | Reguler / Rabu | Sen, Sel, Kam, Jum / Rab | 8 | 16 |
| **Total** | | | **32** | **49** |

**Pola lama diakhiri (1):** satu pegawai unit Human Capital Management memakai shift "Regular"
08.00–16.00 sejak 2023-01-21. Pola itu diakhiri pada **2026-10-23** sebelum pola Yayasan Umum
dibuat, agar hari kerjanya tidak tumpang tindih ("Jadwal bermasalah"). Riwayat sebelum 24 Oktober
tetap memakai shift lama. Shift "Regular" kini tidak dipakai pola aktif mana pun dan dibiarkan.

**Verifikasi dari data aplikasi (bukan dari tampilan):**

- 49 pola baru; tidak ada duplikat; **0 pasangan pola yang tumpang tindih** untuk pegawai mana pun.
- Kehadiran harian: Sabtu 2026-10-24 → 99 Libur (benar, tidak ada kelompok yang bekerja Sabtu).
  Senin 26, Rabu 28, dan Jumat 30 Oktober → masing-masing **32 Terjadwal, 67 Libur**.
- Contoh jam terjadwal sesuai: Yayasan Umum Rabu 07.00–17.00 dan Jumat 07.00–16.00; Taman Tahfizh
  Rabu 07.45–12.00 dan Jumat 07.45–13.00; SDIT 07.00–16.00.

**Yang harus diketahui HC mulai Senin 2026-10-26.** Sebelum hari ini masalah K-1 hampir tidak
terlihat karena hanya 1 pegawai yang terjadwal. Sekarang 32 pegawai terjadwal, dan engine masih
**belum** menghitung scan secara otomatis (ATT-011-2 belum dirilis). Akibatnya pegawai yang sudah
scan akan tampil **"Tidak hadir" setelah jam pulangnya lewat**, sampai HC menekan
**Pengaturan → Finalisasi ulang** untuk tanggal itu. Sementara ATT-011-2 belum ada, jalankan
Finalisasi ulang setiap sore untuk hari tersebut. Setelah finalisasi, hari dengan satu scan saja
akan tampil **Tidak lengkap** — itu benar menurut aturan.

67 pegawai lain tetap tampil Libur sampai kelompoknya diisi: guru tahfizh SDIT (menunggu pemisahan
putra/putri), Pesantren (menunggu ATT-013 untuk Blok Kerja ganda dan roster), dan General Affair
(menunggu data jabatan dan jadwal final).
