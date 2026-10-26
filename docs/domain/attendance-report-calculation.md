# ATT-014 — Laporan & Kalkulasi Kehadiran

**Status:** DRAFT — D-14-1 … D-14-4 diterima owner 2026-10-24; D-14-5 … D-14-7 menunggu. ATT-014-1 diimplementasikan 2026-10-24 (§17), ATT-014-2 diimplementasikan 2026-10-24 (§18). **Revisi R1 diusulkan 2026-10-26 (§19): Kalkulasi menjadi langkah di dalam Laporan, cetak memakai dokumen tersendiri, perbaikan tanggal Koreksi HC, tab Perbaikan Absen, sumber absen di Data Transaksi; menunggu D-14-8 … D-14-16.** **Revisi R2 diusulkan 2026-10-26 (§20): halaman Laporan satu jendela, tab Tanpa Jadwal, pemetaan PIN berlaku mundur; menunggu persetujuan D-14-17 … D-14-21; jam shift D-14-22 sudah ditetapkan owner.**
**Specification:** ATT-014
**Drafted:** 2026-10-24
**Keputusan owner pemicu (2026-10-24):** kehadiran **tidak dihitung dan ditampilkan otomatis**.
HCIS mengikuti model kerja Solution Attendance Management: operator memilih unit dan rentang
tanggal, menekan **Kalkulasi**, meninjau tabel data setengah mentah, lalu membuat laporan format
bawaan, mengekspor, atau menyusun tampilan sendiri. Nasib layar Kehadiran harian ditetapkan di spesifikasi ini.
**Referensi:** `attendance-solution-am-491-reference.md` §4.4–4.6 (layar kalkulasi dan format laporan vendor)
**Terkait:** ATT-007 (engine), ATT-009 (laporan), ATT-011 (penyederhanaan operasional),
ATT-011-2 (digantikan sebagian, §12), ATT-011-3 (digabung, §12), ATT-013 (Blok Kerja ganda), PAY-003 (di luar scope)

## 1. Masalah

1. Hasil kehadiran hanya ditulis bila ada yang menekan **Finalisasi** per tanggal, sehingga layar
   Kehadiran harian menilai pegawai yang sudah scan sebagai **Tidak hadir** (K-1). Sejak jadwal
   gelombang 1 aktif (2026-10-24, 32 pegawai), masalah ini akan terlihat setiap hari kerja.
2. Laporan ATT-009 menghitung status langsung saat dibuka dari read model live, sehingga laporan
   yang sama dapat berbeda hasilnya di jam yang berbeda, dan tidak jelas kapan data "dianggap selesai".
3. HC terbiasa dengan alur aplikasi lama — pilih, kalkulasi, tinjau, cetak — dan laporan andalannya
   (grid bulanan bersimbol) belum ada di HCIS.

## 2. Tujuan, batas, invariant

Tujuan:

- **Satu tempat** untuk menghitung, meninjau, melaporkan, dan mengekspor kehadiran:
  menu **Laporan & Kalkulasi**.
- Perhitungan terjadi **ketika operator menekan Kalkulasi**, untuk lingkup dan rentang yang ia pilih.
- Layar harian menjadi **Pantauan Hari Ini** yang hanya menampilkan **fakta** (siapa sudah scan dan
  jam berapa), tanpa vonis "Tidak hadir".
- Laporan bawaan setara dengan aplikasi lama, dengan keluaran cetak/PDF, Excel, dan CSV.

Invariant ATT-011 §1 tetap berlaku tanpa perubahan:

| Invariant | Konsekuensi di ATT-014 |
|---|---|
| I-2 bukti mentah immutable | Tidak ada aksi tambah/ubah/hapus scan di tabel kalkulasi (berbeda dari aplikasi lama). Koreksi tetap lewat Koreksi HC. |
| I-3 missing punch tetap `incomplete` | Lupa scan tampil **Tidak lengkap**, tidak pernah diubah menjadi "terlambat 60 menit" atau "pulang cepat 60 menit" seperti di aplikasi lama. |
| I-4 jadwal bukan bukti | Tidak ada isi otomatis dari jadwal. |
| I-5 cuti hanya setelah keputusan final | Pantauan dan Kalkulasi memakai disposisi cuti final saja. |
| I-7 lembur hanya dari keputusan eksplisit | Waktu di luar jadwal tampil sebagai fakta, **tidak** otomatis menjadi lembur (berbeda dari aplikasi lama). |
| I-8 tidak ada kalkulasi payroll | Laporan adalah input PAY-003, bukan perhitungan gaji. |

Engine ATT-007 (`materializeAttendanceResult`) **tidak berubah aturannya**. ATT-014 mengubah **kapan**
ia dijalankan dan **bagaimana** hasilnya dibaca.

**Non-goal:** perancang templat seret-lepas seperti FastReport (§8.3); perhitungan otomatis di latar
belakang; edit scan langsung; konversi scan hilang menjadi menit terlambat/pulang cepat; lembur
otomatis dari scan; payroll.

## 3. Actor dan permission

| Actor | Permission | Boleh |
|---|---|---|
| HC Admin | `attendance.reports.read`, `attendance.calculation.run` (baru), `attendance.policy.manage` | Semua, termasuk membagikan tampilan tersimpan ke semua HC. |
| HC Operator | `attendance.reports.read`, `attendance.calculation.run` (baru) | Pantauan, Kalkulasi, laporan, ekspor, tampilan pribadi. |
| Pegawai | data sendiri | Tidak berubah (riwayat kehadiran sendiri). |

`attendance.calculation.run` dipisahkan dari `attendance.reports.read` karena Kalkulasi **menulis**
versi hasil dan memakai sumber daya server. Saat ini `attendance.reports.read` hanya dimiliki
`human_capital_admin` dan `human_capital`, jadi permission baru diberikan ke keduanya (D-14-1).
Backend tetap authoritative; menu hanya menyembunyikan.

## 4. Navigasi

Menu depan "Waktu & Kehadiran" setelah ATT-014 (selaras dengan permintaan owner agar menu depan
berisi pekerjaan harian dan operasi mesin pindah ke belakang):

```text
Waktu & Kehadiran
  Ringkasan
  Pantauan Hari Ini      (pengganti "Kehadiran → Harian")
  Laporan & Kalkulasi    (baru; menggantikan "Kehadiran → Laporan")
  Shift
  Jadwal
  Lembur
  Pengaturan             (Lokasi kerja, Mesin fingerprint lanjutan, …)
```

Klarifikasi, Bukti HP, dan Koreksi HC tetap ada sebagai tab di bawah Pantauan Hari Ini sampai
antrean "Perlu tindakan" ATT-011-3 menggantikannya. Route lama `/admin/attendance/daily` dan
`/admin/attendance/reports` dialihkan minimal satu rilis. Pemindahan menu mesin adalah paket
navigasi tersendiri, bukan bagian ATT-014.

## 5. Pantauan Hari Ini (nasib layar Kehadiran harian)

### 5.1 Perilaku

Layar ini **hanya untuk hari ini** dan **tidak pernah menulis** hasil kehadiran. Untuk tanggal lain
operator diarahkan ke Laporan & Kalkulasi.

Satu baris per pegawai aktif:

| Kolom | Isi |
|---|---|
| Pegawai, Unit | |
| Jadwal hari ini | Nama shift + jam, atau **Libur**, **Libur nasional**, **Cuti/Izin** (disposisi final), **Tanpa jadwal**, **Jadwal bermasalah**. |
| Scan pertama · Scan terakhir · Jumlah scan | Dari bukti mentah hari itu, termasuk scan mesin yang belum pernah dihitung engine. |
| Selisih dari jadwal | Netral, misalnya `+6 mnt` untuk scan masuk 07.06 pada jadwal 07.00. Bukan label "Terlambat". |
| Sumber | Mesin / HP / Koreksi HC. |
| Keterangan | Fakta: "Belum ada scan", "Baru scan masuk", "Scan di luar jadwal". |

Kartu ringkasan: **Sudah scan**, **Belum ada scan** (terjadwal), **Libur**, **Cuti/Izin**,
**Tanpa jadwal**, **Scan tanpa jadwal**. Klik kartu = filter. Muat ulang tiap 30 detik (ATT-009 dipertahankan).

**Tidak ada status Tidak hadir, Terlambat, Pulang cepat, atau Tidak lengkap di layar ini.** Vonis
resmi hanya keluar dari Kalkulasi (D-14-7). Alasannya: Pantauan membaca bukti secara langsung dan
tidak menerapkan klarifikasi, koreksi, dan aturan lain, sehingga vonis di sini bisa berbeda dari
hasil resmi dan justru membingungkan.

### 5.2 Sumber data

- Bukti: `attendance_adms_events` yang ter-mapping ke pegawai pada saat scan (join yang sama dengan
  engine) ditambah `attendance_events` sumber HP dan koreksi, pada jendela hari kerja ini.
  Untuk shift lintas tengah malam jendelanya mengikuti tanggal kerja (jadwal mulai −6 jam s/d sekarang).
- Jadwal: `resolveSchedule` (tidak berubah).
- Cuti/izin: disposisi final yang sama dengan engine.

### 5.3 Kegagalan dan state

| Kondisi | Perilaku |
|---|---|
| Pegawai tanpa mapping PIN | Kolom scan menulis "Belum terhubung mesin" (bukan "Belum ada scan"). |
| Tanpa permission `attendance.reports.read` | 403; menu tidak tampil. |
| Mobile < 768px | Kartu per pegawai; filter kartu tetap. |
| Tidak ada pegawai di filter | "Tidak ada pegawai aktif pada filter ini." |

## 6. Laporan & Kalkulasi

### 6.1 Layar

```text
Unit [SDIT Tahfizh ▾]   Pegawai [Semua ▾]   Rentang [01-10-2026] s/d [31-10-2026]  [Bulan ini ▾]
[Kalkulasi]   [Laporan ▾]   [Ekspor ▾]   Tampilan [Bawaan ▾]
Dihitung terakhir 24-10-2026 16:05 oleh <akun> · 3 baris berubah sejak dikalkulasi  [Kalkulasi ulang]

[ Detail Harian | Data Transaksi | Pengecualian | Rekapitulasi | Lembur | Tanpa Jadwal ]
```

Pintasan rentang: Kemarin, Hari ini, Minggu ini, Minggu lalu, Bulan ini, Bulan lalu.

Filter unit memakai `organizational_units` (saat ini datar). Opsi "termasuk sub-unit" bergantung
pada pemetaan unit ke struktur ORG-004 dan tetap **DRAFT** sampai data itu tersedia (sejalan dengan
asumsi ATT-011 §11).

### 6.2 Menjalankan Kalkulasi

**Actor:** pemegang `attendance.calculation.run`.
**Input:** unit (opsional), pegawai (opsional), `from`, `to`.
**Precondition:** `from ≤ to`; rentang ≤ **93 hari per kalkulasi** (D-14-2); `to` boleh hari ini
tetapi tidak boleh di masa depan.

Rentang 93 hari adalah **batas satu kali tekan**, bukan batas data. Untuk setahun, operator
menjalankan empat kalkulasi. Batas ini sama dengan batas laporan ATT-009 yang sudah ada.

**State machine** (`attendance_calculation_runs.status`):

```text
queued --mulai--> running --selesai--> completed
                          --gagal----> failed
                          --dibatalkan pemohon--> cancelled
running --proses API restart--> failed (error_code INTERRUPTED)
```

Aturan:

1. **Pasangan yang dihitung** = setiap (pegawai dalam lingkup × tanggal dalam rentang) di mana
   pegawai itu berstatus kerja pada tanggal tersebut (`started_on ≤ tanggal ≤ ended_on`).
2. **Aturan cakupan (D-14-3).** Pasangan dihitung hanya bila tanggal itu **tercakup** pencatatan:
   pegawai punya mapping PIN mesin yang berlaku pada tanggal itu, atau punya bukti HP/koreksi pada
   tanggal itu. Pasangan di luar cakupan **tidak dihitung dan tidak ditulis**; di tabel tampil
   **"Tidak tercatat (belum terhubung mesin)"**, bukan Tidak hadir. Alasannya: sebelum PIN
   terhubung, tidak ada scan bukan berarti pegawai tidak masuk. Data production 2026-10-23: 75%
   scan mentah terjadi sebelum mapping PIN-nya berlaku.
3. Pasangan yang tercakup dihitung dengan `materializeAttendanceResult` **tanpa perubahan**.
   Engine sudah idempotent (`input_hash`): menghitung ulang data yang sama tidak membuat versi baru.
4. **Satu kalkulasi berjalan pada satu waktu** di seluruh server. Permintaan lain menunggu dalam
   status `queued` dan tampil "Menunggu giliran (urutan ke-N)". Ini melindungi Mi8VPS.
5. Proses berjalan **di dalam proses API**, dimulai segera setelah permintaan tercatat, pasangan demi
   pasangan, dengan jeda kecil antarpasangan agar layar lain tetap responsif. Tidak ada proses
   interval di latar belakang dan tidak ada perubahan launcher Mi8VPS.
6. Progres (`processed_pairs / total_pairs`) diperbarui tiap 25 pasangan dan ditampilkan sebagai
   bilah proses. Pemohon boleh membatalkan; pasangan yang sudah dihitung tetap valid.
7. Saat proses API mulai, kalkulasi yang masih `running` ditandai `failed` dengan
   `INTERRUPTED`. Menjalankan ulang aman karena engine idempotent.
8. **Hari ini dihitung sebagai hasil sementara.** Baris hari ini diberi tanda "Hari berjalan".
   Status yang bergantung jam (`scheduled`/`pending`) dievaluasi ulang saat dibaca, agar hasil yang
   dihitung pagi tidak membeku sebagai "Belum absen" setelah jam pulang.
9. Satu pasangan gagal tidak menghentikan kalkulasi: dicatat di `failed_pairs`, dan baris itu tampil
   "Gagal dihitung — coba kalkulasi ulang".

### 6.3 Tab dan kolom

Semua tab membaca **hasil tersimpan** dan **bukti mentah**. Tidak ada tab yang menghitung status
sendiri saat dibuka.

| Tab | Satu baris = | Kolom |
|---|---|---|
| **Detail Harian** (padanan tab "Shift") | pegawai × tanggal (× blok, setelah ATT-013) | Pegawai, NIP, Unit, Tanggal, Hari, Shift, Jam masuk/pulang jadwal, Scan masuk/pulang, **Normal/Riil** (hari kerja), Status, Terlambat (mnt), Pulang cepat (mnt), Jam kerja, Lembur disetujui, Pengecualian (cuti/klarifikasi/koreksi), Sumber, **Simbol**, Jenis hari (kerja/akhir pekan/libur). |
| **Data Transaksi** | satu scan | Waktu, Pegawai, Sumber (Mesin/HP/Koreksi), Mesin, Tanggal kerja, Dipakai pada hasil (ya/tidak). **Tanpa aksi edit.** |
| **Pengecualian** | satu kejadian | Cuti/izin final, penyelesaian cuti, klarifikasi (diajukan/diputuskan), koreksi HC, beserta tanggal, keputusan, dan pemutus. |
| **Rekapitulasi** | pegawai | Kolom item yang dapat dipilih: Hari terjadwal (Normal), Hari hadir (Riil), **Presensi %** (Riil ÷ Normal), Tidak hadir, Terlambat (kali & menit), Pulang cepat (kali & menit), Tidak lengkap, Cuti/Izin per jenis, Lembur disetujui, Jam kerja, Tidak tercatat. |
| **Lembur** | pegawai × tanggal | Jadwal, scan, lembur disetujui, sumber pengajuan, dan fakta scan di luar jadwal (ATT-011-6a). Menit lembur hanya dari pengajuan disetujui. |
| **Tanpa Jadwal** | pegawai × tanggal tanpa jadwal yang punya scan | Scan masuk/pulang 1–5, total rentang scan. Membantu HC menemukan pegawai yang bekerja tetapi belum diberi jadwal. |

**Normal/Riil sebelum ATT-013:** hari terjadwal = Normal 1; Riil 1 untuk `present`/`late`, 0 untuk
`absent`, kosong untuk `incomplete` sampai dikoreksi (sama dengan D-13-7). Setelah ATT-013 nilai ini
diambil dari bobot hari per blok.

### 6.4 Alat pada tabel

Filter status (Hadir, Terlambat, Pulang cepat, Tidak lengkap, Tidak hadir, Cuti/Izin, Libur,
Tidak tercatat, Berubah sejak dikalkulasi), filter shift, cari, urutkan (unit, NIP, nama, tanggal,
A→Z/Z→A), **pilih kolom**, **bekukan kolom kiri** (0–3), dan **simpan tampilan** (§8). Di layar
< 768px tabel menjadi kartu per pegawai per hari; pilih kolom dan simpan tampilan hanya di layar lebar.

### 6.5 Kesegaran hasil

Karena tidak ada perhitungan otomatis, layar harus jujur bila data berubah setelah dikalkulasi.
Sebuah baris ditandai **"Berubah sejak dikalkulasi"** bila salah satu masuk setelah `created_at`
versi hasilnya: bukti scan baru untuk tanggal itu, perubahan pola jadwal/roster yang mencakup tanggal
itu, keputusan cuti/penyelesaian, keputusan klarifikasi, koreksi HC, atau keputusan lembur.
Banner menyebut jumlahnya dan tombol **Kalkulasi ulang** menjalankan kalkulasi untuk lingkup yang sama.

Pemeriksaan ini dihitung set-based per permintaan baca (bukan per baris) untuk menjaga beban Mi8VPS.
Daftar sumber perubahan di atas **DRAFT**; yang wajib di paket pertama adalah bukti scan baru dan
perubahan jadwal.

### 6.6 Simbol

Simbol dipakai di tab Detail Harian dan di Laporan Harian (grid bulanan). Usulan bawaan (D-14-5),
huruf biasa agar tetap terbaca saat dicetak hitam-putih:

| Simbol | Arti | Simbol | Arti |
|---|---|---|---|
| `H` | Hadir | `C` | Cuti/Izin |
| `T` | Terlambat | `L` | Libur / akhir pekan |
| `P` | Pulang cepat (label, D-6) | `N` | Libur nasional |
| `TL` | Tidak lengkap | `!` | Jadwal bermasalah |
| `A` | Tidak hadir | `·` | Tidak tercatat / tanpa jadwal |

Hari yang terlambat sekaligus pulang cepat memakai `T` dengan keterangan; status tetap mengikuti
ATT-007 (pulang cepat hanya label, D-6).

## 7. Laporan bawaan

Semua laporan membaca hasil tersimpan untuk lingkup dan rentang yang sedang dipilih. Bila ada
pasangan yang belum dikalkulasi atau berubah sejak dikalkulasi, laporan menampilkan peringatan di
kepala halaman, bukan menghitung sendiri.

Kepala laporan seragam: judul, unit, rentang tanggal, "dicetak oleh <akun>", tanggal cetak, nomor halaman.

| # | Laporan | Bentuk | Padanan |
|---|---|---|---|
| 1 | **Laporan Harian (Grid Bulanan)** | Baris = pegawai, dikelompokkan per unit; kolom = tanggal 1–31 berjudul tanggal + hari; isi = simbol §6.6; akhir pekan dan libur diberi latar; total Normal, Riil, Presensi %, Tidak hadir, Terlambat, Tidak lengkap, Cuti/Izin, Lembur. Legenda simbol di kepala. **Lanskap.** | Aplikasi lama "Laporan Harian". **Belum ada di HCIS.** |
| 2 | **Rekapitulasi Pegawai** | Satu baris per pegawai, subtotal per unit dan total; item = tab Rekapitulasi. | ATT-009 "Periode" diperluas dengan Normal/Riil/Presensi %. |
| 3 | **Rekapitulasi Unit** | Satu baris per unit, item sama. | ATT-009 "Unit". |
| 4 | **Detail Harian** | Per pegawai, satu baris per tanggal: jadwal, scan, terlambat, pulang cepat, lembur, pengecualian, jam kerja; jumlah per pegawai. | ATT-009 "Detail". |
| 5 | **Data Scan** | Per pegawai, blok mingguan; tiap tanggal berisi semua jam scan. Juga tersedia versi daftar. | ATT-009 "Data Scan" + grid aplikasi lama. |
| 6 | **Jadwal Bulanan** | Grid pegawai × tanggal berisi nama shift / Libur, dengan legenda. | ATT-009 "Jadwal" (daftar) → grid. |
| 7 | **Lembur Harian** | Grid pegawai × tanggal berisi menit lembur disetujui; total per jenis hari. | ATT-009 "Lembur". |
| 8 | **Pengecualian & Izin** | Daftar cuti/izin, penyelesaian, klarifikasi, koreksi dalam rentang, dengan ringkasan per jenis. | Baru. |
| 9 | **Log Perubahan Data Kehadiran** | Siapa mengoreksi atau memutuskan apa, kapan, dan alasannya. | Baru; dari audit dan tabel klarifikasi/koreksi. |

**Keluaran:** setiap laporan dapat **Cetak / PDF** (cetak peramban, ukuran A4, orientasi sesuai
laporan), **Excel (.xlsx)** dibuat di server dengan pustaka `exceljs` yang sudah dipakai modul pegawai,
dan **CSV** (UTF-8 dengan BOM, seperti ATT-009). Setiap ekspor diaudit (§11).

Laporan ATT-009 yang lama tetap tersedia sampai laporan 2–7 setara, lalu dipensiunkan dari menu.

## 8. Laporan dari tampilan aktif dan desain sendiri

### 8.1 Laporan dari tampilan aktif

Tombol **Laporan → Dari tampilan aktif** mencetak atau mengekspor **persis kolom, filter, dan urutan
yang sedang tampil** di tab yang aktif, dengan kepala laporan seragam dan pengelompokan per unit.
Ini menjawab sebagian besar kebutuhan "laporan sesuai kebutuhan" tanpa perancang.

### 8.2 Tampilan tersimpan

Kombinasi tab + kolom + filter + urutan + pengelompokan + item total + judul + orientasi dapat
disimpan dengan nama, misalnya "Rekap bulanan untuk Kepala SDIT". Tampilan tersimpan muncul di
pilihan **Tampilan** dan di menu **Laporan** sebagai "Laporan saya".

- Bawaan: **pribadi**. HC Admin (`attendance.policy.manage`) dapat menandainya **dibagikan** ke
  semua pemegang `attendance.reports.read` (D-14-6).
- Tampilan tersimpan hanya menyimpan definisi, **bukan data**.

### 8.3 Perancang templat penuh

Perancang seret-lepas seperti FastReport **tidak dibuat** di ATT-014. Bila setelah UAT ada kebutuhan
tata letak cetak yang tidak terpenuhi oleh §8.1–8.2, kebutuhan itu dibawa sebagai spesifikasi
tersendiri dengan contoh nyata.

## 9. Model data

Migration aditif.

```sql
INSERT INTO permissions (permission_key, description) VALUES
  ('attendance.calculation.run', 'ATT-014: run attendance calculation for a scope and date range')
ON CONFLICT (permission_key) DO NOTHING;
-- diberikan ke role human_capital_admin dan human_capital

CREATE TABLE attendance_calculation_runs (
  id uuid PRIMARY KEY,
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  unit_id uuid NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
  employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_pairs integer NOT NULL DEFAULT 0 CHECK (total_pairs >= 0),
  processed_pairs integer NOT NULL DEFAULT 0 CHECK (processed_pairs >= 0),
  failed_pairs integer NOT NULL DEFAULT 0 CHECK (failed_pairs >= 0),
  uncovered_pairs integer NOT NULL DEFAULT 0 CHECK (uncovered_pairs >= 0),
  cancel_requested_at timestamptz NULL,   -- pembatalan saat running, dibaca di titik progres
  error_code text NULL CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  CHECK (date_to >= date_from AND date_to - date_from <= 92)
);
-- Satu kalkulasi berjalan di seluruh server.
CREATE UNIQUE INDEX attendance_calculation_runs_one_running
  ON attendance_calculation_runs ((true)) WHERE status = 'running';
CREATE INDEX attendance_calculation_runs_queue_idx
  ON attendance_calculation_runs (created_at) WHERE status = 'queued';
CREATE INDEX attendance_calculation_runs_recent_idx
  ON attendance_calculation_runs (created_at DESC);

CREATE TABLE attendance_report_views (
  id uuid PRIMARY KEY,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  shared boolean NOT NULL DEFAULT false,
  base_tab text NOT NULL CHECK (base_tab IN ('detail', 'transactions', 'exceptions', 'summary', 'overtime', 'unscheduled')),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, name)
);
```

`definition` divalidasi skema di server (daftar kolom yang dikenal, filter, urutan, pengelompokan,
item total, judul ≤ 120 karakter, orientasi). Tidak ada SQL atau ekspresi bebas di dalamnya.

Tidak ada perubahan pada tabel hasil, bukti, jadwal, atau cuti.

**Rollback:** rilis lama mengabaikan dua tabel baru dan permission baru; tidak ada data yang hilang.
Menghapus tabel aman untuk `attendance_calculation_runs` (riwayat proses saja). Menghapus
`attendance_report_views` menghilangkan tampilan tersimpan pengguna — dilakukan hanya atas perintah
owner. Versi hasil yang sudah dihitung tetap valid di rilis mana pun karena diproduksi engine yang sama.

## 10. Kontrak API

Ditambahkan ke `docs/api/attendance-workforce.openapi.yaml`.

| Method & path | Permission | Isi |
|---|---|---|
| `GET /admin/attendance/today` | `attendance.reports.read` | Pantauan Hari Ini (§5). Menggantikan pemakaian `GET /admin/attendance/daily` oleh layar harian. |
| `POST /admin/attendance/calculations` | `attendance.calculation.run` | Body `{ unitId?, employeeId?, from, to }` → `202 { id, status, position }`. `400 INVALID_CALCULATION_RANGE`, `422 CALCULATION_RANGE_TOO_LARGE`, `422 CALCULATION_DATE_IN_FUTURE`. |
| `GET /admin/attendance/calculations/{id}` | `attendance.reports.read` | Status dan progres. |
| `POST /admin/attendance/calculations/{id}/cancel` | pemohon atau `attendance.policy.manage` | `409` bila sudah selesai. |
| `GET /admin/attendance/calculation-rows` | `attendance.reports.read` | Query `tab, unitId?, employeeId?, from, to, status?, scheduleId?` → baris tab §6.3 + ringkasan kesegaran §6.5. Maks 93 hari. |
| `GET /admin/attendance/reports/{type}` | `attendance.reports.read` | Laporan bawaan §7. `format=json|xlsx|csv`. |
| `POST /admin/attendance/reports/active-view` | `attendance.reports.read` | Body definisi tampilan + lingkup → `xlsx`/`csv`. |
| `GET/POST/PATCH/DELETE /admin/attendance/report-views[/{id}]` | `attendance.reports.read`; `shared=true` butuh `attendance.policy.manage` | Tampilan tersimpan. Pemilik saja yang boleh mengubah/menghapus tampilan pribadinya. |

`POST /admin/attendance/finalize/{date}` dipertahankan satu rilis sebagai alias kalkulasi seluruh
pegawai untuk satu tanggal, lalu dihapus. `GET /admin/attendance/report` (ATT-009) tetap sampai
laporan baru setara.

## 11. Audit dan log

| Event | Metadata (tanpa data pribadi) |
|---|---|
| `attendance.calculation.requested` | lingkup (unit/pegawai id), rentang, jumlah pasangan |
| `attendance.calculation.completed` / `.failed` / `.cancelled` | id kalkulasi, processed/failed/uncovered, durasi, `error_code` |
| `attendance.report.exported` | jenis laporan atau "tampilan aktif", format, lingkup, rentang, jumlah baris |
| `attendance.report_view.saved` / `.shared` / `.deleted` | id tampilan, nama, base tab |

Ekspor berisi data pribadi (nama, NIP, jam scan) dan karena itu **selalu** diaudit. Log aplikasi
tidak memuat nama atau NIP; hanya id dan hitungan.

## 12. Hubungan dengan rencana lain

| Rencana | Dampak |
|---|---|
| **ATT-011-2** hitung ulang otomatis | **Bagian antrean, worker interval, dan pemicu otomatis digantikan** oleh Kalkulasi sesuai keputusan owner. Yang dipertahankan: endpoint hitung ulang rentang (menjadi `POST /calculations`), alias `finalize/{date}`, idempotensi engine, dan kejujuran tampilan (sekarang lewat "Berubah sejak dikalkulasi", bukan "Sedang diperbarui"). Pemicu "PIN dihubungkan" yang dibahas owner menjadi bagian aturan cakupan §6.2 butir 2. |
| **ATT-011-3** workspace Kehadiran | Tab Hari ini → **Pantauan Hari Ini**; tab Laporan → **Laporan & Kalkulasi**; antrean "Perlu tindakan" tetap di ATT-011-3. Panel detail satu hari dibuka dari baris tab Detail Harian. |
| **ATT-009** laporan | Laporan berhenti menghitung status secara live; membaca hasil Kalkulasi. Format diperluas dan digantikan bertahap (§7). |
| **ATT-013** Blok Kerja ganda | Tab Detail Harian menampilkan satu baris per blok dan kolom Normal/Riil memakai bobot hari per blok. Tidak saling memblokir: ATT-014 berjalan dengan satu blok per hari sampai ATT-013 dirilis. |
| **ATT-011-6a** lembur | Fakta scan di luar jadwal di tab Lembur memakai field yang dirancang di 6a. |
| **PAY-003** | Kelak, periode yang gajinya sudah diproses perlu dikunci agar Kalkulasi ulang tidak mengubahnya diam-diam. Belum ada di ATT-014 karena payroll belum memakai data kehadiran; dicatat sebagai prasyarat PAY-003. |

## 13. Kegagalan, empty, forbidden, mobile

| Kondisi | Perilaku |
|---|---|
| Rentang belum pernah dikalkulasi | Tab kosong dengan pesan "Belum dikalkulasi untuk rentang ini" dan tombol Kalkulasi (bila punya permission). |
| Kalkulasi lain sedang berjalan | Permintaan `queued`; layar menampilkan "Menunggu giliran". |
| Proses terputus | Status `failed` + `INTERRUPTED`; pesan "Kalkulasi terhenti. Jalankan ulang — hasil yang sudah dihitung tetap aman." |
| Sebagian pasangan gagal | Selesai dengan `failed_pairs > 0`; baris terkait ditandai dan dapat dikalkulasi ulang. |
| Tanpa `attendance.calculation.run` | Tombol Kalkulasi tidak tampil; API 403. Laporan tetap bisa dibaca. |
| Tanpa `attendance.reports.read` | 403; menu tidak tampil. |
| Pegawai tanpa jadwal | Muncul di tab Tanpa Jadwal bila ada scan; tidak dihitung Tidak hadir. |
| Ekspor > 50.000 baris | `422 EXPORT_TOO_LARGE` dengan saran mempersempit lingkup (DRAFT, disesuaikan setelah uji beban Mi8VPS). |
| Mobile < 768px | Kartu; Kalkulasi, laporan bawaan, dan ekspor tetap tersedia; pilih kolom dan simpan tampilan hanya layar lebar. |

## 14. Paket implementasi

Setiap paket satu PR, dirilis lewat OPS-MI8-REL-001 dengan persetujuan owner.

| Paket | Isi | Migration | Test minimum |
|---|---|---|---|
| **ATT-014-1** Pantauan Hari Ini | §5: endpoint `today`, layar fakta, kartu, redirect route lama. Tidak menulis hasil. | Tidak ada. | Pegawai yang sudah scan tidak pernah tampil "Tidak hadir"; scan mesin yang belum dihitung engine tetap tampil; tanpa mapping → "Belum terhubung mesin"; cuti final tampil Cuti/Izin, cuti belum final tidak; shift malam memakai tanggal kerja; 403; mobile. |
| **ATT-014-2** Kalkulasi | §6.2, §6.5, §9 (runs), permission baru, `POST/GET/cancel calculations`, `calculation-rows`, alias `finalize`. | Tabel runs + permission. | Lingkup dan rentang benar; > 93 hari → 422; tanggal depan → 422; satu berjalan, lainnya antre; restart → INTERRUPTED; batal; idempotent (kalkulasi dua kali tanpa perubahan → nol versi baru); di luar cakupan tidak ditulis dan tampil "Tidak tercatat"; missing punch tetap Tidak lengkap (I-3); jam jadwal tidak pernah jadi jam scan (I-4); cuti belum final tidak berubah (I-5); bukti tidak berubah (I-2); "Berubah sejak dikalkulasi" muncul setelah scan baru dan perubahan jadwal; 403 tanpa permission baru; audit tercatat. Review tambahan: permission + penulisan hasil. |
| **ATT-014-3** Layar & tabel | §6.1, §6.3, §6.4: enam tab, alat tabel, simbol. | Tidak ada. | Tiap tab memuat kolom yang benar; filter status; urut; bekukan kolom; simbol sesuai legenda; empty/forbidden/mobile. |
| **ATT-014-4** Laporan bawaan & ekspor | §7: sembilan laporan, cetak/PDF, XLSX, CSV, audit ekspor. | Tidak ada. | Grid bulanan menampilkan 28–31 kolom sesuai bulan dan latar akhir pekan/libur; Presensi % = Riil ÷ Normal; subtotal per unit; peringatan bila ada pasangan belum dikalkulasi; XLSX dapat dibuka dan berisi kolom yang sama dengan layar; setiap ekspor teraudit; tidak ada data di luar lingkup permission. |
| **ATT-014-5** Tampilan tersimpan | §8: dari tampilan aktif, simpan/buka/bagikan tampilan, "Laporan saya". | Tabel report views. | Definisi divalidasi (kolom tak dikenal → 400); tampilan pribadi tidak terlihat akun lain; berbagi hanya dengan `attendance.policy.manage`; pemilik saja yang mengubah; ekspor dari tampilan aktif sama dengan layar. |

Urutan yang disarankan: **ATT-014-1 lebih dulu** karena langsung menghentikan vonis "Tidak hadir"
yang keliru mulai Senin 2026-10-26, lalu 014-2 → 014-3 → 014-4 → 014-5. Sampai 014-2 dirilis,
HC menekan **Finalisasi ulang** per tanggal untuk menghasilkan laporan resmi.

## 15. Yang perlu keputusan owner

| # | Pertanyaan | Usulan |
|---|---|---|
| D-14-1 | Kalkulasi memakai permission baru `attendance.calculation.run` untuk HC Admin dan HC Operator, terpisah dari izin membaca laporan? | **Diterima 2026-10-24.** Kalkulasi menulis data dan memakai sumber daya server. |
| D-14-2 | Satu kali Kalkulasi maksimal 93 hari (batas sekali tekan, bukan batas data)? | **Diterima 2026-10-24.** Sama dengan batas laporan sekarang. Setahun = empat kali Kalkulasi. |
| D-14-3 | Tanggal sebelum pegawai terhubung ke mesin (dan tanpa absen HP) tidak dihitung dan tampil "Tidak tercatat", bukan "Tidak hadir"? | **Diterima 2026-10-24.** |
| D-14-4 | Hari ini boleh dikalkulasi sebagai hasil sementara? | **Diterima 2026-10-24**, dengan tanda "Hari berjalan". |
| D-14-5 | Legenda simbol §6.6. | Terima; dapat diubah sebelum ATT-014-4. |
| D-14-6 | Tampilan tersimpan pribadi secara bawaan; hanya HC Admin yang boleh membagikan. | Terima. |
| D-14-7 | Pantauan Hari Ini hanya menampilkan fakta (jam scan dan selisih dari jadwal) tanpa label Terlambat/Tidak hadir. | Terima; vonis resmi hanya dari Kalkulasi. |

## 16. Acceptance

- ATT-014-A: Pegawai yang sudah scan tidak pernah tampil "Tidak hadir" di Pantauan Hari Ini.
- ATT-014-B: HC memilih unit dan rentang, menekan Kalkulasi, melihat progres, lalu melihat tabel
  setengah mentah enam tab.
- ATT-014-C: Kalkulasi dua kali tanpa perubahan data tidak menghasilkan versi hasil baru.
- ATT-014-D: Lupa scan pulang tampil Tidak lengkap, bukan "pulang cepat 60 menit"; waktu di luar
  jadwal tidak menjadi lembur tanpa pengajuan disetujui.
- ATT-014-E: Tanggal sebelum PIN terhubung tampil "Tidak tercatat", bukan Tidak hadir.
- ATT-014-F: HC mencetak Laporan Harian grid bulanan bersimbol dan mengekspornya ke Excel.
- ATT-014-G: HC menyimpan tampilan Rekapitulasi dengan kolom pilihannya dan mencetaknya dari
  tampilan aktif.
- ATT-014-H: Setelah ada scan baru, baris terkait ditandai "Berubah sejak dikalkulasi" sampai
  dikalkulasi ulang.
- ATT-014-I: Setiap ekspor tercatat di audit tanpa data pribadi di metadata.
- ATT-014-J: Typecheck, lint, test, build, dan clean migration lulus; data sintetis saja.

## 17. Catatan implementasi ATT-014-1 (2026-10-24)

- Endpoint `GET /admin/attendance/today` (`attendance.reports.read`) di
  `apps/api/src/modules/attendance/today.ts`. Inti klasifikasinya fungsi murni `classifyToday`
  agar setiap aturan §5 teruji tanpa database. Endpoint ini hanya membaca; test memastikan tidak ada
  pernyataan `INSERT/UPDATE/DELETE` dan respons tidak pernah memuat `absent`, `late`, atau `incomplete`.
- Bukti dibaca langsung dari `attendance_adms_events` lewat mapping PIN yang berlaku pada saat scan,
  ditambah `attendance_events` sumber HP dan koreksi. Event ADMS yang sudah dinormalisasi tidak dihitung
  dua kali.
- "Libur" dibedakan dari "Tanpa jadwal" dengan memeriksa apakah ada pola jadwal yang mencakup hari ini;
  resolver ATT-007 sendiri tidak membedakan keduanya.
- **Penyimpangan disengaja dari §4:** alamat halaman tetap `/admin/attendance/daily` dan isinya diganti
  menjadi Pantauan Hari Ini, bukan dialihkan ke alamat baru. Alamat itu sudah dirujuk menu admin,
  katalog layanan, dan pemetaan izin, sehingga mempertahankannya menghindari pengalihan dan tautan mati.
  Label tab menjadi "Pantauan Hari Ini".
- Kartu "Hari ini" di halaman Ringkasan memakai ringkasan Pantauan yang sama, sehingga tidak lagi
  menampilkan angka "Tidak hadir" dari read model lama.
- Endpoint `GET /admin/attendance/daily` lama **tidak dihapus**: laporan ATT-009 masih memakai read
  model-nya sampai ATT-014-2/4 menggantikannya.
- Manifest AUTH-011 dan `attendance-workforce.openapi.yaml` diperbarui.

## 18. Catatan implementasi ATT-014-2 (2026-10-24)

Keputusan owner 2026-10-24: "Ya, kerjakan ATT-014-2 dengan usulanmu untuk D-14-1 sampai D-14-4".

- **Migration `0061_attendance_calculation_runs.sql`** menambah permission `attendance.calculation.run`
  (role `human_capital_admin` dan `human_capital`) dan tabel `attendance_calculation_runs` sesuai §9,
  ditambah kolom `cancel_requested_at` agar pembatalan saat `running` tidak perlu status baru. Aditif;
  rollback di header migration.
- **Runner** `apps/api/src/modules/attendance/calculation-runner.ts`, di dalam proses API, tanpa
  interval: permintaan baru memulai antrean; saat API siap, run `running` sisa proses lama ditandai
  `failed`/`INTERRUPTED` lalu antrean `queued` dilanjutkan. Slot tunggal dijaga indeks unik
  `status = 'running'` dan `FOR UPDATE SKIP LOCKED`. Setiap pasangan memanggil
  `materializeAttendanceResult` tanpa perubahan, dengan jeda `setImmediate` antarpasangan. Progres dan
  pemeriksaan pembatalan tiap 25 pasangan.
- **Aturan cakupan (D-14-3)** dihitung set-based dalam satu query: pasangan tercakup bila ada mapping PIN
  yang berlaku pada hari itu (WIB), event HP/koreksi pada hari itu, atau klarifikasi disetujui untuk
  tanggal itu. Pasangan "berstatus kerja" memakai `started_on`/`ended_on`; pegawai nonaktif hanya
  sampai `ended_on`.
- **Hari ini (D-14-4)** dihitung dengan jam server saat pasangan diproses. Saat dibaca, hasil hari ini
  tanpa scan masuk dan tanpa keputusan cuti/penyelesaian dievaluasi ulang menurut jam
  (`scheduled` → `pending` → `absent`), aturan yang sama dengan engine.
- **`GET /admin/attendance/calculation-rows`** hanya membaca dan **berhalaman** (`page`, `pageSize`
  10–200, bawaan 50; `summary` dan `changedCount` mencakup semua halaman), sejalan dengan usulan aturan
  daftar panjang ENG-LIST-001. Paket ini hanya mengisi tab Detail Harian (`tab=detail`); lima tab lain
  di ATT-014-3.
- **Kesegaran (§6.5)** paket pertama: scan mesin (`attendance_adms_events.created_at`), event
  kehadiran, pola jadwal baru (`attendance_schedule_assignments.created_at`), dan roster terbit
  (`published_at`) setelah waktu kalkulasi terakhir. Waktu kalkulasi = yang terbaru dari `created_at`
  versi hasil dan `started_at` run `completed` yang mencakup pasangan itu, sehingga kalkulasi ulang yang
  memakai ulang versi lama (input sama) tetap menghapus tanda. **Belum terdeteksi (DRAFT):** pola
  jadwal yang hanya diakhiri (`effective_to` diubah tanpa baris baru), keputusan cuti/klarifikasi,
  koreksi HC, dan keputusan lembur.
- **Normal/Riil** mengikuti §6.3: Normal 1 untuk hari terjadwal; Riil 1 hadir/terlambat, 0 tidak
  hadir, kosong untuk tidak lengkap, cuti, dan hari yang belum selesai.
- **Alias `POST /admin/attendance/finalize/{date}`** sekarang membuat run untuk satu tanggal dan
  menjawab `202` seperti `POST /calculations`, dengan permission `attendance.calculation.run`
  (sebelumnya `attendance.policy.manage` dan sinkron). Dihapus setelah satu rilis.
- **Pembatalan** oleh pemohon, atau akun lain yang juga memegang `attendance.policy.manage`. Run
  `queued` langsung `cancelled`; run `running` berhenti di titik progres berikutnya.
- **Web:** tab baru **Kehadiran → Kalkulasi** (`/admin/attendance/calculation`, dibaca dengan
  `attendance.reports.read`; tombol Kalkulasi hanya untuk `attendance.calculation.run`) dengan unit,
  rentang + pintasan, bilah progres (polling 2 detik), batal, banner "Berubah sejak dikalkulasi", filter
  status, dan tabel berhalaman (kartu di layar < 768px). Tab "Pengaturan → Finalisasi ulang" dihapus;
  alamat lamanya dialihkan ke Kalkulasi. Layar penuh "Laporan & Kalkulasi" dan pemindahan menu tetap di
  ATT-014-3.
- **Audit:** `attendance.calculation.requested`, `.completed`, `.failed` (termasuk `INTERRUPTED`),
  `.cancelled` di `access_audit_events`, metadata hanya id, rentang, hitungan, durasi, dan `error_code`.
  Log aplikasi hanya id run dan hitungan.
- **Test:** `apps/api/test/attendance-calculation.test.ts` (rentang, hari ini sementara, runner: cakupan,
  gagal sebagian, batal, antrean, gagal total, INTERRUPTED; route: 202/400/422/403, alias, batal,
  409) dan `attendance-calculation.postgres.test.ts` (PostgreSQL nyata di CI: cakupan dan "Tidak
  tercatat", tanpa mapping tidak ditulis, I-2/I-3/I-4, idempoten, kesegaran setelah scan baru dan
  jadwal baru, paginasi, INTERRUPTED dan antrean berurutan). I-5 (cuti belum final tidak dihitung)
  tetap dijamin engine ATT-007 yang tidak diubah dan test engine yang ada.
- Manifest AUTH-011 (4 route baru, finalize pindah permission; jumlah route permission 184) dan
  `attendance-workforce.openapi.yaml` diperbarui.

## 19. Revisi R1 — Laporan, cetak, perbaikan absen (DRAFT, menunggu owner)

**Status:** usulan. Owner meminta **tidak ada kode** untuk butir mana pun sampai rencana ini disetujui (D-14-8 … D-14-16).
**Pemicu:** umpan balik owner setelah mencoba rilis `hcis-254caa95` (diteruskan sesi koordinasi,
2026-10-26), dalam kata-kata spesifikasi ini:

1. Kalkulasi terasa janggal sebagai menu sendiri. Kalkulasi adalah **bagian dari membuat laporan**:
   Laporan → atur tanggal → tarik/hitung data → lihat data transaksi mentah (belum berbentuk laporan)
   → pilih model laporan → tampilkan.
2. Cetak saat ini mencetak satu halaman web utuh (`window.print()` pada halaman admin). Yang
   dibutuhkan adalah dokumen cetak yang manusiawi.
3. Koreksi HC: tanggal sudah dipilih, tetapi saat mengisi jam, tanggal harus dipilih ulang (§19.5).
4. Klarifikasi dan Koreksi HC sebaiknya satu tab: pegawai mengajukan lewat HCIS, HC menginput dari
   panel admin (§19.6).
5. Istilah "Bukti HP" tidak jelas (§19.7).
6. Bukti HP jangan jadi layar sendiri: dilebur ke daftar kehadiran dengan kolom sumber, GPS dan foto
   dibuka dari barisnya (§19.7).

Arah ATT-014 tidak berubah: kehadiran tetap **tidak dihitung otomatis**, hasil resmi tetap dari
engine ATT-007 lewat run Kalkulasi, dan D-14-1 … D-14-4 tetap berlaku. Yang berubah adalah **di mana**
Kalkulasi muncul di layar dan **bagaimana** laporan dicetak. Backend ATT-014-2 (tabel run, runner,
`POST/GET/cancel /calculations`, `calculation-rows`) dipakai apa adanya.

### 19.1 Alur Laporan satu layar (menggantikan tab Kalkulasi)

Bentuk akhir menu Kehadiran ada di §19.8 (Pantauan Hari Ini | Perbaikan Absen | Laporan).
Tab Kalkulasi dihapus; `/admin/attendance/calculation` dialihkan ke `/admin/attendance/reports`
minimal satu rilis.

Halaman **Laporan** memandu empat langkah berurutan di satu layar (bukan wizard berpindah halaman):

```text
① Lingkup     Unit [Semua ▾]  Pegawai [Semua ▾]  Rentang [01-10-2026] s/d [26-10-2026]  [Bulan ini ▾]
② Data        [Tarik data]  ← tombol utama; progres tampil di tempat
              "Data 01–26 Okt sudah ditarik 26-10-2026 08:12. 3 baris berubah sejak itu. [Tarik ulang]"
③ Data mentah [ Data Transaksi | Detail Harian ]   ← setengah mentah, berhalaman, belum laporan
④ Laporan     Model [Laporan Harian (Grid Bulanan) ▾]  [Tampilkan]  → pratinjau  [Cetak] [Excel] [CSV]
```

| Langkah | Perilaku | Sumber |
|---|---|---|
| ① Lingkup | Unit, pegawai, rentang + pintasan §6.1. Mengubah lingkup mengosongkan ③ dan ④. | — |
| ② Tarik data | Membuat run Kalkulasi untuk lingkup itu (`POST /admin/attendance/calculations`). Bila lingkup sudah ditarik dan tidak ada baris berubah, tombol menjadi sekunder dengan teks "Data sudah terbaru" tetapi tetap bisa ditekan. Antrean, progres, batal, dan `INTERRUPTED` sama seperti §6.2. Tanpa `attendance.calculation.run` tombol tidak tampil; ③ dan ④ tetap bisa dibaca dari hasil tersimpan (D-14-1). | §6.2, ATT-014-2 |
| ③ Data mentah | Dua tab dulu: **Data Transaksi** (setiap scan: waktu, pegawai, sumber, mesin, tanggal kerja, dipakai/tidak; tanpa aksi edit) dan **Detail Harian** (baris `calculation-rows` yang sudah ada). Empat tab lain §6.3 menyusul. Tanda "Tidak tercatat", "Belum dikalkulasi", "Hari berjalan", "Berubah sejak dikalkulasi" tetap. | `calculation-rows`; endpoint transaksi baru (read-only, berhalaman) |
| ④ Model laporan | Daftar model §7. Laporan dibuat dari hasil tersimpan untuk lingkup ①; bila ada pasangan belum ditarik atau berubah, pratinjau dan cetakan memuat peringatan di kepala. **Tampilkan** membuka pratinjau di halaman; **Cetak** membuka dokumen cetak §19.2. | §7 |

Diksi tombol ② adalah keputusan owner (D-14-8). Usulan: **"Tarik data"**, dengan keterangan kecil
"menghitung kehadiran dari scan, jadwal, klarifikasi, dan cuti yang sudah final". Kata "Kalkulasi"
tidak lagi dipakai sebagai nama menu, hanya di riwayat/audit.

Halaman Laporan ATT-009 yang sekarang (menghitung status secara live) **digantikan** halaman ini.
Endpoint `GET /admin/attendance/report` tetap ada sampai model §7 yang setara selesai (§10).

### 19.2 Dokumen cetak yang manusiawi

Tombol **Cetak** tidak lagi memanggil `window.print()` pada halaman admin. Ia membuka **dokumen cetak
tersendiri** di tab baru (`/admin/attendance/reports/print?model=…&from=…&to=…&unitId=…`), tanpa
sidebar, menu, filter, atau tombol, lalu menawarkan dialog cetak peramban (Simpan sebagai PDF tersedia
dari dialog yang sama).

| Unsur | Aturan |
|---|---|
| Kop | Nama yayasan dan logo (TBD: teks dan berkas logo resmi dari owner, D-14-10), lalu judul laporan. |
| Kepala | Model laporan, unit (atau "Semua unit"), periode, "Dicetak oleh <nama akun> pada <tanggal jam WIB>". Peringatan "N pegawai-hari belum ditarik/berubah sejak ditarik" bila ada. |
| Isi | Hanya kolom model itu; angka rata kanan; tanggal dan jam format Indonesia; tidak ada warna yang wajib untuk dibaca (aman hitam-putih, simbol §6.6). |
| Halaman | A4; orientasi mengikuti model (Grid Bulanan dan Jadwal Bulanan **lanskap**, lainnya potret). Judul kolom diulang di setiap halaman. Baris tidak terpotong di tengah. Pengelompokan per unit dimulai di halaman baru bila model mengelompokkan per unit. |
| Kaki | Nomor halaman "Halaman x dari y" bila peramban mendukung; legenda simbol di halaman pertama untuk model bersimbol. |
| Tanda tangan | Kolom "Mengetahui" opsional di akhir laporan (DRAFT; diaktifkan bila owner meminta, D-14-10). |

PDF dari server, perancang tata letak, dan templat yang bisa diubah pengguna **tetap di luar scope**
(§8.3). Ekspor Excel/CSV tidak berubah dari §7.

### 19.3 Dampak pada paket implementasi

| Paket | Isi setelah R1 |
|---|---|
| ATT-014-1 | Tetap (sudah dirilis). |
| ATT-014-2 | Tetap; backend dipakai apa adanya. Halaman Kalkulasi sementara tetap ada sampai ATT-014-3R dirilis, lalu dialihkan. |
| **ATT-014-3R** Alur Laporan | §19.1: halaman Laporan empat langkah, tab Data Transaksi + Detail Harian, endpoint transaksi read-only berhalaman, hapus tab Kalkulasi + redirect, pensiunkan halaman ATT-009 lama dari menu. Tanpa migration. |
| **ATT-014-4R** Model laporan + cetak | §19.2 dan §7: dokumen cetak, lalu model bertahap (usulan urutan D-14-11), Excel/CSV, audit ekspor. Tanpa migration. |
| ATT-014-5 | Tetap (tampilan tersimpan). |

Test minimum tambahan: alur ①→④ tanpa `attendance.calculation.run` (tombol tidak tampil, data tetap
terbaca); mengubah lingkup mengosongkan data dan pratinjau; `/admin/attendance/calculation` dialihkan;
dokumen cetak tidak memuat elemen navigasi dan memuat kop, periode, lingkup, pencetak; orientasi
sesuai model; judul kolom berulang (diperiksa lewat CSS `thead { display: table-header-group }` dan
uji render); setiap cetak dan ekspor teraudit.

### 19.4 Keputusan owner untuk R1

| # | Pertanyaan | Usulan |
|---|---|---|
| D-14-8 | Nama tombol langkah ②. | **"Tarik data"** + keterangan kecil apa yang dihitung. Alternatif: "Proses data", "Hitung data". |
| D-14-9 | Tab Kalkulasi dihapus dan alamatnya dialihkan ke Laporan; halaman Laporan ATT-009 lama digantikan alur §19.1. | Ya. |
| D-14-10 | Kop cetak: nama yayasan dan logo yang dipakai; perlu kolom tanda tangan "Mengetahui"? | Kirim teks kop dan berkas logo resmi; tanda tangan opsional, mati secara bawaan. |
| D-14-11 | Model laporan yang dibuat pertama. | **Laporan Harian (Grid Bulanan)**, **Rekapitulasi Pegawai**, **Detail Harian**; sisanya menyusul. |
| D-14-12 | PR #170 (perbaikan form HC, sudah terlanjur dibuat, kini draft): dipakai sebagai dasar atau ditutup? | Dipakai sebagai dasar, ditambah form pegawai (§19.5). |
| D-14-13 | Pemeriksaan read-only data koreksi lama di production, dan bila ada baris: status `superseded` dengan migration aditif kecil. | Ya untuk pemeriksaan; `superseded` hanya bila pemeriksaan menemukan baris. |
| D-14-14 | Nama tab gabungan Klarifikasi + Koreksi HC. | **"Perbaikan Absen"**. Alternatif: "Klarifikasi & Koreksi". |
| D-14-15 | "Bukti HP" dilebur ke **Data Transaksi** di Laporan: kolom Sumber (Mesin/HP/Koreksi), lencana "Perlu ditinjau" tetap terlihat, GPS dan foto dari panel detail baris dan hanya untuk `attendance.clarification.manage`; tab Bukti HP dihapus. | Ya. |
| D-14-16 | Bentuk akhir navigasi Kehadiran: Pantauan Hari Ini, Perbaikan Absen, Laporan, dengan pengalihan route lama §19.8. | Ya. |

### 19.5 Butir 3 — bug tanggal pada Koreksi HC dan pengajuan pegawai

**Masalah (diverifikasi di `main` 2026-10-26).** Form Koreksi HC (`AdminAttendancePage.tsx`) mengirim
`workDate` dari field Tanggal, tetapi jam masuk/pulang berasal dari input `datetime-local` yang membawa
tanggalnya sendiri (bawaan hari ini). Form pengajuan klarifikasi pegawai
(`EmployeeMobileAttendancePage.tsx`, mode koreksi) memakai pola `datetime-local` yang sama. API
(`manualCorrectionSchema`, `clarificationSchema`) hanya memeriksa format. Akibatnya koreksi untuk
20 Oktober bisa tersimpan dengan stempel 26 Oktober dan ikut dihitung engine.

**Rencana perbaikan:**

1. Form HC dan form pegawai memakai satu **Tanggal kerja** plus jam saja (`type="time"`), dengan
   centang eksplisit "Pulang keesokan hari (+1 hari)" untuk shift yang berakhir lewat tengah malam.
2. API menolak dengan `422` **sebelum menulis apa pun**, untuk koreksi HC, pengajuan pegawai, dan
   keputusan HC atas pengajuan:
   `CHECK_IN_OUTSIDE_WORK_DATE` (jam masuk bukan pada tanggal kerja, WIB),
   `CHECK_OUT_OUTSIDE_WORK_DATE` (jam pulang bukan pada tanggal kerja atau keesokan harinya),
   `CHECK_OUT_BEFORE_CHECK_IN` (jam pulang tidak setelah jam masuk, atau lebih dari 24 jam sesudahnya).
3. Test unit untuk jendela (termasuk 00:30 WIB dan shift malam), test route (422 tanpa query database,
   permission tetap diperiksa lebih dulu), test form web.

**Yang sudah terlanjur dibuat sebelum instruksi "jangan koding":** branch `claude/att-hc-correction-date`,
commit `fix(attendance): keep Koreksi HC times on the selected work date`, PR #170 — kini **draft** dan
tidak akan di-merge tanpa keputusan owner. Isinya butir 1–3 di atas **untuk form HC saja** (belum form
pegawai). Pilihan untuk owner (D-14-12): (a) pakai PR #170 sebagai dasar lalu tambah form pegawai, atau
(b) tutup PR #170 dan kerjakan ulang setelah seluruh rencana disetujui. Usulan: (a).

**Data yang mungkin sudah tersimpan keliru.**

*Pemeriksaan read-only* (dijalankan hanya dengan persetujuan owner, lewat `ssh mi8vps`, di dalam
`BEGIN TRANSACTION READ ONLY`, keluaran hanya id, tanggal, dan hitungan — tanpa nama atau NIP):

```sql
BEGIN TRANSACTION READ ONLY;
SELECT c.id, c.work_date, c.status, c.mode, c.kind,
       (c.proposed_check_in_at  AT TIME ZONE 'Asia/Jakarta')::date AS check_in_date,
       (c.proposed_check_out_at AT TIME ZONE 'Asia/Jakarta')::date AS check_out_date,
       EXISTS (SELECT 1 FROM attendance_clarification_events e
               WHERE e.clarification_id = c.id
                 AND e.payload->>'administrativeCorrection' = 'true') AS by_hc
FROM attendance_clarifications c
WHERE c.mode = 'correction'
  AND (
    (c.proposed_check_in_at IS NOT NULL
      AND (c.proposed_check_in_at AT TIME ZONE 'Asia/Jakarta')::date <> c.work_date)
    OR (c.proposed_check_out_at IS NOT NULL
      AND (c.proposed_check_out_at AT TIME ZONE 'Asia/Jakarta')::date NOT IN (c.work_date, c.work_date + 1))
    OR (c.proposed_check_in_at IS NOT NULL AND c.proposed_check_out_at IS NOT NULL
      AND c.proposed_check_out_at <= c.proposed_check_in_at)
  )
ORDER BY c.work_date;
ROLLBACK;
```

*Bila tidak ada baris:* catat hasilnya di catatan rilis, tidak ada tindakan data.

*Hasil pemeriksaan 2026-10-26 (D-14-13 disetujui owner):* dijalankan read-only di `sqcore_hcis`
Mi8VPS (`BEGIN TRANSACTION READ ONLY` dan `default_transaction_read_only=on`). Jumlah klarifikasi
`mode='correction'` di production: **0** (baik dari pegawai maupun HC), sehingga baris bermasalah
**0**. Tidak ada data yang perlu ditangani; status `superseded` dan migration-nya **tidak dibuat**.

*Bila ada baris:* data scan asli dan baris klarifikasi **tidak dihapus atau diubah** (append-only).
Yang diusulkan (D-14-13):

1. Laporkan daftar id + tanggal kepada owner dan HC; HC memastikan jam yang benar untuk tiap kasus.
2. Tambah transisi status baru **`superseded`** ("Digantikan") untuk klarifikasi `approved`, hanya oleh
   pemegang `attendance.records.manage`, wajib alasan, tercatat di `attendance_clarification_events`
   dan audit `attendance.clarification.superseded`. Engine mengabaikan klarifikasi `superseded`
   (input hasil berubah, sehingga versi hasil baru terbentuk dan versi lama tetap sebagai riwayat).
   Ini butuh migration aditif kecil (memperluas CHECK status) dan review tambahan.
3. HC memasukkan koreksi baru yang benar untuk tanggal yang tepat, lalu **Tarik data** untuk rentang itu.
4. Kasus `submitted` (belum diputuskan) cukup ditolak HC dengan catatan "tanggal dan jam tidak
   sejalan; ajukan ulang".

Alternatif tanpa migration: biarkan baris lama dan hanya tambahkan koreksi benar. **Tidak
disarankan**, karena koreksi lama tetap dipakai engine pada tanggal yang salah.

### 19.6 Butir 4 — Klarifikasi dan Koreksi HC menjadi satu tab

**Pengamatan.** Keduanya sudah satu model di backend: koreksi HC disimpan sebagai baris
`attendance_clarifications` (`mode='correction'`, `kind='other'`, langsung `approved`) dengan event
`submitted` + `approved` berpayload `administrativeCorrection: true`. Yang terpisah hanya layar dan
permission: daftar klarifikasi butuh `attendance.clarification.manage`, input koreksi HC butuh
`attendance.records.manage`. Daftar admin sekarang dibatasi `LIMIT 500` tanpa halaman (melanggar
usulan ENG-LIST-001).

**Usulan:**

| Aspek | Rencana |
|---|---|
| Nama tab | **"Perbaikan Absen"** (D-14-14; alternatif "Klarifikasi & Koreksi"). Tab "Koreksi HC" dihapus; alamatnya dialihkan. |
| Satu daftar | Semua klarifikasi dan koreksi, berhalaman, terbaru dulu. Filter: status (Menunggu, Disetujui, Ditolak, Dibatalkan, Digantikan), asal, jenis (koreksi jam / alasan), unit, rentang tanggal kerja, cari pegawai. Bawaan: Menunggu. |
| Asal pengajuan | Kolom **Asal**: "Diajukan pegawai" atau "Diinput HC", diturunkan dari event `submitted` yang sudah ada (tanpa kolom baru). Koreksi HC tampil langsung "Disetujui" dengan nama penginput. |
| Input HC | Tombol **"Input koreksi"** di tab yang sama (hanya untuk `attendance.records.manage`), membuka form §19.5. |
| Keputusan | Pengajuan pegawai diputuskan dari panel detail (setujui/tolak + catatan), seperti sekarang. |
| Bukti pendukung | Panel detail menampilkan scan asli hari itu, hasil terakhir, dan — bila ada — bukti absen HP (§19.7). |
| Permission | Tab terlihat dengan `attendance.clarification.manage` **atau** `attendance.records.manage`; tiap aksi tetap memeriksa permission-nya sendiri di API. Tidak ada permission baru. |
| Backend | Model data **sudah cukup**; tidak perlu disatukan. Yang ditambah: daftar admin berhalaman + filter asal, dan validasi §19.5. `POST /admin/attendance/manual-corrections` tetap sebagai jalur input HC. |

Batas tetap: data scan asli tidak pernah diubah; setiap perbaikan adalah fakta baru dengan alasan dan
jejak keputusan.

### 19.7 Butir 5 dan 6 — "Bukti HP" dilebur ke daftar kehadiran

**Fakta production (diperiksa read-only oleh sesi koordinasi 2026-10-26):** `MOBILE_ATTENDANCE_ENABLED`
tidak ada di `final.env` (absen dari HP mati), dan `attendance_mobile_evidence` hanya berisi 3 baris
lama. Tab itu praktis kosong.

**Tempatnya: tab Data Transaksi di alur Laporan (§19.1 langkah ③)** — satu baris = satu absen, dari
sumber mana pun. Alasannya:

- Sumber adalah sifat **tiap absen**, dan Data Transaksi adalah satu-satunya daftar yang barisnya satu
  absen. Di daftar Perbaikan Absen barisnya satu pengajuan, sehingga absen HP yang tidak pernah
  diajukan perbaikan tidak akan terlihat di sana.
- Operator memeriksa absen dalam konteks lingkup dan rentang yang sama dengan laporannya, tanpa pindah
  layar. Bila absen HP perlu diperbaiki, panel detail barisnya punya tombol **"Buat koreksi"** (hanya
  untuk `attendance.records.manage`) yang membuka form Perbaikan Absen terisi pegawai dan tanggal kerja.
- Panel detail di Perbaikan Absen menampilkan absen hari itu dengan komponen yang sama, sehingga
  pemutus pengajuan juga melihat GPS/foto tanpa membuka layar lain.

| Aspek | Rencana |
|---|---|
| Kolom **Sumber** | Lencana per baris: **Mesin** (nama mesin), **HP**, atau **Koreksi HC** / **Koreksi pegawai** (koreksi jam yang disetujui). Filter Sumber di kepala tabel. |
| Satu hari, beberapa sumber | Di Data Transaksi tiap absen tetap satu baris, sehingga hari dengan scan Mesin dan HP tampil dua baris berurutan. Di Detail Harian (satu baris = satu hari) kolom Sumber menggabungkan lencana, misalnya "Mesin + HP", dan menandai mana yang dipakai engine sebagai jam masuk/pulang. |
| **Perlu ditinjau** | Baris HP dengan `review_state = needs_review` (di luar radius lokasi atau akurasi GPS buruk) diberi lencana **"Perlu ditinjau"** berikut alasannya (jarak, akurasi). Filter cepat "Perlu ditinjau" dengan jumlahnya tampil di kepala tabel selama ada baris seperti itu dalam lingkup, terlepas dari status absen HP di server. |
| GPS dan foto | Dibuka dari **panel detail baris**: koordinat, akurasi, jarak ke lokasi kerja, status tinjauan, dan tombol **"Lihat foto"**. Foto diambil satu per satu lewat endpoint yang sudah ada saat tombol ditekan; setiap pembukaan tercatat `attendance.mobile.photo.read`. Daftar tidak pernah memuat foto, thumbnail, atau tautan foto massal. |
| Hak akses | Data Transaksi dibaca dengan `attendance.reports.read`. Lencana Sumber dan "Perlu ditinjau" boleh terlihat semua pembaca. **Koordinat, jarak, dan tombol foto disembunyikan** (tidak dirender, dan tidak dikirim API) untuk akun tanpa `attendance.clarification.manage`. Endpoint transaksi hanya menyertakan field GPS bila pemanggil memegang izin itu; endpoint foto tetap menolak 403 seperti sekarang. |
| Batas | Data scan asli tidak berubah. Tidak ada aksi edit di Data Transaksi; perbaikan selalu lewat Perbaikan Absen sebagai fakta baru beralasan. Aturan ATT-006 tetap. |
| Nama | "Bukti HP" tidak dipakai lagi. Di mana pun tampil: **"HP"** sebagai sumber, "absen lewat HP (lokasi GPS dan foto)" sebagai keterangan. |

### 19.8 Bentuk akhir navigasi Kehadiran

```text
Sebelum: Pantauan Hari Ini | Kalkulasi | Klarifikasi | Bukti HP | Koreksi HC | Laporan
Sesudah: Pantauan Hari Ini | Perbaikan Absen | Laporan
```

| Tab | Route | Dibuka dengan | Isi |
|---|---|---|---|
| Pantauan Hari Ini | `/admin/attendance/daily` (tetap) | `attendance.reports.read` | §5, tidak berubah. |
| Perbaikan Absen | `/admin/attendance/corrections` (route lama Koreksi HC dipakai ulang) | `attendance.clarification.manage` **atau** `attendance.records.manage` | §19.6. |
| Laporan | `/admin/attendance/reports` (tetap) | `attendance.reports.read` | §19.1 (Data Transaksi + Detail Harian, model laporan, cetak). |

Pengalihan, dipertahankan minimal satu rilis, lalu dihapus:

| Route lama | Dialihkan ke |
|---|---|
| `/admin/attendance/calculation` (Kalkulasi, ATT-014-2) | `/admin/attendance/reports` |
| `/admin/attendance/settings/recalculate` (sudah dialihkan ke Kalkulasi) | `/admin/attendance/reports` (langsung, tanpa rantai) |
| `/admin/attendance/clarifications` | `/admin/attendance/corrections` |
| `/admin/attendance/mobile-evidence` | `/admin/attendance/reports?tab=transactions&source=mobile` |
| `/admin/attendance/workforce/clarifications`, `/workforce/mobile` (pra-ATT-011) | sama dengan dua baris di atas |

Kartu Ringkasan, katalog layanan, dan pemetaan izin web (`authorization.ts`) ikut diperbarui; test
navigasi memastikan setiap route lama berakhir di route yang ada.

### 19.9 Urutan paket setelah disetujui

| Urutan | Paket | Isi | Migration |
|---|---|---|---|
| 1 | **ATT-FIX-1** Tanggal koreksi | §19.5 butir 1–3 (form HC + form pegawai + validasi API). | Tidak. |
| 2 | **ATT-FIX-2** Pemeriksaan data lama | Jalankan kueri read-only §19.5 dengan persetujuan owner; laporkan. Bila ada baris: status `superseded` + alur penggantian. | Hanya bila ada baris (aditif). |
| 3 | **ATT-014-3R** Alur Laporan | §19.1. | Tidak. |
| 4 | **ATT-011-3R** Perbaikan Absen + sumber absen | §19.6, §19.7 (kolom Sumber, panel GPS/foto, field GPS hanya untuk pemegang izin), §19.8 navigasi dan pengalihan. | Tidak. |
| 5 | **ATT-014-4R** Cetak + model laporan | §19.2, model sesuai D-14-11. | Tidak. |

Setiap paket satu PR, dirilis lewat OPS-MI8-REL-001 dengan persetujuan owner.

### 19.10 Catatan implementasi ATT-014-3R (2026-10-26)

Rencana R1 dan D-14-8 … D-14-15 disetujui owner 2026-10-26 (diteruskan sesi koordinasi).

- **Halaman Laporan** (`/admin/attendance/reports`, `AdminAttendanceReportsPage.tsx`) memandu empat
  langkah di satu layar: ① Lingkup (unit dan pegawai hanya tampil bila katalog pegawai boleh dibaca,
  rentang + pintasan), ② **Tarik data** (run Kalkulasi yang sama; bila lingkup sudah lengkap dan tidak
  ada baris berubah, tombol menjadi sekunder "Tarik ulang" dengan teks "Data sudah terbaru"; tanpa
  `attendance.calculation.run` tombol tidak tampil), ③ **Data mentah** dengan tab Data Transaksi dan
  Detail Harian, keduanya berhalaman, ④ **Laporan**.
- **Mengubah lingkup** mengosongkan run yang tampil dan mengembalikan kedua tabel ke halaman 1.
- **Data Transaksi** memakai endpoint baru `GET /admin/attendance/transactions`
  (`attendance.reports.read`, read-only, berhalaman, maks 93 hari): scan mesin dibaca mentah lewat
  mapping PIN yang berlaku saat scan (termasuk yang belum diproses engine), event HP/koreksi lama, dan
  jam koreksi yang disetujui (satu baris per batas, asal HC atau pegawai). Kolom **Sumber** (Mesin ·
  nama mesin, HP, Koreksi HC, Koreksi pegawai) dan **Dipakai** (dipakai versi hasil terakhir). Kolom
  GPS/foto absen HP dan penanda "Perlu ditinjau" ada di paket ATT-011-3R (§19.7).
- **Langkah ④ sementara** memakai format laporan ATT-009 yang lama (`LegacyReportSection`, lingkup dari
  langkah ①) agar tidak ada laporan yang hilang sebelum ATT-014-4R. Format itu masih menghitung status
  saat dibuka, dan tombol cetaknya masih mencetak halaman; keduanya digantikan model laporan dan dokumen
  cetak §19.2 di ATT-014-4R. Peringatan tampil bila data belum ditarik atau berubah.
- **Tab Kalkulasi dihapus**; `/admin/attendance/calculation` dan `/admin/attendance/settings/recalculate`
  dialihkan langsung ke `/admin/attendance/reports`. Endpoint ATT-014-2 tidak berubah.
- Manifest AUTH-011 (+1 route, jumlah 185) dan `attendance-workforce.openapi.yaml` diperbarui.

### 19.11 Catatan implementasi ATT-014-4R (2026-10-26)

- **Tiga model laporan pertama (D-14-11)** dibuat di server dari hasil tersimpan (`report-models.ts`):
  **Laporan Harian (Grid Bulanan)** (simbol §6.6, kolom per tanggal dengan tanda akhir pekan, total
  Normal, Riil, Presensi %, A, T, TL, C, lembur; lanskap), **Rekapitulasi Pegawai** (subtotal per unit
  dan jumlah seluruhnya; Presensi % = Riil ÷ Normal, satu desimal), dan **Detail Harian**. Satu tabel
  yang sama dipakai pratinjau, dokumen cetak, CSV, dan XLSX.
- **Endpoint** `GET /admin/attendance/reports/{model}` (`attendance.reports.read`), `format=json|csv|xlsx`,
  `purpose=view|print`, maks 93 hari dan 50 000 pegawai-hari (`422 EXPORT_TOO_LARGE`, DRAFT). Setiap
  **cetak** (`purpose=print`) dan **ekspor** (csv/xlsx) diaudit `attendance.report.exported` dengan model,
  format, tujuan, lingkup, rentang, dan jumlah baris saja. Pratinjau di layar tidak diaudit.
- **Dokumen cetak mengikuti mock-up yang disetujui owner (2026-10-26):** halaman tersendiri
  `/admin/attendance/reports/print` di tab baru, hanya lembar kertas (tanpa kerangka admin), lalu dialog
  cetak terbuka otomatis. Kop: lambang di kiri, nama yayasan dan satu baris alamat, garis 1,4pt. Judul di
  tengah, huruf besar, serif, dengan baris periode. Blok identitas (unit, jumlah pegawai, penyaring, hari
  kerja) dan kotak meta bergaris kiri tebal berisi **Data dihitung**, **Dicetak**, **Dicetak oleh**
  secara terpisah. Tabel: kolom Pegawai 48mm (nama + NIP), kolom tanggal 5,4mm, rekap 9mm, libur berlatar
  abu sangat tipis, angka `tabular-nums`, judul kolom berulang di tiap halaman, baris tidak terpotong,
  unit berikutnya mulai di halaman baru, jumlah seluruhnya sekali di akhir. Legenda di bawah tabel, dan
  "Tidak lengkap" serta "Tidak tercatat" dijelaskan satu kalimat di lembarnya.
- **Kolom mengikuti mock-up:** grid bulanan merekap Hadir, Telat, Tdk lengkap, Cuti/Izin, Tdk hadir;
  Rekapitulasi Pegawai memuat Hari kerja, Hadir, Terlambat, Menit telat, Tidak lengkap, Cuti/Izin, Tidak
  hadir, Lembur, ditambah Presensi % (§6.3). Judul di kertas: "Laporan Kehadiran Harian", "Rekapitulasi
  Kehadiran Pegawai", "Detail Kehadiran Harian".
- **Orientasi** memakai named page (`page: lanskap | potret`). **Nomor halaman "Halaman n dari N"**
  dan kalimat pembuat netral di kaki memakai *page margin box* CSS (`@bottom-left`, `@bottom-right`,
  `counter(pages)`). Keputusan teknis: tanpa pustaka paged media dan tanpa PDF dari server. Margin box
  hanya tampil di margin halaman yang tidak nol, sehingga padding lembar pada mock-up (10/12mm lanskap,
  14mm potret) dipakai sebagai margin `@page`; hasil visualnya sama. **Diverifikasi 2026-10-26** dengan
  mencetak lembar sintetis ke PDF memakai Chrome 155: nomor halaman, kalimat kaki, judul kolom berulang,
  dan campuran lanskap/potret tampil. Chrome dan Edge versi 131 ke atas mendukungnya; Firefox dan Safari
  mencetak tanpa nomor halaman, dan hal itu disebutkan di bilah layar dokumen cetak.
- **Kop (D-14-10, ditetapkan owner 2026-10-26):** lambang lengkap yayasan yang sudah ada di repo
  (`apps/web/src/assets/brand/ysq-mark.png`, berlatar sendiri sehingga tetap terbaca di kertas putih dan
  cetak hitam putih) dengan nama yayasan sebagai teks serif dan baris "hcis.sabilulquran.or.id". Wordmark
  emas dan logo putih tidak dipakai di kertas. Semua nilai kop dan kalimat kaki ada di satu berkas (`apps/web/src/lib/reportLetterhead.ts`). Blok tanda
  tangan "Mengetahui" opsional di kanan bawah, mati secara bawaan, dinyalakan di berkas yang sama. Tanpa
  QR atau tautan verifikasi.
- **Langkah ④** kini memakai model baru (Tampilkan, Cetak, Excel, CSV). Format ATT-009 lama (sesi kerja,
  data scan, jadwal, lembur) tetap tersedia di bagian "Format lama" yang tertutup secara bawaan untuk
  satu rilis.
- Manifest AUTH-011 (+1 route, jumlah 186) dan `attendance-workforce.openapi.yaml` diperbarui.

### 19.12 Catatan implementasi ATT-011-3R (2026-10-26)

D-14-15 (revisi) dan D-14-16 disetujui owner 2026-10-26 (diteruskan sesi koordinasi).

- **Perbaikan Absen** (`/admin/attendance/corrections`) menggantikan tab Klarifikasi dan Koreksi HC:
  satu daftar berhalaman, tab status (Menunggu keputusan dengan jumlahnya, Disetujui, Ditolak,
  Dibatalkan, Semua), penyaring asal, jenis, rentang tanggal kerja, cari nama/NIP. Kolom **Asal**
  ("Diajukan pegawai"/"Diinput HC") diturunkan dari event `submitted` yang sudah ada, tanpa migration.
  Panel detail: alasan, usulan jam, status dan pemutus, **absen tercatat hari itu** (komponen Data
  Transaksi), serta tombol Setujui/Tolak untuk pengajuan yang menunggu (`attendance.clarification.manage`).
  Tombol **Input koreksi** (`attendance.records.manage`) membuka form satu tanggal kerja + jam dari
  ATT-FIX-1. Daftar dibaca dengan salah satu dari dua permission itu; setiap aksi tetap memeriksa
  permission-nya sendiri di API.
- **Bukti HP dilebur ke Data Transaksi:** kolom Sumber tetap, absen HP dengan `needs_review` diberi
  lencana **"Perlu ditinjau"** yang terlihat semua pembaca, dan tombol cepat "Perlu ditinjau (N)" tampil
  selama ada baris seperti itu. Klik baris membuka detail: alasan tinjauan, panel GPS (posisi terhadap
  lokasi kerja, jarak, akurasi, koordinat) dan tombol **Lihat foto**, serta **Buat koreksi** langsung di
  tempat (`attendance.records.manage`). API hanya mengirim field GPS dan id bukti bila pemanggil memegang
  `attendance.clarification.manage`; foto diambil satu per satu lewat endpoint foto yang ada dan setiap
  pembukaan tetap teraudit. Tidak ada foto atau thumbnail di daftar.
- **Navigasi akhir (D-14-16):** Kehadiran = Pantauan Hari Ini | Perbaikan Absen | Laporan. Pengalihan:
  `/admin/attendance/clarifications` → Perbaikan Absen, `/admin/attendance/mobile-evidence` dan
  `/admin/attendance/workforce/mobile` → `/admin/attendance/reports?tab=transactions&source=mobile`,
  `/admin/attendance/workforce/clarifications` → Perbaikan Absen. Kartu Ringkasan dan katalog layanan
  ikut diarahkan ulang.
- **Backend:** `GET /admin/attendance/clarifications` kini berhalaman dengan penyaring asal/jenis/rentang/
  cari dan `submittedCount` (sebelumnya `LIMIT 500`); helper `requireAnyPermissionFromCookie` baru di
  modul otorisasi (perlu review tambahan). `GET /admin/attendance/transactions` menambah `reviewState`,
  `geofenceStatus`, `needsReviewTotal`, penyaring `reviewState=needs_review`, dan `evidence` bersyarat.
  Endpoint daftar bukti HP lama tetap ada untuk kartu Ringkasan. Tidak ada migration dan tidak ada
  permission baru.

## 20. Revisi R2 — halaman Laporan satu jendela, tab "Tanpa Jadwal", dan kenapa data kosong (DRAFT, menunggu owner)

**Status:** usulan, **belum ada kode**. Menunggu persetujuan owner atas D-14-17 … D-14-21 (D-14-20 dalam bentuk yang direvisi menurut arahan owner). Jam shift D-14-22 sudah ditetapkan owner 2026-10-26; toleransinya menunggu konfirmasi.
**Pemicu:** owner mencoba rilis R1 `hcis-b1657745-20261026` (2026-10-26, diteruskan sesi koordinasi):
halaman Laporan membingungkan, format lama masih terlipat di bawah, owner meminta pola software
Solution Attendance Management (satu bar menu di atas, sedikit tabel, laporan terbuka sebagai popup), dan
menanyakan kenapa data SD kosong setelah Tarik data padahal mesin terus menerima scan.

### 20.1 Kenapa data SD kosong (diagnosis read-only production, 2026-10-26)

Pipa data **tidak putus**; datanya belum siap, dan layar tidak pernah menjelaskannya.

| Fakta | Angka |
|---|---|
| Scan mesin 30 hari terakhir | 1.779 scan, 1.772 dari mesin SDIT Tahfizh, 51 PIN unik |
| PIN yang sudah dipetakan ke pegawai | 44 dari 51; **43 di antaranya baru berlaku 19 Okt 2026 11.38** |
| Pegawai aktif SDIT Tahfizh | 46 |
| — punya PIN dan scan setiap hari, **tanpa jadwal sama sekali** | **28** |
| — punya jadwal + PIN + scan | 11 |
| — punya jadwal + PIN, tanpa scan sejak 19 Okt | 2 |
| — punya jadwal, tanpa PIN | 2 |
| — tanpa ketiganya | 3 |
| Pola jadwal yang ada | 15, **semuanya mulai 24 Okt 2026** |
| Run Kalkulasi 1–26 Okt | 346 pasangan dihitung, 850 di luar cakupan |
| Run Kalkulasi 1–30 Sep | 30 dihitung, 1.350 di luar cakupan |

Akibatnya:

1. **Scan sebelum 19 Okt tidak bisa dikaitkan ke pegawai mana pun**, karena pemetaan PIN berlaku sejak
   dibuat. Hari-hari itu tampil "Tidak tercatat" (aturan D-14-3).
2. **Hari tanpa jadwal tidak punya vonis**, karena jadwal tidak pernah disintesis (I-4). Engine hanya
   menyalin scan mesin ke `attendance_events` saat menghitung hari yang berjadwal. Karena itu
   `attendance_events` sumber mesin baru berisi 11 baris.
3. **Ditemukan cacat tampilan:** untuk 28 pegawai tanpa jadwal, engine menulis status `off` dan tab
   Detail Harian menampilkannya sebagai **"Libur"**. Seharusnya "Tanpa jadwal", seperti di Pantauan Hari
   Ini yang sudah membedakan keduanya.
4. Data Transaksi sebetulnya membaca scan mentah lewat pemetaan PIN, jadi scan sejak 19 Okt seharusnya
   tampil di sana. Namun tidak ada tempat yang mengatakan "28 pegawai ini belum punya jadwal" atau
   "scan PIN ini terjadi sebelum PIN dipetakan".

Karantina 4.769 baris `UNKNOWN_DEVICE` (28 Agu–16 Okt) adalah scan sebelum mesin didaftarkan; itu
sejarah, bukan masalah aktif, dan tidak disentuh R2.

### 20.2 Bentuk halaman Laporan (pola referensi, D-14-17)

Satu jendela, satu bar kontrol, satu tabel per tab. Bagian "Format lama" yang terlipat **dihapus**.

```text
┌ Laporan dan Kalkulasi ─────────────────────────────────────────────────────────────────────────┐
│ Unit [SDIT Tahfizh ▾]  Pegawai [<Semua> ▾]  Tgl [01-10-2026] s/d [26-10-2026] [Bulan ini ▾]     │
│ [Kalkulasi]  [Laporan ▾]  [Ekspor ▾]          Urutkan [Unit ▾] [A→Z ▾]                          │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Data Transaksi | Harian | Pengecualian | Rekapitulasi | Lembur | Tanpa Jadwal (28)               │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ satu tabel berhalaman, kolom sesuai tab                                     [panel detail baris] │
│ status kesegaran: "Dihitung 26 Okt 09.12 · 3 baris berubah sejak dihitung"                      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Bagian | Isi |
|---|---|
| **Bar kontrol** | Unit, pegawai (bawaan `<Semua>`), rentang + pintasan, tombol **Kalkulasi**, **Laporan ▾**, **Ekspor ▾** (Excel/CSV dari tab aktif), urutan (unit, NIP, nama, tanggal/jam, A→Z/Z→A). Satu baris di layar lebar; dua baris di < 1024px; kartu di < 768px. |
| **Kalkulasi** | Membuka **popup progres** di halaman: "Menghitung … 63% (218 dari 346 pegawai-hari)" dengan tombol **Batal**. Selama berjalan, Laporan dan Ekspor nonaktif. Selesai: popup menutup dan tab aktif dimuat ulang. Nama pegawai yang sedang dihitung butuh kolom baru di tabel run (migration kecil), jadi usulan awalnya tanpa nama (lihat D-14-17). |
| **Tab Data Transaksi** | Tetap seperti R1 (satu baris = satu absen, sumber, "Perlu ditinjau", detail GPS/foto, Buat koreksi). |
| **Tab Harian** (padanan "Shift") | Kolom: NIP, Nama, Tanggal, Jam kerja (nama shift), Jam masuk/pulang jadwal, Scan masuk/pulang, Normal, Riil, Terlambat, Plg. cepat, Tidak hadir (centang), Lembur, Jml jam kerja, Pengecualian, Unit. Baris tidak hadir diberi latar biru muda pada kolom scan, sel scan yang hilang hijau muda, sesuai referensi. Status "Tanpa jadwal" dibedakan dari "Libur" (perbaikan 20.1 butir 3). |
| **Tab Pengecualian** | Cuti/izin final, penyelesaian, klarifikasi, dan koreksi dalam rentang (read-only), dengan tautan ke Perbaikan Absen. |
| **Tab Rekapitulasi** | Satu baris per pegawai: Hari kerja, Hadir, Terlambat, Menit telat, Tidak lengkap, Cuti/Izin, Tidak hadir, Lembur, Presensi %. |
| **Tab Lembur** | Lembur disetujui dan fakta scan di luar jadwal (tanpa vonis lembur; ATT-011-6a). |
| **Tab Tanpa Jadwal** | §20.3. |
| **Laporan ▾** | Menu model: Laporan Harian (grid), Rekapitulasi Pegawai, Detail Harian (sudah ada); Per Unit, Data Scan, Jadwal Harian, Data Transaksi, Lembur Harian, Dari tampilan aktif (bertahap). Model terbuka sebagai popup (§20.4). |

Tidak ada lagi langkah ①–④ bertumpuk, dan tidak ada blok "Format lama". Format ATT-009 yang masih
diperlukan diganti tab (Data Transaksi untuk data scan, Lembur untuk lembur) dan model laporan di menu.

### 20.3 Tab "Tanpa Jadwal" (D-14-19)

Tab ini menjawab langsung "kenapa kosong". Isinya dua bagian.

**A. Pegawai yang scan tetapi belum punya jadwal** (padanan "Tidak Ada Shift").
Satu baris per pegawai dalam lingkup: NIP, Nama, Unit, jumlah hari ber-scan tanpa jadwal, scan
pertama–terakhir, dan alasan:

- "Belum punya pola jadwal";
- "Pola jadwal mulai 24 Okt; scan sebelumnya tidak dinilai".

Sumbernya scan mentah lewat pemetaan PIN, seperti Data Transaksi, sehingga tidak bergantung pada
Kalkulasi. Jumlah baris tampil di judul tab.

Daftar ini **dikelompokkan menurut jabatan** (lalu unit), karena penyebab yang paling mungkin adalah
**tidak adanya shift yang cocok** untuk satu kelompok jabatan, bukan kelalaian per orang. Fakta production
2026-10-26: 21 dari 28 pegawai SDIT Tahfizh tanpa jadwal berjabatan "Guru Tahfizh (Half Day)" atau
"(Half Day) II", sedangkan shift SDIT hanya "SDIT — Hari Penuh" 07.00–16.00. Memasang mereka ke shift
hari penuh akan membuat semuanya "pulang cepat" setiap hari. Setiap kelompok menampilkan jumlah pegawai,
jabatan, dan rentang jam scan terakhir yang **hanya sebagai keterangan**, tidak dipakai untuk menebak jam
shift. Aksi per kelompok (hanya `attendance.schedule.manage`):

- **Pasang ke shift yang ada**: memilih shift dan hari, lalu membuat pola jadwal untuk pegawai terpilih
  di kelompok itu, mulai tanggal yang dipilih HC. Ini memakai alur Pola jadwal yang ada, dengan pratinjau
  "N pegawai, mulai <tanggal>".
- **Buat shift baru**: membuka Shift → tambah, lalu kembali ke kelompok ini. Jam masuk/pulang **wajib
  diisi HC**; HCIS tidak pernah mengusulkan jam dari data scan (I-4).

Per pegawai juga tersedia tombol **Pasang jadwal**, yang membuka Jadwal → Pola jadwal dengan pegawai
terpilih sudah terisi.

**B. Scan yang belum bisa dikaitkan ke pegawai.**
Satu baris per mesin + PIN: jumlah scan dalam rentang, tanggal scan pertama–terakhir, dan statusnya:

- **"PIN belum dipetakan"** (7 PIN saat ini), dengan tombol **Petakan PIN** ke asisten pemetaan ADMS
  yang sudah ada (`attendance.devices.operate`);
- **"Scan sebelum pemetaan berlaku"**, berisi nama pegawai yang kini memegang PIN itu, TMT-nya, dan
  tanggal pemetaan berlaku (mis. 19 Okt 11.38), dengan tombol **Sesuaikan dengan TMT** (§20.5).

Bagian B hanya tampil untuk pemegang `attendance.devices.read`, karena PIN adalah data mesin.

### 20.4 Laporan sebagai popup (D-14-18)

| Pilihan | Kelebihan | Kekurangan |
|---|---|---|
| **Jendela baru** (`window.open` ke route cetak `/admin/attendance/reports/print` yang sudah ada) | Dokumen berhalaman sungguhan: zoom, cari, simpan PDF, dan cetak memakai peramban. Tidak diblokir karena dipicu klik. Kop, nomor halaman, dan judul kolom berulang sudah teruji (§19.11). Halaman Laporan tetap utuh di belakangnya. | Penunjuk "Halaman 1/76" hanya terlihat di pratinjau cetak, bukan di layar. |
| **Modal di halaman** | Tidak berpindah jendela. | Tidak bisa menampilkan halaman cetak sungguhan. Isi modal tetap satu halaman web panjang, persis keluhan owner sebelumnya. |

**Usulan: jendela baru**, berukuran sekitar 1100×800 dan diberi nama per model sehingga klik ulang
memakai jendela yang sama. Di atas lembar ada bilah alat layar: Cetak, Simpan PDF (dialog cetak), Excel,
CSV, dan Tutup. Penunjuk halaman di layar memerlukan pustaka paged media; itu tidak termasuk usulan ini.

### 20.5 Pemetaan PIN berlaku sejak tanggal mulai aktif pegawai (D-14-20, direvisi menurut arahan owner 2026-10-26)

**Arahan owner (2026-10-26, menunggu persetujuan rencana):** pemetaan PIN adalah urusan pengelolaan kehadiran, sedangkan scan di mesin tetap ada.
Selama PIN cocok, semua scan PIN itu di mesin itu milik pegawai tersebut. Batasnya adalah **tanggal mulai
aktif pegawai (TMT, `employees.started_on`)**, bukan tanggal pemetaan dibuat. Ini menggantikan usulan
lama (mundur maksimal 62 hari dan alasan per kasus).

**Aturan baru:**

1. Pemetaan berlaku untuk semua scan PIN itu di mesin itu **sejak TMT pegawai pukul 00.00 WIB**. Bila
   pegawai sudah keluar, pemetaan berakhir di **akhir tanggal berhenti** (`ended_on` + 1 hari, 00.00 WIB).
2. Pemetaan baru **otomatis** memakai TMT sebagai awal berlaku. Field "awal berlaku" di asisten pemetaan
   tidak lagi diisi bebas dan bawaannya tidak lagi `now()`. Pegawai tanpa TMT tidak bisa dipetakan; layar
   meminta TMT diisi lebih dulu di data pegawai. Saat ini ke-46 pegawai berpemetaan aktif sudah punya TMT.
3. **Pengaman PIN didaur ulang tetap wajib.** Bila PIN yang sama di mesin yang sama pernah dipetakan ke
   pegawai lain, periode pemetaan lama yang menang. Pemetaan baru berlaku mulai yang lebih akhir antara
   TMT dan akhir pemetaan lama. Tumpang tindih ditolak oleh server, tidak sekadar diperingatkan.
4. **Mengubah TMT** pegawai menggeser awal pemetaannya hanya lewat aksi yang sama: tombol **"Sesuaikan
   dengan TMT"**, dengan pratinjau jumlah scan terdampak. Tidak ada pergeseran diam-diam saat data pegawai
   diubah.
5. Setiap pembuatan dan penyesuaian pemetaan tercatat di audit ADMS yang ada (`mapping_created`,
   `mapping_aligned_to_start_date`) dengan keadaan sebelum dan sesudah.

**Koreksi satu kali untuk 43 pemetaan tanggal 19 Okt** (perubahan data production, butuh persetujuan
owner terpisah):

- Lewat jalur aplikasi yang diaudit: aksi "Sesuaikan dengan TMT" dalam jumlah banyak di tab Tanpa Jadwal
  bagian B, atau skrip operator yang memanggil logika yang sama. Tidak ada `UPDATE` SQL manual.
- **Dry-run lebih dulu**, berupa daftar per pemetaan: pegawai (id), mesin, PIN, awal berlaku sekarang →
  TMT, dan jumlah scan yang ikut tercakup. Angka read-only production 2026-10-26: **2.599 scan tambahan**,
  di atas 560 yang sudah tercakup. Tidak ada scan sebelum TMT, dan **0 PIN** pernah dipegang dua pegawai.
- **Pemulihan:** audit menyimpan `effective_from` lama per pemetaan. Rollback mengembalikan nilai itu
  lewat aksi yang sama. Hasil kehadiran yang sudah dihitung tidak berubah sampai Kalkulasi dijalankan lagi.
  Versi hasil lama tetap tersimpan sebagai riwayat.
- Sebelum koreksi, ambil backup database pra-perubahan seperti pola rilis OPS-MI8-REL-001.

**Mencocokkan PIN saja belum menghasilkan kehadiran.** Setelah scan September–Oktober menjadi milik
pegawai, hari-hari itu baru dinilai bila pegawai punya **jadwal** pada tanggal tersebut (I-4: jadwal tidak
pernah disintesis). Pola jadwal SDIT saat ini baru berlaku **24 Okt 2026**. Agar 1 Sep–23 Okt bisa
dihitung, HC juga perlu **memundurkan tanggal mulai pola jadwal**, misalnya ke 1 Sep 2026 bila jadwal itu
memang berlaku sejak saat itu. Tanpa itu, hari-hari tersebut tampil di tab Tanpa Jadwal, bukan sebagai
hadir atau tidak hadir.

### 20.6 Scan pada hari tanpa jadwal (D-14-21)

**Usulan: engine tidak diubah.** Fakta "ada scan tanpa jadwal" dibaca langsung dari scan mentah lewat
pemetaan, oleh tab Tanpa Jadwal dan Data Transaksi. Kalkulasi tetap tidak menyalin atau memvonis hari
tanpa jadwal, sesuai invariant bahwa jadwal tidak pernah disintesis.

Alternatifnya adalah menyalin scan ke `attendance_events` untuk semua hari ber-pemetaan. Itu menambah
penulisan tanpa manfaat bagi layar, karena layar sudah bisa membaca scan mentah. Yang tetap diperbaiki
adalah label: hari tanpa pola jadwal tampil **"Tanpa jadwal"**, bukan "Libur" (§20.1 butir 3).

### 20.7 Keputusan owner untuk R2

| # | Pertanyaan | Usulan |
|---|---|---|
| D-14-17 | Bentuk halaman Laporan mengikuti §20.2 (satu bar kontrol, enam tab, Kalkulasi dengan popup progres), dan bagian "Format lama" dihapus seluruhnya. | Ya. Popup progres tanpa nama pegawai dulu; nama pegawai bisa ditambah kemudian dengan migration kecil. |
| D-14-18 | Laporan terbuka di jendela baru ke route cetak, atau modal di halaman. | **Jendela baru** (§20.4). |
| D-14-19 | Tab "Tanpa Jadwal" dengan dua bagian (§20.3) dan tombol Pasang jadwal / Petakan PIN. | Ya. |
| D-14-20 | Pemetaan PIN berlaku sejak TMT pegawai (sampai tanggal berhenti), pemetaan baru otomatis memakai TMT, PIN didaur ulang tidak boleh tumpang tindih. | Ya, sesuai arahan owner 2026-10-26 (§20.5); menunggu persetujuan rencana. Koreksi satu kali 43 pemetaan 19 Okt butuh persetujuan owner terpisah setelah dry-run. |
| D-14-21 | Scan pada hari tanpa jadwal tetap tidak disalin engine dan cukup dibaca dari scan mentah; label "Libur" untuk hari tanpa pola diganti "Tanpa jadwal". | Ya. |
| D-14-22 | Jam shift setengah hari SDIT Tahfizh untuk jabatan "Guru Tahfizh (Half Day)" dan "(Half Day) II" (21 pegawai). | **Ditetapkan owner 2026-10-26:** "Guru Tahfizh (Half Day)" **07.00–12.00**, "Guru Tahfizh (Half Day) II" **07.00–12.30** (jam masuk sama dengan hari penuh). **Toleransi terlambat dan pulang cepat belum disebut owner**: nilai bawaan diusulkan sama dengan "SDIT — Hari Penuh" (terlambat 1 menit, pulang cepat 0 menit), **menunggu konfirmasi**. Setelah dikonfirmasi, HC membuat dua shift itu lalu memakai "Pasang ke shift yang ada". |

### 20.8 Paket setelah disetujui

| Urutan | Paket | Isi | Migration |
|---|---|---|---|
| 1 | **ATT-014-R2a** Kenapa kosong | Status "Tanpa jadwal" vs "Libur" di Detail Harian/laporan; tab **Tanpa Jadwal** bagian A (dikelompokkan per jabatan, dengan Pasang ke shift yang ada / Buat shift baru / Pasang jadwal) dan B (Petakan PIN). | Tidak. |
| 2 | **ATT-014-R2b** Satu jendela | Bar kontrol tunggal, enam tab, popup progres Kalkulasi, menu Laporan → jendela baru, hapus "Format lama". Tab Pengecualian dan Lembur read-only. | Tidak. |
| 3 | **ADMS-R2c** Pemetaan sejak TMT | Pemetaan baru otomatis sejak TMT (dan berakhir di tanggal berhenti), penolakan tumpang tindih PIN didaur ulang di server, aksi "Sesuaikan dengan TMT" (satuan dan banyak) dengan dry-run jumlah scan terdampak, audit `mapping_aligned_to_start_date`, tawaran Kalkulasi. Koreksi 43 pemetaan dijalankan terpisah dengan persetujuan owner. | Tidak. |
| 4 | **ATT-014-R2d** Model tambahan | Per Unit, Data Scan, Jadwal Harian, Data Transaksi, Lembur Harian, Dari tampilan aktif. | Tidak. |

R2a disarankan lebih dulu karena langsung menjawab "kenapa kosong", dan bisa dirilis sendiri. Setiap paket
satu PR, dirilis lewat OPS-MI8-REL-001 dengan persetujuan owner.

**Langkah operasional yang tidak butuh kode** dan bisa dilakukan HC sekarang:

- konfirmasi toleransi, lalu buat shift "Guru Tahfizh (Half Day)" 07.00–12.00 dan "Guru Tahfizh (Half Day)
  II" 07.00–12.30, dan pasang pola jadwal untuk 28 pegawai SDIT Tahfizh yang belum punya (21 di antaranya
  Guru Tahfizh half day);
- **mundurkan tanggal mulai pola jadwal SDIT** dari 24 Okt ke tanggal jadwal itu memang mulai berlaku
  (mis. 1 Sep 2026), karena tanpa jadwal hari-hari September–Oktober tidak dinilai;
- petakan 7 PIN yang belum dipetakan;
- koreksi 43 pemetaan 19 Okt ke TMT menunggu paket ADMS-R2c, dry-run, dan persetujuan owner (§20.5).

Setelah itu, jalankan Kalkulasi lagi untuk rentang yang diperlukan.
