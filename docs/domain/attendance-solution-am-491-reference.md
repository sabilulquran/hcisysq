# Referensi Solution Attendance Management 4.9.1 — Jam Kerja, Shift, Jadwal, Laporan

**Status:** DISCOVERY — temuan referensi, bukan keputusan produk.
**Tanggal:** 2026-10-24
**Diminta owner:** bedah pengaturan Shift → Jam Kerja → Jadwal, serta bagian laporan.
**Terkait:** ATT-013 (Blok Kerja ganda), ATT-009 (laporan), ATT-011 §3 (navigasi), `attendance-wdms-805-source-audit.md`

## 1. Bahan dan metode

Paket lokal `Attendance Management Versi 4.9.1 Indonesia` (di luar repo): aplikasi desktop Delphi
merek Solution (OEM ZKTeco), berbasis database Microsoft Access.

Yang dibaca, tanpa menjalankan aplikasi:

| Bahan | Isi yang diambil |
|---|---|
| `att2000.mdb` | Struktur tabel dan parameter bawaan. **Database ini template kosong**: tidak ada pegawai, scan, maupun jadwal, sehingga tidak ada data pribadi yang tersentuh. Dibaca dengan `access-parser` (PyPI) di folder scratch. |
| `attcheckin.in` | Berkas bahasa Indonesia berformat INI per layar: label setiap kolom dan tombol. Dari sini isi tiap layar direkonstruksi. |
| `RPTLIST.CFG`, `*.rpt` | Daftar laporan dan field data yang dipakai templat laporan (FastReport). |

## 2. Model tiga lapis

Aplikasi ini memisahkan **blok waktu**, **pola hari**, dan **penugasan pegawai** menjadi tiga hal.

```text
Jam Kerja (SchClass)        satu blok waktu: masuk, pulang, toleransi, jendela scan, hitungan hari
      │  satu atau lebih per hari
      ▼
Shift (NUM_RUN + detail)    pola berulang: hari ke-n siklus → daftar Jam Kerja
      │  satu atau lebih per pegawai, bertanggal
      ▼
Jadwal Karyawan             pegawai + shift + tanggal mulai/akhir (+ jadwal sementara per tanggal)
```

### 2.1 Jam Kerja — layar "Pengaturan jam kerja"

| Field layar | Kolom DB | Arti |
|---|---|---|
| Nama Jam kerja | `schName` | |
| Jam masuk / Jam pulang | `StartTime` / `EndTime` | Satu blok. |
| Toleransi terlambat (menit) | `LateMinutes` | **Per blok**, bukan per shift. |
| Toleransi plg. cepat (menit) | `EarlyMinutes` | Per blok. |
| Jam mulai / akhir scan masuk | `CheckInTime1` / `CheckInTime2` | Jendela waktu scan yang dianggap scan masuk blok ini. |
| Jam mulai / akhir scan pulang | `CheckOutTime1` / `CheckOutTime2` | Jendela waktu scan pulang blok ini. |
| Harus C/In · Harus C/Out | `CheckIn` / `CheckOut` | Apakah blok ini wajib scan masuk/pulang. |
| **Hitungan hari** | `WorkDay` | Blok ini bernilai berapa hari kerja, misalnya **0,5**. |
| **Hitungan menit** | `WorkMins` | Blok ini bernilai berapa menit kerja. |
| Warna | `Color` | Warna di jadwal/laporan. |

Ada juga tombol "Menganalisa Periode Shift dari Data Presensi" yang mengusulkan jam kerja dari pola
scan yang ada.

### 2.2 Shift — layar "Pengaturan Shift"

`NUM_RUN`: Nama Shift, Tgl. Mulai, **Periode** (panjang siklus) dan **Unit Periode** (hari / minggu /
bulan). Isinya diatur lewat dialog "Tambah Periode Shift":

- "Pilih hari jam kerja akan diterapkan" — hari-hari dalam siklus;
- "Pilih jam kerja untuk jadwal ini" — Jam Kerja yang dipasang pada hari-hari itu;
- "Dihitung lembur" dan "Lembur (menit)".

Setiap pasangan disimpan sebagai satu baris `NUM_RUN_DEIL (SDAYS, EDAYS, SCHCLASSID)`. **Tidak ada
batasan satu Jam Kerja per hari**: dua baris dengan hari yang sama berarti hari itu memuat dua blok.

**Inilah cara dua blok digabung** — sesuai ingatan owner. Contoh untuk Guru Tahfizh Pesantren:

| Jam Kerja | Jam | Hitungan hari |
|---|---|---|
| Tahfizh Pagi | 04.00–08.30 | 0,5 |
| Tahfizh Sore | 14.30–19.30 | 0,5 |

Keduanya dipasang pada Senin–Jumat di satu Shift, sehingga satu hari penuh bernilai 1 hari kerja.

### 2.3 Jadwal Karyawan — layar "Jadwal kerja karyawan"

| Bagian | Tabel | Arti |
|---|---|---|
| Jadwal tetap | `USER_OF_RUN (USERID, NUM_OF_RUN_ID, STARTDATE, ENDDATE, ORDER_RUN)` | Pegawai memakai shift dalam rentang tanggal; boleh beberapa shift berurutan ("Metode mengubah Shift" untuk rotasi). |
| Jadwal tidak tetap / sementara | `USER_TEMP_SCH (COMETIME, LEAVETIME, SCHCLASSID)` | Pengganti untuk tanggal tertentu. |
| Opsi per pegawai | `USERINFO` | Masuk Kerja / Jam Pulang: *ikut jam kerja · harus scan · ijinkan tidak scan*; Registrasi lembur; Hari Libur; Absensi Aktif; Hitung Lembur. |
| Jadwal otomatis | `UserUsedSClasses`, `DeptUsedSchs` | "Jadwal kerja otomatis": sistem memilih Jam Kerja dari daftar yang diizinkan berdasarkan jam scan. |
| Default departemen | `DEPARTMENTS.DefaultSchId` | "Jam kerja standar" untuk pegawai baru, dan daftar jam kerja yang boleh dipakai departemen. |

## 3. Aturan presensi — layar "Pengaturan Presensi"

| Aturan | Nilai bawaan | Catatan untuk HCIS |
|---|---|---|
| Satu hari kerja | 420 menit | Konversi menit ↔ hari di laporan. |
| Terlambat dihitung setelah / pulang cepat sebelum | 10 / 5 menit | Ambang global, di samping toleransi per Jam Kerja. |
| Tidak scan masuk dianggap | *Terlambat N menit* atau *Absen* | **Bertentangan dengan I-3 HCIS**: aplikasi ini mengubah scan yang hilang menjadi terlambat/absen. HCIS mempertahankan "Tidak lengkap". |
| Tidak scan pulang dianggap | *Pulang cepat N menit* atau *Absen* | Sama, bertentangan dengan I-3. |
| Terlambat / pulang cepat lebih dari N menit dianggap absen | opsional | Kebijakan, bukan teknis. |
| JK lewat tengah malam | Hari pertama / Hari kedua | HCIS memakai "hari pertama" (tanggal kerja = tanggal mulai). |
| Lembur | awal/akhir aktif setelah N menit, maksimum, akhir pekan dihitung lembur, **Registrasi Lembur** | "Registrasi Lembur" sejalan dengan I-7 HCIS (lembur hanya dari keputusan eksplisit). |
| Set akhir pekan | pilih hari + simbol + warna | |

## 4. Kalkulasi dan laporan

### 4.1 Hasil dihitung per Jam Kerja, bukan per hari

Layar "Laporan dan Kalkulasi Transaksi" tab **Shift** menampilkan **satu baris per pegawai per
tanggal per Jam Kerja**. Kolomnya antara lain: Jam Kerja, Jam Masuk, Jam Pulang, Scan Masuk, Scan
Pulang, **Normal**, **Riil**, Tidak C/In, Tidak C/Out, Terlambat, Plg. Cepat, Absent, Lembur, Jml
Jam Kerja, Hari Normal / Akhir Pekan / Hari Libur, Jml Kehadiran.

`Normal` adalah hitungan hari yang **seharusnya** (nilai Jam Kerja, misal 0,5) dan `Riil` adalah
yang **benar-benar didapat**. Pegawai dua blok yang hanya hadir pagi menghasilkan dua baris:
pagi Normal 0,5 · Riil 0,5, dan sore Normal 0,5 · Riil 0 · Absen. Di rekap bulanan keduanya
dijumlahkan: **0,5 dari 1 hari**.

Aplikasi ini tidak pernah memaksa satu status per hari untuk hari dua blok.

### 4.2 Daftar laporan (dari `RPTLIST.CFG`)

| Laporan | Isi | Padanan HCIS (ATT-009) |
|---|---|---|
| Statistik presensi harian (`attdaily`) | **Grid bulanan**: baris = pegawai, kolom = tanggal 1–31 berisi **simbol** per hari, lalu total Seharusnya, Riil, Terlambat, Pulang cepat, Absen, Lembur, Ijin, Dinas luar. | **Belum ada.** HCIS "Periode" memberi total per pegawai tetapi tidak menampilkan grid tanggal 1–31. |
| Rekap presensi (`atttotal`) | Total per pegawai. | Ada: laporan Periode. |
| Rekap per departemen (`depttotal`) | Total per unit. | Ada: laporan Unit. |
| Jam masuk–pulang karyawan (`empattrec`) | Daftar jam per hari. | Ada: Detail harian. |
| Jadwal shift harian (`attDailySch`) | **Grid bulanan** jadwal: pegawai × tanggal → nama Jam Kerja. | Sebagian: laporan Jadwal HCIS berupa daftar, bukan grid. |
| Statistik jam kehadiran bulanan (`attdailyOT`) | Jam kerja per hari dalam sebulan. | Sebagian: Detail harian. |
| Lembur bulanan (`attOverTime`, `SummaryOfOverTime`) | Statistik dan ringkasan lembur. | Ada: laporan Lembur. |
| Catatan presensi (`empinouts*`) | Log scan mentah. | Ada: Data Scan. |
| Pengecualian (`exc`) | Daftar pelanggaran. | Sebagian: Klarifikasi. |
| Perubahan data presensi (`recmodi`) | Log koreksi. | Sebagian: audit koreksi. |

Setiap item statistik dapat diatur: satuan minimal (jam/menit/hari), pembulatan (ke bawah / apa
adanya / ke atas), "hitung berapa kali", simbol di laporan, dan apakah ijin ikut dihitung.

### 4.3 Yang dilakukan aplikasi ini tetapi **tidak boleh ditiru**

- Tab "Data Transaksi" mengizinkan operator **menambah, mengganti status, dan menghapus scan**
  langsung. HCIS menjaga bukti mentah immutable (I-2); koreksi adalah event terpisah beralasan.
- Scan yang hilang **diubah menjadi terlambat/pulang cepat/absen** menurut aturan. HCIS
  mempertahankan "Tidak lengkap" sampai ada koreksi atau klarifikasi (I-3).
- Waktu di luar jam kerja **otomatis dihitung lembur** (di data operasional owner terlihat
  "Lembur 00:45" hampir setiap hari). HCIS hanya mengakui lembur dari pengajuan yang disetujui (I-7);
  scan di luar jadwal tampil sebagai fakta.

Contoh nyata dari tangkapan layar owner (data operasional aplikasi lama, April–Mei 2026, tidak
disalin ke repo): hari tanpa scan pulang tampil **Plg. Cepat 01:00** dengan latar hijau, dan hari
tanpa scan masuk tampil **Terlambat 01:00**. Di HCIS kedua hari itu akan tampil **Tidak lengkap**.

### 4.4 Layar "Laporan dan Kalkulasi Transaksi" — alur kerja

Alur yang dipakai HC sehari-hari (dikonfirmasi tangkapan layar owner 2026-10-24):

1. **Pilih** Departemen, Nama (atau `<Semua>`), dan Rentang Waktu (dengan pintasan Kemarin, Hari ini,
   Minggu ini/lalu, Bulan ini/lalu).
2. Tekan **Kalkulasi**. Aplikasi menghitung rentang itu saat itu juga (dengan bilah proses) — tidak
   ada perhitungan otomatis di latar belakang.
3. Hasilnya tampil sebagai **tabel setengah mentah** dalam beberapa tab, belum berbentuk laporan.
4. Dari tabel itu operator memilih **Laporan** (format bawaan), **Ekspor Data**, atau mencentang
   **Desain Laporan** untuk menyunting templat.

Tab dan kolomnya:

| Tab | Satu baris = | Kolom utama |
|---|---|---|
| **Data Transaksi** | satu scan | Waktu, Status (masuk/keluar), Status baru, Pengecualian, Shift, Operasi. Ada aksi ubah status / tambah / hapus scan (tidak boleh ditiru, §4.3). |
| **Shift** | pegawai × tanggal × Jam Kerja | Jadwal, Auto-Assign, Tanggal, Jam Kerja, Jam Masuk/Pulang, Scan Masuk/Pulang, **Normal, Riil**, Tidak C/In, Tidak C/Out, Terlambat, Plg. Cepat, Absent, Lembur, Jml Jam Kerja, Pengecualian, Simbol, Harus C/In/Out, Hari Normal/Akhir Pekan/Hari Libur, Jml Kehadiran, Lembur per jenis hari. |
| **Pengecualian** | ijin/dinas luar/koreksi | Jam mulai/akhir, Pengecualian, Diaudit, Jam shift, Total jam, Waktu valid, Tanggal, Hari kerja. Ada alur setujui/batalkan audit. |
| **Rekapitulasi** | pegawai | **Kolom dinamis** dari daftar "Item" yang dapat ditambah, diubah, diurutkan (Normal, Riil, Absen, Terlambat, Pulang Cepat, Lembur, tiap jenis ijin, Tidak C/In/Out, dsb.). |
| **Laporan Lembur** | pegawai × tanggal | Jam masuk/pulang, Scan masuk/pulang, Waktu kerja, Lembur awal/akhir, Lembur hari normal/akhir pekan/libur, Jml lembur, Memo. |
| **Tidak Ada Shift** | pegawai × tanggal tanpa jadwal | Scan Masuk/Pulang 1–5, Total jam kerja. |

Alat pada tabel: filter status (Normal, Terlambat, Pulang Cepat, Tidak C/In, Tidak C/Out, Absen,
Auto-assigned), filter jam kerja, ganti warna, cari, urutkan (Dep., No. ID, Nama, Jam, Z→A),
pilih kolom yang tampil, **kolom tetap** (bekukan 0–6 kolom kiri), **simpan/buka layout**,
**Ekspor Data** dan Ekspor lanjutan, **Buat Laporan dari Tampilan Aktif**, dan **Simpan sebagai
templat laporan**. Cetak bisa potret/lanskap; keluaran ke layar, printer, atau file teks.

### 4.5 Format laporan bawaan

Menu **Laporan** (tangkapan layar owner) dipetakan ke templat FastReport yang terkirim bersama aplikasi:

| Menu | Templat | Bentuk |
|---|---|---|
| **Laporan Harian** | `attdaily.rpt` | **Grid bulanan** per departemen: baris = pegawai (nama + No. ID), kolom = tanggal 1–31 berjudul tanggal + nama hari, isi = **simbol** status hari itu; akhir pekan abu-abu, hari libur kuning; kolom total Normal, Riil, Absen, Terlambat, Pulang Cepat, Lembur, Jml Ijin, Dinas Luar; legenda simbol di kepala laporan. |
| **Laporan Rekapitulasi** | `atttotal.rpt` | Baris = pegawai, dikelompokkan per departemen dengan **subtotal** dan total: Normal, Riil, Absen, Terlambat, Pulang Cepat, Lembur, jenis-jenis ijin, Tidak scan masuk, Tidak scan pulang, Waktu kerja, **Presensi %** (= Riil ÷ Normal). |
| **Laporan Per Departemen** | `depttotal.rpt` | Item yang sama dengan Rekapitulasi, tetapi satu baris per departemen. |
| **Data Scan Karyawan** | `empattrec.rpt` | Per pegawai, blok mingguan; tiap kolom tanggal (`mm/dd ddd`) berisi **semua jam scan** hari itu. |
| **Jadwal Harian Karyawan** | `attDailySch.rpt` | **Grid bulanan** pegawai × tanggal berisi nama Jam Kerja hari itu, dengan legenda warna. |
| **Laporan Detail Harian** | `attdailyOT.rpt` | Per pegawai, satu baris per tanggal: Jam Masuk, Jam Pulang, Scan Masuk, Scan Keluar, Terlambat, Pulang Cepat, Lembur, Pengecualian, Jml Hadir; jumlah baris per pegawai. |
| **Data Transaksi Karyawan** | `SummaryOFOvertime.rpt` (judul di templat: "Data Transaksi Karyawan") | Grid pegawai × tanggal, tiap sel berisi jam-jam scan hari itu. |
| **Laporan Lembur Harian** | `attOverTime.rpt` | Grid pegawai × tanggal berisi lembur per hari, lalu Total lembur, Lembur hari normal, Lembur akhir pekan + libur. |
| **Buat laporan dari tampilan aktif** | dinamis (`attcust.rpt`) | Mencetak kolom dan filter tabel yang sedang tampil, dikelompokkan per departemen dengan jumlah orang. |

Laporan pendukung lain: Pengecualian per departemen (`exc.rpt`), Ijin/Dinas luar beserta ringkasan
per jenis (`attleave.rpt`), Jadwal kerja per pegawai (`schs.rpt`), dan **Log perubahan data
presensi** — siapa mengubah apa, kapan, dan alasannya (`recmodi.rpt`).

Semua laporan memakai kepala yang sama: judul, rentang tanggal, "oleh: <pengguna>", tanggal cetak,
dan nomor halaman.

### 4.6 Desain laporan sendiri

Centang **Desain Laporan** membuka perancang FastReport (band, memo, ekspresi data, skrip warna).
Templat hasil suntingan disimpan dan muncul sebagai "Laporan yang dibuat sendiri". Dalam praktik,
kebanyakan kebutuhan kustom dipenuhi oleh kombinasi **pilih kolom + filter + simpan layout +
laporan dari tampilan aktif**, dan perancang penuh hanya untuk tata letak cetak khusus.

## 5. Struktur menu

Menu utama aplikasi ini memisahkan dua dunia:

- **Operasi Umum** (toolbar depan): Data Presensi, Pelanggaran, Ijin, Karyawan, Jam Kerja, Laporan.
- **Pengaturan Mesin** (panel terpisah): koneksi, download/upload data dan sidik jari, sinkronisasi
  waktu, backup/restore mesin, hapus data mesin, pintu dan hak akses.

Ini sama dengan permintaan owner untuk HCIS (2026-10-24): menu depan hanya untuk membuat laporan,
melihat data transaksi, menambah pegawai ke mesin, dan menghubungkan data; operasi mesin yang rumit
dipindah ke belakang.

**Usul pemetaan untuk HCIS** (halaman ADMS yang ada saat ini: Ringkasan mesin, Transaksi, Pengguna
mesin, Job, Kesehatan, Audit):

| Tempat | Isi |
|---|---|
| **Depan** — tetap di menu "Waktu & Kehadiran" | Laporan; Data scan / transaksi; **Pegawai di mesin** (tambah pegawai ke mesin dan hubungkan PIN mesin dengan data pegawai). |
| **Belakang** — Pengaturan → Mesin (lanjutan) | Ringkasan dan konfigurasi mesin, Job/perintah ke mesin, Kesehatan, Audit, dan operasi teknis lainnya. |

Ini perubahan navigasi tersendiri (bukan ATT-013) dan dikerjakan sebagai paket terpisah.

## 6. Dampak ke HCIS

| Temuan | Dampak | Tindak lanjut |
|---|---|---|
| Dua blok digabung dengan **Hitungan hari** per blok | Menguatkan arah ATT-013 dan memberi jawaban yang lebih baik untuk D-13-1: hadir sebagian dinyatakan sebagai **0,5 dari 1 hari**, bukan hanya sebagai status. | ATT-013 ditambah bobot hari per blok dan hitungan Normal/Riil per blok (lihat `attendance-multi-block-schedule.md`). |
| Toleransi dan jendela scan **per Jam Kerja** | Vendor mengizinkan tiap blok punya toleransi sendiri. Draf SK tidak membedakannya. | ATT-013 tetap toleransi per shift (D-13-4); jendela scan eksplisit tidak diadopsi sekarang, aturan titik tengah tetap dipakai. |
| HCIS "Shift" ≈ "Jam Kerja" vendor; HCIS "Pola jadwal" ≈ "Shift + Jadwal Karyawan" vendor | Istilah yang sama berarti hal berbeda. Operator yang terbiasa dengan aplikasi ini mungkin mencari "Jam Kerja". | Dicatat untuk kamus istilah dan UAT ATT-013-2. |
| **Grid laporan bulanan dengan simbol** | Laporan andalan HC di aplikasi lama belum ada di HCIS. | Kandidat paket laporan berikutnya, setelah jadwal terisi (tanpa jadwal grid itu berisi "Libur" semua). |
| Pemisahan menu Operasi Umum / Pengaturan Mesin | Sesuai permintaan owner. | Paket navigasi terpisah (§5). |
| Konversi scan hilang dan edit scan langsung | Bertentangan dengan I-2 dan I-3. | Tidak diadopsi. |
