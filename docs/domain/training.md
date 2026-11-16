# Pelatihan Pegawai — Paket 1: Pencatatan Pelatihan

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** TRAIN-001
**Tanggal:** 2026-11-02
**Terkait:** EMP-008, PERF-001, ORG-004, CAL-001, LEAVE-001, TRIP-001, NOTIF-004, AUTH-011, ENG-LIST-001, ADR-0002
**Discovery:** `docs/domain/training-lms-discovery.md` (arah jangka panjang R1–R4; keputusan Product Owner 2026-10-20 tetap berlaku)

## 1. Tujuan

HC hari ini mencatat pelatihan di spreadsheet terpisah: siapa ikut apa, hadir atau tidak, sertifikat di mana, dan berapa jam pelatihan tiap pegawai setahun. Paket 1 memindahkan pencatatan itu ke HCIS:

- HC membuat **program pelatihan** dengan **sesi terjadwal**, menambahkan **peserta**, dan mencatat **kehadiran per sesi**;
- jadwal sesi memakai waktu pegawai, jadi sesi **diblokir** bila bentrok dengan rapat, cuti, perjalanan dinas, atau pelatihan lain (selaras dengan CAL-001 §6);
- saat program ditutup, setiap peserta yang hadir mendapat **catatan pelatihan** resmi beserta jam yang benar-benar dihadiri;
- pegawai mengajukan **pelatihan eksternal** (seminar, diklat pihak luar) dengan sertifikat, lalu HC memverifikasi;
- pegawai melihat **riwayat pelatihan** dan **jam pelatihan** miliknya; HC melihat **rekap jam** per pegawai per tahun.

## 2. Kajian legacy (2026-11-02)

| Sumber | Temuan |
| --- | --- |
| `hcysq/hcis-ysq` (Laravel, commit `30264ba`, 31 Jul 2026) | **LMS penuh**: tabel `trainings` (mode `classic` terjadwal dan mode LMS), `training_modules`, `training_lessons` dengan video YouTube/berkas, `quiz_*` dan `QuizGradingService`, pembuat formulir evaluasi (`forms`, `form_sections`, `form_questions`), sesi dengan check-in QR (`training_sessions`, `training_session_attendances`), `training_participants` (`registered`/`attended`/`absent`, nilai, path sertifikat), audiens per unit/role/pegawai, analitik, ulasan kursus. |
| `hcysq/GAS-HCIS` (Apps Script) | Hanya daftar "Pelatihan" di profil pegawai (nama program) dan kartu "Pelatihan Internal" di beranda. Tidak ada jadwal, kehadiran, atau kuis. |

Kesimpulan: legacy Laravel adalah LMS penuh, legacy GAS hanya riwayat. Paket 1 tetap **pencatatan pelatihan**, bukan LMS, karena:

1. Keputusan Product Owner 2026-10-20 no. 2 (mulai dari catatan pelatihan, lalu program luring, evaluasi, dan modul daring) dan no. 6 (dibangun baru; format, data, dan kode legacy tidak dijadikan acuan dan tidak dimigrasikan).
2. Video legacy bergantung pada YouTube, bertentangan dengan keputusan no. 3 (video di server sendiri) dan no. 5 (tidak bisa dilewati) yang butuh R4 dan kebijakan kapasitas server.
3. Evaluasi dirancang sebagai kerangka tersendiri (no. 4, R3), bukan kuis legacy.

Yang **diambil** dari legacy sebagai bukti kebutuhan (bukan format): sesi terjadwal dengan narasumber dan lokasi, kehadiran per sesi, kuota peserta, sertifikat per peserta, dan pembedaan pelatihan internal/eksternal. Check-in QR legacy tidak diambil di Paket 1 (D-05).

## 3. Batas

Termasuk (Paket 1 = R1 + inti R2 discovery):

- program, sesi terjadwal, peserta, kehadiran per sesi, penutupan program;
- blokir bentrok jadwal terhadap rapat, cuti, perjalanan dinas, dan pelatihan lain;
- catatan pelatihan internal (otomatis) dan eksternal (diajukan pegawai, diverifikasi HC);
- unggah sertifikat dengan mekanisme dokumen pendukung terenkripsi yang sudah ada;
- riwayat dan jam pelatihan pegawai; rekap jam per pegawai per tahun untuk HC;
- notifikasi in-app NOTIF-004 dan audit.

**Tidak** termasuk:

| Di luar lingkup | Rencana |
| --- | --- |
| Materi, video, modul daring, kuis, bank soal, nilai | R3/R4 discovery. Butuh port `ObjectStorage` (ADR-0002) dan kebijakan kapasitas video. |
| Kuesioner reaksi, RTL, evaluasi penerapan | R3 discovery §7. |
| Sertifikat yang diterbitkan sistem | R4 discovery. Paket 1 hanya sertifikat unggahan. |
| Pegawai mendaftar sendiri ke program | Paket 2 (D-03). |
| Penugasan per unit/jabatan sekaligus | Paket 2; Paket 1 per pegawai dengan pencarian. |
| Atasan melihat pelatihan bawahan (scope `U`) | Paket 2 (D-11). |
| Check-in QR oleh peserta | Paket 2 (D-05). |
| Pengajuan pelatihan eksternal berbiaya lewat APR-001 | Discovery §10; Paket 1 hanya mencatat. Tidak ada nominal. |
| Usulan kompetensi ke EMP-008 | R3 discovery §10. |
| Pengingat WhatsApp | Paket 2; Paket 1 in-app saja (D-15). |

## 4. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Paket 1 adalah **pencatatan pelatihan**, bukan LMS (alasan §2). | ACCEPTED (PO 2026-10-20 no. 2 dan 6) |
| D-02 | Kategori program dan catatan: Keterampilan Qur'ani, Pedagogi guru, Pengasuhan, SOP/administrasi, Orientasi pegawai baru, Pembinaan rutin, Lainnya (dari discovery §7.2). | DRAFT |
| D-03 | Peserta ditambahkan **HC per pegawai** lewat pencarian, paling banyak 100 pegawai per permintaan. Kuota opsional per program (1–500). Pegawai tidak mendaftar sendiri. | DRAFT |
| D-04 | **Blokir bentrok** mengikuti CAL-001 §6 (§7). Sesi yang seluruhnya sudah lewat tidak diblokir; bentroknya menjadi peringatan, supaya HC dapat mencatat pelatihan yang sudah terjadi. Tidak ada tombol paksa. | DRAFT |
| D-05 | Kehadiran per sesi dicatat **HC**: Hadir, Tidak hadir, atau Izin. Pencatatan dibuka sejak jam mulai sesi dan dapat diubah sampai program ditutup. | DRAFT |
| D-06 | Peserta dinyatakan **menyelesaikan** program bila jam sesi yang dihadiri ≥ **80%** dari total jam sesi program. Ambang dapat diatur per program (50–100). Izin tidak dihitung hadir. | DRAFT |
| D-07 | **Jam pelatihan** internal = jumlah durasi sesi yang dihadiri, dua desimal. Jam eksternal diisi pegawai (0,5–200 jam per catatan) dan diverifikasi HC. Rekap per tahun memakai tanggal selesai (WIB). | DRAFT |
| D-08 | Saat program ditutup, setiap peserta yang hadir **minimal satu sesi** mendapat catatan `VERIFIED` (menyelesaikan atau tidak), dan narasumber internal mendapat catatan peran **Narasumber** dengan jam sesi yang dibawakannya. Peserta tanpa kehadiran tidak mendapat catatan. | DRAFT |
| D-09 | Pelatihan eksternal: pegawai mengajukan, HC **memverifikasi** atau **menolak dengan alasan**. Yang ditolak diajukan ulang sebagai catatan baru. Pegawai dapat menarik pengajuan selama belum diputus. Tanggal selesai tidak boleh di masa depan. | DRAFT |
| D-10 | Sertifikat memakai **mekanisme dokumen pendukung terenkripsi yang sudah ada** (pola `leave_request_evidence`, migrasi 0007): PDF/JPG/PNG maks 2 MB, isi diperiksa dari tanda tangan berkas, dienkripsi AES-GCM dengan `AUTH_ENCRYPTION_KEY`, disimpan di database. Tidak ada penyimpanan baru. Satu sertifikat aktif per catatan; mengganti membuat baris baru dan yang lama tetap tersimpan sebagai jejak. | DRAFT |
| D-11 | `training.read` dan `training.manage` dibawa `human_capital_admin`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy. Atasan belum melihat pelatihan bawahan di Paket 1. | DRAFT |
| D-12 | Program yang ditutup **terkunci**: sesi, peserta, dan kehadiran tidak dapat diubah. Koreksi catatan setelah penutupan adalah Paket 2. | DRAFT |
| D-13 | Membatalkan program (alasan wajib) membatalkan semua sesinya yang masih terjadwal, membebaskan waktu peserta, dan memberi tahu peserta. Program yang sudah ditutup tidak dapat dibatalkan. | DRAFT |
| D-14 | Pelatihan **tidak** mengubah presensi kerja atau payroll; kehadiran sesi bukan presensi (discovery §10). Jam pelatihan bukan komponen nilai PERF-001. | ACCEPTED (PO 2026-10-20 no. 12) |
| D-15 | Notifikasi Paket 1 hanya in-app (NOTIF-004). | DRAFT |
| D-16 | Tidak ada target jam pelatihan per pegawai yang ditanam di kode; rekap jam tampil tanpa target (discovery §12 no. 3). | DRAFT |
| D-17 | Satu sesi berlangsung 15 menit sampai 12 jam, paling banyak 50 sesi per program. | DRAFT |
| D-18 | Rekap jam tahun tertentu memuat pegawai aktif (termasuk yang belum punya jam) dan pegawai yang sudah keluar bila punya jam terverifikasi pada tahun itu. | DRAFT |

## 5. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai | Melihat program yang diikutinya beserta jadwal dan kehadirannya, melihat riwayat dan jam pelatihannya, mengajukan dan menarik pelatihan eksternal, mengunggah sertifikat pada pengajuannya, mengunduh sertifikat miliknya |
| HC dengan `training.read` | Melihat program, sesi, peserta, kehadiran, catatan semua pegawai, sertifikat, dan rekap jam |
| HC dengan `training.manage` | Membuat dan mengubah program, sesi, peserta; mencatat kehadiran; menutup dan membatalkan program; memverifikasi atau menolak catatan eksternal; mengunggah sertifikat untuk catatan internal |
| Narasumber internal | Pegawai biasa; waktunya ikut diblokir dan ia mendapat catatan peran Narasumber (D-08) |
| Sistem | Cek bentrok, transisi, catatan otomatis, audit, notifikasi |

## 6. Alur dan state

### 6.1 Program

```text
ACTIVE -> COMPLETED   (HC menutup; syarat §6.5)
ACTIVE -> CANCELLED   (HC, alasan 10–500)
COMPLETED / CANCELLED -> terminal
```

Input buat/ubah: `title` (3–200), `category` (D-02), `description?` (≤ 2000), `organizer?` (≤ 200, bawaan "Yayasan Sabilul Qur'an"), `capacity?` (1–500), `minAttendancePercent` (50–100, bawaan 80). Ubah hanya saat `ACTIVE`; `capacity` tidak boleh di bawah jumlah peserta terdaftar (409 `TRAINING_CAPACITY_BELOW_ENROLLED`).

### 6.2 Sesi

```text
SCHEDULED -> CANCELLED   (HC, alasan 5–500, sebelum program ditutup)
```

Input: `title` (3–200), `startAt`, `endAt` (ISO 8601 dengan zona), `location?` (≤ 200), `speakerEmployeeId?` (pegawai aktif) atau `speakerName?` (≤ 150, narasumber luar). Validasi D-17 (batas 50 menghitung juga sesi yang dibatalkan); 400 `INVALID_TRAINING_SESSION`, 409 `TRAINING_SESSION_LIMIT`. Sesi dalam satu program tidak boleh beririsan satu sama lain, siapa pun pesertanya (409 `TRAINING_SESSION_OVERLAP`), supaya jam tidak terhitung ganda. Peserta terdaftar yang sudah tidak aktif tidak menghalangi penjadwalan dan tidak diperiksa bentroknya.

Sesi boleh dibuat dengan waktu yang sudah lewat (pencatatan susulan, D-04). Waktu sesi tidak dapat diubah lagi setelah ada kehadiran tercatat untuk sesi itu (409 `TRAINING_SESSION_HAS_ATTENDANCE`). Judul, lokasi, dan narasumber dapat diubah selama program `ACTIVE`. Perubahan waktu atau narasumber menjalankan cek bentrok §7 untuk semua peserta terdaftar dan narasumber internal, lalu memberi tahu peserta. Pembatalan sesi memberi tahu peserta; kehadiran sesi itu tidak dihitung.

### 6.3 Peserta

```text
ENROLLED -> WITHDRAWN    (HC, alasan 5–500, sebelum program ditutup)
WITHDRAWN -> ENROLLED    (HC menambahkan lagi; cek bentrok dijalankan ulang)
ENROLLED -> COMPLETED | INCOMPLETE   (saat program ditutup, D-06)
```

Menambah peserta: `employeeIds` (1–100, unik, pegawai `active`). Dalam satu transaksi: kunci program, kunci baris pegawai urut id (§7.2), cek kuota (409 `TRAINING_CAPACITY_FULL`), cek bentrok terhadap semua sesi `SCHEDULED` program yang belum selesai, lalu simpan. Pegawai yang sudah terdaftar dilewati dan dilaporkan sebagai `alreadyEnrolled`. Peserta baru diberi tahu.

### 6.4 Kehadiran

`PUT` batch per sesi: `entries[]` (1–100) berisi `employeeId`, `status` (`PRESENT`, `ABSENT`, `EXCUSED`), `note?` (≤ 300). Syarat: program `ACTIVE`, sesi `SCHEDULED`, sekarang ≥ `startAt` (409 `TRAINING_SESSION_NOT_STARTED`), setiap pegawai adalah peserta `ENROLLED` (409 `TRAINING_NOT_PARTICIPANT`). Upsert per `(sesi, pegawai)`.

### 6.5 Penutupan program

Syarat: program `ACTIVE`; minimal satu sesi `SCHEDULED`; semua sesi `SCHEDULED` sudah berakhir (409 `TRAINING_SESSIONS_NOT_FINISHED`); setiap peserta `ENROLLED` sudah punya kehadiran di setiap sesi `SCHEDULED` (409 `TRAINING_ATTENDANCE_INCOMPLETE` dengan jumlah yang kurang).

Dalam satu transaksi: hitung jam hadir per peserta, tetapkan `COMPLETED`/`INCOMPLETE` (D-06), buat catatan internal (D-08), program → `COMPLETED`, audit, beri tahu peserta yang mendapat catatan.

### 6.6 Catatan pelatihan

```text
Eksternal: SUBMITTED -> VERIFIED   (HC)
           SUBMITTED -> REJECTED   (HC, alasan 5–500)
           SUBMITTED -> WITHDRAWN  (pegawai)
Internal:  dibuat VERIFIED saat program ditutup
```

Pengajuan eksternal: `title` (3–200), `category`, `organizer` (3–200), `startOn`, `endOn` (`YYYY-MM-DD`, `endOn ≥ startOn`, `endOn ≤ hari ini WIB`, rentang ≤ 366 hari), `hours` (0,5–200, kelipatan 0,25), `description?` (≤ 2000), `certificate?` (§9), `idempotencyKey` (UUID; replay mengembalikan catatan yang sama). 400 `INVALID_TRAINING_RECORD`; 409 `TRAINING_RECORD_FUTURE`.

Verifikasi dan penolakan hanya dari `SUBMITTED` (409 `TRAINING_RECORD_NOT_PENDING`), mengunci baris catatan, dan memberi tahu pegawai.

## 7. Blokir bentrok jadwal

### 7.1 Aturan

Interval sesi setengah terbuka `[startAt, endAt)`; bersentuhan bukan bentrok. Orang yang diperiksa: peserta `ENROLLED` program dan narasumber internal sesi.

| Sumber | Kondisi | Hasil |
| --- | --- | --- |
| Sesi pelatihan lain | view `training_employee_busy`, bukan sesi yang sedang diubah, beririsan | **BLOCK** `IN_TRAINING` |
| Rapat (CAL-001) | `meeting_participants.blocks_time` dan `busy` beririsan | **BLOCK** `MEETING_OVERLAP` |
| Cuti | `leave_requests.status = 'approved'`, tanggal penuh WIB beririsan | **BLOCK** `ON_LEAVE` |
| Cuti | `status = 'in_review'` | WARN `LEAVE_PENDING` |
| Perjalanan dinas | `business_trip_requests.status IN ('APPROVED','ISSUED')` | **BLOCK** `ON_TRIP` |
| Perjalanan dinas | `status = 'IN_REVIEW'` | WARN `TRIP_PENDING` |

Tanggal penuh dikonversi ke `[tanggal 00:00 WIB, tanggal+1 00:00 WIB)`. Sesi yang sudah berakhir saat diperiksa menurunkan semua BLOCK menjadi WARN (D-04).

BLOCK menjawab 409 `TRAINING_CONFLICT` dengan daftar `{employeeId, name, reason, startAt, endAt, title?}`. `title` hanya untuk sesi pelatihan lain dan rapat yang tidak Rahasia (CAL-001 K-05). Tidak pernah: jenis atau alasan cuti, tujuan dinas. WARN dikembalikan di respons sukses sebagai `warnings`.

`POST /admin/training/availability` menjalankan aturan yang sama tanpa menyimpan, untuk pratinjau di layar.

Kontrak baca rapat bergantung pada migrasi CAL-001 `0117`. Selama tabel `meeting_participants` belum ada di database, sumber rapat dilewati dan tidak ada BLOCK `MEETING_OVERLAP`; begitu CAL-001 terpasang, sumber itu otomatis aktif tanpa perubahan kode.

### 7.2 Konkurensi

Penulisan yang memengaruhi waktu atau peserta mengunci baris `employees` semua orang yang terlibat dengan `FOR UPDATE` urut `id` naik, sama dengan CAL-001 §6.1, lalu menghitung bentrok dan menulis dalam transaksi yang sama. Karena kedua modul mengunci baris yang sama, undangan rapat dan sesi pelatihan untuk orang yang sama tidak dapat lolos bersamaan.

### 7.3 Kontrak untuk CAL-001

View `training_employee_busy (employee_id, session_id, program_id, title, busy tstzrange)` berisi sesi `SCHEDULED` dari program `ACTIVE` untuk peserta `ENROLLED` dan narasumber internal. CAL-001 membacanya sebagai sumber BLOCK `IN_TRAINING` (judul pelatihan boleh tampil; pelatihan tidak rahasia). Hanya baca; tidak ada hook atau penulisan lintas modul.

## 8. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `training.read` | Program, sesi, peserta, kehadiran, catatan, sertifikat, dan rekap jam semua pegawai | `human_capital_admin` |
| `training.manage` | Semua penulisan HC di §6 dan pencarian pegawai untuk peserta/narasumber | `human_capital_admin` |

Akses pegawai ke data pelatihannya sendiri adalah kepemilikan dari sesi, bukan permission. Migrasi `0119` menambah izin ke role yang sudah ada, jadi rilisnya berdiri sendiri (DOC-001 D-17, OPS-MI8-REL-001 §4.5). `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama.

## 9. Sertifikat

- Input: `fileName` (≤ 180), `contentType` (`application/pdf`, `image/jpeg`, `image/png`), `contentBase64`. Maks 2 MB setelah decode; tanda tangan berkas harus cocok dengan tipe (400 `CERTIFICATE_TYPE_MISMATCH`, 413 `CERTIFICATE_TOO_LARGE`).
- Pegawai mengunggah pada catatan eksternal miliknya selama `SUBMITTED`. HC (`training.manage`) mengunggah pada catatan internal `VERIFIED`.
- Unduhan: pegawai pemilik dan pemegang `training.read`; respons `Cache-Control: private, no-store` dan `Content-Disposition: attachment`.
- Isi sertifikat tidak pernah masuk log atau audit; audit hanya mencatat id, tipe, dan ukuran.

## 10. Audit

Tabel `training_audit_events` (program, sesi, catatan, pegawai, aktor, `clock_timestamp()`):

`training.program.created`, `training.program.updated`, `training.program.cancelled`, `training.program.completed`, `training.session.created`, `training.session.updated`, `training.session.cancelled`, `training.participant.enrolled`, `training.participant.withdrawn`, `training.attendance.recorded`, `training.record.created`, `training.record.submitted`, `training.record.withdrawn`, `training.record.verified`, `training.record.rejected`, `training.certificate.uploaded`.

Alasan disimpan sebagai `note`. Metadata hanya id, status, jumlah, dan jam; tidak ada isi sertifikat.

## 11. Notifikasi (NOTIF-004, kategori `system`)

- ditambahkan sebagai peserta → pegawai;
- waktu sesi berubah atau sesi dibatalkan → peserta terdaftar;
- program dibatalkan → peserta terdaftar;
- program ditutup dan catatan dibuat → pegawai yang mendapat catatan;
- catatan eksternal diverifikasi atau ditolak → pegawai.

Ditulis dalam transaksi yang sama dengan transisinya dan idempoten per `eventKey`.

## 12. Penyimpanan

```text
training_programs             program
training_sessions             sesi, busy tstzrange (kolom generated)
training_participants         peserta per program
training_attendance           kehadiran per sesi per peserta
training_records              catatan pelatihan (internal/eksternal, peran peserta/narasumber)
training_certificates         sertifikat terenkripsi (pola leave_request_evidence)
training_audit_events         audit
training_employee_busy        view kesibukan untuk CAL-001
```

Aturan: `training_participants` unik `(program_id, employee_id)`; `training_attendance` unik `(session_id, employee_id)`; catatan internal unik `(program_id, employee_id, role)`; catatan eksternal unik `(employee_id, idempotency_key)`; tidak ada kolom nominal; tidak ada endpoint hapus. Rollback ditulis sebagai komentar `-- Down:` di berkas migrasi.

## 13. API

Pegawai: `GET /training/me/summary`, `GET /training/me/records` (halaman), `POST /training/me/records`, `POST /training/me/records/:id/withdraw`, `POST /training/me/records/:id/certificate`, `GET /training/me/records/:id/certificate`, `GET /training/me/programs` (halaman), `GET /training/me/programs/:id`.

HC: `GET|POST /admin/training/programs`, `GET|PATCH /admin/training/programs/:id`, `POST /admin/training/programs/:id/cancel`, `POST /admin/training/programs/:id/complete`, `POST /admin/training/programs/:id/sessions`, `PATCH /admin/training/sessions/:id`, `POST /admin/training/sessions/:id/cancel`, `GET|POST /admin/training/programs/:id/participants`, `POST /admin/training/programs/:id/participants/:employeeId/withdraw`, `GET|PUT /admin/training/sessions/:id/attendance`, `POST /admin/training/availability`, `GET /admin/training/records`, `GET /admin/training/records/:id`, `POST /admin/training/records/:id/verify`, `POST /admin/training/records/:id/reject`, `POST /admin/training/records/:id/certificate`, `GET /admin/training/records/:id/certificate`, `GET /admin/training/hours`, `GET /admin/training/employee-options`.

Kontrak lengkap: `docs/api/training.openapi.yaml`, tag `Training`. Daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`; pemilih peserta dan narasumber memakai typeahead `employee-options` (`q` ≥ 2 huruf, maks 20 hasil). Sesi dalam detail program dibatasi D-17 (≤ 50), dicatat sebagai daftar terbatas.

## 14. Layar

- Pegawai: `/app/training` — ringkasan jam tahun berjalan, program yang diikuti dengan jadwal dan kehadiran, riwayat pelatihan berhalaman, formulir pelatihan eksternal dengan unggah sertifikat.
- HC: `/admin/training` — tab Program (daftar selebar halaman; formulir buat dan detail dengan sesi, peserta, kehadiran per sesi, tutup/batalkan terbuka sebagai pop-up `?program=baru` / `?program=<id>`), tab Catatan (antrean verifikasi eksternal, register catatan; detail catatan dalam pop-up `?catatan=<id>`), tab Rekap jam (per pegawai per tahun).

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 15. Acceptance criteria

- TRAIN-001-A: pegawai hanya melihat program yang diikutinya dan catatan miliknya; catatan atau sertifikat pegawai lain menjawab 404.
- TRAIN-001-B: tanpa `training.read` layar HC menjawab 403; penulisan tanpa `training.manage` menjawab 403; Super Admin legacy tidak menerima `training.*`.
- TRAIN-001-C: sesi atau peserta yang bentrok dengan sesi pelatihan lain, rapat aktif, cuti disetujui, atau perjalanan disetujui ditolak 409 `TRAINING_CONFLICT` dengan nama dan jam; cuti/perjalanan yang masih diproses hanya peringatan; batas bersentuhan bukan bentrok.
- TRAIN-001-D: kuota tidak dapat dilampaui.
- TRAIN-001-E: kehadiran hanya untuk peserta terdaftar dan setelah sesi dimulai.
- TRAIN-001-F: program tidak dapat ditutup sebelum semua sesi selesai dan semua kehadiran tercatat; penutupan menghasilkan catatan dengan jam hadir yang benar dan status menyelesaikan sesuai ambang.
- TRAIN-001-G: program yang ditutup terkunci; program yang dibatalkan membebaskan waktu peserta (view kosong).
- TRAIN-001-H: catatan eksternal masa depan ditolak; verifikasi/penolakan hanya dari `SUBMITTED`; replay idempotency tidak menggandakan.
- TRAIN-001-I: sertifikat bertipe palsu atau > 2 MB ditolak; sertifikat tersimpan terenkripsi dan hanya dapat diunduh pemilik atau `training.read`.
- TRAIN-001-J: rekap jam hanya menjumlahkan catatan `VERIFIED` pada tahun yang diminta, termasuk pegawai aktif tanpa jam dan pegawai yang sudah keluar tetapi punya jam terverifikasi pada tahun itu (D-18).
- TRAIN-001-K: setiap transisi menulis audit event dengan aktor; tidak ada isi sertifikat di audit.

## 16. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| D-03 | Siapa yang mendaftarkan peserta? | HC per pegawai; pegawai belum daftar sendiri |
| D-04 | Sesi yang sudah lewat tetap diblokir bila bentrok? | Tidak, hanya peringatan (untuk pencatatan susulan) |
| D-05 | Siapa yang mengisi daftar hadir? | HC; check-in QR peserta di Paket 2 |
| D-06 | Kapan peserta dianggap menyelesaikan? | Hadir ≥ 80% jam sesi, dapat diatur per program |
| D-07 | Jam pelatihan dihitung dari apa? | Durasi sesi yang dihadiri; eksternal diisi pegawai, diverifikasi HC |
| D-08 | Peserta yang hadir sebagian tetap tercatat? | Ya, dengan tanda "belum memenuhi kehadiran" |
| D-08 | Narasumber internal ikut tercatat? | Ya, peran Narasumber |
| D-10 | Di mana sertifikat disimpan? | Terenkripsi di database HCIS, maks 2 MB, seperti dokumen pendukung cuti |
| D-11 | Atasan melihat pelatihan bawahan? | Belum di Paket 1 |
| D-16 | Ada target jam pelatihan per tahun? | Tidak ditanam; rekap tanpa target |
