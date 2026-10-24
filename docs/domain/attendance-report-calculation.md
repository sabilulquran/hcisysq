# ATT-014 — Laporan & Kalkulasi Kehadiran

**Status:** DRAFT — menunggu penerimaan owner atas §15. ATT-014-1 diimplementasikan 2026-10-24 (§17).
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
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 80),
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
| D-14-1 | Kalkulasi memakai permission baru `attendance.calculation.run` untuk HC Admin dan HC Operator, terpisah dari izin membaca laporan? | Ya. Kalkulasi menulis data dan memakai sumber daya server. |
| D-14-2 | Satu kali Kalkulasi maksimal 93 hari (batas sekali tekan, bukan batas data)? | Ya; sama dengan batas laporan sekarang. Setahun = empat kali Kalkulasi. |
| D-14-3 | Tanggal sebelum pegawai terhubung ke mesin (dan tanpa absen HP) tidak dihitung dan tampil "Tidak tercatat", bukan "Tidak hadir"? | Ya; ini aturan yang dibahas 2026-10-24. |
| D-14-4 | Hari ini boleh dikalkulasi sebagai hasil sementara? | Ya, dengan tanda "Hari berjalan". |
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
