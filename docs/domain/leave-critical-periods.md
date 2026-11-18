# Masa Kritis Cuti

**Status:** ACCEPTED — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Perubahan 2026-11-18 (D-12):** tahap tinjauan HC masa kritis **dihapus**. Masa kritis tetap ditetapkan HC, tetap memperingatkan di pratinjau dan Kalender, dan tetap tercatat di riwayat dan audit; persetujuan berakhir di rantai lini seperti di luar masa kritis. Bagian di bawah ini tetap memuat aturan lama agar jejaknya terbaca, dengan penanda di tiap tempat yang berubah.
**Spesifikasi:** LEAVE-009
**Tanggal:** 2026-11-03
**Terkait:** LEAVE-003 (Cuti Tahunan), LEAVE-004/LEAVE-007 (cuti terencana dan Cuti Tanpa Gaji), LEAVE-005 (validasi HC), APR-001 (snapshot-on-submit), CAL-001 (kalender), AUTH-011, ENG-LIST-001
**Bukti legacy:** `docs/product/legacy-parity-audit-2026-11-02.md` §(c) — Laravel `hcysq/hcis-ysq`: model `CriticalPeriod` (label, tanggal mulai/selesai, unit opsional, aktif), `Admin/CriticalPeriodController` di `admin/critical-periods`, dan `ApprovalChainBuilder::isCriticalPeriodActive` yang menambahkan langkah HCM ke rantai cuti bila tanggal mulai cuti jatuh pada masa kritis aktif untuk unit pegawai atau untuk semua unit.

## 1. Tujuan

Di sekolah dan pondok ada pekan-pekan yang tidak boleh kekurangan guru dan staf: ujian, PPDB, pembagian rapor, akhir tahun ajaran. HCIS lama menamainya **masa kritis**: cuti yang jatuh di masa itu wajib melewati Human Capital, sehingga HC dapat melihat dampaknya ke unit sebelum cuti disetujui.

LEAVE-009 membawa perilaku itu ke HCIS baru:

- HC menetapkan masa kritis untuk seluruh yayasan atau untuk satu unit;
- pegawai yang mengajukan cuti di masa itu melihat peringatan sebelum mengirim;
- ~~rantai persetujuan cuti itu disnapshot dengan **satu tahap tinjauan HC tambahan** setelah persetujuan lini~~ (dihapus D-12, 2026-11-18): masa kritis yang cocok **dicatat** pada pengajuan, tanpa tahap tambahan;
- ~~HC menyetujui atau menolak dari antrean tinjauan masa kritis~~ (dihapus D-12): kepala unit yang menyetujui yang bertanggung jawab;
- masa kritis tampil di Kalender (CAL-001) supaya pegawai tahu sejak awal.

## 2. Batas

Termasuk:

- daftar, tambah, ubah, nonaktifkan, dan aktifkan kembali masa kritis oleh HC;
- deteksi masa kritis saat pratinjau dan pengajuan Cuti Tahunan dan cuti terencana yang melewati persetujuan lini;
- ~~tahap tinjauan HC masa kritis, antreannya, dan keputusannya~~ (dihapus D-12);
- ~~status "menunggu tinjauan HC" pada riwayat cuti pegawai~~ (dihapus D-12); masa kritis yang cocok tetap tersimpan di `validation_summary.criticalPeriods`;
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
| D-01 | Masa kritis **menambah tahap tinjauan HC** dan **tidak memblokir** pengajuan. Pegawai tetap dapat mengirim; peringatan tampil di pratinjau. | DRAFT (default audit 2026-11-02) — **digantikan D-12 (2026-11-18)**: tidak ada tahap tinjauan HC. Yang tetap berlaku: tidak memblokir, dan peringatan di pratinjau. |
| D-02 | Berlaku untuk Cuti Tahunan dan cuti terencana dengan persetujuan lini: Pernikahan, Menikahkan Anak, Khitanan Anak, Haji, serta Cuti Tanpa Gaji. Cuti khusus LEAVE-005 tidak terkena. Sejak D-12 perlakuannya sama untuk semuanya: dicatat dan diperingatkan, tanpa tahap tambahan (sebelumnya Cuti Tanpa Gaji "hanya dicatat" karena sudah diputus HC). | DRAFT (diperbarui D-12, 2026-11-18) |
| D-03 | Cuti terkena masa kritis bila **ada satu hari kalender saja** dari rentang cuti yang beririsan dengan masa kritis (inklusif). Legacy hanya memeriksa tanggal mulai; cuti yang mulai sehari sebelum ujian dan berakhir di tengah ujian lolos dari tinjauan, jadi aturan irisan dipakai. | DRAFT |
| D-04 | Cakupan masa kritis: seluruh yayasan, atau satu unit (`organizational_units`). Unit pegawai yang dipakai adalah unit pada saat pengajuan dikirim. Unit tidak berjenjang di tabel ini, jadi tidak ada pewarisan ke sub-unit. | DRAFT |
| D-05 | Urutan: persetujuan lini (atasan langsung, approver unit, atau governance) → ~~**tinjauan HC masa kritis**~~ (dihapus D-12) → pemeriksaan administrasi HC bila jenis cutinya memilikinya (Pernikahan, Haji, dan sejenisnya) → selesai. | DRAFT (diperbarui D-12, 2026-11-18) |
| D-06 | Snapshot-on-submit: masa kritis yang cocok disalin ke pengajuan saat dikirim. Membuat, mengubah, atau menonaktifkan masa kritis sesudahnya tidak menambah atau menghapus tahap pada pengajuan yang sudah ada. | Mengikuti APR-001 |
| D-07 | ~~Yang memutus tinjauan: akun HC dengan `leave.validate` **dan** `leave.hc.approve`~~ (tidak berlaku sejak D-12; `leave.hc.approve` tetap dipakai Cuti Tanpa Gaji LEAVE-007). Yang mengelola masa kritis: `leave.configuration.manage` (HC Admin), izin yang sama dengan kalender kerja cuti. Tidak ada izin baru dan tidak ada izin yang dicabut. | DRAFT (diperbarui D-12, 2026-11-18) |
| D-08 | Masa kritis tidak dihapus permanen; dinonaktifkan (dan dapat diaktifkan kembali). Hanya masa kritis aktif yang dipakai saat pengajuan. | DRAFT |
| D-09 | Panjang satu masa kritis maksimal 120 hari kalender; label wajib (maks. 120 karakter), keterangan opsional (maks. 500 karakter). Tumpang tindih antar masa kritis diperbolehkan. | DRAFT |
| D-10 | Masa kritis tampil di Kalender (CAL-001) bagi pegawai yang terkena: masa kritis seluruh yayasan dan masa kritis unitnya sendiri. | DRAFT |
| D-11 | ~~Tidak ada yang meninjau cutinya sendiri. Antrean menyembunyikan pengajuan milik peninjau, dan keputusannya ditolak `403 SELF_REVIEW_FORBIDDEN`~~ (tidak berlaku sejak D-12: tidak ada antrean maupun keputusan tinjauan). Larangan self-approval di rantai lini tetap berlaku lewat APR-001. | Mengikuti APR-001 (tanpa self-approval) |
| D-12 | **Tahap tinjauan HC masa kritis dihapus** (keputusan owner 2026-11-18, C1 daftar sign-off HC): "tahap approval kan kepala unit yg approve. kalau disetujui dia yg tgg jawab". Yang tetap: HC menetapkan masa kritis untuk yayasan atau unit; peringatan di pratinjau cuti dan di Kalender (CAL-001); masa kritis yang cocok disalin ke `validation_summary.criticalPeriods` pengajuan sehingga tetap terbaca di riwayat dan audit. Yang hilang: tahap tambahan di rantai, antrean `/leave/hc/critical-reviews`, keputusan HC-nya, layar **Cuti Masa Kritis**, dan status "menunggu tinjauan HC". Persetujuan berakhir di rantai lini, persis seperti di luar masa kritis. Tabel `leave_request_critical_reviews` dipertahankan untuk riwayat tinjauan yang sudah terjadi; tidak ada baris baru. | DRAFT (keputusan owner 2026-11-18) |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| HC Admin (`leave.configuration.manage`) | Melihat, menambah, mengubah, menonaktifkan, mengaktifkan kembali masa kritis. |
| ~~HC dengan mandat persetujuan (`leave.validate` + `leave.hc.approve`)~~ | Dihapus D-12 (2026-11-18): tidak ada antrean maupun keputusan tinjauan masa kritis. |
| Pegawai | Melihat peringatan masa kritis di pratinjau dan masa kritis di Kalender. |
| Approver lini | Tidak berubah, dan sejak D-12 tahap lini terakhir yang menutup persetujuan: kepala unit yang menyetujui yang bertanggung jawab. |
| Sistem | Mencocokkan masa kritis saat pengajuan, mencatatnya di pengajuan, menulis audit. |

## 5. Alur dan state

### 5.1 Mengelola masa kritis

Precondition: akun memiliki `leave.configuration.manage`.

Input: `label`, `description` (opsional), `startOn`, `endOn`, `unitId` (null = seluruh yayasan).

Validasi: tanggal ISO valid, `endOn >= startOn`, durasi ≤ 120 hari (D-09), unit ada bila diisi.

State masa kritis: `active` ↔ `inactive`. Tidak ada state lain dan tidak ada penghapusan.

Audit (`access_audit_events`, `entity_type = 'leave_critical_period'`):
`leave.critical_period.created`, `leave.critical_period.updated` (payload berisi nilai sebelum dan sesudah), `leave.critical_period.deactivated`, `leave.critical_period.reactivated`.

### 5.2 Pratinjau dan pengajuan

1. Pegawai memilih tanggal; pratinjau Cuti Tahunan (`POST /leave/me/annual/preview`) atau cuti terencana (`POST /leave/planned/me/preview`) mengembalikan `criticalPeriods`: daftar masa kritis aktif yang cocok (D-03, D-04). Sejak D-12 tidak ada lagi field `criticalReviewRequired`.
2. Bila tidak kosong, layar menampilkan peringatan: "Tanggal ini masuk masa kritis {label}. Pengajuan tetap bisa dikirim dan diputus atasan seperti biasa; pertimbangkan dampaknya ke unit Anda." Tombol kirim tetap aktif (D-01).
3. Saat dikirim, pencocokan diulang di dalam transaksi pengajuan (bukan diambil dari pratinjau). Masa kritis yang cocok disimpan di `validation_summary.criticalPeriods` pengajuan (D-06), dan itulah catatan riwayatnya. ~~Baris `leave_request_critical_reviews` dan event `leave.critical_review.attached`~~ tidak dibuat lagi sejak D-12.

### 5.3 ~~State tinjauan masa kritis~~ (dihapus D-12, 2026-11-18)

Tidak ada lagi baris tinjauan baru. Baris lama (`waiting|pending|approved|rejected|cancelled`) tetap tersimpan sebagai riwayat tinjauan yang benar-benar terjadi sebelum 18 November 2026.

Migrasi `0174_leave_critical_review_retired.sql` menutup baris yang masih terbuka saat rilis, supaya tidak ada pengajuan yang menggantung:

- tinjauan `pending` (lini sudah selesai, HC belum memutus) **dianggap disetujui** — rantai lini sudah mengatakan ya, dan tahap yang dihapus justru tahap ini. Pengajuan lalu melanjutkan: tugas administrasi HC yang `waiting` menjadi `pending`, atau, bila tidak ada, pengajuan menjadi `approved` dan pegawai diberi tahu lewat outbox;
- tinjauan `waiting` (lini masih berjalan) menjadi `cancelled`; pengajuan berjalan terus di rantai lininya tanpa perubahan;
- keduanya menulis event `leave.critical_review.retired` di `leave_request_events`, supaya riwayat menjelaskan mengapa tahapnya berakhir tanpa keputusan HC.

Yang diketahui tidak ikut: notifikasi pengawasan ORG-004 (`leave.oversight.approved`, hanya pada mode rollout `STRUCTURE`) diresolusi di kode aplikasi dan tidak dikirim untuk pengajuan yang diselesaikan migrasi itu.

### 5.4 Persetujuan lini terakhir

Sejak D-12: tahap lini terakhir yang disetujui langsung menyelesaikan pengajuan, atau mengaktifkan tugas administrasi HC bila jenis cutinya memilikinya — persis seperti di luar masa kritis. ~~Tinjauan masa kritis menjadi `pending` dan menahan pengajuan~~ tidak berlaku lagi, begitu pula event `leave.critical_review.pending` dan outbox `leave.critical_review.requested`.

### 5.5 ~~Keputusan HC~~ (dihapus D-12, 2026-11-18)

Tidak ada keputusan tinjauan masa kritis. Kode `404 CRITICAL_REVIEW_NOT_FOUND`, `409 CRITICAL_REVIEW_NOT_PENDING`, `403 HC_APPROVAL_FORBIDDEN` dan `403 SELF_REVIEW_FORBIDDEN` tidak lagi dipakai jalur ini.

## 6. Permission

| Endpoint | Izin |
| --- | --- |
| `GET/POST /admin/leave/critical-periods`, `PATCH /admin/leave/critical-periods/{id}` | `leave.configuration.manage` |
| ~~`GET /leave/hc/critical-reviews`, `POST /leave/hc/critical-reviews/{reviewId}/decision`~~ | Rute dihapus D-12 (2026-11-18). `leave.hc.approve` tetap ada untuk Cuti Tanpa Gaji (LEAVE-007). |
| Pratinjau/pengajuan dan Kalender | prinsipal `EMPLOYEE` aktif (tidak berubah) |

Setiap rute admin terdaftar di `docs/domain/AUTH-011-admin-route-permissions.json`. Test otomatis memeriksa 403 untuk akun tanpa izin.

## 7. Penyimpanan

Migration `0128_leave_critical_periods.sql`:

- `leave_critical_periods` — `id`, `label`, `description`, `starts_on`, `ends_on`, `organizational_unit_id` (null = seluruh yayasan), `is_active`, pembuat/pengubah, waktu. CHECK `ends_on >= starts_on` dan durasi ≤ 120 hari. Indeks `(starts_on, ends_on) WHERE is_active`.
- `leave_request_critical_reviews` — `id`, `leave_request_id` (UNIQUE), `status` (`waiting|pending|approved|rejected`), `period_snapshot` jsonb, `note`, `acted_by_account_id`, `acted_at`, waktu. Indeks antrean `(status, created_at) WHERE status = 'pending'`.

Sejak D-12 (migrasi `0174_leave_critical_review_retired.sql`) tidak ada baris `leave_request_critical_reviews` baru; tabelnya dipertahankan sebagai riwayat. Rollback rilis cukup mengembalikan kode: build lama membaca tabel itu dan menemukan semua tinjauan sudah diputus. Migrasi 0174 sendiri tidak punya `Down` otomatis — membuka kembali tinjauan yang sudah diselesaikan akan bertentangan dengan persetujuan dan notifikasi yang sudah ditulisnya.

## 8. API

Kontrak: `docs/api/leave-critical-periods.openapi.yaml`, dirujuk dari `docs/api/openapi.yaml`.

- `GET /admin/leave/critical-periods?page&pageSize&status=active|inactive|all&year` — berhalaman (ENG-LIST-001), urut `starts_on DESC, id`.
- `POST /admin/leave/critical-periods` — buat.
- `PATCH /admin/leave/critical-periods/{id}` — ubah label/keterangan/tanggal/unit dan/atau `isActive`.
- ~~`GET /leave/hc/critical-reviews`~~ dan ~~`POST /leave/hc/critical-reviews/{reviewId}/decision`~~ — dihapus D-12 (2026-11-18).
- Pratinjau Cuti Tahunan dan cuti terencana menambah `criticalPeriods` (tanpa `criticalReviewRequired` sejak D-12).
- ~~Ringkasan cuti pegawai menambah `criticalReviewStatus` per pengajuan~~ — dihapus D-12.
- `GET /me/calendar` menambah item `{ kind: "critical_period", id, label, startOn, endOn, unitName }`.

## 9. Layar

- **Admin → Cuti → Masa Kritis** (`/admin/leave/critical-periods`): tabel berhalaman dengan filter status, form tambah/ubah (unit dipilih dari daftar unit — data terbatas, `<select>` diperbolehkan selama ≤ 50 unit; production 2026-11-03: 17 unit), tombol nonaktifkan/aktifkan.
- **HC → Cuti Terencana**: kartu Cuti Tanpa Gaji menampilkan masa kritis yang tercatat (D-02).
- ~~**HC → Cuti Masa Kritis** (`/app/hc/critical-leave`)~~: layar dan menunya dihapus D-12 (2026-11-18).
- **Pegawai**: peringatan di pratinjau Cuti Tahunan dan cuti terencana. ~~Riwayat menampilkan "Menunggu tinjauan Human Capital (masa kritis)"~~ — dihapus D-12.
- **Kalender**: pita/tanda "Masa kritis" pada tanggal terkait.

State loading, kosong, galat, 403, dan tampilan ponsel diperiksa pada setiap layar baru.

## 10. Acceptance criteria

- LEAVE-009-A: HC Admin dapat membuat masa kritis seluruh yayasan dan per unit; akun tanpa `leave.configuration.manage` mendapat 403.
- LEAVE-009-B: Pratinjau cuti yang beririsan dengan masa kritis aktif yang berlaku untuk pegawai mengembalikan masa kritis itu; masa kritis unit lain atau nonaktif tidak muncul.
- LEAVE-009-C: Pengajuan Cuti Tahunan yang terkena masa kritis tetap dapat dikirim (tidak diblokir) dan mencatat masa kritis yang cocok di `validation_summary.criticalPeriods`; sejak D-12 tidak ada baris tinjauan.
- LEAVE-009-D: Setelah tahap lini terakhir disetujui, pengajuan selesai (atau masuk pemeriksaan administrasi HC bila jenis cutinya memilikinya) — sama persis dengan pengajuan tanpa masa kritis.
- LEAVE-009-E: ~~Keputusan setuju/tolak HC atas tinjauan~~ — tidak berlaku sejak D-12.
- LEAVE-009-F: ~~Hanya akun dengan `leave.validate` dan `leave.hc.approve` dapat membaca antrean dan memutus~~ — antreannya tidak ada lagi (D-12).
- LEAVE-009-G: Mengubah atau menonaktifkan masa kritis tidak mengubah pengajuan yang sudah dikirim.
- LEAVE-009-H: Cuti khusus LEAVE-005 tidak terkena masa kritis sama sekali.
- LEAVE-009-I: Setiap perubahan masa kritis tercatat sebagai audit event.
- LEAVE-009-J: Kalender pegawai menampilkan masa kritis yang berlaku untuknya.

## 11. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

1. ~~D-01 — hanya menambah tinjauan HC, tidak memblokir.~~ Dijawab owner 2026-11-18 (D-12): tidak ada tinjauan HC; tetap tidak memblokir.
2. D-02 — cuti khusus LEAVE-005 tidak terkena masa kritis.
3. D-03 — irisan rentang tanggal, bukan hanya tanggal mulai.
4. ~~D-05 — HC meninjau setelah atasan menyetujui (bukan sebelum).~~ Tidak berlaku (D-12).
5. ~~D-07 — yang memutus adalah pemegang mandat persetujuan HC.~~ Tidak berlaku (D-12).
6. D-09 — maksimal 120 hari per masa kritis.
7. ~~D-11 — cuti milik approver HC sendiri diputus approver HC lain.~~ Tidak berlaku (D-12).
8. D-12 — tinjauan `pending` yang masih terbuka saat rilis dianggap disetujui (lihat §5.3). Default yang dipakai, perlu dikonfirmasi bila ternyata harus ditolak atau dikembalikan ke pemohon.
