# ATT-011 — Gap Analysis: Operasional Kehadiran Hari Ini vs Target

**Status:** DISCOVERY EVIDENCE — repository inventory 2026-10-16  
**Specification:** ATT-011  
**Baseline commit:** `c2746a3` (`origin/main`, 2026-10-16)  
**Related:** `attendance-operational-simplification.md` (direction), `attendance-operational-simplification-spec.md` (spec), ATT-003, ATT-007, ATT-008, ATT-009, ATT-010, LEAVE-007

Dokumen ini mencatat apa yang **benar-benar** ada di repository dan apa yang harus dikerjakan Human Capital (HC) hari ini, dibandingkan alur target:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

Inventory dibuat dari kode (`apps/web/src/pages/*Attendance*`, `apps/api/src/modules/attendance/**`, migration `0046`-`0048`), bukan dari dokumen saja. Ini bukan bukti perilaku production; production Mi8VPS tidak diperiksa.

## 1. Navigasi dan istilah yang dilihat HC hari ini

Sidebar admin grup **Kehadiran** (`apps/web/src/layouts/AdminShell.tsx`):

| Menu | Route | Isi |
|---|---|---|
| Rekaman Kehadiran | `/admin/attendance` | judul halaman "Koreksi Kehadiran"; koreksi manual satu pegawai satu tanggal |
| Operasional Kehadiran | `/admin/attendance/workforce` | 10 tab (lihat bawah) |
| Persetujuan Tukar Shift | `/admin/attendance/workforce/shift-swaps` | duplikat tab Tukar Shift |

Grup terpisah **Perangkat ADMS** → Manajemen ADMS (ATT-012, di luar scope ATT-011).

Tab **Operasional Kehadiran**: Ringkasan, Lokasi, Jadwal, Assignment, Roster, Klarifikasi, Evidence Mobile, Lembur, Tukar Shift, Laporan.

Penyelesaian cuti yang belum tervalidasi (LEAVE-007) ada di aplikasi pegawai: `/app/hc/attendance-resolution`.

Istilah teknis yang masih tampil ke operator: "Template jadwal", "Assignment", "jadwal default", "Roster", "Ikuti default", "Buat draft", "Publish", "Evidence", "canonical", "materialized", "append-only", "result version"/"vN", "configuration error", "authoritative", enum mentah (status lembur, jenis klarifikasi), UUID versi jadwal/roster, "Requester/Counterpart".

## 2. Gap per langkah target

Legenda dampak: **K** = kritis (hasil salah/menyesatkan), **T** = tinggi (banyak langkah/kerja manual), **S** = sedang (bahasa/UX), **R** = rendah.

### 2.1 Shift

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| S-1 | Template jadwal: nama, jam mulai/selesai, overnight (`end_day_offset`), grace terlambat, toleransi pulang cepat, lokasi, aktif. Setiap perubahan semantik membuat `attendance_schedule_versions` baru. | Buat di tab "Jadwal" yang judulnya "Jadwal & Shift"; lokasi dibuat dulu di tab lain. | Menu **Shift** tersendiri dengan bahasa "Shift". | S |
| S-2 | Perubahan template berlaku **sejak detik disimpan** (`clock_timestamp()`); tanggal efektif tidak bisa dipilih. | Harus menunggu hari H untuk mengubah jam shift, atau perubahan langsung mengenai hari ini. | Pilih "berlaku mulai tanggal" (hari ini/masa depan). | T |
| S-3 | Menonaktifkan template membuat assignment pegawai tersebut diam-diam menjadi **Libur** (`engine.ts` resolver), bukan error. | Tidak ada peringatan; pegawai tiba-tiba "off". | Nonaktifkan shift yang masih dipakai harus ditolak/diperingatkan dengan daftar pegawai terdampak. | K |
| S-4 | Tidak ada field istirahat; istirahat = jeda antar sesi scan. | — | Tetap (tidak diubah ATT-011); dicatat sebagai keputusan owner bila perlu. | R |
| S-5 | Tidak ada delete; hanya nonaktif. | — | Tetap (benar secara audit). | — |

### 2.2 Jadwal

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| J-1 | Default assignment: **satu pegawai per submit** (pegawai, template, hari, dari/sampai). Picker = dropdown seluruh pegawai aktif, tanpa filter unit. | Menjadwalkan unit 40 guru = 40 kali isi form. | Bulk: pilih unit/beberapa pegawai + shift + rentang + pola hari, satu kali simpan. | T |
| J-2 | Assignment tidak bisa diedit; PATCH hanya `effective_to`. Tidak ada cek overlap saat simpan; overlap baru ketahuan sebagai `configuration_error` pada hari H. | Untuk mengganti pola: akhiri assignment lama, buat baru, satu per satu, dan berharap tidak tumpang tindih. | Sistem menghitung penggantian (split/akhiri) otomatis dan menampilkan preview; tumpang tindih ditolak sebelum berlaku. | K |
| J-3 | Roster mingguan **satu dokumen untuk seluruh organisasi per minggu** (`attendance_rosters(week_start, version)`). Grid menampilkan **semua pegawai aktif semua unit** tanpa filter/pencarian/paging. | Mengubah jadwal satu unit berarti membuka grid seluruh yayasan. | Planner per unit/kelompok; batas minggu tidak terlihat operator. | T |
| J-4 | UI menyimpan **per sel** (satu request per dropdown). API sebenarnya mendukung batch 1000 entry. | Ratusan klik + simpan untuk satu minggu. | Isi sel massal (seret/blok, isi baris, isi kolom). | T |
| J-5 | Alur roster: Buat draft → (Salin minggu lalu, hanya bila minggu lalu sudah **published**) → ubah sel → Publish, **per minggu**. Tidak ada multi-minggu/rentang. | Jadwal bergilir satu kuartal ≈ 13 × (3 aksi + sel yang diubah). | Rentang tanggal + pola; salin minggu/bulan sekali jalan. | T |
| J-6 | API mengizinkan beberapa draft untuk minggu yang sama; UI hanya melihat yang pertama. ATT-008 (tukar shift) **diblokir** bila ada draft minggu itu. | Draft yang terlupa memblokir persetujuan tukar shift. | Tidak ada draft yatim; konflik dijelaskan dengan bahasa manusia. | T |
| J-7 | Draft dibuat, sel diubah, salin minggu: **tidak diaudit**. Hanya publish yang diaudit (`attendance.roster.published`). | — | Setiap perubahan jadwal yang berlaku tercatat siapa/kapan/alasan. | S |
| J-8 | Publish roster dan perubahan assignment **tidak menghitung ulang** hasil yang sudah ada. | Harus menekan "Finalisasi tanggal" per tanggal. | Hitung ulang otomatis untuk tanggal terdampak (lihat K-1). | K |
| J-9 | Entry roster pada tanggal libur kalender **mengalahkan** libur (resolver: roster > holiday > assignment). | Isi roster massal bisa diam-diam membatalkan libur nasional. | Preview menandai tanggal libur; perilaku default = keputusan owner (D-2). | T |
| J-10 | Tidak ada konsep "penggantian jadwal tanggal tertentu" selain sel roster. | — | Aksi **Ganti jadwal** satu pegawai/tanggal atau rentang, dengan pesan "menggantikan Shift Pagi pada 15 Sep". | S |
| J-11 | Pegawai hanya melihat jadwal hari ini + 30 hari ke belakang; **tidak ada jadwal ke depan** di UI, padahal `GET /attendance/me/schedule?from&to` sudah mendukung rentang ≤ 31 hari ke depan (`EmployeeAttendancePage.tsx` hanya meminta 29 hari lalu s.d. hari ini). | HC harus mengabarkan jadwal di luar sistem. | "Jadwal saya" minggu ini & depan. | T |

### 2.3 Kehadiran

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| K-1 | Read model harian untuk pegawai tanpa result tersimpan **mengabaikan scan** (`reporting.ts` live branch): setelah jam pulang = `absent`. Scan ADMS **tidak** memicu perhitungan ulang. | Pegawai yang scan di mesin tampil "Tidak hadir" sampai HC menekan "Finalisasi tanggal" (satu tanggal per klik). | Hasil harian mengikuti bukti yang sudah masuk tanpa tombol manual. | K |
| K-2 | Keputusan cuti/izin dan Attendance Resolution **tidak memicu** perhitungan ulang. | Hasil "absent" lama tetap ada sampai finalisasi. | Hitung ulang otomatis setelah keputusan authoritative. | K |
| K-3 | Ringkasan: tabel satu tanggal, filter status + cari, refresh 30 detik; **tidak ada klik ke detail**. Laporan V2: 7 jenis, tanpa drill-down. | Untuk tahu "kenapa telat/tidak lengkap" harus membuka laporan Data Scan terpisah. | Klik baris → panel detail: scan + sumber, jadwal yang berlaku, sesi, cuti/izin, klarifikasi, riwayat perhitungan. | T |
| K-4 | Koreksi manual di menu terpisah "Rekaman Kehadiran" (satu pegawai/tanggal). Klarifikasi di tab lain. Evidence mobile di tab lain. Penyelesaian cuti di aplikasi pegawai. | Satu masalah kehadiran = 3-5 layar. | Satu workspace **Kehadiran** dengan antrean "Perlu tindakan" dan aksi dari panel detail. | T |
| K-5 | Tab Evidence Mobile: query filter memakai placeholder SQL yang salah (`= ${values.length}` tanpa `$`, `workforce-routes.ts` GET `/admin/attendance/mobile-evidence`), sehingga filter tanggal/status kemungkinan selalu error dan kartu "Evidence review" menampilkan 0. Belum ada test. | Evidence di luar geofence tidak terlihat. | **Bug terpisah dari ATT-011**; perbaiki sebagai patch kecil sebelum paket UI. | K |
| K-6 | Pulang cepat hanya menit, tidak mengubah status. | — | Tampil sebagai label pengecualian "Pulang cepat"; status tetap (D-6). | S |
| K-7 | Missing punch → `incomplete`; jam jadwal tidak disintesis. | — | **Dipertahankan** (invariant). | — |
| K-8 | Ringkasan dapat dibuka oleh 6 permission berbeda tetapi datanya butuh `attendance.reports.read`; laporan diam-diam gagal memuat daftar mesin tanpa `attendance.devices.read`. | Banner error membingungkan. | Menu/aksi hanya muncul bila data bisa dimuat; forbidden state jelas. | S |
| K-9 | Tabel lebar tetap 850-1160px, scroll horizontal, tanpa layout kartu mobile. | HC tidak nyaman memakai HP. | Daftar kartu di layar < 768px untuk Kehadiran dan Lembur. | S |
| K-10 | Klarifikasi pegawai hanya bisa diajukan dari UI untuk **hari kerja hari ini** (halaman clock), sementara API `POST /attendance/clarifications` **tidak membatasi tanggal sama sekali** (termasuk tanggal depan); riwayat klarifikasi tidak ditampilkan dan tidak bisa dibatalkan dari UI meski API mendukung. Tidak ada notifikasi keputusan klarifikasi. | HC menerima keluhan lewat chat. | Ajukan dari baris riwayat yang bermasalah (batas hari = D-7), lihat status, batalkan. | T |

### 2.4 Lembur

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| L-1 | Pengajuan eksplisit (`submitted → approved/rejected/cancelled`); pegawai atau HC dapat mengajukan; HC memutuskan; menit disetujui ≤ diajukan; notifikasi ke pegawai; result dihitung ulang. | Bekerja. | Dipertahankan. | — |
| L-2 | "Jam diakui" = menit disetujui dari **satu** pengajuan approved terbaru pada tanggal itu; beberapa pengajuan approved **tidak dijumlahkan**. | Pengajuan kedua menimpa yang pertama secara diam-diam. | Aturan eksplisit (D-5): jumlahkan atau tolak pengajuan kedua. | K |
| L-3 | Tidak ada perbandingan dengan fakta waktu kerja (scan di luar jadwal); lembur tetap tercatat walau hari itu `absent`/`off`. | HC menilai tanpa melihat scan. | Tampilkan fakta "scan di luar jadwal" di samping pengajuan (bukan inferensi otomatis). | T |
| L-4 | Halaman lembur hanya memuat 100 pegawai pertama untuk pilihan pegawai; status tampil sebagai enum Inggris. | — | Pencarian pegawai penuh; label Indonesia. | S |
| L-5 | Tidak ada tahap atasan langsung; keputusan lembur hanya di tabel event sendiri, tidak di `access_audit_events`. | — | Keputusan owner (D-5); audit seragam. | S |
| L-6 | Konsekuensi payroll tidak dihitung (benar sesuai MVP). | — | Tetap; PAY-003 di luar ATT-011. | — |

### 2.5 Pegawai (self-service)

| # | Yang ada | Gap | Dampak |
|---|---|---|---|
| E-1 | `/app/attendance`: kartu hari ini, form lembur + 5 terakhir, riwayat 30 hari. | Tidak ada jadwal ke depan (J-11), tidak ada daftar klarifikasi (K-10). | T |
| E-2 | `/app/attendance/clock`: GPS + kamera, klarifikasi hari ini. | Klarifikasi hari lalu tidak bisa. | T |
| E-3 | `/app/attendance/shift-swap`: lengkap untuk ATT-008. | Masuk dari menu terpisah, bukan dari jadwal. | S |
| E-4 | Sub-navigasi "Klarifikasi" dan "Lembur" mengarah ke anchor `#`. | Link mati. | S |

## 3. Hitungan langkah — contoh nyata

**Menjadwalkan 40 guru SDIT Shift Pagi Senin-Jumat untuk 1 Okt - 31 Des:**

- Hari ini: tab Lokasi (sekali) → tab Jadwal (sekali) → tab Assignment: **40 × isi form** (pegawai, template, centang 5 hari, tanggal dari, tanggal sampai, simpan) ≈ 280 interaksi; overlap dengan assignment lama tidak dicek.
- Target: Jadwal → **Atur jadwal** → pilih unit SDIT → Shift Pagi → 1 Okt-31 Des → Sen-Jum → **Lihat dampak** → **Terapkan** ≈ 7 interaksi, termasuk preview konflik.

**Satu guru ganti ke Shift Siang pada 15 Sep:**

- Hari ini: tab Roster → pilih minggu → Buat draft → cari baris guru di grid seluruh yayasan → pilih sel → Publish → (opsional) Laporan → Finalisasi tanggal.
- Target: Jadwal → klik sel guru 15 Sep → **Ganti jadwal** → Shift Siang → alasan → **Terapkan**; hasil kehadiran dihitung ulang otomatis.

**Mengetahui siapa yang belum hadir hari ini dan kenapa:**

- Hari ini: Ringkasan (status `absent` bisa salah untuk pengguna mesin, K-1) → Laporan "Data Scan" → Klarifikasi → Evidence Mobile.
- Target: Kehadiran → Hari ini → filter "Tidak hadir/Tidak lengkap" → klik baris → panel detail.

## 4. Yang sudah benar dan wajib dipertahankan

- Bukti mentah ADMS/mobile immutable; koreksi = event baru (ATT-010).
- `attendance_schedule_versions` dan pin `schedule_version_id` saat publish roster.
- `attendance_result_versions` immutable + input hash; sesi per versi.
- Missing punch tetap `incomplete`; jadwal tidak menjadi bukti.
- Cuti/izin memengaruhi hasil hanya bila approved + tervalidasi, atau resolution final (LEAVE-007).
- Lembur hanya dari keputusan eksplisit; checkout terlambat bukan lembur.
- Ambiguitas jadwal gagal tertutup (`configuration_error`), tidak dipilih diam-diam.
- Kontrak OpenAPI (`attendance-workforce.openapi.yaml`, `openapi.yaml`) sinkron dengan route yang ada.

## 5. Temuan di luar scope ATT-011

- **K-5** bug filter Evidence Mobile — patch terpisah dengan test API.
- File mati: `AdminAttendanceWorkforcePage.tsx` dan `AdminAttendanceReportsPage` (tidak di-route). Dibersihkan saat paket ATT-011-1, bukan refactor terpisah.
