# Penangguhan Cuti dengan Usulan Tanggal Pengganti

**Status:** ACCEPTED — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** LEAVE-008
**Tanggal:** 2026-11-11
**Terkait:** APR-001 (snapshot-on-submit), LEAVE-003/LEAVE-004 (Cuti Tahunan), LEAVE-007 (cuti terencana dan Cuti Tanpa Gaji), LEAVE-009 (masa kritis), LEAVE-010 (pembatalan oleh pegawai, notifikasi penyetuju), NOTIF-004, ORG-013
**Bukti legacy:** `docs/product/legacy-parity-audit-2026-11-02.md` §(c) — Laravel `hcysq/hcis-ysq` (`30264ba`): `LeaveApprovalService::suspend` mewajibkan catatan dan minimal satu usulan tanggal mulai/selesai, mencatat aksi `suspend` beserta `proposed_start_date`/`proposed_end_date` di `leave_approvals`, dan mengubah status pengajuan menjadi `suspended` ("Menunggu Respon Pegawai"). Pegawai menerima lewat `leave/{leaveRequest}/accept-suspension` (`LeaveRequestService::acceptSuspension`), yang **menimpa** tanggal dan jumlah hari pengajuan lalu mengembalikannya ke level approval yang sama; atau membatalkan pengajuan. Saldo yang tertahan dilepas selama `suspended`.

## 1. Tujuan

Penyetuju lini kadang tidak menolak cuti, tetapi tidak bisa melepas pegawai pada tanggal itu: "jangan pekan ini, pekan depan saja". Sampai sekarang HCIS hanya memberi pilihan setujui atau tolak, sehingga penyetuju terpaksa menolak dan pegawai harus mengajukan ulang dari awal tanpa tahu tanggal mana yang bisa diterima.

LEAVE-008 menambahkan aksi ketiga pada tahap persetujuan lini: **Usulkan tanggal lain**. Pegawai lalu menerima atau menolak usulan itu.

Beda penting dengan legacy: HCIS **tidak menimpa** tanggal pengajuan yang sudah dikirim. Menerima usulan membuat **pengajuan pengganti baru** yang divalidasi dan disnapshot ulang (APR-001), sementara pengajuan asal ditutup dengan status `postponed` dan tetap utuh sebagai riwayat.

## 2. Batas

Termasuk:

- aksi usulan tanggal lain oleh pemilik tahap persetujuan lini yang aktif (pegawai penyetuju atau akun pengurus yayasan ORG-013), dengan pratinjau;
- respons pegawai: terima (membuat pengajuan pengganti) atau tolak (pengajuan selesai tanpa cuti);
- tampilan usulan di riwayat Cuti Tahunan dan cuti terencana pegawai, dan tanda "pengganti" pada pengajuan baru;
- audit event, outbox, dan notifikasi in-app (NOTIF-004);
- migration status, kolom tautan pengganti, dan tabel usulan.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Cuti khusus LEAVE-005 (sakit, melahirkan, duka, dsb.) | Tidak melewati persetujuan lini (`line_handling` `notify`/`none`); tanggalnya fakta, bukan permintaan. |
| Usulan dari Human Capital (tinjauan masa kritis LEAVE-009, validasi atau approval HC) | D-02 (DRAFT). HC tetap setujui/tolak; perluasan ke tinjauan masa kritis dicatat `TBD`. |
| Mengubah pengajuan yang sudah `approved` | Pembatalan/perubahan pasca-persetujuan tetap urusan HC (LEAVE-004 slice boundary). |
| Penyetuju menarik kembali usulannya | `TBD`. Pegawai dapat menolak; penyetuju dapat menunggu respons. |
| Batas waktu / kedaluwarsa otomatis usulan | APR-001 tidak punya expiry generik. Usulan yang tanggal mulainya sudah lewat hanya bisa ditolak (D-08). |
| Usulan berulang (negosiasi bolak-balik) | Satu usulan per pengajuan. Pengajuan pengganti dapat diusulkan ulang oleh penyetujunya sendiri, karena itu pengajuan baru. |

## 3. Keputusan

| ID | Keputusan | Status |
| --- | --- | --- |
| D-01 | Menerima usulan **membuat pengajuan pengganti baru**; pengajuan asal menjadi `postponed` (akhir) dan menunjuk ke penggantinya. Tanggal, jumlah hari, kalkulasi, dan snapshot persetujuan pengajuan asal tidak pernah diubah. | Mengikuti APR-001 dan `planning_note` feature-parity |
| D-02 | Yang dapat mengusulkan: pemilik tahap **lini** yang sedang `pending` (atasan langsung, approver unit, atau penyetuju pengurus ORG-013 dengan `leave.governance.approve`), dengan aturan kepemilikan yang sama dengan keputusan setujui/tolak. HC tidak mengusulkan. Tidak ada izin baru. | DRAFT |
| D-03 | Berlaku untuk Cuti Tahunan dan semua cuti terencana dengan persetujuan lini (Pernikahan, Menikahkan Anak, Khitanan Anak, Haji, Cuti Tanpa Gaji). | DRAFT |
| D-04 | Usulan wajib berisi **tanggal mulai dan tanggal selesai** (legacy boleh salah satu) dan **catatan** 5–1000 karakter. Tanggal usulan harus berbeda dari tanggal pengajuan asal, dan tanggal mulai harus **setelah hari ini** (Asia/Jakarta). | DRAFT |
| D-05 | Usulan divalidasi dengan aturan jenis cutinya **saat diusulkan** dan **diulang saat diterima**: kalender kerja, hari kerja > 0, kelayakan dan kuota periode Cuti Tahunan (tanpa menghitung pengajuan asal), aturan jenis cuti terencana, dan resolusi rantai persetujuan. Penyetuju tidak dapat mengusulkan tanggal yang tidak mungkin diajukan pegawai. | DRAFT |
| D-06 | Batas pemberitahuan minimum (H-7 Cuti Tahunan dan batas jenis cuti terencana) dihitung dari **tanggal pengajuan asal dikirim**, bukan dari tanggal usulan atau tanggal diterima. Pegawai sudah memberi tahu tepat waktu; keterlambatan karena usulan tidak boleh membuatnya gagal. Tanggal acuan itu dicatat di `validation_summary.noticeReferenceOn` pengganti, dan tetap dipakai bila pengganti itu sendiri ditangguhkan lagi. | DRAFT |
| D-07 | Pengajuan pengganti menjalani **seluruh rantai persetujuan dari awal**, diresolusi pada **tanggal diterima** (APR-001: penerimaan adalah pengiriman), sehingga perubahan atasan atau struktur sejak pengajuan asal ikut berlaku. Tidak ada tahap yang dianggap sudah disetujui, termasuk tahap pengusul; APR-001 tidak mengenal auto-approval. Masa kritis LEAVE-009 dicocokkan ulang untuk tanggal baru. | DRAFT |
| D-08 | Selama usulan menunggu respons, pengajuan asal berstatus `postponement_proposed` dan **tidak menahan kuota** maupun penjaga tumpang tindih (keduanya hanya menghitung `in_review`/`approved`), sama seperti legacy. Bila kuota terpakai pengajuan lain sebelum pegawai menerima, penerimaan ditolak dengan alasannya dan pegawai dapat menolak usulan. | DRAFT |
| D-09 | Menolak usulan menutup pengajuan asal sebagai `cancelled` (pegawai yang mengakhiri, seperti `cancelPendingRequest` legacy) dengan event `leave.postponement.declined`. Tidak kembali ke penyetuju. | DRAFT |
| D-10 | Alasan cuti pengajuan asal disalin ke pengganti. Dokumen pendukung cuti terencana disalin (ciphertext yang sama, baris baru) supaya pegawai tidak mengunggah ulang. | DRAFT |
| D-12 | Pesan validasi pratinjau dan usulan dikirim apa adanya ke penyetuju, termasuk sisa kuota periode pemohon bila usulan melampauinya. Penyetuju lini memang menilai ketersediaan pegawainya; tidak ada angka lain dari profil pegawai yang dibuka. | DRAFT |
| D-11 | Catatan penyetuju dan alasan cuti tidak masuk ke isi notifikasi; notifikasi hanya menyebut nama, jenis cuti, dan tanggal. Catatan tampil di layar pegawai pemilik pengajuan. | Mengikuti LEAVE-004 "Audit and privacy" |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| Penyetuju lini (pemilik tahap `pending`) | Melihat pratinjau usulan, mengirim usulan tanggal lain dengan catatan. |
| Pegawai pemohon | Melihat usulan di riwayat cutinya, menerima (membuat pengganti) atau menolak (opsional dengan alasan). |
| Human Capital | Tidak berubah. Pengganti yang terkena masa kritis atau tugas HC melewati antrean HC seperti pengajuan biasa. |
| Sistem | Mengunci baris, memvalidasi, membuat pengganti, menulis audit, outbox, dan notifikasi in-app. |

## 5. Alur dan state

### 5.1 State pengajuan

```text
in_review ──(penyetuju lini mengusulkan)──> postponement_proposed
postponement_proposed ──(pegawai menerima)──> postponed            [akhir; replaced_by → pengganti]
postponement_proposed ──(pegawai menolak)───> cancelled            [akhir]

pengajuan pengganti: dibuat langsung in_review, dengan replaces_request_id → pengajuan asal
```

`postponement_proposed` dan `postponed` bukan `in_review`/`approved`, sehingga tidak dihitung kuota, penjaga tumpang tindih, presensi, kalender rapat/pelatihan, laporan cuti aktif, maupun payroll.

### 5.2 State tahap dan bagian terbuka

| Bagian | Saat diusulkan |
| --- | --- |
| Tahap lini `pending` milik pengusul | → `postponed` (`acted_by_account_id`, `acted_at`, `decision_note` = catatan). |
| Tahap lini `waiting` sesudahnya | → `cancelled`. |
| Tugas HC (`waiting`) | → `cancelled`. |
| Tinjauan masa kritis (`waiting`) | → `cancelled`. |
| Tahap yang sudah diputus | Tetap, sebagai riwayat. |

### 5.3 State usulan (`leave_postponement_proposals`)

| State | Arti | Transisi |
| --- | --- | --- |
| `proposed` | Menunggu respons pegawai. Paling banyak satu per pengajuan. | → `accepted` / `declined` oleh pegawai. |
| `accepted` | Pegawai menerima; `replacement_request_id` terisi. | Akhir. |
| `declined` | Pegawai menolak; `response_note` berisi alasan bila ada. | Akhir. |

### 5.4 Mengusulkan tanggal lain

Endpoint: `POST /leave/approvals/{stepId}/postponement/preview` (tanpa menyimpan) dan `POST /leave/approvals/{stepId}/postpone`.

Precondition:

- principal `EMPLOYEE` aktif yang menjadi `approver_employee_id` tahap itu, atau `FOUNDATION_BOARD` yang menjadi `approver_account_id` dan memiliki `leave.governance.approve` dan bukan pemohon (sama dengan keputusan);
- tahap `pending`, pengajuan `in_review`, `line_handling = approval`, jenis cuti Cuti Tahunan atau cuti terencana (D-03);
- snapshot sekuensial valid (tepat satu tahap `pending`, sebelumnya `approved`, sesudahnya `waiting`);
- pemohon masih pegawai aktif.

Input: `startOn`, `endOn` (ISO), dan untuk `postpone` juga `note` (5–1000 karakter setelah dipangkas).

Langkah (`postpone`), dalam satu transaksi:

1. Kunci tahap dan pengajuan (`FOR UPDATE OF step, request`, sama dengan keputusan).
2. Periksa kepemilikan dan state (di atas), D-04, lalu validasi D-05/D-06 terhadap konteks pemohon. Kuota Cuti Tahunan dihitung tanpa pengajuan asal. Tanggal usulan tidak boleh beririsan dengan cuti lain pemohon yang `in_review`/`approved` (selain pengajuan asal).
3. Simpan usulan `proposed` (tanggal, hari kerja, catatan, pengusul).
4. Ubah tahap, bagian terbuka, dan pengajuan sesuai §5.2 dan §5.1.
5. Event `leave.postponement.proposed` pada pengajuan asal.
6. Outbox `leave.postponement.proposed` → pegawai; notifikasi in-app ke pemohon (`event_key = leave.postponement.proposed.<proposalId>`, judul "Penyetuju mengusulkan tanggal lain", tautan halaman cuti jenis itu).

Respons: `requestId`, `requestStatus = postponement_proposed`, `proposalId`, tanggal dan hari kerja usulan.

### 5.5 Menerima usulan

Endpoint: `POST /leave/me/postponements/{proposalId}/accept` dengan `idempotencyKey` (UUID).

Precondition: pengajuan asal milik pegawai sesi; usulan `proposed`; pengajuan `postponement_proposed`; tanggal mulai usulan setelah hari ini.

Langkah, dalam satu transaksi:

1. Kunci baris pegawai (seperti pengajuan cuti biasa, menyerialkan kuota), lalu usulan dan pengajuan asal.
2. Bila usulan sudah `accepted`: jawab ulang dengan pengganti yang sama (`idempotentReplay = true`), tanpa efek baru, apa pun kunci idempotensi yang dikirim (usulan itu sendiri sudah menjadi kunci).
3. Buat pengajuan pengganti lewat jalur pengiriman jenis cutinya (validasi penuh D-05/D-06, snapshot rantai baru D-07, masa kritis, tugas HC untuk cuti terencana, salinan dokumen D-10), dengan `replaces_request_id` dan `idempotency_key` dari input.
4. Usulan → `accepted` (`responded_at`, `replacement_request_id`); pengajuan asal → `postponed`.
5. Event `leave.postponement.accepted` pada pengajuan asal; event pengiriman biasa (`leave.request.submitted` / `leave.planned.submitted`, payload memuat `replacesRequestId`) pada pengganti.
6. Notifikasi pengiriman biasa ke penyetuju tahap pertama pengganti (LEAVE-010), plus outbox `leave.postponement.accepted` dan notifikasi in-app ke pengusul ("Usulan tanggal cuti diterima").

Respons 201: `proposalId`, `replacementRequestId`, `replacementStatus = in_review`, rantai persetujuan baru, `criticalReviewRequired`.

### 5.6 Menolak usulan

Endpoint: `POST /leave/me/postponements/{proposalId}/decline`, `reason` opsional (maks. 500 karakter).

Langkah: kunci usulan dan pengajuan; usulan → `declined` (`response_note`, `responded_at`); pengajuan asal → `cancelled`; event `leave.postponement.declined`; outbox `leave.postponement.declined` dan notifikasi in-app ke pengusul ("Usulan tanggal cuti ditolak pegawai"). Penolakan ulang atas usulan yang sudah `declined` dijawab ulang tanpa efek baru.

### 5.7 Interaksi

| Area | Perilaku |
| --- | --- |
| APR-001 | Snapshot pengajuan asal tidak ditulis ulang; tahapnya hanya diputus (`postponed`) atau ditutup (`cancelled`). Pengganti mendapat snapshot baru saat diterima. Tahap `postponed` tidak dapat diputus lagi (`REQUEST_NOT_REVIEWABLE`). |
| Saldo / kuota | Asal melepas tahanan saat diusulkan (D-08). Pengganti menahan kuota sejak `in_review` dan dihitung di periode tanggal barunya. Penerimaan diserialkan dengan kunci baris pegawai, sama dengan pengajuan biasa, sehingga tidak dapat melampaui kuota. |
| LEAVE-009 | Tinjauan masa kritis asal ditutup (`cancelled`). Pengganti dicocokkan ulang terhadap masa kritis aktif untuk tanggal baru dan unit pemohon saat diterima. Pratinjau usulan menampilkan masa kritis yang akan terkena. |
| LEAVE-010 | Pengajuan `postponement_proposed` tidak dapat dibatalkan lewat "Batalkan pengajuan" (`canCancel = false`); pegawai menolak usulan. Pengganti dapat dibatalkan seperti pengajuan biasa. |
| Haji | Satu Haji aktif per pegawai tetap dijaga: asal tidak aktif selama usulan, pengganti mengambil slot. |
| Presensi (ATT/LEAVE-006) | Hanya pengajuan `approved` yang menjelaskan hari presensi. Asal tidak pernah `approved`; pengganti berlaku setelah disetujui penuh. |
| Payroll (PAY-003) | Cuti Tanpa Gaji yang memengaruhi payroll hanya yang `approved`. Asal tidak pernah masuk; pengganti masuk dengan tanggal barunya setelah disetujui. |
| Laporan dan dasbor | Menghitung `in_review`/`approved`; status baru tidak terhitung sebagai cuti aktif. |

## 6. Izin

Tidak ada izin baru. Mengusulkan memakai kepemilikan tahap yang sama dengan keputusan (`/leave/approvals/{stepId}/decision`); menerima dan menolak adalah kepemilikan pengajuan (pola LEAVE-010). Manifest AUTH-011 mencatat keempat route sebagai `self-service`.

## 7. Audit event

| Event | Pada | Payload |
| --- | --- | --- |
| `leave.postponement.proposed` | pengajuan asal | `proposalId`, `stepId`, `policyKey`, tanggal asal, tanggal dan hari kerja usulan |
| `leave.postponement.accepted` | pengajuan asal | `proposalId`, `replacementRequestId` |
| `leave.request.submitted` / `leave.planned.submitted` | pengganti | payload pengiriman biasa + `replacesRequestId`, `postponementProposalId` |
| `leave.postponement.declined` | pengajuan asal | `proposalId`, `reason` bila ada |

Catatan penyetuju disimpan di tahap (`decision_note`) dan usulan, tidak di payload event.

## 8. Kegagalan

| Kondisi | Jawaban |
| --- | --- |
| Body tidak valid (tanggal, catatan < 5 atau > 1000, alasan > 500, kunci idempotensi) | 400 `INVALID_LEAVE_POSTPONEMENT` |
| Tahap tidak ada | 404 `APPROVAL_STEP_NOT_FOUND` |
| Tahap bukan milik akun / pengurus tanpa kapabilitas / pemohon sendiri | 403 `APPROVAL_FORBIDDEN` / `APPROVAL_SELF_FORBIDDEN` |
| Pengajuan tidak lagi diproses, tahap tidak aktif | 409 `REQUEST_NOT_REVIEWABLE` / `STEP_NOT_PENDING` |
| Jenis cuti tidak mendukung penangguhan | 409 `POSTPONEMENT_NOT_SUPPORTED` |
| Tanggal sama dengan asal / mulai tidak setelah hari ini | 409 `POSTPONEMENT_DATES_UNCHANGED` / `POSTPONEMENT_DATE_PASSED` |
| Aturan cuti gagal (kuota, periode, kalender, rantai) | 409 dengan kode validasi jenis cutinya, mis. `PERIOD_LIMIT_EXCEEDED`, `CROSS_PERIOD_REQUEST_UNSUPPORTED`, `EVIDENCE_REQUIRED`, `LEAVE_CALENDAR_NOT_CONFIGURED`, `APPROVER_ACCOUNT_NOT_READY` |
| Pemohon tidak lagi aktif | 409 `REQUESTER_NOT_ACTIVE` |
| Data pemohon ditandai di luar pengelolaan HCIS (EMP-005 §8.7): usulan, pratinjau usulan, dan penerimaan ditolak karena penerimaan mengajukan cuti baru; penyetuju tetap dapat menyetujui atau menolak pengajuan asal, dan pegawai tetap dapat menolak usulan | 409 `EMPLOYEE_OUTSIDE_HCIS_READ_ONLY` |
| Tanggal usulan beririsan dengan cuti lain pemohon yang masih aktif | 409 `LEAVE_REQUEST_OVERLAP` |
| Keputusan lain atas pengajuan yang sama sedang berjalan (kunci bertabrakan) | 409 `LEAVE_REQUEST_BUSY`; transaksi dibatalkan, ulangi setelah memuat ulang |
| Kunci idempotensi sudah dipakai pengajuan lain | 409 `IDEMPOTENCY_KEY_REUSED` |
| Usulan tidak ada atau bukan milik pegawai | 404 `POSTPONEMENT_NOT_FOUND` |
| Usulan sudah dijawab dengan cara lain / pengajuan tidak menunggu respons | 409 `POSTPONEMENT_NOT_OPEN` |
| Diterima saat tanggal mulai usulan sudah tiba | 409 `POSTPONEMENT_DATE_PASSED` (pegawai menolak, lalu mengajukan baru) |
| Penerimaan gagal validasi ulang | 409 kode validasinya; usulan tetap `proposed`, tidak ada perubahan |
| Penyedia notifikasi gagal | Tidak memengaruhi transaksi; outbox dan notifikasi in-app ditulis dalam transaksi yang sama. |

## 9. Layar

- **Persetujuan** (pegawai penyetuju, mobile-first): tiap kartu cuti mendapat tombol **Usulkan tanggal lain** di samping Tolak/Setujui. Formulir sebaris: tanggal mulai, tanggal selesai, catatan wajib, tombol **Periksa** (pratinjau: hari kerja, masa kritis) lalu **Kirim usulan**. Error tampil di kartu. Setelah terkirim kartu hilang dari antrean.
- **Pengurus yayasan** (`BoardApprovalsSection`): aksi yang sama.
- **Riwayat Cuti Tahunan** dan **Riwayat cuti terencana**: pengajuan `postponement_proposed` berlabel "Menunggu respons Anda" dan menampilkan kotak usulan (nama pengusul, tanggal usulan, hari kerja, catatan) dengan **Terima tanggal ini** dan **Tolak usulan** (konfirmasi + alasan opsional). Status `postponed` berlabel "Ditangguhkan — diganti pengajuan baru"; pengganti berlabel "Pengganti pengajuan sebelumnya". Loading, error, dan kosong mengikuti pola halaman yang ada.
- API mengembalikan `postponement` dan `canRespondToPostponement` per pengajuan; layar tidak memutuskan.

## 10. Data

Migration (lihat file migration untuk resep rollback):

- `leave_requests.status` menerima `postponement_proposed` dan `postponed`;
- `leave_request_approval_steps.status` menerima `postponed`;
- `leave_requests.replaces_request_id uuid NULL` → `leave_requests(id)`, unik bila terisi;
- tabel `leave_postponement_proposals` (id, `leave_request_id`, `approval_step_id` unik, pengusul akun/pegawai, tanggal usulan, `proposed_working_days`, `note`, `status`, `response_note`, `responded_at`, `replacement_request_id` unik, `created_at`), dengan CHECK konsistensi state dan indeks unik satu usulan `proposed` per pengajuan.

Tidak ada baris yang diubah oleh migration; tidak ada izin baru.

## 11. Acceptance criteria

- LEAVE-008-A: pemilik tahap lini `pending` mengusulkan tanggal lain dengan catatan; pengajuan menjadi `postponement_proposed`, tahap `postponed`, tahap berikutnya/tugas HC/tinjauan masa kritis `cancelled`, event dan notifikasi pemohon tercatat tanpa alasan cuti maupun catatan.
- LEAVE-008-B: selain pemilik tahap aktif (pegawai lain, pemohon, tahap `waiting`, pengurus tanpa kapabilitas) ditolak 403/409 tanpa perubahan.
- LEAVE-008-C: usulan yang melanggar aturan cuti (kuota, kalender, tanggal sama, tanggal lewat) ditolak 409 dan tidak mengubah apa pun.
- LEAVE-008-D: selama usulan menunggu, kuota periode Cuti Tahunan pengajuan asal dilepas.
- LEAVE-008-E: menerima membuat pengganti `in_review` dengan snapshot rantai baru dari tahap pertama, `replaces_request_id` terisi, pengajuan asal `postponed`, tanggal asal tidak berubah; penerimaan berulang dengan kunci yang sama tidak membuat pengganti kedua.
- LEAVE-008-F: penerimaan yang gagal validasi ulang (mis. kuota sudah terpakai) ditolak 409 dan usulan tetap terbuka.
- LEAVE-008-G: menolak menutup pengajuan asal `cancelled` dan memberi tahu pengusul.
- LEAVE-008-H: pegawai lain tidak dapat menerima/menolak usulan milik orang lain (404); tahap `postponed` tidak dapat disetujui/ditolak lagi.
- LEAVE-008-I: cuti terencana dengan dokumen: pengganti membawa salinan dokumen dan tugas HC `waiting` baru.
