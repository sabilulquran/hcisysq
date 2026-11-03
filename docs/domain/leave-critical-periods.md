# Masa Kritis Cuti

**Status:** ACCEPTED — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** LEAVE-009
**Tanggal:** 2026-11-03
**Terkait:** LEAVE-003 (Cuti Tahunan), LEAVE-004/LEAVE-007 (cuti terencana dan Cuti Tanpa Gaji), LEAVE-005 (validasi HC), APR-001 (snapshot-on-submit), CAL-001 (kalender), AUTH-011, ENG-LIST-001
**Bukti legacy:** `docs/product/legacy-parity-audit-2026-11-02.md` §(c) — Laravel `hcysq/hcis-ysq`: model `CriticalPeriod` (label, tanggal mulai/selesai, unit opsional, aktif), `Admin/CriticalPeriodController` di `admin/critical-periods`, dan `ApprovalChainBuilder::isCriticalPeriodActive` yang menambahkan langkah HCM ke rantai cuti bila tanggal mulai cuti jatuh pada masa kritis aktif untuk unit pegawai atau untuk semua unit.

## 1. Tujuan

Di sekolah dan pondok ada pekan-pekan yang tidak boleh kekurangan guru dan staf: ujian, PPDB, pembagian rapor, akhir tahun ajaran. HCIS lama menamainya **masa kritis**: cuti yang jatuh di masa itu wajib melewati Human Capital, sehingga HC dapat melihat dampaknya ke unit sebelum cuti disetujui.

LEAVE-009 membawa perilaku itu ke HCIS baru:

- HC menetapkan masa kritis untuk seluruh yayasan atau untuk satu unit;
- pegawai yang mengajukan cuti di masa itu melihat peringatan sebelum mengirim;
- rantai persetujuan cuti itu disnapshot dengan **satu tahap tinjauan HC tambahan** setelah persetujuan lini;
- HC menyetujui atau menolak dari antrean tinjauan masa kritis;
- masa kritis tampil di Kalender (CAL-001) supaya pegawai tahu sejak awal.

## 2. Batas

Termasuk:

- daftar, tambah, ubah, nonaktifkan, dan aktifkan kembali masa kritis oleh HC;
- deteksi masa kritis saat pratinjau dan pengajuan Cuti Tahunan dan cuti terencana yang melewati persetujuan lini;
- tahap tinjauan HC masa kritis, antreannya, dan keputusannya;
- status "menunggu tinjauan HC" pada riwayat cuti pegawai;
- tampilan masa kritis di Kalender pegawai;
- audit event dan baris notifikasi outbox.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Memblokir pengajuan cuti di masa kritis | D-01 (DRAFT): masa kritis hanya menambah tinjauan HC. |
| Kuota jumlah pegawai cuti per unit per hari | Tidak ada di legacy dan belum ada aturan. HC menilainya saat meninjau. |
| Cuti khusus LEAVE-005 (sakit, melahirkan, keguguran, haid, duka, pendampingan istri) | D-02: hak darurat/medis tidak tunduk pada masa kritis; HC sudah memvalidasinya. |
| Mengubah pengajuan yang sudah dikirim sebelum masa kritis dibuat atau diubah | APR-001 snapshot-on-submit (D-06). |
| Menghapus masa kritis secara permanen | D-08: masa kritis hanya dinonaktifkan, supaya riwayat dan audit tetap utuh. |

## 3. Keputusan

| ID | Keputusan | Status |
| --- | --- | --- |
| D-01 | Masa kritis **menambah tahap tinjauan HC** dan **tidak memblokir** pengajuan. Pegawai tetap dapat mengirim; peringatan tampil di pratinjau. | DRAFT (default audit 2026-11-02) |
| D-02 | Berlaku untuk Cuti Tahunan dan cuti terencana dengan persetujuan lini: Pernikahan, Menikahkan Anak, Khitanan Anak, Haji. Cuti Tanpa Gaji sudah wajib diputuskan HC (LEAVE-007), jadi tidak mendapat tahap kedua; masa kritisnya hanya dicatat di ringkasan pengajuan dan tampil di antrean persetujuan HC. Cuti khusus LEAVE-005 tidak terkena. | DRAFT |
| D-03 | Cuti terkena masa kritis bila **ada satu hari kalender saja** dari rentang cuti yang beririsan dengan masa kritis (inklusif). Legacy hanya memeriksa tanggal mulai; cuti yang mulai sehari sebelum ujian dan berakhir di tengah ujian lolos dari tinjauan, jadi aturan irisan dipakai. | DRAFT |
| D-04 | Cakupan masa kritis: seluruh yayasan, atau satu unit (`organizational_units`). Unit pegawai yang dipakai adalah unit pada saat pengajuan dikirim. Unit tidak berjenjang di tabel ini, jadi tidak ada pewarisan ke sub-unit. | DRAFT |
| D-05 | Urutan: persetujuan lini (atasan langsung, approver unit, atau governance) → **tinjauan HC masa kritis** → pemeriksaan administrasi HC bila jenis cutinya memilikinya (Pernikahan, Haji, dan sejenisnya) → selesai. Penolakan di tinjauan masa kritis menolak pengajuan. | DRAFT |
| D-06 | Snapshot-on-submit: masa kritis yang cocok disalin ke pengajuan saat dikirim. Membuat, mengubah, atau menonaktifkan masa kritis sesudahnya tidak menambah atau menghapus tahap pada pengajuan yang sudah ada. | Mengikuti APR-001 |
| D-07 | Yang memutus tinjauan: akun HC dengan `leave.validate` **dan** `leave.hc.approve` (mandat actual approval HC, pola Cuti Tanpa Gaji). Yang mengelola masa kritis: `leave.configuration.manage` (HC Admin), izin yang sama dengan kalender kerja cuti. Tidak ada izin baru. | DRAFT |
| D-08 | Masa kritis tidak dihapus permanen; dinonaktifkan (dan dapat diaktifkan kembali). Hanya masa kritis aktif yang dipakai saat pengajuan. | DRAFT |
| D-09 | Panjang satu masa kritis maksimal 120 hari kalender; label wajib (maks. 120 karakter), keterangan opsional (maks. 500 karakter). Tumpang tindih antar masa kritis diperbolehkan. | DRAFT |
| D-10 | Masa kritis tampil di Kalender (CAL-001) bagi pegawai yang terkena: masa kritis seluruh yayasan dan masa kritis unitnya sendiri. | DRAFT |
| D-11 | Tidak ada yang meninjau cutinya sendiri. Antrean menyembunyikan pengajuan milik peninjau, dan keputusannya ditolak `403 SELF_REVIEW_FORBIDDEN`; approver HC lain yang memutus. | Mengikuti APR-001 (tanpa self-approval) |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| HC Admin (`leave.configuration.manage`) | Melihat, menambah, mengubah, menonaktifkan, mengaktifkan kembali masa kritis. |
| HC dengan mandat persetujuan (`leave.validate` + `leave.hc.approve`) | Melihat antrean tinjauan masa kritis dan memutus setuju/tolak. |
| Pegawai | Melihat peringatan masa kritis di pratinjau, status tinjauan di riwayat, dan masa kritis di Kalender. |
| Approver lini | Tidak berubah. Tahap lini tetap diputus dari kotak Persetujuan. |
| Sistem | Mencocokkan masa kritis saat pengajuan, mengaktifkan tahap tinjauan, menulis audit dan outbox. |

## 5. Alur dan state

### 5.1 Mengelola masa kritis

Precondition: akun memiliki `leave.configuration.manage`.

Input: `label`, `description` (opsional), `startOn`, `endOn`, `unitId` (null = seluruh yayasan).

Validasi: tanggal ISO valid, `endOn >= startOn`, durasi ≤ 120 hari (D-09), unit ada bila diisi.

State masa kritis: `active` ↔ `inactive`. Tidak ada state lain dan tidak ada penghapusan.

Audit (`access_audit_events`, `entity_type = 'leave_critical_period'`):
`leave.critical_period.created`, `leave.critical_period.updated` (payload berisi nilai sebelum dan sesudah), `leave.critical_period.deactivated`, `leave.critical_period.reactivated`.

### 5.2 Pratinjau dan pengajuan

1. Pegawai memilih tanggal; pratinjau Cuti Tahunan (`POST /leave/me/annual/preview`) atau cuti terencana (`POST /leave/planned/me/preview`) mengembalikan `criticalPeriods`: daftar masa kritis aktif yang cocok (D-03, D-04), beserta `criticalReviewRequired`.
2. Bila tidak kosong, layar menampilkan peringatan: "Tanggal ini masuk masa kritis {label}. Setelah atasan menyetujui, pengajuan ditinjau Human Capital." Tombol kirim tetap aktif (D-01).
3. Saat dikirim, pencocokan diulang di dalam transaksi pengajuan (bukan diambil dari pratinjau). Bila ada yang cocok dan jenis cutinya terkena (D-02):
   - baris `leave_request_critical_reviews` dibuat dengan status `waiting` dan `period_snapshot` berisi id, label, tanggal, dan cakupan setiap masa kritis yang cocok;
   - `validation_summary.criticalPeriods` menyimpan salinan yang sama;
   - event `leave.critical_review.attached` ditulis.
4. Untuk Cuti Tanpa Gaji, hanya `validation_summary.criticalPeriods` yang disimpan (D-02).

### 5.3 State tinjauan masa kritis

| State | Arti | Transisi |
| --- | --- | --- |
| `waiting` | Persetujuan lini belum selesai. | → `pending` saat tahap lini terakhir disetujui. |
| `pending` | Menunggu keputusan HC. | → `approved` / `rejected` oleh HC. |
| `approved` | HC menyetujui. | Akhir. |
| `rejected` | HC menolak; pengajuan ikut ditolak. | Akhir. |

Bila pengajuan ditolak di tahap lini, tinjauan tetap `waiting` dan tidak pernah aktif; antrean hanya membaca tinjauan `pending` dengan pengajuan `in_review`.

### 5.4 Persetujuan lini terakhir

Saat tahap lini terakhir disetujui dan pengajuan memiliki tinjauan `waiting`:

- tinjauan menjadi `pending`, pengajuan tetap `in_review`;
- tugas HC LEAVE-005/LEAVE-007 (bila ada) tetap `waiting`;
- event `leave.critical_review.pending`, outbox `leave.critical_review.requested` ke role `human_capital`, dan outbox `leave.line_approval.completed.employee_notify` ke pegawai.

### 5.5 Keputusan HC

Precondition: akun memiliki `leave.validate` dan `leave.hc.approve`; tinjauan `pending`; pengajuan `in_review`. Baris tinjauan dan pengajuan dikunci (`FOR UPDATE`).

- **Setuju**: tinjauan `approved`. Bila pengajuan memiliki tugas HC `waiting`, tugas itu menjadi `pending` dan outbox HC validasi/approval dikirim seperti biasa. Bila tidak, pengajuan menjadi `approved`, `final_decided_at` diisi, outbox `leave.request.approved` ke pegawai (dan `leave.request.approved.hc_notify` bila `hc_handling = notify`), serta pengawasan akhir ORG-004 (`enqueueFinalApprovalOversight`).
- **Tolak**: tinjauan `rejected`, pengajuan `rejected`, outbox `leave.critical_review.rejected.employee_notify`. Catatan HC dianjurkan.

Event: `leave.critical_review.approved` / `leave.critical_review.rejected`.

Bila `hc_handling` pengajuan `validate`/`approve`, tugas HC dengan jenis yang sama wajib masih `waiting`; bila tidak, keputusan ditolak `409 HC_TASK_NOT_READY` (pemeriksaan administrasi tidak pernah dilewati diam-diam).

Failure: `404 CRITICAL_REVIEW_NOT_FOUND`, `409 CRITICAL_REVIEW_NOT_PENDING`, `409 HC_TASK_NOT_READY`, `403 HC_APPROVAL_FORBIDDEN`, `403 SELF_REVIEW_FORBIDDEN` (D-11).

## 6. Permission

| Endpoint | Izin |
| --- | --- |
| `GET/POST /admin/leave/critical-periods`, `PATCH /admin/leave/critical-periods/{id}` | `leave.configuration.manage` |
| `GET /leave/hc/critical-reviews`, `POST /leave/hc/critical-reviews/{reviewId}/decision` | prinsipal `EMPLOYEE` dengan `leave.validate` + `leave.hc.approve` aktif berscope organisasi |
| Pratinjau/pengajuan dan Kalender | prinsipal `EMPLOYEE` aktif (tidak berubah) |

Setiap rute admin terdaftar di `docs/domain/AUTH-011-admin-route-permissions.json`. Test otomatis memeriksa 403 untuk akun tanpa izin.

## 7. Penyimpanan

Migration `0128_leave_critical_periods.sql`:

- `leave_critical_periods` — `id`, `label`, `description`, `starts_on`, `ends_on`, `organizational_unit_id` (null = seluruh yayasan), `is_active`, pembuat/pengubah, waktu. CHECK `ends_on >= starts_on` dan durasi ≤ 120 hari. Indeks `(starts_on, ends_on) WHERE is_active`.
- `leave_request_critical_reviews` — `id`, `leave_request_id` (UNIQUE), `status` (`waiting|pending|approved|rejected`), `period_snapshot` jsonb, `note`, `acted_by_account_id`, `acted_at`, waktu. Indeks antrean `(status, created_at) WHERE status = 'pending'`.

Rollback: kedua tabel baru dan tidak diubah tabel lain. Rollback rilis cukup mengembalikan kode; database dibiarkan (kode lama tidak membaca tabel ini). Bila perlu dibuang: `DROP TABLE leave_request_critical_reviews; DROP TABLE leave_critical_periods;` setelah memastikan tidak ada tinjauan `pending` (pengajuan dengan tinjauan pending akan tetap `in_review` tanpa approver aktif di kode lama, jadi putuskan dulu atau catat untuk HC).

## 8. API

Kontrak: `docs/api/leave-critical-periods.openapi.yaml`, dirujuk dari `docs/api/openapi.yaml`.

- `GET /admin/leave/critical-periods?page&pageSize&status=active|inactive|all&year` — berhalaman (ENG-LIST-001), urut `starts_on DESC, id`.
- `POST /admin/leave/critical-periods` — buat.
- `PATCH /admin/leave/critical-periods/{id}` — ubah label/keterangan/tanggal/unit dan/atau `isActive`.
- `GET /leave/hc/critical-reviews?page&pageSize` — antrean `pending`, berhalaman, urut `submitted_at, id`.
- `POST /leave/hc/critical-reviews/{reviewId}/decision` — `{ decision: approve|reject, note? }`.
- Pratinjau Cuti Tahunan dan cuti terencana menambah `criticalPeriods` dan `criticalReviewRequired`.
- Ringkasan cuti pegawai menambah `criticalReviewStatus` per pengajuan.
- `GET /me/calendar` menambah item `{ kind: "critical_period", id, label, startOn, endOn, unitName }`.

## 9. Layar

- **Admin → Cuti → Masa Kritis** (`/admin/leave/critical-periods`): tabel berhalaman dengan filter status, form tambah/ubah (unit dipilih dari daftar unit — data terbatas, `<select>` diperbolehkan selama ≤ 50 unit; production 2026-11-03: 17 unit), tombol nonaktifkan/aktifkan.
- **HC → Cuti Terencana**: kartu Cuti Tanpa Gaji menampilkan masa kritis yang tercatat (D-02).
- **HC → Cuti Masa Kritis** (`/app/hc/critical-leave`): antrean berhalaman; tiap kartu menampilkan pegawai, unit, jenis cuti, tanggal, masa kritis yang terkena, dan tombol Setujui/Tolak. Akun HC tanpa mandat persetujuan melihat penjelasan, bukan galat.
- **Pegawai**: peringatan di pratinjau Cuti Tahunan dan cuti terencana; riwayat menampilkan "Menunggu tinjauan Human Capital (masa kritis)".
- **Kalender**: pita/tanda "Masa kritis" pada tanggal terkait.

State loading, kosong, galat, 403, dan tampilan ponsel diperiksa pada setiap layar baru.

## 10. Acceptance criteria

- LEAVE-009-A: HC Admin dapat membuat masa kritis seluruh yayasan dan per unit; akun tanpa `leave.configuration.manage` mendapat 403.
- LEAVE-009-B: Pratinjau cuti yang beririsan dengan masa kritis aktif yang berlaku untuk pegawai mengembalikan masa kritis itu; masa kritis unit lain atau nonaktif tidak muncul.
- LEAVE-009-C: Pengajuan Cuti Tahunan yang terkena masa kritis tetap dapat dikirim (tidak diblokir) dan memiliki tinjauan `waiting`.
- LEAVE-009-D: Setelah tahap lini terakhir disetujui, pengajuan tetap `in_review` dan tinjauan menjadi `pending`; tanpa masa kritis, perilaku lama tidak berubah.
- LEAVE-009-E: Keputusan setuju HC menyelesaikan pengajuan (atau mengaktifkan pemeriksaan administrasi HC bila ada); keputusan tolak menolak pengajuan.
- LEAVE-009-F: Hanya akun dengan `leave.validate` dan `leave.hc.approve` dapat membaca antrean dan memutus.
- LEAVE-009-G: Mengubah atau menonaktifkan masa kritis tidak mengubah pengajuan yang sudah dikirim.
- LEAVE-009-H: Cuti khusus LEAVE-005 dan Cuti Tanpa Gaji tidak mendapat tahap tinjauan masa kritis.
- LEAVE-009-I: Setiap perubahan masa kritis dan keputusan tinjauan tercatat sebagai audit/event.
- LEAVE-009-J: Kalender pegawai menampilkan masa kritis yang berlaku untuknya.

## 11. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

1. D-01 — hanya menambah tinjauan HC, tidak memblokir.
2. D-02 — Cuti Tahunan dan cuti terencana saja; cuti khusus dan Cuti Tanpa Gaji tidak mendapat tahap tambahan.
3. D-03 — irisan rentang tanggal, bukan hanya tanggal mulai.
4. D-05 — HC meninjau setelah atasan menyetujui (bukan sebelum).
5. D-07 — yang memutus adalah pemegang mandat persetujuan HC (`leave.hc.approve`), bukan semua staf HC.
6. D-09 — maksimal 120 hari per masa kritis.
7. D-11 — cuti milik approver HC sendiri diputus approver HC lain.
