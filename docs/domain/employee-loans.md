# Pinjaman Pegawai

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** LOAN-001
**Tanggal:** 2026-11-02
**Terkait:** APR-001, ORG-002, ORG-004, PAY-001, PAY-002, PAY-003, NOTIF-004, AUTH-011, ENG-LIST-001, TRIP-001
**Roadmap:** `docs/product/roadmap.md` §G, `docs/product/hcis-capability-map.md` §5, `docs/design/employee-self-service-experience.md` (Keuangan Saya)

## 1. Tujuan

Pegawai YSQ kadang membutuhkan pinjaman (kasbon) untuk keperluan mendesak. Di HCIS legacy (Laravel `hcysq/hcis-ysq`) modul pinjaman sudah ada, tetapi jadwal cicilannya tidak pernah tersambung ke gaji: potongan di slip datang dari kolom `POTONGAN KASBON` spreadsheet Keuangan yang diketik ulang tiap bulan. Akibatnya sisa pinjaman tidak dapat dipercaya dan tidak ada jejak siapa mencatat pembayaran.

Yang dituju Paket 1:

- pegawai mengajukan pinjaman dari HCIS dan melihat status, jadwal cicilan, pembayaran, dan sisanya;
- persetujuan berjalan lewat approval engine APR-001 yang sama dengan cuti dan perjalanan dinas: rantai disnapshot saat pengajuan;
- Keuangan mencatat **pencairan**, yang sekaligus menetapkan jadwal cicilan;
- Keuangan mencatat **pembayaran** (termasuk potongan gaji yang tampil di slip resmi) dan **pelunasan**, dan dapat **mengoreksi** pembayaran yang salah tanpa menghapusnya;
- sisa pinjaman selalu sama dengan pokok dikurangi pembayaran yang berlaku, dan database menolak keadaan lain;
- setiap langkah tercatat sebagai riwayat dan audit event.

## 2. Batas

Termasuk (Paket 1):

- pengajuan oleh pegawai untuk dirinya sendiri, dengan pratinjau cicilan dan penyetuju;
- persetujuan berurutan oleh atasan langsung lalu approver unit (APR-001);
- pencairan, jadwal cicilan, pencatatan pembayaran, pelunasan, dan koreksi pembayaran oleh Keuangan;
- pembatalan sebelum pencairan oleh pegawai atau Keuangan;
- register Keuangan/HC dengan filter status dan pencarian peminjam (typeahead);
- notifikasi in-app melalui NOTIF-004.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| **Potongan cicilan otomatis lewat payroll** | PAY-003 belum lulus parallel run, dan AGENTS.md §5 melarang mengubah jalur slip resmi PAY-001/PAY-002. Paket 1 tidak membaca maupun menulis tabel `payroll_*`. Kontraknya ditulis di §9 sebagai **Paket 2**. |
| Bunga, biaya administrasi, denda keterlambatan | D-02: pinjaman tanpa bunga. Tidak ada kolom untuknya. |
| Restrukturisasi (ubah tenor/nominal setelah cair), penghapusan (write-off) | Belum ada aturan. Koreksi hanya lewat pembayaran dan koreksi pembayaran (D-12). |
| Plafon berbasis gaji atau batas cicilan per gaji | Membaca gaji membutuhkan data payroll yang belum resmi di HCIS. Keuangan menilainya saat mencairkan (D-03). |
| Penyelesaian sisa pinjaman saat pegawai berhenti | Paket 2 (§9.3). Paket 1 hanya menampilkan sisa di register. |
| Migrasi pinjaman legacy | Keputusan D5 rencana migrasi: arsip saja (§11). |
| Nomor pinjaman / surat perjanjian | Legacy memakai `KSB-YYYYMM-NNN` dan surat persetujuan `SPP`. Belum dibangun; identitas pinjaman di Paket 1 adalah id-nya. |
| Pemberitahuan ke Ketua Yayasan untuk total pinjaman ≥ Rp2.000.000 | Ada di legacy sebagai notifikasi informasi saja. Tidak dibawa sampai ada keputusan (D-01). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Persetujuan memakai **APR-001 dengan rantai atasan langsung → approver unit**, sama dengan Cuti Tahunan dan TRIP-001. Kunci alur rollout ORG-004: `LOAN`; tanpa baris rollout, mode `LEGACY`. **Keuangan bukan tahap approval**, tetapi pencairan oleh Keuangan adalah gerbang terakhir: Keuangan dapat membatalkan pinjaman yang sudah disetujui sebelum mencairkannya. Legacy memakai rantai lebih panjang (versi lama: slot tetap HCM → Keuangan → Yayasan; versi baru: garis atasan → Kepala HCM → Kepala Keuangan → Direktur) yang tidak dapat dipetakan tanpa resolver jabatan; resolver APR-001 tidak boleh membaca teks jabatan. | DRAFT |
| D-02 | **Tanpa bunga**, sesuai praktik lembaga keagamaan dan legacy. Total cicilan = pokok. | DRAFT |
| D-03 | Pokok **Rp100.000 sampai Rp10.000.000**, bilangan bulat rupiah. Batas bawah dari legacy; legacy tidak punya batas atas. | DRAFT |
| D-04 | Tenor **3, 6, atau 12 bulan**, sama dengan pilihan legacy. | DRAFT |
| D-05 | **Tidak ada syarat masa kerja**; syaratnya hanya pegawai `active` dengan akun aktif (sama dengan legacy). | DRAFT |
| D-06 | **Satu pinjaman terbuka per pegawai** (`IN_REVIEW`, `APPROVED`, `DISBURSED`), sama dengan legacy. Dijaga route dan indeks unik parsial database. | DRAFT |
| D-07 | Cicilan = pokok ÷ tenor **dibulatkan ke bawah ke Rp1.000**; **cicilan terakhir menanggung sisanya**, sehingga jumlah jadwal selalu tepat sama dengan pokok. Contoh Rp1.000.000 / 3 = Rp333.000, Rp333.000, Rp334.000. | DRAFT |
| D-08 | Pembatalan hanya **sebelum pencairan**: pegawai atau Keuangan, status `IN_REVIEW`/`APPROVED`, alasan wajib. Setelah cair, pinjaman hanya selesai lewat pelunasan. | DRAFT |
| D-09 | Pencairan oleh Keuangan: tanggal cair tidak setelah hari ini dan tidak sebelum persetujuan akhir (WIB); cara `CASH` atau `TRANSFER`; cicilan pertama paling cepat **bulan setelah pencairan** (default bulan itu) dan paling lambat tiga bulan sesudahnya, karena jadwal tidak dapat dikoreksi. Jadwal dibuat sekali dan tidak dapat diubah. | DRAFT |
| D-10 | Pembayaran: nominal bulat positif, **tidak boleh melebihi sisa**, tanggal antara tanggal cair dan hari ini. Cara `CASH`, `TRANSFER`, atau `PAYROLL_DEDUCTION` (potongan gaji yang **dicatat manual** setelah tampil di slip resmi). Pembayaran sebesar sisa = **pelunasan**; status menjadi `PAID_OFF`. Pembayaran sebagian dan pelunasan dipercepat diperbolehkan. | DRAFT |
| D-11 | Pembayaran mengisi cicilan **paling awal lebih dulu**. Karena pengisiannya kumulatif, status tiap cicilan dihitung dari total pembayaran yang berlaku; tidak ada alokasi yang disimpan, sehingga koreksi tidak meninggalkan sisa alokasi. Cicilan yang bulannya sudah lewat dan belum lunas ditandai "lewat bulan". | ACCEPTED |
| D-12 | Pembayaran tidak pernah dihapus. Kesalahan dikoreksi dengan menandai pembayaran `REVERSED` beserta alasan (10–500); sisa dan status dihitung ulang (pinjaman lunas dapat kembali `DISBURSED`). | DRAFT |
| D-13 | `loans.read` dan `loans.manage` dibawa **`finance_officer`** ("Staf Keuangan (Kasbon)", pemegang register kasbon PAY-003). `human_capital_admin` hanya membawa `loans.read`. Keduanya berscope organisasi; Super Admin tidak menerimanya lewat kompatibilitas legacy. | DRAFT |
| D-14 | **Pemisahan tugas:** pemegang `loans.manage` tidak dapat mencairkan, mencatat atau mengoreksi pembayaran, maupun membatalkan pinjamannya sendiri (403 `LOAN_SELF_ACTION_FORBIDDEN`). Approver dalam rantai pinjaman itu (sudah memutuskan atau belum) tidak dapat mencairkannya (403 `LOAN_APPROVER_CANNOT_DISBURSE`), sehingga tidak ada satu orang yang membawa pinjaman dari persetujuan sampai uang keluar. Pemohon tidak pernah menjadi approver-nya sendiri (resolver APR-001 membuangnya). | ACCEPTED |
| D-15 | **Nominal tidak pernah muncul di log, notifikasi, atau metadata riwayat.** Nominal hanya ada di kolom uang dan di respons kepada orang yang berhak melihatnya (§6). | ACCEPTED |
| D-16 | Uang disimpan sebagai `bigint` rupiah dan dihitung dengan `bigint` di domain; tidak pernah floating point. API membawanya sebagai bilangan bulat JSON; pecahan atau string ditolak 400, tidak dibulatkan. | ACCEPTED |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai (pemohon) | Pratinjau cicilan dan penyetuju, mengajukan, membatalkan sebelum cair, melihat jadwal, pembayaran, sisa, dan riwayat miliknya |
| Approver tahap aktif | Melihat pemohon, keperluan, pokok, dan tenor pada antreannya; menyetujui atau menolak tahap `pending` miliknya |
| Pemegang `loans.read` (Keuangan, HC) | Register seluruh pinjaman beserta jadwal, pembayaran, dan riwayat; pencarian peminjam |
| Pemegang `loans.manage` (Keuangan) | Mencairkan, mencatat pembayaran dan pelunasan, mengoreksi pembayaran, membatalkan sebelum cair — kecuali pinjamannya sendiri (D-14) |
| Sistem | Snapshot rantai, transisi, jadwal, invarian uang, audit, notifikasi |

## 5. Alur dan state

### 5.1 Pengajuan

Precondition: akun `EMPLOYEE` aktif yang terhubung ke pegawai `active`, tanpa pinjaman terbuka (D-06).

Input: `principal` (bilangan bulat rupiah), `tenorMonths` (3/6/12), `purpose` (10–1000), `idempotencyKey` (UUID).

Langkah, dalam satu transaksi:

1. kunci baris pegawai (`FOR UPDATE`), sehingga dua pengajuan bersamaan diperiksa berurutan;
2. bila `idempotencyKey` sudah dipakai pegawai ini, kembalikan pengajuan yang sama (replay, bukan duplikat);
3. validasi D-03, D-04, D-06;
4. resolusi rantai APR-001 (D-01): atasan langsung dan approver unit menjadi pegawai konkret, pemohon dibuang, approver ganda digabung;
5. setiap approver harus pegawai aktif dengan akun aktif; bila tidak, pengajuan **gagal** dengan pesan konfigurasi — tidak ada rantai setengah jadi;
6. simpan pinjaman `IN_REVIEW`, tahap pertama `pending`, sisanya `waiting`, snapshot resolusi;
7. audit `loan.request.submitted`, notifikasi ke approver tahap pertama (tanpa nominal).

Pratinjau (`POST /loans/me/preview`) menjalankan langkah 3–5 tanpa menyimpan dan mengembalikan perkiraan jadwal dengan cicilan pertama bulan depan; bulan pastinya ditetapkan saat pencairan.

Kegagalan (409 kecuali disebut lain): `LOAN_PRINCIPAL_OUT_OF_RANGE`, `LOAN_TENOR_OUT_OF_RANGE`, `LOAN_ALREADY_OPEN`, `DIRECT_MANAGER_MISSING`, `UNIT_APPROVER_MISSING`, `APPROVAL_CHAIN_EMPTY`, `APPROVER_NOT_ACTIVE`, `APPROVER_ACCOUNT_NOT_READY`; input tidak valid (termasuk pecahan rupiah) 400 `INVALID_LOAN_REQUEST`; akun bukan pegawai aktif 403 `EMPLOYEE_NOT_ACTIVE`.

> Konsekuensi yang diketahui: sebelum akun pemimpin diaktifkan, pengajuan di production berhenti di `APPROVER_ACCOUNT_NOT_READY`. Itu perilaku yang benar (APR-001-E). Alurnya diuji dengan data sintetis di test integrasi.

### 5.2 State pinjaman

```text
IN_REVIEW -> APPROVED      (tahap terakhir disetujui)
IN_REVIEW -> REJECTED      (salah satu tahap menolak)
IN_REVIEW -> CANCELLED     (pegawai atau Keuangan, dengan alasan)
APPROVED  -> DISBURSED     (Keuangan mencairkan; jadwal dibuat)
APPROVED  -> CANCELLED     (pegawai atau Keuangan, dengan alasan)
DISBURSED -> PAID_OFF      (pembayaran yang berlaku = pokok)
PAID_OFF  -> DISBURSED     (pembayaran dikoreksi, D-12)
REJECTED / CANCELLED -> terminal
```

`APPROVED` dan `DISBURSED` dipisah karena persetujuan atasan bukan penyerahan uang. Legacy menyatukannya (`approved_at` = `disbursed_at`), sehingga tanggal cair yang sebenarnya hilang.

### 5.3 State tahap approval

```text
waiting -> pending -> approved
                   -> rejected
waiting/pending -> cancelled   (pinjaman dibatalkan; riwayat tahap tidak dihapus)
```

Satu tahap `pending` per pinjaman dijaga indeks unik parsial (APR-001-G). Keputusan mengunci baris pinjaman lalu tahap (`FOR UPDATE`), urutan yang sama dengan pembatalan, sehingga keputusan yang berbarengan dengan pembatalan menunggu, bukan deadlock.

### 5.4 Keputusan approval

Hanya approver yang tersimpan pada tahap `pending` yang dapat memutuskan; lainnya 403 `APPROVAL_FORBIDDEN`. Tahap yang bukan aktif 409 `STEP_NOT_PENDING`. Menolak mewajibkan catatan (5–1000). Menyetujui tahap terakhir membuat pinjaman `APPROVED` dan memberi tahu pegawai; Keuangan melihatnya di register dengan filter "Disetujui, menunggu pencairan".

### 5.5 Pencairan

Actor `loans.manage`, bukan pemilik pinjaman (D-14). Precondition `APPROVED` dan pegawai masih `active` (bila tidak: 409 `LOAN_EMPLOYEE_NOT_ACTIVE`; Keuangan membatalkan pinjamannya). Input `disbursedOn`, `method` (`CASH`/`TRANSFER`), `reference` opsional (≤200), `firstDueMonth` opsional (`YYYY-MM`).

Dalam satu transaksi: tolak approver pinjaman itu (D-14), validasi D-09 (`LOAN_DISBURSED_IN_FUTURE`, `LOAN_DISBURSED_BEFORE_APPROVAL`, `LOAN_FIRST_DUE_TOO_EARLY`, `LOAN_FIRST_DUE_TOO_LATE`), buat jadwal D-07 (`tenorMonths` baris), pinjaman → `DISBURSED`, audit `loan.disbursed`, notifikasi pegawai. Status lain: 409 `LOAN_NOT_DISBURSABLE`.

### 5.6 Pembayaran dan pelunasan

Actor `loans.manage`, bukan pemilik. Precondition `DISBURSED` (lainnya 409 `LOAN_NOT_REPAYABLE`). Input `amount`, `paidOn`, `method`, `reference` (≤200, misalnya nomor bukti atau periode slip), `note` (≤500), `idempotencyKey`.

Dalam satu transaksi dengan baris pinjaman terkunci: replay bila kunci sudah dipakai untuk pinjaman ini dengan nominal, tanggal, dan cara yang sama (kunci yang sama dengan nilai lain: 409 `IDEMPOTENCY_KEY_REUSED`; pengajuan pinjaman diperlakukan sama untuk pokok dan tenor); validasi D-10 (`LOAN_PAYMENT_DATE`, `LOAN_PAYMENT_EXCEEDS_BALANCE`); simpan pembayaran; `paid_total` bertambah; status `PAID_OFF` bila sama dengan pokok; audit `loan.payment.recorded` (dan `loan.paid_off`); notifikasi pegawai tanpa nominal.

### 5.7 Koreksi pembayaran

Actor `loans.manage`, bukan pemilik. Alasan 10–500. Pembayaran harus `ACTIVE` dan milik pinjaman itu (lainnya 404 `LOAN_PAYMENT_NOT_FOUND` / 409 `LOAN_PAYMENT_ALREADY_REVERSED`). Pembayaran → `REVERSED` dengan aktor, waktu, dan alasan; `paid_total` berkurang; status dihitung ulang; audit `loan.payment.reversed`; notifikasi pegawai.

### 5.8 Pembatalan

Input `reason` (pegawai 5–500, Keuangan 10–500). Tahap `waiting`/`pending` menjadi `cancelled`. Pembatalan oleh Keuangan memberi tahu pegawai. Status yang tidak mengizinkan: 409 `LOAN_NOT_CANCELLABLE`.

## 6. Permission dan visibilitas nominal

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `loans.read` | Register pinjaman, detail, jadwal, pembayaran, riwayat; pencarian peminjam | `finance_officer`, `human_capital_admin` |
| `loans.manage` | Mencairkan, mencatat dan mengoreksi pembayaran, membatalkan sebelum cair | `finance_officer` |

Akses pegawai ke pinjamannya sendiri adalah kepemilikan dari sesi; pinjaman pegawai lain tidak dapat dibedakan dari yang tidak ada (404). Akses approver adalah kepemilikan tahap snapshot: approver hanya melihat pokok, tenor, keperluan, dan identitas pemohon untuk tahap yang sedang menunggunya.

`payroll.loans.manage` (register kasbon PAY-003) **tidak** membuka LOAN-001, dan `loans.*` tidak membuka PAY-003.

Migrasi `0123` menambah izin ke role yang sudah ada, jadi rilisnya berdiri sendiri (DOC-001 D-17, OPS-MI8-REL-001 §4.5). `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama.

## 7. Audit, riwayat, dan kerahasiaan

Tabel `employee_loan_events` adalah riwayat per pinjaman sekaligus audit event, append-only (trigger menolak UPDATE/DELETE):

`loan.request.submitted`, `loan.approval.approved_step`, `loan.request.approved`, `loan.request.rejected`, `loan.request.cancelled`, `loan.disbursed`, `loan.payment.recorded`, `loan.payment.reversed`, `loan.paid_off`.

Setiap event memuat aktor, waktu (`clock_timestamp()`), dan metadata aman: id tahap/pembayaran, cara bayar, tanggal, bulan cicilan pertama, jumlah cicilan, tenor. **Tidak pernah nominal** (D-15). Alasan penolakan, pembatalan, dan koreksi disimpan sebagai `note`. Nominal pembayaran dibaca dari `employee_loan_payments`, yang juga append-only kecuali transisi `ACTIVE → REVERSED`.

Kerahasiaan log: PostgreSQL menaruh baris yang gagal — termasuk nominal — di `detail` galat. Route pinjaman memetakan balapan unik yang wajar (pinjaman terbuka kedua, tahap aktif, kunci idempotensi) ke 409. Galat database lain — termasuk CHECK atau trigger invarian uang, yang berarti cacat kode, bukan balapan — menjadi 500 yang **dicatat** dengan kode, nama constraint, dan pesan saja; `detail` dibuang sebelum mencapai error handler. Pesan CHECK dan trigger hanya menyebut aturan, tidak pernah angka.

## 8. Notifikasi (NOTIF-004, kategori `system`)

- tahap menjadi `pending` → approver tahap itu;
- disetujui akhir / ditolak → pegawai;
- dicairkan (menyebut bulan cicilan pertama) → pegawai;
- pembayaran dicatat, pelunasan, koreksi pembayaran → pegawai;
- dibatalkan oleh Keuangan → pegawai.

Judul dan isi notifikasi tidak memuat nominal (D-15). Notifikasi ditulis dalam transaksi yang sama dengan transisinya dan idempoten per `eventKey`.

## 9. Kontrak Paket 2 dengan payroll (belum dibangun)

### 9.1 Kondisi hari ini

- Jalur slip resmi tetap PAY-001/PAY-002 (impor). Potongan kasbon di slip datang dari data impor, bukan dari LOAN-001.
- PAY-003 sudah punya register kasbon sendiri (`payroll_loans`, `payroll_loan_deductions`, komponen `LOAN` "Potongan kasbon", izin `payroll.loans.manage`) yang dipakai mesin hitung selama parallel run (`docs/domain/payroll-calculation-v1.md` §3.4).
- Di Paket 1, Keuangan mencatat potongan gaji yang tampil di slip resmi sebagai pembayaran `PAYROLL_DEDUCTION` di LOAN-001, dengan periode slip di `reference`. Selama parallel run PAY-003, Keuangan masih mengisi register kasbon PAY-003 secara terpisah; kedua register belum saling membaca.

### 9.2 Kontrak yang dibangun setelah PAY-003 lulus parallel run

1. **Satu sumber pinjaman.** Pinjaman LOAN-001 yang `DISBURSED` menjadi sumber register kasbon PAY-003: `payroll_loans` mendapat kolom `employee_loan_id` (unik, nullable untuk kasbon lama), dan pencairan LOAN-001 membuat barisnya dengan `principal` = pokok dan `instalment` = cicilan dasar D-07. Kasbon tidak lagi diketik dua kali.
2. **Usulan potongan per periode.** Mesin PAY-003 mengusulkan potongan periode = jumlah cicilan yang jatuh pada bulan periode dan belum lunas menurut D-11, dibatasi sisa pinjaman. Keuangan tetap dapat mengubahnya per periode (perilaku `payroll_loan_deductions` hari ini), dan aturan kunci di `CALCULATED` tetap berlaku.
3. **Potongan final menjadi pembayaran.** Saat periode mencapai `APPROVED`, setiap `payroll_loan_deductions` yang tertaut ke pinjaman LOAN-001 menulis satu pembayaran `PAYROLL_DEDUCTION` dengan sumber `(period_id, loan_id)` yang unik, sehingga ulangan tidak menggandakan. Pembukaan ulang periode (`reopen`) membalik pembayaran itu lewat koreksi D-12 dengan alasan otomatis.
4. **Tidak ada potongan melebihi sisa** — sudah menjadi blocker PAY-003 (`PAYROLL_LOAN_EXCEEDS_BALANCE`); sisa yang dipakai adalah sisa LOAN-001.
5. **Uang tetap `bigint` rupiah** di kedua sisi; tidak ada pembulatan baru.
6. Perubahan ini menyentuh payroll dan migration, jadi wajib review independen dan baru boleh setelah keputusan pemilik bahwa PAY-003 menjadi jalur slip resmi.

### 9.3 Pemberhentian (Paket 2)

Dialog Pemberhentian (EMP) menampilkan peringatan bila pegawai masih punya pinjaman `DISBURSED` dengan sisa, seperti peringatan aset ASSET-001. Peringatan tidak memblokir (DRAFT); penyelesaian sisa lewat pelunasan tunai atau potongan gaji terakhir dicatat Keuangan dengan D-10.

## 10. Penyimpanan

```text
employee_loans                pinjaman, snapshot resolusi, pencairan, paid_total
employee_loan_approval_steps  snapshot rantai APR-001
employee_loan_instalments     jadwal, dibuat sekali saat pencairan, tidak dapat diubah
employee_loan_payments        pembayaran append-only; koreksi = status REVERSED
employee_loan_events          riwayat dan audit, append-only
```

Aturan database (migrasi `0122`):

- semua nominal `bigint` dengan `CHECK` 0 < nominal ≤ 1.000.000.000 (jauh di bawah 2^53, aman sebagai bilangan bulat JSON);
- `employee_loans` unik pada `(employee_id, idempotency_key)`; indeks unik parsial satu pinjaman terbuka per pegawai (D-06);
- `CHECK` status: `DISBURSED`/`PAID_OFF` ⇔ data pencairan lengkap; `paid_total` 0 sebelum cair; `PAID_OFF` ⇔ `paid_total = principal_amount` ⇔ `paid_off_at` terisi; `0 ≤ paid_total ≤ principal_amount`;
- **trigger invarian uang yang ditunda sampai COMMIT** (`employee_loan_assert_money`): pinjaman cair punya tepat `tenor_months` cicilan yang jumlahnya sama dengan pokok; pinjaman yang belum cair tidak punya cicilan atau pembayaran; `paid_total` sama dengan jumlah pembayaran `ACTIVE`;
- cicilan dan event tidak dapat di-UPDATE/DELETE; pinjaman dan pembayaran tidak dapat di-DELETE; pembayaran hanya dapat berubah `ACTIVE → REVERSED` beserta kolom koreksinya;
- catatan pengujian: test integrasi menjalankan trigger tertunda lewat `SET CONSTRAINTS ALL IMMEDIATE`, karena COMMIT route menjadi savepoint di dalam transaksi test;
- `employee_loan_approval_steps` unik pada `(loan_id, step_order)`, satu `pending` per pinjaman;
- tidak ada endpoint hapus.

Rollback migrasi:

- **Kode:** rilis sebelumnya tidak mendaftarkan route `/loans/*`; tabel baru tidak dibaca kode lama, jadi rollback rilis aman tanpa menyentuh database.
- **Skema `0122`:** perintah `-- Down:` di berkas migrasi. Hanya boleh dijalankan selama belum ada pinjaman di production; setelah ada data, ekspor terenkripsi dulu (data uang tidak boleh hilang diam-diam).
- **Izin `0123`:** `DELETE FROM role_permissions WHERE permission_key LIKE 'loans.%'; DELETE FROM permissions WHERE permission_key LIKE 'loans.%';`.

## 11. Data legacy

Rencana migrasi (`docs/migration/legacy-migration-and-freeze-plan.md`, D5) mengusulkan **arsip saja** untuk pinjaman legacy, karena rekonsiliasi sisa pinjaman kritis dan data cicilan legacy tidak tersambung ke slip. LOAN-001 Paket 1 tidak mengimpor apa pun. Pinjaman legacy yang masih berjalan dicatat ulang oleh Keuangan sebagai pinjaman baru hanya bila pemilik memutuskan demikian (TBD, bagian D5).

## 12. API

Pegawai: `GET /loans/me` (halaman), `GET /loans/me/:id`, `POST /loans/me/preview`, `POST /loans/me`, `POST /loans/me/:id/cancel`.

Approver: `GET /loans/approvals` (halaman), `POST /loans/approvals/:stepId/decision`.

Keuangan/HC: `GET /admin/loans` (halaman, filter status dan pegawai), `GET /admin/loans/borrowers` (typeahead peminjam, halaman), `GET /admin/loans/:id`, `POST /admin/loans/:id/disburse`, `POST /admin/loans/:id/payments`, `POST /admin/loans/:id/payments/:paymentId/reverse`, `POST /admin/loans/:id/cancel`.

Kontrak lengkap: `docs/api/employee-loans.openapi.yaml`, tag `Employee Loans`. Daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`, filter sebelum `LIMIT`. Detail pinjaman memuat jadwal (≤12 baris, D-04) dan pembayaran satu pinjaman, dibatasi oleh pinjamannya sendiri. Filter pegawai di register memakai typeahead atas **peminjam saja**, sehingga `loans.read` tidak membuka direktori pegawai yang lebih luas.

## 13. Layar

- Pegawai: `/app/loans` di Keuangan Saya — formulir dengan input rupiah tanpa pecahan, pilihan tenor, pratinjau cicilan dan penyetuju; daftar berhalaman; detail dengan sisa, jadwal, pembayaran, tahap, riwayat; tombol batal sebelum cair.
- Approver: bagian "Pinjaman" di halaman Persetujuan, menampilkan pokok dan tenor.
- Keuangan/HC: `/admin/loans` — register berhalaman dengan filter status dan typeahead peminjam; detail; formulir pencairan; formulir pembayaran dengan tombol isi sisa untuk pelunasan; koreksi per pembayaran; batalkan sebelum cair. Pemegang `loans.read` saja tidak melihat tombol tindakan.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada di ketiga layar.

## 14. Acceptance criteria

- LOAN-001-A: pegawai aktif dapat mengajukan dan melihat pinjamannya; pegawai lain tidak dapat membaca atau membatalkannya.
- LOAN-001-B: rantai approval disnapshot saat pengajuan; mengubah atasan sesudahnya tidak mengubah tahap yang tersimpan.
- LOAN-001-C: approver yang tidak memegang tahap aktif menerima 403; keputusan ganda hanya menghasilkan satu transisi.
- LOAN-001-D: resolver yang gagal atau approver dengan akun belum aktif menggagalkan pengajuan tanpa menyimpan apa pun.
- LOAN-001-E: pokok/tenor di luar batas, pecahan rupiah, dan pinjaman terbuka kedua ditolak; pengajuan dengan kunci yang sama di-replay.
- LOAN-001-F: pencairan hanya dari `APPROVED` oleh pemegang `loans.manage`, menghasilkan jadwal yang jumlahnya tepat sama dengan pokok; cicilan pertama tidak sebelum bulan setelah pencairan.
- LOAN-001-G: pembayaran mengisi cicilan paling awal lebih dulu, tidak dapat melebihi sisa, dan pembayaran sebesar sisa membuat pinjaman `PAID_OFF`.
- LOAN-001-H: koreksi pembayaran tidak menghapus apa pun, menghitung ulang sisa, dan dapat mengembalikan pinjaman lunas ke `DISBURSED`.
- LOAN-001-I: riwayat dan notifikasi tidak memuat nominal.
- LOAN-001-J: tanpa `loans.read` register menjawab 403; tanpa `loans.manage` tindakan menjawab 403; Super Admin legacy dan `payroll.loans.manage` tidak menerima `loans.*`.
- LOAN-001-K: pemegang `loans.manage` tidak dapat memproses pinjamannya sendiri.
- LOAN-001-L: database menolak `paid_total` yang tidak sama dengan pembayaran berlaku, jadwal yang tidak sama dengan pokok, dan perubahan/penghapusan riwayat uang.
- LOAN-001-M: tidak ada tabel, kolom, atau trigger LOAN-001 yang membaca atau menulis tabel `payroll_*`.

## 15. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai | Legacy |
| --- | --- | --- | --- |
| D-01 | Siapa yang menyetujui? | Atasan langsung → approver unit; Keuangan mencairkan | Garis atasan → Kepala HCM → Kepala Keuangan → Direktur |
| D-02 | Ada bunga? | Tidak | Tidak |
| D-03 | Batas pokok? | Rp100.000 – Rp10.000.000 | Min Rp100.000, tanpa maksimum |
| D-04 | Pilihan tenor? | 3, 6, 12 bulan | 3, 6, 12 bulan |
| D-05 | Syarat masa kerja? | Tidak ada, cukup pegawai aktif | Tidak ada |
| D-06 | Boleh dua pinjaman berjalan? | Tidak | Tidak |
| D-07 | Pembulatan cicilan? | Ke bawah Rp1.000, sisa di cicilan terakhir | Dua desimal, sisa di cicilan terakhir |
| D-08 | Pembatalan setelah cair? | Tidak; selesaikan lewat pelunasan | Tidak ada jalur |
| D-10 | Cara bayar dan pelunasan dipercepat? | Tunai, transfer, potong gaji (dicatat manual); sebagian dan pelunasan dipercepat boleh | Tandai satu cicilan lunas |
| D-12 | Koreksi pembayaran? | Ditandai dikoreksi dengan alasan, tidak dihapus | Tidak ada |
| D-13 | Siapa mengelola? | Staf Keuangan (Kasbon); HC hanya membaca | Kepala Keuangan/HCM |
