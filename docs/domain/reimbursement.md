# Reimbursement Pegawai

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** REIMB-001
**Tanggal:** 2026-11-13
**Keputusan produk:** instruksi owner 2026-11-11 "selesaikan dulu semua PRD HCIS" memindahkan REIMB-001 dari pasca-MVP (`deferred`) ke lingkup yang dibangun sekarang. AGENTS.md §5 dan `docs/product/mvp.md` diperbarui dalam perubahan yang sama.
**Terkait:** APR-001, ORG-002, ORG-004, TRIP-001, LOAN-001, EMP-011, NOTIF-003, NOTIF-004, PAY-001, PAY-002, PAY-003, AUTH-011, ENG-LIST-001, HELP-001

## 1. Tujuan

Pegawai YSQ kerap menalangi biaya kerja: transport dinas, penginapan, konsumsi rapat, perlengkapan operasional. HCIS legacy (Laravel `hcysq/hcis-ysq`) sudah punya modul reimbursement: satu klaim satu kategori (`transport`, `konsumsi`, `operasional`, `lain`), 1–5 lampiran, rantai atasan + Finance Head (ditambah Kabid bila > Rp1.000.000 dan Direktur bila > Rp3.000.000), lalu Finance Head menandai `paid`. Nominalnya `decimal(12,2)` dan lampiran disimpan di Google Drive dengan nama asli.

Yang dituju Paket 1:

- pegawai menyusun klaim berisi beberapa baris biaya, mengunggah bukti, dan bila perlu menautkannya ke perjalanan dinas TRIP-001 (biaya perjalanan sejak awal diserahkan TRIP-001 ke REIMB-001);
- persetujuan lewat approval engine APR-001 yang sama dengan cuti, dinas, dan pinjaman: rantai disnapshot saat pengajuan;
- Keuangan **memverifikasi** bukti (dapat menyetujui sebagian per baris) lalu **mencatat pembayaran** di luar payroll; pencatatan pembayaran idempoten;
- total klaim, total yang disetujui, dan pembayaran dijaga database, bukan hanya route;
- setiap langkah tercatat sebagai riwayat dan audit event tanpa nominal;
- Keuangan/HC punya register, ringkasan per kategori, dan ekspor CSV.

## 2. Batas

Termasuk (Paket 1):

- draf klaim milik pegawai sendiri: judul, 1–10 baris biaya (kategori, tanggal, uraian, nominal), tautan perjalanan dinas opsional;
- bukti 1–10 berkas per klaim (PDF/JPG/PNG, ≤ 4 MB), terenkripsi di database;
- persetujuan berurutan atasan langsung → approver unit (APR-001);
- verifikasi, penolakan, dan pencatatan pembayaran oleh Keuangan;
- register, ringkasan per kategori/status, ekspor CSV, pencarian pengaju (typeahead);
- notifikasi in-app (NOTIF-004) dan pengingat (NOTIF-003).

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Uang muka (advance) perjalanan dan penyelesaiannya | Butuh aturan pertanggungjawaban yang belum ada. Klaim Paket 1 selalu pengganti biaya yang sudah dikeluarkan. TBD owner. |
| Uang harian/per diem dan tarif standar per golongan | Belum ada tabel tarif. Pegawai mengklaim biaya nyata dengan bukti. |
| Pembayaran otomatis lewat payroll | Jalur slip resmi tetap PAY-001/PAY-002 (AGENTS.md §5). Penyerahan ke periode payroll hanya ada di balik saklar `DRAFT` yang mati (D-11). Tidak ada tabel `payroll_*` yang dibaca atau ditulis. |
| Koreksi/pembatalan pembayaran yang sudah dicatat | D-18. Satu klaim satu pembayaran; kesalahan dicatat Keuangan di luar HCIS sampai ada keputusan. |
| Ambang nominal legacy (Kabid > Rp1 jt, Direktur > Rp3 jt, Finance Head sebagai tahap) | Resolver APR-001 tidak boleh membaca teks jabatan (D-01). |
| Migrasi klaim legacy | Arsip saja, sama dengan LOAN-001 D5 (§11). |
| Integrasi bank/transfer otomatis, akuntansi | Di luar HCIS. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Persetujuan memakai **APR-001 dengan rantai atasan langsung → approver unit**, kunci alur ORG-004 `REIMBURSEMENT` (tanpa baris rollout: mode `LEGACY`). **Keuangan bukan tahap approval**, tetapi verifikasi Keuangan adalah gerbang sebelum uang keluar. Ambang nominal legacy (Kabid, Direktur) dan Finance Head sebagai tahap tidak dibawa. | DRAFT |
| D-02 | **Kategori dan batas per baris** (bilangan bulat rupiah): Transportasi (`TRANSPORT`) ≤ Rp3.000.000; Akomodasi (`ACCOMMODATION`) ≤ Rp2.000.000; Konsumsi (`MEALS`) ≤ Rp1.000.000; Operasional/perlengkapan kerja (`OPERATIONAL`) ≤ Rp2.000.000; Lainnya (`OTHER`) ≤ Rp1.000.000. Katalog tetap di kode (`modules/reimbursements/domain.ts`), dikirim API ke layar; mengubahnya adalah perubahan kode. | DRAFT |
| D-03 | Satu klaim **1–10 baris**, tiap baris **≥ Rp1.000** (batas bawah legacy), total klaim **≤ Rp10.000.000**. | DRAFT |
| D-04 | Tanggal biaya **tidak setelah hari ini** dan **paling lama 90 hari** sebelum tanggal pengajuan (WIB). Legacy tidak membatasi umur bukti. | DRAFT |
| D-05 | **Bukti wajib** saat pengajuan: 1–10 berkas per klaim, PDF/JPG/PNG ≤ 4 MB, diperiksa tanda tangan berkas dan konten aktif PDF dengan aturan EMP-011 D-02/D-07. Disimpan AES-256-GCM di database dengan pola EMP-011/TRAIN-001 di tabel sendiri; nama berkas asli tidak disimpan. WebP (diterima legacy) tidak diterima. | DRAFT |
| D-06 | Tautan **perjalanan dinas opsional**: hanya perjalanan milik pengaju berstatus `APPROVED`, `ISSUED`, atau `COMPLETED`. Satu perjalanan boleh punya beberapa klaim. Tanggal biaya tidak dipaksa berada di dalam tanggal perjalanan; Keuangan melihat tanggal perjalanan saat verifikasi. | DRAFT |
| D-07 | Klaim mulai sebagai **draf** supaya bukti dapat diunggah satu per satu dari HP. Paling banyak **5 draf** terbuka per pegawai. Draf dapat diubah dan dibuang; membuang draf menghapus isi bukti untuk selamanya (baris metadata dan riwayat tetap). | DRAFT |
| D-08 | **Pembatalan oleh pegawai** saat `IN_REVIEW` atau `APPROVED` (sebelum Keuangan memverifikasi), alasan 5–500 karakter. Setelah diverifikasi pegawai tidak dapat membatalkan; Keuangan menolaknya bila perlu. | DRAFT |
| D-09 | **Verifikasi Keuangan** dari `APPROVED`: per baris nominal disetujui 0 sampai nominal klaim. Bila ada baris yang dikurangi, catatan 10–500 karakter wajib. Total disetujui harus > 0; klaim yang tidak layak sama sekali ditolak. **Penolakan Keuangan** dari `APPROVED` atau `VERIFIED`, alasan 10–500. | DRAFT |
| D-10 | **Pembayaran** dicatat Keuangan dari `VERIFIED`: nominal selalu = total disetujui (tidak diketik), tanggal antara tanggal verifikasi dan hari ini, cara `CASH` atau `TRANSFER` **di luar payroll (bawaan)**, nomor bukti ≤ 200, catatan ≤ 500, kunci idempotensi. Kunci yang sama dengan tanggal dan cara yang sama = replay (200); kunci yang sama dengan nilai lain = 409 `IDEMPOTENCY_KEY_REUSED`; klaim yang sudah dibayar dengan kunci lain = 409 `REIMBURSEMENT_ALREADY_PAID`. Satu klaim tepat satu pembayaran (unik di database). | DRAFT |
| D-11 | **Penyerahan ke payroll** hanya di balik saklar `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED` (bawaan `0`, **tetap mati**). Selama `0`, cara `PAYROLL` ditolak 409 `REIMBURSEMENT_PAYROLL_HANDOFF_DISABLED`. Bila suatu saat `1`, Keuangan dapat mencatat cara `PAYROLL` dengan `payrollMonth` (`YYYY-MM`) — itu hanya catatan bahwa penggantian ikut dibayarkan pada gaji bulan itu dan diinput manual oleh Keuangan; Paket 1 tidak menulis tabel `payroll_*`. Kontrak otomatisnya §9. | DRAFT |
| D-12 | `reimbursements.read` dan `reimbursements.manage` dibawa **`finance_officer`**; `human_capital_admin` hanya `reimbursements.read` (HC membaca, tidak memproses). Keduanya berscope organisasi; Super Admin tidak menerimanya lewat kompatibilitas legacy. | DRAFT |
| D-13 | **Pemisahan tugas:** pemegang `reimbursements.manage` tidak dapat memverifikasi, menolak, atau membayar klaimnya sendiri (403 `REIMBURSEMENT_SELF_ACTION_FORBIDDEN`). Approver dalam rantai klaim itu tidak dapat memverifikasi atau membayarnya (403 `REIMBURSEMENT_APPROVER_CANNOT_PROCESS`). Pemverifikasi boleh orang yang sama dengan pencatat pembayaran (tim Keuangan kecil). | DRAFT |
| D-14 | **Nominal tidak pernah muncul di log, notifikasi, pengingat, atau metadata riwayat.** Nominal hanya ada di kolom uang dan di respons kepada orang yang berhak melihatnya (§6). | ACCEPTED |
| D-15 | Uang disimpan sebagai `bigint` rupiah dan dihitung dengan `bigint`; API membawanya sebagai bilangan bulat JSON; pecahan atau string ditolak 400, tidak dibulatkan. | ACCEPTED |
| D-16 | **Sinyal bukti ganda:** detail Keuangan menandai bukti yang SHA-256-nya juga dipakai klaim lain yang tidak dibatalkan. Hanya peringatan, bukan penolakan otomatis. | DRAFT |
| D-17 | **Laporan:** ringkasan per kategori dan per status dalam rentang tanggal pengajuan; ekspor CSV klaim dengan rentang ≤ 366 hari dan ≤ 20.000 baris (lebih dari itu 422, tidak dipotong). Setiap ekspor dicatat sebagai audit event. | DRAFT |
| D-18 | Pembayaran yang sudah dicatat tidak dapat dikoreksi di Paket 1. | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai (pengaju) | Menyusun, mengubah, dan membuang draf; mengunggah dan menghapus bukti draf; melihat penyetuju; mengajukan; membatalkan sebelum verifikasi; melihat klaim, bukti, tahap, pembayaran, dan riwayat miliknya |
| Approver tahap | Melihat klaim (baris, nominal, bukti, perjalanan) untuk tahap `pending` miliknya dan tahap yang sudah ia putuskan; menyetujui atau menolak tahap `pending` |
| Pemegang `reimbursements.read` (Keuangan, HC) | Register, detail, bukti, ringkasan, ekspor, pencarian pengaju |
| Pemegang `reimbursements.manage` (Keuangan) | Memverifikasi, menolak, mencatat pembayaran — kecuali klaim sendiri dan klaim yang ia setujui (D-13) |
| Sistem | Snapshot rantai, transisi, invarian uang, audit, notifikasi, pengingat |

## 5. Alur dan state

### 5.1 Draf

Precondition: akun `EMPLOYEE` aktif yang terhubung ke pegawai `active`.

Input buat/ubah draf: `title` (5–200), `businessTripId` opsional, `items[]` (1–10; `category`, `expenseDate`, `description` 3–300, `amount`), `idempotencyKey` (UUID, hanya saat membuat). Mengubah draf mengganti seluruh baris.

Pembuatan dalam satu transaksi: kunci baris pegawai (`FOR NO KEY UPDATE`); replay bila kunci sudah dipakai pegawai ini; validasi D-02, D-03, D-06 (tanggal D-04 diperiksa saat pengajuan, tetapi tanggal setelah hari ini langsung ditolak); batas D-07; simpan draf; audit `reimbursement.draft.created`.

Bukti: `POST .../receipts` (base64 JSON, satu berkas per panggilan) hanya untuk draf; berkas ke-11 ditolak 409 `REIMBURSEMENT_TOO_MANY_RECEIPTS`. Menghapus bukti draf mengosongkan ciphertext untuk selamanya (`purged_at`). Audit `reimbursement.receipt.added` / `reimbursement.receipt.removed` (tanpa nama berkas).

Membuang draf: draf → `CANCELLED` dengan alasan tetap "Draf dibuang pegawai"; semua buktinya dihapus isinya; audit `reimbursement.request.cancelled` dengan `by: employee, previousStatus: DRAFT`.

### 5.2 Pengajuan

`POST /reimbursements/me/:id/submit` dalam satu transaksi: kunci klaim; harus `DRAFT` (lainnya 409 `REIMBURSEMENT_NOT_SUBMITTABLE`); pegawai masih aktif; validasi ulang D-02–D-06 dengan tanggal hari ini (`REIMBURSEMENT_EXPENSE_TOO_OLD`, `REIMBURSEMENT_EXPENSE_IN_FUTURE`, `REIMBURSEMENT_RECEIPT_REQUIRED`, `REIMBURSEMENT_TRIP_NOT_ELIGIBLE`); resolusi rantai APR-001 (D-01) — setiap approver harus pegawai aktif dengan akun aktif, atau pengajuan gagal tanpa menyimpan apa pun (`DIRECT_MANAGER_MISSING`, `UNIT_APPROVER_MISSING`, `APPROVAL_CHAIN_EMPTY`, `APPROVER_NOT_ACTIVE`, `APPROVER_ACCOUNT_NOT_READY`); klaim `IN_REVIEW`, tahap pertama `pending`, sisanya `waiting`, snapshot resolusi; audit `reimbursement.request.submitted`; notifikasi approver tahap pertama (tanpa nominal). Pengajuan ulang klaim yang sudah `IN_REVIEW` dijawab 409, bukan diproses dua kali.

Pratinjau penyetuju (`GET /reimbursements/me/approvers`) menjalankan resolusi tanpa menyimpan.

> Konsekuensi yang diketahui: sebelum akun pemimpin diaktifkan, pengajuan di production berhenti di `APPROVER_ACCOUNT_NOT_READY` (APR-001-E). Alurnya diuji dengan data sintetis.

### 5.3 State klaim

```text
DRAFT     -> IN_REVIEW   (pegawai mengajukan)
DRAFT     -> CANCELLED   (pegawai membuang draf)
IN_REVIEW -> APPROVED    (tahap terakhir disetujui)
IN_REVIEW -> REJECTED    (salah satu tahap menolak)
IN_REVIEW -> CANCELLED   (pegawai, dengan alasan)
APPROVED  -> VERIFIED    (Keuangan memverifikasi; total disetujui ditetapkan)
APPROVED  -> REJECTED    (Keuangan menolak, dengan alasan)
APPROVED  -> CANCELLED   (pegawai, dengan alasan)
VERIFIED  -> PAID        (Keuangan mencatat pembayaran)
VERIFIED  -> REJECTED    (Keuangan menolak, dengan alasan)
PAID / REJECTED / CANCELLED -> terminal
```

`rejected_by` membedakan penolakan approver (`APPROVER`) dari Keuangan (`FINANCE`).

### 5.4 State tahap approval

Sama dengan LOAN-001 §5.3: `waiting → pending → approved/rejected`; `waiting/pending → cancelled` saat klaim dibatalkan. Satu tahap `pending` per klaim dijaga indeks unik parsial (APR-001-G). Keputusan mengunci klaim lalu tahap, urutan yang sama dengan pembatalan.

### 5.5 Keputusan approval

Hanya approver yang tersimpan pada tahap `pending` yang memutuskan; lainnya 403 `APPROVAL_FORBIDDEN`. Tahap bukan aktif 409 `STEP_NOT_PENDING`. Menolak mewajibkan catatan (5–1000). Tahap terakhir disetujui → klaim `APPROVED`, pegawai diberi tahu; Keuangan melihatnya di register ("Disetujui, menunggu verifikasi") dan di pengingat §8.

### 5.6 Verifikasi Keuangan

Actor `reimbursements.manage`, bukan pengaju (D-13), bukan approver klaim itu. Precondition `APPROVED`. Input `items[]` (`itemId`, `approvedAmount`) — wajib memuat setiap baris tepat sekali — dan `note`. Dalam satu transaksi: validasi D-09 (`REIMBURSEMENT_APPROVED_EXCEEDS_CLAIM`, `REIMBURSEMENT_REDUCTION_NOTE_REQUIRED`, `REIMBURSEMENT_NOTHING_APPROVED`, `REIMBURSEMENT_ITEMS_MISMATCH`); baris menyimpan `approved_amount`; klaim `VERIFIED` dengan `verified_total`; audit `reimbursement.verified` (metadata: jumlah baris dikurangi, tanpa nominal); notifikasi pegawai. Status lain 409 `REIMBURSEMENT_NOT_VERIFIABLE`.

### 5.7 Pembayaran

Actor `reimbursements.manage`, bukan pengaju, bukan approver. Precondition `VERIFIED`. Input `paidOn`, `method`, `payrollMonth` (hanya `PAYROLL`), `reference`, `note`, `idempotencyKey`. Dalam satu transaksi dengan klaim terkunci: replay/konflik D-10; D-11; tanggal (`REIMBURSEMENT_PAYMENT_DATE`); simpan pembayaran sebesar `verified_total`; klaim `PAID`; audit `reimbursement.paid` (cara, tanggal); notifikasi pegawai tanpa nominal. Status lain 409 `REIMBURSEMENT_NOT_PAYABLE`.

### 5.8 Penolakan Keuangan dan pembatalan

Penolakan Keuangan (D-09): tahap yang tersisa tidak ada (rantai sudah selesai); klaim `REJECTED`, `rejected_by = FINANCE`, alasan disimpan; audit `reimbursement.finance.rejected`; notifikasi pegawai. Status lain 409 `REIMBURSEMENT_NOT_REJECTABLE`.

Pembatalan pegawai (D-08): tahap `waiting`/`pending` menjadi `cancelled`; audit `reimbursement.request.cancelled`. Status lain 409 `REIMBURSEMENT_NOT_CANCELLABLE`.

## 6. Permission dan visibilitas

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `reimbursements.read` | Register, detail, bukti, ringkasan, ekspor, pencarian pengaju | `finance_officer`, `human_capital_admin` |
| `reimbursements.manage` | Verifikasi, penolakan Keuangan, pencatatan pembayaran | `finance_officer` |

Akses pegawai ke klaimnya sendiri adalah kepemilikan dari sesi; klaim pegawai lain tidak dapat dibedakan dari yang tidak ada (404). Akses approver adalah kepemilikan tahap snapshot: approver melihat klaim dan buktinya hanya lewat tahap miliknya yang `pending`, `approved`, atau `rejected`; tahap `waiting` belum membuka apa pun.

`payroll.*` tidak membuka REIMB-001, dan `reimbursements.*` tidak membuka payroll maupun LOAN-001.

Migrasi izin menambah kunci ke role yang sudah ada; `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama (OPS-MI8-REL-001 §4.5: jendela singkat saat build lama belum mengenal kunci baru, tanpa pelebaran izin).

## 7. Audit, riwayat, dan kerahasiaan

Tabel `reimbursement_events` adalah riwayat per klaim sekaligus audit event, append-only (trigger menolak UPDATE/DELETE):

`reimbursement.draft.created`, `reimbursement.draft.updated`, `reimbursement.receipt.added`, `reimbursement.receipt.removed`, `reimbursement.receipt.read`, `reimbursement.request.submitted`, `reimbursement.approval.approved_step`, `reimbursement.request.approved`, `reimbursement.request.rejected`, `reimbursement.request.cancelled`, `reimbursement.verified`, `reimbursement.finance.rejected`, `reimbursement.paid`, dan `reimbursement.register.exported` (tanpa klaim, memuat filter dan jumlah baris).

Metadata hanya berisi id, kategori, tanggal, cara bayar, jumlah baris/berkas, dan `via` (siapa membuka bukti: `APPROVER`/`FINANCE`); **tidak pernah nominal** (D-14). Pembukaan bukti oleh pemiliknya sendiri tidak dicatat; oleh approver atau Keuangan/HC dicatat sebelum byte pertama dikirim (pola EMP-011 D-11).

Kerahasiaan log: sama dengan LOAN-001 §7 — balapan unik yang wajar dipetakan ke 409; galat database lain menjadi 500 yang dicatat dengan kode, nama constraint, dan pesan saja; `detail` (yang memuat baris beserta nominal) dibuang. Pesan CHECK dan trigger hanya menyebut aturan.

## 8. Notifikasi dan pengingat

NOTIF-004 (kategori `system`), tanpa nominal: tahap menjadi `pending` → approver; disetujui akhir / ditolak → pegawai; diverifikasi → pegawai; ditolak Keuangan → pegawai; dibayar → pegawai. Ditulis dalam transaksi transisinya, idempoten per `eventKey`.

NOTIF-003:

- `approval.pending_digest` ikut menghitung tahap reimbursement `pending`;
- aturan baru `reimbursement.finance_queue_digest`: Senin–Sabtu 07.00 WIB, bila ada klaim `APPROVED` (menunggu verifikasi) atau `VERIFIED` (menunggu pembayaran), satu ringkasan per pemegang `reimbursements.manage`, berisi jumlah klaim saja; WhatsApp bawaan nyala (tetap tunduk `WHATSAPP_RECIPIENT_MODE=allowlist`); tautan `/admin/reimbursements`.

## 9. Kontrak penyerahan ke payroll (ditunda)

Status: **ditunda**, sama alasannya dengan LOAN-001 §9 — menunggu keputusan owner bahwa PAY-003 menjadi jalur slip resmi.

1. Saklar D-11 tetap `0` sampai keputusan itu ada; mengubahnya adalah perubahan konfigurasi production yang wajib dilaporkan.
2. Bila dibangun: klaim `VERIFIED` yang diserahkan ke bulan payroll menjadi input komponen non-pajak "Penggantian biaya" pada periode PAY-003 bulan itu, dengan sumber `(period_id, claim_id)` unik; periode `APPROVED` menandai klaim `PAID` dengan cara `PAYROLL`; `reopen` periode mengembalikannya ke `VERIFIED`.
3. Uang tetap `bigint`; perubahan itu menyentuh payroll dan migration, jadi wajib review independen.

## 10. Penyimpanan

```text
reimbursement_claims            klaim, snapshot resolusi, total, verifikasi, penolakan, pembatalan
reimbursement_items             baris biaya; approved_amount diisi saat verifikasi
reimbursement_receipts          bukti terenkripsi (AES-256-GCM, AUTH_ENCRYPTION_KEY), sha256, purged_at
reimbursement_approval_steps    snapshot rantai APR-001
reimbursement_payments          satu pembayaran per klaim, append-only
reimbursement_events            riwayat dan audit, append-only
```

Aturan database (migrasi `0148`):

- semua nominal `bigint` dengan `CHECK` batas atas Rp1.000.000.000 (jauh di bawah 2^53);
- `reimbursement_claims` unik pada `(employee_id, idempotency_key)`; `CHECK` status ⇔ kolom (`VERIFIED`/`PAID` ⇒ `verified_total`, yang tetap tersimpan sebagai riwayat bila Keuangan menolak klaim yang sudah diverifikasi; `PAID` ⇔ `paid_at`, `CANCELLED` ⇔ `cancel_reason`, `REJECTED` ⇔ `rejected_by` dan `reject_reason`);
- **trigger invarian uang yang ditunda sampai COMMIT** (`reimbursement_assert_money`): `claimed_total` = jumlah nominal baris; klaim yang sudah diajukan punya 1–10 baris; `verified_total` = jumlah `approved_amount` dan setiap baris punya `approved_amount` ≤ nominalnya untuk `VERIFIED`/`PAID`, dan tidak ada `approved_amount` sebelum verifikasi; klaim `PAID` punya tepat satu pembayaran sebesar `verified_total`, klaim lain tidak punya pembayaran;
- baris biaya hanya dapat diubah/dihapus selama klaim `DRAFT`; saat `APPROVED` hanya `approved_amount` yang boleh diisi;
- bukti hanya dapat ditambah selama klaim `DRAFT`; perubahan bukti hanya pengosongan isi (purge);
- pembayaran dan event tidak dapat di-UPDATE/DELETE; klaim tidak dapat di-DELETE;
- `reimbursement_approval_steps` unik pada `(claim_id, step_order)`, satu `pending` per klaim;
- tidak ada endpoint hapus selain bukti draf.

Rollback migrasi:

- **Kode:** rilis sebelumnya tidak mendaftarkan route `/reimbursements/*`; tabel baru tidak dibaca kode lama. Rollback rilis aman tanpa menyentuh database.
- **Skema `0148`:** perintah `-- Down:` di berkas migrasi. Hanya selama belum ada klaim di production; setelah ada data, ekspor terenkripsi dulu.
- **Izin `0149`:** `DELETE FROM role_permissions WHERE permission_key LIKE 'reimbursements.%'; DELETE FROM permissions WHERE permission_key LIKE 'reimbursements.%';`.
- **Bantuan `0150`:** lihat `docs/domain/help-center.md` §8.2.

## 11. Data legacy

Sama dengan LOAN-001: **arsip saja**. Klaim legacy (`reimbursements`, lampiran di Google Drive) tidak diimpor; klaim legacy yang belum dibayar diselesaikan Keuangan di luar HCIS atau diajukan ulang pegawai bila owner memutuskan (TBD, `docs/migration/legacy-migration-and-freeze-plan.md`).

## 12. API

Pegawai: `GET /reimbursements/me` (halaman, filter status; juga katalog kategori), `GET /reimbursements/me/trips` (halaman, perjalanan yang dapat ditautkan), `GET /reimbursements/me/approvers`, `GET /reimbursements/me/:id`, `POST /reimbursements/me`, `PUT /reimbursements/me/:id`, `POST /reimbursements/me/:id/receipts`, `DELETE /reimbursements/me/:id/receipts/:receiptId`, `GET /reimbursements/me/:id/receipts/:receiptId`, `POST /reimbursements/me/:id/submit`, `POST /reimbursements/me/:id/cancel`.

Approver: `GET /reimbursements/approvals` (halaman), `GET /reimbursements/approvals/:stepId`, `GET /reimbursements/approvals/:stepId/receipts/:receiptId`, `POST /reimbursements/approvals/:stepId/decision`.

Keuangan/HC: `GET /admin/reimbursements` (halaman; filter status, kategori, pegawai, rentang tanggal pengajuan), `GET /admin/reimbursements/claimants` (typeahead pengaju), `GET /admin/reimbursements/summary`, `GET /admin/reimbursements/export.csv`, `GET /admin/reimbursements/:id`, `GET /admin/reimbursements/:id/receipts/:receiptId`, `POST /admin/reimbursements/:id/verify`, `POST /admin/reimbursements/:id/reject`, `POST /admin/reimbursements/:id/pay`.

Kontrak lengkap: `docs/api/reimbursements.openapi.yaml`. Daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`, filter dan scope sebelum `LIMIT`. Detail klaim memuat ≤ 10 baris, ≤ 10 bukti, satu pembayaran, tahap, dan riwayat satu klaim (dibatasi klaimnya sendiri). Filter pegawai di register memakai typeahead atas **pengaju saja**. Pilihan perjalanan dinas di formulir memuat 50 perjalanan terbaru milik pegawai dengan tombol "Tampilkan perjalanan lebih lama" (halaman berikutnya), tidak pernah dipotong diam-diam. Ringkasan adalah agregat; ekspor adalah `export` dengan batas tegas D-17.

## 13. Layar

- Pegawai: `/app/reimbursements` di Keuangan Saya — daftar berhalaman; formulir draf (judul, perjalanan opsional, baris biaya dengan kategori dan batasnya, input rupiah tanpa pecahan); unggah bukti dari kamera/berkas; pratinjau penyetuju; kirim; detail dengan tahap, verifikasi, pembayaran, riwayat; buang draf dan batalkan.
- Approver: bagian "Reimbursement" di halaman Persetujuan, menampilkan total, baris, dan tautan bukti.
- Keuangan/HC: `/admin/reimbursements` — register berhalaman dengan filter status, kategori, typeahead pengaju, dan rentang tanggal; ringkasan per kategori; unduh CSV; detail dengan bukti (tanda bukti ganda), formulir verifikasi per baris, tolak, catat pembayaran. Pemegang `reimbursements.read` saja tidak melihat tombol tindakan.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada di ketiga layar.

## 14. Acceptance criteria

- REIMB-001-A: pegawai aktif dapat menyusun draf, mengunggah bukti, dan mengajukan; pegawai lain tidak dapat membaca, mengubah, membatalkan, atau mengunduh bukti klaim itu (404).
- REIMB-001-B: rantai approval disnapshot saat pengajuan; mengubah atasan sesudahnya tidak mengubah tahap tersimpan.
- REIMB-001-C: approver yang tidak memegang tahap aktif menerima 403; approver tahap `waiting` belum dapat membuka klaim; keputusan ganda hanya menghasilkan satu transisi.
- REIMB-001-D: resolver yang gagal atau approver dengan akun belum aktif menggagalkan pengajuan tanpa mengubah draf.
- REIMB-001-E: kategori tak dikenal, nominal di atas batas kategori atau total, pecahan rupiah, tanggal di masa depan atau lebih dari 90 hari, klaim tanpa bukti, dan perjalanan orang lain ditolak; pembuatan draf dengan kunci yang sama di-replay.
- REIMB-001-F: verifikasi hanya dari `APPROVED` oleh pemegang `reimbursements.manage`; nominal disetujui tidak melebihi klaim; pengurangan mewajibkan catatan.
- REIMB-001-G: pembayaran hanya dari `VERIFIED`, sebesar total disetujui; ulangan dengan kunci yang sama tidak menggandakan; kunci lain pada klaim yang sudah dibayar ditolak.
- REIMB-001-H: cara `PAYROLL` ditolak selama saklar D-11 mati.
- REIMB-001-I: riwayat, notifikasi, dan pengingat tidak memuat nominal.
- REIMB-001-J: tanpa `reimbursements.read` register, ringkasan, ekspor, dan bukti menjawab 403; tanpa `reimbursements.manage` tindakan menjawab 403; Super Admin legacy dan izin payroll tidak menerima `reimbursements.*`.
- REIMB-001-K: pemegang `reimbursements.manage` tidak dapat memproses klaimnya sendiri, dan approver klaim tidak dapat memverifikasi atau membayarnya.
- REIMB-001-L: database menolak total yang tidak sama dengan baris, `verified_total` yang tidak sama dengan baris, pembayaran yang tidak sama dengan total disetujui, perubahan baris setelah diajukan, dan perubahan/penghapusan pembayaran atau riwayat.
- REIMB-001-M: tidak ada tabel, kolom, atau trigger REIMB-001 yang membaca atau menulis tabel `payroll_*`.

Bukti test: `apps/api/test/reimbursements.test.ts` (aturan domain dan penjaga route) dan `apps/api/test/reimbursements.postgres.test.ts` (A–L di atas skema nyata, termasuk tamper database); `apps/web/src/lib/reimbursements.test.ts`.

## 15. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai | Legacy |
| --- | --- | --- | --- |
| D-01 | Siapa yang menyetujui? | Atasan langsung → approver unit; Keuangan memverifikasi dan membayar | Garis atasan → (Kabid > Rp1 jt) → (Direktur > Rp3 jt) → Finance Head |
| D-02 | Kategori dan batas per baris? | Transportasi Rp3 jt, Akomodasi Rp2 jt, Konsumsi Rp1 jt, Operasional Rp2 jt, Lainnya Rp1 jt | 4 kategori, tanpa batas |
| D-03 | Batas per klaim? | 1–10 baris, min Rp1.000/baris, total ≤ Rp10 jt | Satu nominal, min Rp1.000, tanpa maksimum |
| D-04 | Umur bukti? | ≤ 90 hari | Tidak dibatasi |
| D-05 | Berkas bukti? | 1–10, PDF/JPG/PNG ≤ 4 MB | 1–5, PDF/JPG/PNG/WEBP ≤ 5 MB |
| D-08 | Kapan pegawai boleh membatalkan? | Sampai sebelum verifikasi Keuangan | Hanya sebelum keputusan pertama |
| D-10/D-11 | Siapa dan bagaimana membayar? | Keuangan, tunai/transfer di luar payroll; payroll di balik saklar mati | Finance Head menandai dibayar |
| D-12 | Siapa mengelola? | Staf Keuangan; HC hanya membaca | Finance Head, Super Admin |
| D-18 | Koreksi pembayaran? | Belum ada | Tidak ada |
