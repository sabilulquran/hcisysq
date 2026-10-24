# ATT-013 — Blok Kerja Ganda dalam Satu Hari

**Status:** DRAFT — menunggu penerimaan owner atas §9.
**Specification:** ATT-013
**Drafted:** 2026-10-24
**Keputusan owner pemicu:** 2026-10-24, pilihan "HCIS menyesuaikan" atas konflik Blok Kerja ganda
(`attendance-schedule-intake-feasibility.md` §2). Keputusan ini **membatalkan non-goal**
"multi-shift per pegawai per hari" di ATT-011 §1.
**Terkait:** ATT-003 (versi shift), ATT-007 (engine), ATT-008 (tukar shift), ATT-010 (konvergensi),
ATT-011 (penyederhanaan operasional), ATT-011-2 (hitung ulang otomatis), PAY-003 (di luar scope)

## 1. Masalah

Draf SK Jadwal Kerja YSQ menyusun jadwal di atas **Blok Kerja**. DRAF 01 diktum KEDUA menetapkan:

> Pegawai wajib melakukan presensi masuk pada awal dan presensi pulang pada akhir setiap Blok
> Kerja. Istirahat di dalam Blok Kerja tidak memerlukan presensi ulang dan tidak dihitung sebagai
> Jam Kerja, kecuali pegawai tetap ditugaskan. Libur atau Jeda Antarblok Kerja menutup Blok Kerja
> sehingga pekerjaan berikutnya memerlukan pasangan presensi baru. Keterlambatan dan pulang
> sebelum waktunya dihitung berdasarkan jadwal Blok Kerja yang berlaku.

Empat kelompok memakai dua Blok Kerja dalam satu hari:

| Kelompok | Blok | Pegawai (perkiraan) |
|---|---|---|
| Pesantren — Guru Tahfizh | 04.00–08.30 dan 14.30–19.30 | 5 |
| Pesantren — Wakil Kepala Tahfizh | bervariasi per hari, 2 blok | 1 |
| Pesantren — Mudir | 03.30–05.00 dan 15.00–21.00/22.00 | 1 |
| SDIT — Guru Tahfizh Putra | Rabu: 07.00–12.30 dan 16.00–17.00 | sebagian dari 26 |

HCIS hari ini tidak dapat menyatakannya. Batasan satu-shift-per-hari ada di **tiga** tempat,
bukan satu:

1. `resolveSchedule` (`apps/api/src/modules/attendance/engine.ts`) mengambil assignment dengan
   `LIMIT 2`; bila lebih dari satu cocok untuk satu tanggal → `configuration_error`
   (`ambiguous_default_assignment`), tampil "Jadwal bermasalah".
2. `attendance_roster_entries` memakai `PRIMARY KEY (roster_id, employee_id, work_date)` — satu
   entry per pegawai per tanggal, sehingga penggantian jadwal per tanggal juga hanya satu shift.
3. `attendance_result_versions` menyimpan satu pasang `scheduled_start_at` / `scheduled_end_at`
   dan `UNIQUE (employee_id, work_date, version)` — satu hasil per hari.

## 2. Tujuan dan batas

Tujuan: HCIS dapat menyatakan satu hari kerja yang terdiri atas **satu atau lebih Blok Kerja**,
menilai keterlambatan dan pulang cepat **per blok** sesuai SK, dan menampilkannya kepada operator
tanpa istilah teknis.

Invariant ATT-011 §1 yang **tetap berlaku tanpa perubahan**:

| Invariant | Konsekuensi di ATT-013 |
|---|---|
| I-1 effective dating + versioning | Blok adalah bagian dari versi shift; mengubah blok menghasilkan versi baru, tidak menulis ulang versi berjalan. |
| I-2 bukti mentah immutable | Tidak ada scan yang dibuat, diubah, atau dihapus. Pembagian scan ke blok hanya penafsiran saat menghitung. |
| I-3 missing punch tetap `incomplete` | Blok tanpa scan pulang tetap "Tidak lengkap"; jam blok tidak pernah dipakai sebagai jam pulang. |
| I-4 jadwal adalah ekspektasi | Blok yang tidak dihadiri tidak pernah diisi otomatis. |
| I-5 cuti hanya setelah keputusan final | Cuti berlaku untuk seluruh hari, bukan per blok (§6.4). |
| I-6 ambiguitas gagal tertutup | Blok yang saling tumpang tindih ditolak saat simpan; assignment ganda tetap `configuration_error`. |
| I-7 lembur hanya dari keputusan eksplisit | Scan di Jeda Antarblok adalah fakta, bukan lembur dan bukan jam kerja. |
| I-8 tidak ada kalkulasi payroll | Hasil per blok adalah input masa depan PAY-003. |

**Non-goal ATT-013:** jam istirahat terjadwal di dalam blok (SK menyatakan istirahat tidak perlu
presensi, jadi HCIS tidak perlu menyimpannya); blok yang berbeda antar pegawai dalam satu shift;
blok yang dibuat otomatis dari pola scan.

## 3. Yang dilihat operator

Kamus istilah ATT-011 §3 bertambah satu baris:

| Backend | Label operator |
|---|---|
| schedule version block | **Blok Kerja** |
| gap antar blok | **Jeda Antarblok** |

**Layar Shift.** Form shift mendapat daftar Blok Kerja. Shift satu blok tampil persis seperti
sekarang (satu baris jam masuk dan jam pulang); tombol "Tambah Blok Kerja" muncul di bawahnya.
Contoh tampilan daftar: `Guru Tahfizh Pesantren | 04.00–08.30, 14.30–19.30 | 2 blok | 37 jam/minggu`.

**Layar Kehadiran harian.** Kolom Masuk dan Pulang tetap ada dan berisi scan **pertama** dan scan
**terakhir** hari itu, sehingga tabel tidak melebar. Baris dengan lebih dari satu blok mendapat
teks kecil per blok, misalnya `Blok 1 04.02–08.28 · Blok 2 14.35–19.31`. Blok yang tidak dihadiri
ditulis `Blok 2 tidak hadir`.

**Panel detail satu hari** (ATT-011-3) menampilkan tiap blok sebagai bagian tersendiri dengan jam
jadwal, scan, dan label pengecualiannya.

## 4. Model data

### 4.1 Tabel baru `attendance_schedule_version_blocks`

Blok melekat pada **versi shift**, bukan pada assignment. Alasannya: dalam draf SK, dua blok adalah
sifat pekerjaan itu sendiri, bukan dua penugasan terpisah; dan batasan satu-entry-per-hari pada
`attendance_roster_entries` (§1 butir 2) membuat pendekatan "dua assignment" juga memaksa perubahan
model roster.

```sql
CREATE TABLE attendance_schedule_version_blocks (
  id uuid PRIMARY KEY,
  schedule_version_id uuid NOT NULL
    REFERENCES attendance_schedule_versions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  start_time time NOT NULL,
  end_time time NOT NULL,
  end_day_offset integer NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0, 1)),
  UNIQUE (schedule_version_id, sequence)
);
CREATE INDEX attendance_schedule_version_blocks_version_idx
  ON attendance_schedule_version_blocks (schedule_version_id, sequence);
```

Batas 3 blok disengaja: draf SK hanya memerlukan 2, dan batas keras menahan jadwal yang tidak
dapat dibaca operator. Menaikkannya kelak hanya mengubah satu `CHECK`.

Aturan yang ditegakkan di server saat menyimpan versi shift:

- blok diurutkan menaik menurut waktu mulai absolut (setelah `end_day_offset` diperhitungkan);
- blok tidak boleh saling tumpang tindih, dan Jeda Antarblok minimal **30 menit** — jeda lebih
  pendek berarti itu istirahat di dalam satu blok, bukan dua blok (sejalan dengan SK);
- total durasi seluruh blok dalam satu hari ≤ 20 jam.

Pelanggaran → `400 INVALID_SCHEDULE_BLOCKS` dengan pesan yang menyebut blok ke berapa.

**Toleransi tetap di tingkat versi, bukan per blok.** `late_grace_minutes` dan
`early_leave_tolerance_minutes` berlaku sama untuk semua blok shift itu. Draf SK tidak
membedakannya per blok, dan membuatnya per blok menambah kolom yang belum ada yang meminta.

### 4.2 Kolom lama pada `attendance_schedule_versions`

`start_time`, `end_time`, dan `end_day_offset` **dipertahankan** dan diisi dari blok pertama dan
blok terakhir (mulai paling awal, selesai paling akhir). Alasannya: kolom itu dibaca oleh resolver
roster, laporan jadwal, layar Assignment/Roster lama, dan ATT-008; mengubahnya sekaligus akan
membuat perubahan ini menyentuh terlalu banyak tempat dalam satu PR. Kolom tersebut menjadi
**turunan**, dan server yang menghitungnya — bukan pemanggil.

### 4.3 Backfill

Setiap `attendance_schedule_versions` yang ada mendapat tepat satu blok `sequence = 1` yang
menyalin `start_time`, `end_time`, dan `end_day_offset`-nya. Backfill ini deterministik dan tidak
mengubah hasil perhitungan apa pun: shift satu blok sebelum dan sesudah migration menghasilkan
jadwal yang identik.

### 4.4 Tabel baru `attendance_result_blocks`

Hasil per blok disimpan sebagai anak dari versi hasil, mengikuti pola
`attendance_result_sessions` yang sudah ada.

```sql
CREATE TABLE attendance_result_blocks (
  id uuid PRIMARY KEY,
  attendance_result_version_id uuid NOT NULL
    REFERENCES attendance_result_versions(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  first_check_in_at timestamptz NULL,
  last_check_out_at timestamptz NULL,
  status text NOT NULL CHECK (
    status IN ('scheduled', 'pending', 'present', 'late', 'incomplete', 'absent')
  ),
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_leave_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  incomplete_session boolean NOT NULL DEFAULT false,
  UNIQUE (attendance_result_version_id, sequence)
);
CREATE INDEX attendance_result_blocks_employee_date_idx
  ON attendance_result_blocks (employee_id, work_date);
```

`attendance_result_sessions` mendapat kolom nullable `block_sequence` agar tiap sesi scan dapat
ditelusuri ke bloknya. `NULL` berarti sesi di luar seluruh jendela blok (lihat §5.2).

`attendance_result_versions` **tidak berubah strukturnya**. `scheduled_start_at` diisi dari blok
pertama, `scheduled_end_at` dari blok terakhir, `first_check_in_at` dan `last_check_out_at` dari
scan pertama dan terakhir hari itu. Dengan begitu seluruh pembaca lama tetap benar.

## 5. Perilaku engine

### 5.1 Resolver

`ResolvedSchedule` mendapat `blocks: ResolvedBlock[]` dengan `scheduledStartAt` dan
`scheduledEndAt` absolut per blok. Field `scheduledStartAt`/`scheduledEndAt` di tingkat hari
dipertahankan sebagai turunan blok pertama dan terakhir.

Shift satu blok menghasilkan `blocks` berisi satu elemen, sehingga seluruh jalur kode lama tetap
melewati bentuk data yang sama. Pemeriksaan `LIMIT 2` → `configuration_error` untuk **assignment**
ganda **tetap ada**: dua assignment pada satu tanggal tetap ambigu dan harus gagal tertutup (I-6).
Yang berubah hanya: satu assignment kini boleh membawa lebih dari satu blok.

### 5.2 Membagi scan ke blok

Masalah: jendela event sekarang adalah ±6 jam di sekitar jadwal. Untuk hari 04.00–19.30 jendela itu
menjadi 22.00 H-1 sampai 01.30 H+1 dan berisiko menarik scan milik hari lain.

Aturan baru, deterministik dan tanpa konfigurasi tambahan:

1. Jendela pemuatan event = 6 jam sebelum blok pertama sampai 6 jam sesudah blok terakhir
   (tidak berubah), tetapi pembagiannya dilakukan per blok.
2. Batas antara dua blok berurutan = **titik tengah Jeda Antarblok**.
3. Sebuah sesi kerja (hasil `buildSessions`) masuk ke blok yang jendelanya memuat **jam check-in**
   sesi itu.
4. Sesi yang jatuh sebelum batas bawah blok pertama atau sesudah batas atas blok terakhir
   disimpan dengan `block_sequence = NULL`: ditampilkan sebagai fakta scan, tidak menambah jam
   kerja blok mana pun, dan tidak menjadi lembur (I-7).

Contoh: blok 04.00–08.30 dan 14.30–19.30. Jeda Antarblok 08.30–14.30, titik tengahnya 11.30. Scan
masuk pukul 04.02 → blok 1. Scan masuk pukul 14.35 → blok 2. Scan pukul 10.00 → blok 1 (sebelum
11.30), muncul sebagai pulang jauh setelah jadwal blok 1, bukan sebagai blok baru.

### 5.3 Penilaian per blok

Aturan ATT-007 diterapkan apa adanya **pada tiap blok**, memakai toleransi dari versi shift:

- `late_minutes` blok = selisih scan masuk pertama blok itu terhadap jam mulai blok + toleransi.
- `early_leave_minutes` blok = selisih scan pulang terakhir blok itu terhadap jam selesai blok
  − toleransi pulang cepat.
- `incomplete_session` blok = ada sesi tanpa pasangan pulang di blok itu (I-3).
- Blok tanpa scan sama sekali: `scheduled` bila sekarang sebelum jam mulai blok, `pending` bila
  masih di dalam blok, `absent` bila blok sudah lewat.

`worked_minutes` hari = jumlah seluruh blok. `break_minutes` hari = jeda **di dalam** blok saja;
Jeda Antarblok **tidak** dihitung sebagai istirahat maupun jam kerja, sesuai SK.

### 5.4 Status hari

Status hari diturunkan dari status blok dengan urutan tetap, dievaluasi dari atas:

| Urutan | Kondisi | Status hari |
|---|---|---|
| 1 | Jadwal `configuration_error` | `configuration_error` |
| 2 | Hari libur / tidak terjadwal | `off` |
| 3 | Disposisi cuti final `leave` | `leave` |
| 4 | Disposisi cuti final `absent` | `absent` |
| 5 | **Tidak ada satu pun scan** di seluruh blok, dan seluruh blok sudah lewat | `absent` |
| 6 | Ada blok `incomplete`, **atau** ada blok `absent` sementara blok lain dihadiri | `incomplete` |
| 7 | Seluruh blok yang sudah lewat dihadiri, dan ada blok yang terlambat | `late` |
| 8 | Seluruh blok yang sudah lewat dihadiri tepat waktu, masih ada blok yang belum mulai | `pending` |
| 9 | Seluruh blok dihadiri lengkap | `present` |

Baris 6 adalah keputusan yang perlu diperhatikan: **pegawai yang menghadiri blok pagi lalu tidak
hadir sama sekali di blok sore berstatus "Tidak lengkap", bukan "Tidak hadir"**. Alasannya ia
memang bekerja hari itu, dan status `absent` akan salah untuk penggajian kelak. Perbedaannya
dijelaskan oleh **label**, bukan status: baris itu menampilkan `Blok 2 tidak hadir`, sejalan dengan
pola label pengecualian ATT-011 §6.3. Alternatif yang **tidak** diambil: menambah status baru
`partial`, karena status baru menyentuh read model, laporan, filter, dan PAY-003 sekaligus.
Bila UAT menunjukkan HC bingung, penambahan status dibahas tersendiri.

**Tidak ada nilai enum status baru di ATT-013.**

## 6. Interaksi dengan bagian lain

### 6.1 Hitung ulang otomatis (ATT-011-2)

Tidak ada pemicu baru. `input_hash` di `materializeAttendanceResult` sudah memuat seluruh jadwal
ter-resolve; begitu `blocks` masuk ke objek itu, perubahan blok otomatis menghasilkan versi hasil
baru. Bila ATT-011-2 dirilis lebih dulu, pemicu "versi shift berubah" sudah mencakup perubahan blok.

### 6.2 Tukar shift (ATT-008)

Tukar shift menukar `schedule_version_id` pada entry roster, jadi ia ikut menukar seluruh blok
sebagai satu kesatuan. Tidak ada perubahan perilaku, tetapi test regresi ATT-008 wajib lulus
dengan shift dua blok.

### 6.3 Perubahan Jadwal (ATT-011-4)

Change set bekerja pada assignment dan entry roster, yang tetap satu per pegawai per tanggal.
Tidak ada perubahan model di sana. Layar "Lihat dampak" perlu menampilkan jumlah blok shift
pengganti agar operator tahu yang ia terapkan.

### 6.4 Cuti dan lembur

Cuti berlaku **per hari**, bukan per blok: tidak ada "cuti setengah hari" di HCIS hari ini, dan
ATT-013 tidak memperkenalkannya. Lembur tetap keputusan eksplisit per hari (I-7); menit lembur
tidak dipecah per blok pada paket ini.

### 6.5 Payroll (PAY-003)

Hasil per blok adalah data yang lebih kaya daripada sebelumnya, dan `attendance_result_blocks`
dirancang agar dapat dibaca langsung. Tidak ada perhitungan payroll di ATT-013.

## 7. Paket implementasi

| Paket | Isi | Migration | Test minimum |
|---|---|---|---|
| **ATT-013-1** Model dan engine | Tabel blok shift dan blok hasil, backfill, validasi simpan, resolver `blocks`, pembagian scan, penilaian per blok, status hari §5.4, `block_sequence` pada sesi. API shift menerima `blocks[]`; daily read menambah `blocks[]`. OpenAPI. | Aditif: 2 tabel baru, 1 kolom nullable, backfill 1 blok per versi. Rollback: rilis lama mengabaikan tabel baru dan tetap membaca `start_time`/`end_time` versi, sehingga shift satu blok tetap benar; shift dua blok akan dinilai rilis lama sebagai satu rentang panjang — **risiko perilaku yang harus diberitahukan sebelum rollback**. | Shift 1 blok sebelum/sesudah migration menghasilkan hasil identik (property test); blok tumpang tindih → 400; jeda < 30 menit → 400; > 3 blok → 400; scan dibagi ke blok yang benar termasuk pada titik tengah jeda; terlambat dihitung per blok; blok 1 hadir blok 2 kosong → `incomplete` + label; missing punch di blok 2 → `incomplete` (I-3); jam blok tidak pernah menjadi jam scan (I-4); scan di Jeda Antarblok tidak menambah jam kerja; Jeda Antarblok bukan `break_minutes`; dua assignment tetap `configuration_error`; bukti tidak berubah (I-2); idempotensi hash; regresi ATT-007 dan ATT-008 lulus. |
| **ATT-013-2** UI | Form Shift dengan daftar Blok Kerja, daftar shift menampilkan jumlah blok, Kehadiran harian menampilkan rincian per blok, panel detail per blok. | Tidak ada. | Shift 2 blok dapat dibuat dan diubah; validasi tampil per blok; tabel tidak melebar di mobile; empty/forbidden state; label memakai kamus §3. |

Urutan: ATT-013-1 lebih dulu dan dapat dirilis sendiri; sampai ATT-013-2 ada, shift dua blok dibuat
lewat API dan belum lewat layar.

Review tambahan (AGENTS.md §8): **ya** untuk ATT-013-1 — migration dan perubahan engine.

## 8. Kegagalan, empty, forbidden

| Kondisi | Perilaku |
|---|---|
| Blok tumpang tindih / jeda < 30 menit / > 3 blok / total > 20 jam | `400 INVALID_SCHEDULE_BLOCKS`, pesan menyebut nomor blok. |
| Shift dua blok dipakai pada tanggal yang juga punya assignment lain | Tetap `configuration_error` (I-6). |
| Pegawai scan hanya di Jeda Antarblok | Hari tampil `absent` bila tidak ada blok yang dihadiri; scan tetap terlihat sebagai fakta. |
| Rilis lama membaca shift dua blok | Dinilai sebagai satu rentang panjang; dicatat di release note. |
| Tanpa permission `attendance.schedule.manage` | 403; layar Shift tidak menampilkan tombol blok. |

Audit: `attendance.schedule.created` dan `attendance.schedule.updated` menambahkan jumlah blok pada
metadata. Tidak ada event audit baru.

## 9. Yang masih perlu keputusan owner

| # | Pertanyaan | Usulan |
|---|---|---|
| D-13-1 | Blok pagi hadir, blok sore tidak hadir sama sekali → "Tidak lengkap" dengan label "Blok 2 tidak hadir", atau status baru "Hadir sebagian"? | "Tidak lengkap" + label (§5.4). Status baru menyentuh laporan dan PAY-003 sekaligus. |
| D-13-2 | Jeda Antarblok minimal 30 menit sebagai pembeda "dua blok" dari "istirahat panjang". | Terima 30 menit. Draf SK tidak menyebut angka; yang terpendek di draf adalah 3,5 jam, jadi angka ini hanya pagar. |
| D-13-3 | Batas 3 blok per hari. | Terima. Draf hanya butuh 2. |
| D-13-4 | Toleransi telat berlaku sama untuk semua blok, bukan per blok. | Terima. |
| D-13-5 | Scan di Jeda Antarblok tidak dihitung sebagai jam kerja dan tidak otomatis menjadi lembur. | Terima; sejalan dengan I-7 dan diktum KEDUA SK. |

Butir di atas tidak memblokir penulisan kode ATT-013-1 kecuali **D-13-1**, yang menentukan status
yang dilihat HC dan ikut menentukan test.

## 10. Acceptance

- ATT-013-A: HC membuat shift dengan dua Blok Kerja dan melihat keduanya di daftar shift.
- ATT-013-B: pegawai dua blok yang scan empat kali tampil Hadir dengan rincian per blok, bukan
  "Jadwal bermasalah".
- ATT-013-C: terlambat di blok sore saja menghasilkan status Terlambat dengan label pada blok itu.
- ATT-013-D: hadir blok pagi dan tidak hadir blok sore menghasilkan Tidak lengkap dengan label
  "Blok 2 tidak hadir" (bergantung D-13-1).
- ATT-013-E: missing punch di salah satu blok tetap Tidak lengkap; jam jadwal tidak pernah menjadi
  jam scan.
- ATT-013-F: shift satu blok yang sudah ada menghasilkan hasil yang sama persis seperti sebelum
  ATT-013 dirilis.
- ATT-013-G: scan pada Jeda Antarblok terlihat sebagai fakta tanpa menambah jam kerja.
- ATT-013-H: typecheck, lint, test, build, dan clean migration lulus; data sintetis saja.
