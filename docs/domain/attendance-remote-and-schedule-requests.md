# Tugas Luar, WFH/WFA, dan Permintaan Ubah Jadwal

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling konservatif.
**Spesifikasi:** ATT-015
**Tanggal:** 2026-11-03
**Terkait:** APR-001, ORG-004, ATT-007 (engine), ATT-008 (tukar shift), ATT-011-4 (Perubahan Jadwal), ATT-011-7 (klarifikasi), ATT-013 (blok kerja), ATT-014 (laporan dan kalkulasi), LEAVE-001, LEAVE-007, TRIP-001, CAL-001, NOTIF-004, PAY-003, AUTH-011, ENG-LIST-001
**Bukti legacy:** `docs/product/legacy-parity-audit-2026-11-02.md` — `WorkAssignment` tipe `tugas_luar`, `wfh_wfa`, `perubahan_shift` (tipe `perjalanan_dinas` sudah menjadi TRIP-001).

## 1. Tujuan

Guru dan staf YSQ sering bertugas di luar sekolah: mengantar santri lomba, rapat di yayasan mitra, mengawas ujian di sekolah lain, belanja kebutuhan asrama. Hari ini mesin sidik jari mencatat mereka "tidak hadir" atau "tidak lengkap", lalu HC menjelaskannya satu per satu lewat klarifikasi. Ada pula pegawai yang sesekali bekerja dari rumah atau lokasi lain, dan pegawai yang butuh bertukar jam kerja pada satu hari.

Yang dituju Paket 1:

- pegawai mengajukan **tugas luar**, **WFH/WFA**, atau **ubah jadwal** dari HCIS dan melihat statusnya;
- persetujuan berjalan lewat approval engine APR-001: rantai disnapshot saat pengajuan;
- tugas luar dan WFH/WFA yang disetujui menjadi **pengecualian kehadiran yang terlihat**: hari tanpa scan tampil "Tugas luar" atau "WFH/WFA", bukan "Tidak hadir";
- ubah jadwal yang disetujui diterapkan HC sebagai roster terbit, lalu kehadiran dihitung dengan jadwal baru;
- bentrok dengan cuti, perjalanan dinas, dan pengajuan lain ditolak; bentrok dengan rapat diberi peringatan;
- semua langkah tercatat sebagai riwayat dan audit event.

### 1.1 Anti-copy guardrail (ACCEPTED)

Mengikuti roadmap ("schedule time tidak boleh disintesis menjadi attendance evidence"): **ATT-015 tidak pernah membuat punch**, baik dari jam jadwal, dari jam tugas luar, maupun dari persetujuan. Tidak ada baris yang ditulis ke `attendance_events`. Pengajuan yang disetujui hanya menjadi **disposisi** yang menjelaskan ketiadaan punch, dan hari itu tetap terbaca jujur: jam masuk/pulang kosong, menit kerja 0.

## 2. Batas

Termasuk (Paket 1):

- tiga jenis pengajuan oleh pegawai untuk dirinya sendiri;
- persetujuan berurutan atasan langsung lalu approver unit (APR-001);
- penerapan ubah jadwal oleh HC;
- pembatalan oleh pegawai atau HC;
- disposisi kehadiran harian di engine ATT-007 dan hitung ulang tanggal yang terdampak;
- baris di tab Pengecualian ATT-014 dan simbol baru di Rekap;
- notifikasi in-app (NOTIF-004), register HC, riwayat per pengajuan.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Perjalanan dinas (menginap, luar kota, surat tugas bernomor) | TRIP-001. Tugas luar adalah tugas harian tanpa surat tugas. |
| Tukar shift dengan rekan | ATT-008. Ubah jadwal ATT-015 hanya mengganti shift pegawai itu sendiri. |
| Mengubah hari libur menjadi hari kerja atau sebaliknya | Tetap lewat Perubahan Jadwal HC (ATT-011-4), karena menyentuh jumlah hari kerja (D-09). |
| Kuota WFH, persetujuan otomatis, WFH berulang | Belum ada kebijakan owner (D-02). |
| Lampiran bukti, foto, atau titik lokasi | Belum ada object storage untuk berkas pegawai; lokasi ditulis sebagai teks (D-03). |
| Tugas luar sebagian hari dengan jam | Paket 1 per hari penuh; jam masuk/pulang yang menyimpang dijelaskan otomatis (D-06). |
| Dampak payroll di luar transport | Hanya transport PKWT yang berubah (D-07); komponen lain PAY-003 tidak diubah. |
| Pengajuan atas nama bawahan | Paket 1 hanya untuk diri sendiri. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Persetujuan memakai **APR-001 dengan rantai atasan langsung → approver unit**, sama dengan Cuti Tahunan dan perjalanan dinas. Kunci alur rollout ORG-004: `WORK_ARRANGEMENT`. Tanpa baris rollout, mode `LEGACY`. HC **tidak** menjadi tahap approval. | ACCEPTED (owner 2026-11-03) |
| D-02 | **WFH/WFA**: setiap pegawai aktif boleh mengajukan, **satu pengajuan untuk satu hari**, tanpa kuota otomatis dan tanpa persetujuan otomatis. Setiap hari WFH harus disetujui rantai D-01. | ACCEPTED (owner 2026-11-03) |
| D-03 | WFH/WFA tidak membutuhkan lampiran atau titik lokasi di Paket 1. Pegawai wajib menulis **lokasi kerja** (3–200 karakter, misalnya "Rumah, Cibinong") dan **keperluan** (10–1000). | ACCEPTED (owner 2026-11-03) |
| D-04 | **Tugas luar**: 1–7 hari kalender per pengajuan, dihitung inklusif, dengan tempat tugas (3–200) dan keperluan (10–1000). Tugas yang menginap atau lebih dari 7 hari diajukan sebagai perjalanan dinas (TRIP-001). | ACCEPTED (owner 2026-11-03) |
| D-05 | Tanggal pengajuan: tugas luar paling lambat **7 hari ke belakang** (sama dengan batas klarifikasi ATT-011-7, karena tugas luar sering mendadak) dan paling jauh 60 hari ke depan; WFH/WFA mulai **hari ini** sampai 60 hari ke depan; ubah jadwal mulai **besok** sampai 60 hari ke depan. Semua tanggal WIB. | ACCEPTED (owner 2026-11-03) |
| D-06 | Dampak kehadiran tugas luar/WFH yang `APPROVED` pada hari kerja terjadwal: tanpa punch → status hari `field_assignment` atau `remote_work` (Riil 1); dengan punch → punch tetap dipakai, keterlambatan, pulang cepat, dan di luar lokasi dianggap **dijelaskan** (`justified`). Punch tidak pernah dibuat (§1.1). Hari libur, hari tanpa jadwal, dan jadwal bermasalah tidak berubah. Cuti atau penyelesaian kehadiran yang final selalu menang. | ACCEPTED (owner 2026-11-03) |
| D-07 | Uang transport PKWT (PAY-003) diberikan untuk hari tugas luar yang `APPROVED`, juga tanpa scan (status hari `field_assignment`), karena pegawai tetap berangkat untuk bekerja. WFH/WFA tanpa scan **tidak** mendapat transport. Berlaku di mesin PAY-003 (`resolveAttendanceDays`); jalur slip resmi PAY-001/PAY-002 tidak berubah sampai PAY-003 lulus parallel run. | ACCEPTED (owner 2026-11-03, mengganti default "tidak ada transport") |
| D-08 | Bentrok: tugas luar dan WFH ditolak bila beririsan dengan cuti `in_review`/`approved`, perjalanan dinas `IN_REVIEW`/`APPROVED`/`ISSUED`/`COMPLETED`, atau tugas luar/WFH lain milik pegawai yang `IN_REVIEW`/`APPROVED`. Pengajuan perjalanan dinas juga ditolak bila beririsan dengan tugas luar/WFH yang `IN_REVIEW`/`APPROVED`. Rapat tidak memblokir: pratinjau menampilkan rapat pegawai pada tanggal itu sebagai peringatan, dan pembuat rapat (CAL-001) mendapat peringatan `ON_FIELD_ASSIGNMENT` untuk peserta yang sedang tugas luar. | DRAFT |
| D-09 | **Ubah jadwal**: satu tanggal, hanya dari hari kerja terjadwal ke **shift aktif lain**. Tidak dapat mengubah hari libur, hari dengan cuti/dinas/tukar shift aktif, atau memilih shift yang sama. Setelah `APPROVED`, HC menekan **Terapkan**, yang menerbitkan versi roster baru minggu itu untuk pegawai tersebut (cara yang sama dengan tukar shift ATT-008). Terapkan ditolak bila jadwal pegawai sudah berubah sejak pengajuan, bila ada draft roster minggu itu, atau bila salah satu shift sudah mulai. | ACCEPTED (owner 2026-11-03) |
| D-10 | Pembatalan: pegawai boleh membatalkan `IN_REVIEW` kapan saja dan `APPROVED` **sebelum tanggal mulai**. HC (`attendance.arrangements.manage`) boleh membatalkan `IN_REVIEW` atau `APPROVED` kapan saja. Alasan wajib. `APPLIED` adalah akhir; jadwal yang sudah diterapkan diubah lewat Perubahan Jadwal. | ACCEPTED (owner 2026-11-03) |
| D-11 | `attendance.arrangements.read` dan `attendance.arrangements.manage` dibawa `human_capital_admin`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy. Atasan melihat pengajuan bawahan hanya lewat antrean approval-nya. | DRAFT |
| D-12 | Tidak ada perubahan isi atau tanggal setelah diajukan. Perubahan = batalkan, lalu ajukan baru. | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai (pemohon) | Pratinjau rantai approval dan bentrok, mengajukan, membatalkan (D-10), melihat riwayat miliknya |
| Approver tahap aktif | Menyetujui atau menolak tahap `pending` miliknya |
| HC dengan `attendance.arrangements.read` | Register semua pengajuan beserta riwayatnya |
| HC dengan `attendance.arrangements.manage` | Menerapkan ubah jadwal (D-09), membatalkan (D-10) |
| Sistem | Snapshot rantai, transisi, audit, notifikasi, hitung ulang kehadiran |

## 5. Alur dan state

### 5.1 Pengajuan

Precondition: akun `EMPLOYEE` aktif yang terhubung ke pegawai `active`.

Input umum: `type` (`FIELD_ASSIGNMENT`, `REMOTE_WORK`, `SCHEDULE_CHANGE`), `startOn`, `endOn`, `purpose` (10–1000), `idempotencyKey` (UUID). Tambahan per jenis:

| Jenis | Field | Aturan |
| --- | --- | --- |
| `FIELD_ASSIGNMENT` | `location` (tempat tugas) | D-04, D-05 |
| `REMOTE_WORK` | `location` (lokasi kerja) | `startOn = endOn`, D-02, D-05 |
| `SCHEDULE_CHANGE` | `scheduleTemplateId` (shift tujuan) | `startOn = endOn`, D-05, D-09 |

Langkah, dalam satu transaksi:

1. kunci baris pegawai (`FOR UPDATE`), sehingga dua pengajuan bersamaan diperiksa berurutan;
2. bila `idempotencyKey` sudah dipakai pegawai ini, kembalikan pengajuan yang sama;
3. validasi tanggal (D-02, D-04, D-05) dan bentrok (D-08; untuk ubah jadwal D-09);
4. ubah jadwal: resolusi jadwal saat ini dan shift tujuan pada tanggal itu, disimpan sebagai snapshot (template, versi, jam mulai/selesai);
5. resolusi rantai APR-001 (D-01), approver harus pegawai aktif dengan akun aktif — sama persis dengan TRIP-001 §5.1 butir 4–5;
6. simpan pengajuan `IN_REVIEW`, tahap pertama `pending`, sisanya `waiting`;
7. audit `arrangement.request.submitted`, notifikasi approver tahap pertama.

`POST /attendance/arrangements/me/preview` menjalankan langkah 3–5 tanpa menyimpan, dan menambahkan daftar rapat aktif pegawai pada rentang itu sebagai peringatan (D-08).

Kegagalan (409 kecuali disebut lain): `ARRANGEMENT_DATE_RANGE`, `ARRANGEMENT_TOO_LONG`, `ARRANGEMENT_SINGLE_DAY`, `ARRANGEMENT_DATE_TOO_EARLY`, `ARRANGEMENT_DATE_TOO_LATE`, `ARRANGEMENT_OVERLAP`, `ARRANGEMENT_LEAVE_OVERLAP`, `ARRANGEMENT_TRIP_OVERLAP`, `SCHEDULE_CHANGE_NOT_WORKING_DAY`, `SCHEDULE_CHANGE_SAME_SHIFT`, `SCHEDULE_CHANGE_SHIFT_NOT_VALID`, `SCHEDULE_CHANGE_SHIFT_SWAP_ACTIVE`, `DIRECT_MANAGER_MISSING`, `UNIT_APPROVER_MISSING`, `APPROVAL_CHAIN_EMPTY`, `APPROVER_NOT_ACTIVE`, `APPROVER_ACCOUNT_NOT_READY`; input tidak valid 400 `INVALID_ARRANGEMENT_REQUEST`; akun bukan pegawai aktif 403 `EMPLOYEE_NOT_ACTIVE`.

> Sebelum akun pemimpin diaktifkan, pengajuan di production berhenti di `APPROVER_ACCOUNT_NOT_READY`. Itu perilaku yang benar (APR-001-E). Alurnya diuji dengan data sintetis di test integrasi.

### 5.2 State pengajuan

```text
IN_REVIEW -> APPROVED      (tahap terakhir disetujui)
IN_REVIEW -> REJECTED      (salah satu tahap menolak)
IN_REVIEW -> CANCELLED     (pegawai atau HC, dengan alasan)
APPROVED  -> CANCELLED     (D-10)
APPROVED  -> APPLIED       (ubah jadwal saja; HC menerapkan, D-09)
REJECTED / CANCELLED / APPLIED -> terminal
```

Tugas luar dan WFH berlaku sejak `APPROVED`; tidak ada langkah HC.

### 5.3 State tahap approval

Sama dengan TRIP-001 §5.3: `waiting -> pending -> approved | rejected`, `waiting/pending -> cancelled`. Satu tahap `pending` per pengajuan dijaga indeks unik parsial; keputusan mengunci pengajuan lalu tahap (`FOR UPDATE`).

### 5.4 Keputusan approval

Hanya approver tahap `pending` yang tersimpan yang dapat memutuskan; lainnya 403 `APPROVAL_FORBIDDEN`. Tahap yang bukan aktif 409 `STEP_NOT_PENDING`. Menolak mewajibkan catatan (5–1000). Persetujuan akhir memberi tahu pegawai; untuk ubah jadwal, juga memberi tahu bahwa HC akan menerapkannya.

Setelah COMMIT persetujuan akhir tugas luar/WFH, sistem menghitung ulang (§7.3) setiap tanggal dalam rentang yang sudah lewat atau hari ini.

### 5.5 Penerapan ubah jadwal

Actor `attendance.arrangements.manage`; precondition `APPROVED`, jenis `SCHEDULE_CHANGE`, pegawai masih `active`. Dalam satu transaksi:

1. kunci pengajuan, kunci tanggal pegawai (kunci yang sama dengan tukar shift), kunci minggu roster;
2. tidak boleh ada tukar shift aktif pada tanggal itu (`SCHEDULE_CHANGE_SHIFT_SWAP_ACTIVE`);
3. resolusi jadwal saat ini harus sama dengan snapshot (`SCHEDULE_CHANGE_STALE`);
4. sekarang harus sebelum jam mulai shift lama dan shift baru (`SCHEDULE_CHANGE_STARTED`);
5. tidak boleh ada draft roster minggu itu (`SCHEDULE_CHANGE_ROSTER_DRAFT_EXISTS`);
6. terbitkan versi roster baru: salinan versi terbit terakhir ditambah entri pegawai itu dengan shift tujuan;
7. pengajuan → `APPLIED`, simpan id roster, audit `arrangement.schedule.applied`, notifikasi pegawai;
8. setelah COMMIT, hitung ulang tanggal itu.

Bila gagal di butir 2–5 pengajuan tetap `APPROVED`; HC dapat membatalkannya dengan alasan.

### 5.6 Pembatalan

Input `reason` (pegawai 5–500, HC 10–500). Tahap `waiting`/`pending` menjadi `cancelled`. Pembatalan oleh HC memberi tahu pegawai. Status yang tidak mengizinkan: 409 `ARRANGEMENT_NOT_CANCELLABLE`. Pembatalan tugas luar/WFH yang sudah `APPROVED` memicu hitung ulang tanggal yang sudah lewat atau hari ini, sehingga hari itu kembali dinilai dari punch saja.

## 6. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `attendance.arrangements.read` | Register tugas luar, WFH/WFA, dan ubah jadwal seluruh pegawai beserta riwayatnya | `human_capital_admin` |
| `attendance.arrangements.manage` | Menerapkan ubah jadwal dan membatalkan pengajuan | `human_capital_admin` |

Akses pegawai ke pengajuannya sendiri adalah kepemilikan dari sesi; akses approver adalah kepemilikan tahap snapshot. Migrasi `0125` menambah izin ke role yang sudah ada; `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama. Urutan rilis mengikuti OPS-MI8-REL-001 §4.5.

## 7. Kehadiran

### 7.1 Disposisi engine

`materializeAttendanceResult` (ATT-007) membaca pengajuan `FIELD_ASSIGNMENT`/`REMOTE_WORK` berstatus `APPROVED` yang mencakup tanggal itu, **hanya bila tidak ada disposisi cuti atau penyelesaian** (LEAVE-007). Urutan keputusan per hari:

```text
jadwal bermasalah  -> configuration_error   (tidak berubah)
libur / tanpa jadwal -> off                 (tidak berubah)
cuti / penyelesaian final -> leave | absent (tidak berubah)
tugas luar/WFH disetujui:
   tanpa punch  -> field_assignment | remote_work, menit kerja 0, justified
   dengan punch -> penilaian punch biasa; late/early/geofence justified
selain itu -> penilaian punch biasa
```

Hari multi-blok (ATT-013) mengikuti aturan yang sama: tanpa punch sama sekali → status disposisi; dengan punch → penilaian per blok dengan justifikasi yang sama. Punch yang tidak lengkap tetap `incomplete` (invariant ATT-011 I-3); pegawai mengajukan klarifikasi seperti biasa.

Versi hasil menyimpan `source_work_arrangement_id`; id pengajuan masuk ke `input_hash`, sehingga persetujuan atau pembatalan menghasilkan versi baru dan riwayat versi lama tetap utuh.

### 7.2 Status, simbol, dan rekap

| Status | Label | Simbol Rekap | Normal | Riil |
| --- | --- | --- | --- | --- |
| `field_assignment` | Tugas luar | `DL` | 1 | 1 |
| `remote_work` | WFH/WFA | `W` | 1 | 1 |

Kolom rekap "Tugas luar/WFH" menjumlah kedua status; laporan periode dan per unit menghitungnya sebagai hari hadir. Tampilan harian yang membaca hari belum dihitung memakai disposisi yang sama, sehingga hari itu tidak tampil "Tidak hadir". Pantauan Hari Ini (yang hanya menampilkan fakta scan, ATT-014 §5) menambah penanda "Tugas luar"/"WFH/WFA" di kolom Keterangan; kartunya tetap fakta scan. Antrean tindakan hanya memuat hari `incomplete` dan `configuration_error`, jadi hari berstatus disposisi tidak muncul di sana.

### 7.3 Hitung ulang

ATT-014 menghitung kehadiran lewat tombol Kalkulasi. ATT-015 memanggil engine langsung untuk tanggal yang terdampak, dengan cara yang sama seperti keputusan klarifikasi dan tukar shift: setelah COMMIT, per tanggal ≤ hari ini, berurutan, gagal satu tanggal tidak menggagalkan keputusan (hasilnya tetap bisa diperbaiki lewat Kalkulasi). Tanggal di masa depan dihitung saat harinya tiba, oleh Kalkulasi atau absen pegawai.

### 7.4 Tab Pengecualian

`GET /admin/attendance/exceptions` (ATT-014 §20.2) menambah baris `kind = "arrangement"` untuk pengajuan `APPROVED` dan `APPLIED` yang beririsan dengan rentang: `type` = jenis, `typeName` = label jenis, `reason` = keperluan, `status` = status pengajuan.

## 8. Audit dan riwayat

Tabel `attendance_work_arrangement_events` adalah riwayat per pengajuan sekaligus audit event:

`arrangement.request.submitted`, `arrangement.approval.approved_step`, `arrangement.request.approved`, `arrangement.request.rejected`, `arrangement.request.cancelled`, `arrangement.schedule.applied`.

Setiap event memuat aktor, waktu `clock_timestamp()`, dan metadata aman (id tahap, id roster, peran pembatal). Alasan penolakan/pembatalan disimpan sebagai `note`. Tidak ada koordinat, lampiran, atau nominal.

## 9. Notifikasi (NOTIF-004, kategori `attendance`)

- tahap menjadi `pending` → approver tahap itu;
- disetujui akhir / ditolak → pegawai;
- ubah jadwal diterapkan → pegawai;
- dibatalkan oleh HC → pegawai.

Ditulis dalam transaksi yang sama dengan transisinya, idempoten per `eventKey`.

## 10. Penyimpanan

```text
attendance_work_arrangement_requests        pengajuan, snapshot APR-001, snapshot jadwal (ubah jadwal)
attendance_work_arrangement_approval_steps  snapshot rantai APR-001
attendance_work_arrangement_events          riwayat dan audit
attendance_result_versions.source_work_arrangement_id
```

Aturan:

- unik `(employee_id, idempotency_key)`; `CHECK (end_on >= start_on)`; `CHECK (end_on - start_on <= 6)`; WFH dan ubah jadwal `CHECK (start_on = end_on)`;
- ubah jadwal wajib menyimpan `requested_schedule_template_id`, `requested_schedule_version_id`, dan snapshot jadwal lama; jenis lain wajib `location`;
- `APPLIED` hanya untuk ubah jadwal dan wajib `applied_roster_id`;
- satu `pending` per pengajuan (indeks unik parsial);
- status hasil kehadiran menerima `field_assignment` dan `remote_work`;
- tidak ada endpoint hapus.

Rollback migrasi ditulis sebagai komentar `-- Down:` di berkas migrasi. Mengembalikan CHECK status hasil hanya aman bila belum ada versi hasil berstatus baru; bila sudah ada, rollback kode cukup (build lama tidak menulis status baru dan membaca status asing sebagai "·").

## 11. API

Pegawai: `GET /attendance/arrangements/me` (halaman, filter status dan jenis), `GET /attendance/arrangements/me/:id`, `GET /attendance/arrangements/schedule-options?workDate=` (jadwal saat ini dan shift aktif), `POST /attendance/arrangements/me/preview`, `POST /attendance/arrangements/me`, `POST /attendance/arrangements/me/:id/cancel`.

Approver: `GET /attendance/arrangements/approvals` (halaman), `POST /attendance/arrangements/approvals/:stepId/decision`.

HC: `GET /admin/attendance/arrangements` (halaman, filter status, jenis, pegawai), `GET /admin/attendance/arrangements/:id`, `POST /admin/attendance/arrangements/:id/apply`, `POST /admin/attendance/arrangements/:id/cancel`.

Kontrak lengkap: `docs/api/attendance-work-arrangements.openapi.yaml`, tag `Work Arrangements`. Daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`; filter pegawai di layar HC memakai pencarian typeahead. Pengecualian tertulis: `schedule-options` mengembalikan shift aktif organisasi secara utuh dengan batas 200 dan menolak (bukan memotong) bila lebih — daftar shift adalah data konfigurasi yang kecil, dan dropdown-nya memakai pencarian teks bila lebih dari 50.

## 12. Layar

- Pegawai: `/app/attendance/arrangements` ("Tugas Luar & WFH") di Layanan Pegawai — formulir tiga jenis dengan pratinjau penyetuju dan peringatan rapat, daftar berhalaman, detail berisi tahap approval dan riwayat, tombol batal sesuai state.
- Approver: bagian "Tugas Luar, WFH & Ubah Jadwal" di halaman Persetujuan.
- HC: `/admin/attendance/arrangements` — register berhalaman dengan filter status, jenis, dan pencarian pegawai; detail sebagai pop-up (`?pengajuan=<id>`) (aturan app-shell "Detail views open as a pop-up", 2026-11-13); Terapkan (ubah jadwal); Batalkan.
- Laporan kehadiran: status dan simbol baru (§7.2), baris di tab Pengecualian.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada di ketiga layar.

## 13. Acceptance criteria

- ATT-015-A: pegawai aktif dapat mengajukan dan melihat pengajuannya; pegawai lain tidak dapat membaca atau membatalkannya.
- ATT-015-B: rantai approval disnapshot saat pengajuan; mengubah atasan sesudahnya tidak mengubah tahap tersimpan.
- ATT-015-C: approver yang tidak memegang tahap aktif menerima 403; keputusan ganda hanya menghasilkan satu transisi.
- ATT-015-D: resolver gagal atau approver dengan akun belum aktif menggagalkan pengajuan tanpa menyimpan apa pun.
- ATT-015-E: WFH lebih dari satu hari, tugas luar lebih dari 7 hari, tanggal di luar jendela D-05, dan bentrok D-08 ditolak; perjalanan dinas yang beririsan dengan tugas luar/WFH aktif ditolak.
- ATT-015-F: hari kerja terjadwal tanpa punch dengan tugas luar/WFH `APPROVED` dihitung `field_assignment`/`remote_work`; tidak ada baris baru di `attendance_events`.
- ATT-015-G: hari dengan punch tetap memakai punch; keterlambatan tercatat tetapi `justified`.
- ATT-015-H: cuti yang disetujui pada hari yang sama menang atas tugas luar/WFH; hari libur tetap `off`.
- ATT-015-I: pembatalan tugas luar/WFH yang disetujui menghitung ulang hari yang sudah lewat menjadi hasil punch biasa.
- ATT-015-J: ubah jadwal hanya diterapkan dari `APPROVED` oleh pemegang `attendance.arrangements.manage`, menerbitkan versi roster baru, dan ditolak bila jadwal berubah sejak pengajuan.
- ATT-015-K: tanpa `attendance.arrangements.read` register HC menjawab 403; Super Admin legacy tidak menerima `attendance.arrangements.*`.
- ATT-015-L: setiap transisi menulis event riwayat dengan aktor.
- ATT-015-M: tab Pengecualian menampilkan pengajuan yang disetujui; Rekap memakai simbol `DL` dan `W`.

## 14. Keputusan pemilik produk (2026-11-03)

Pemilik produk menyetujui semua rekomendasi pada 2026-11-03 ("Tugas Luar & WFH setuju semua saran"): default D-01..D-06, D-09, dan D-10 dipertahankan; D-07 diubah sehingga tugas luar mendapat transport dan WFH tidak. Batas WFH per bulan tidak ditetapkan.

| # | Pertanyaan | Keputusan |
| --- | --- | --- |
| D-01 | Siapa yang menyetujui? | Atasan langsung → approver unit; HC tidak menyetujui |
| D-02 | Siapa boleh WFH/WFA dan berapa kali? | Semua pegawai aktif, per hari, tanpa kuota, selalu lewat persetujuan |
| D-03 | WFH perlu bukti atau lokasi? | Lokasi ditulis sebagai teks, tanpa foto/titik GPS |
| D-04 | Batas lama tugas luar? | 7 hari; lebih dari itu atau menginap = perjalanan dinas |
| D-05 | Boleh diajukan sesudah kejadian? | Tugas luar sampai 7 hari ke belakang; WFH mulai hari ini; ubah jadwal mulai besok |
| D-06 | Hari tugas luar/WFH tanpa scan dihitung apa? | Dihitung masuk kerja (Riil 1), tanpa jam palsu |
| D-07 | Tugas luar tanpa scan dapat uang transport PKWT? | **Ya** untuk tugas luar; tidak untuk WFH (diubah owner) |
| D-09 | Siapa menerapkan ubah jadwal? | HC, setelah atasan menyetujui |
| D-10 | Siapa boleh membatalkan setelah disetujui? | Pegawai sebelum hari H; HC kapan saja |
