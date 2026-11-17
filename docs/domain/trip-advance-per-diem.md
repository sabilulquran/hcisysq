# Uang Muka dan Uang Harian Perjalanan Dinas

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** TRIP-002
**Tanggal:** 2026-11-17
**Keputusan produk:** instruksi owner 2026-11-11 "selesaikan dulu semua PRD HCIS" dan instruksi 2026-11-17 untuk membangun yang tercatat "tidak termasuk" di TRIP-001 §2 dan REIMB-001 §2: uang muka perjalanan dinas (advance) dan uang harian (per diem).
**Terkait:** TRIP-001, REIMB-001, APR-001, NOTIF-003, NOTIF-004, AUTH-011, ENG-LIST-001, PAY-003

## 1. Tujuan

Pegawai yang berangkat dinas sering perlu uang sebelum berangkat (tiket, penginapan), dan berhak atas uang harian selama bertugas. TRIP-001 sengaja tidak menyimpan nominal, dan REIMB-001 hanya mengganti biaya yang sudah dikeluarkan. Paket ini menambah:

- **tabel tarif uang harian berversi** per zona perjalanan, dikelola HC/Keuangan;
- **pengajuan uang muka dinas** oleh pegawai untuk perjalanannya sendiri, disetujui lewat APR-001 dengan **rantai yang sama** dengan perjalanannya;
- **pencairan** uang muka oleh Keuangan di luar payroll, idempoten;
- **pertanggungjawaban**: biaya nyata diklaim lewat REIMB-001 dengan menautkan perjalanan, Keuangan memverifikasinya seperti biasa, lalu Keuangan menyelesaikan uang muka: uang harian dihitung dari tarif, klaim terverifikasi diperhitungkan, dan selisihnya dibayar ke pegawai atau dicatat sebagai kewajiban pengembalian pegawai;
- antrean Keuangan dan pengingat NOTIF-003 untuk uang muka yang terlambat dipertanggungjawabkan.

Tidak ada nominal yang ditebak: tarif awal **kosong**, dan HC/Keuangan harus mengisinya sebelum uang harian dapat dihitung.

## 2. Batas

Termasuk: tarif berversi; pengajuan uang muka (boleh Rp0 bila pegawai hanya mengambil uang harian); persetujuan; pencairan; pengajuan pertanggungjawaban; penyelesaian; pembayaran selisih; pencatatan pengembalian (boleh bertahap); register, detail, ekspor CSV beraudit, typeahead pengaju; notifikasi dan pengingat.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Pemotongan gaji untuk pengembalian, pembayaran lewat payroll | Tidak menyentuh payroll (AGENTS.md §5). Pengembalian dicatat Keuangan sebagai uang diterima tunai/transfer. |
| Tarif per golongan/jabatan | Belum ada keputusan; tarif hanya per zona (D-01). Menambah dimensi golongan adalah perubahan skema. |
| Uang harian untuk perjalanan tanpa pengajuan TRIP-002 | Uang harian dihitung saat penyelesaian TRIP-002. Pegawai yang hanya ingin uang harian mengajukan dengan uang muka Rp0 (D-04). |
| Koreksi transaksi yang sudah dicatat | Sama dengan REIMB-001 D-18: transaksi uang muka append-only; kesalahan dicatat di luar HCIS sampai ada keputusan. |
| Perubahan zona atau nominal setelah diajukan | Batalkan lalu ajukan ulang (selama belum dicairkan). |
| Pertanggungjawaban atas nama pegawai yang sudah keluar | Pengajuan pertanggungjawaban memerlukan akun pegawai aktif. Uang muka pegawai yang keluar tetap `DISBURSED` dan terlambat di register; Keuangan menyelesaikannya di luar HCIS sampai ada keputusan (TBD owner). |
| Valuta asing | Semua nominal rupiah bulat. Perjalanan luar negeri memakai tarif rupiah zona `INTERNATIONAL`. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Zona perjalanan** (katalog di kode `modules/trip-advances/domain.ts`): `LOCAL` Dalam kabupaten/kota; `PROVINCIAL` Luar kabupaten/kota, dalam provinsi; `NATIONAL` Luar provinsi; `INTERNATIONAL` Luar negeri. Pegawai memilih zona saat mengajukan; approver dan Keuangan melihatnya. | DRAFT |
| D-02 | **Tarif uang harian berversi**: baris `(zona, berlaku mulai, nominal per hari)`, append-only. Tarif yang berlaku untuk suatu perjalanan = baris zona itu dengan `berlaku mulai` ≤ tanggal berangkat, yang terbaru; bila ada dua baris bertanggal sama, yang dicatat paling akhir menang (koreksi = baris baru, riwayat tetap). Nominal 0–Rp5.000.000 per hari; 0 berarti zona itu tidak mendapat uang harian. **Tabel awal kosong.** Versi baru berlaku paling cepat hari ini; hanya tarif pertama suatu zona (pengisian awal) yang boleh berlaku mundur (409 `TRIP_PER_DIEM_RATE_BACKDATED`), sehingga tarif tidak dapat diubah mundur untuk uang muka yang sudah berjalan. | DRAFT |
| D-03 | **Hari uang harian** = jumlah hari kalender perjalanan, inklusif (TRIP-001 D-03, maks. 30). Perjalanan yang dibatalkan atau ditolak: 0 hari. Keuangan boleh menurunkan jumlah hari saat penyelesaian (misalnya pegawai pulang lebih awal), dengan catatan 10–500 karakter. | DRAFT |
| D-04 | **Pengajuan uang muka**: pegawai, untuk perjalanannya sendiri yang `IN_REVIEW`, `APPROVED`, atau `ISSUED`; satu uang muka hidup per perjalanan (selain `REJECTED`/`CANCELLED`). Nominal Rp0 sampai **Rp10.000.000 + perkiraan uang harian** (hari perjalanan × tarif zona yang berlaku pada tanggal berangkat menurut tabel saat pengajuan; 0 bila tarif belum ada). Rp0 = hanya uang harian, tanpa pencairan. Rincian perkiraan 10–1000 karakter. | DRAFT |
| D-05 | **Persetujuan** memakai APR-001 dengan **rantai yang sama dengan perjalanannya**: approver tahap-tahap perjalanan (snapshot TRIP-001) disalin berurutan, lalu disnapshot pada uang muka. Setiap approver harus pegawai aktif dengan akun aktif, atau pengajuan gagal tanpa menyimpan apa pun (`APPROVER_NOT_ACTIVE`, `APPROVER_ACCOUNT_NOT_READY`). Keuangan bukan tahap approval. | DRAFT |
| D-06 | **Pembatalan** oleh pegawai saat `IN_REVIEW` atau `APPROVED` (sebelum dicairkan), alasan 5–500. **Penolakan Keuangan** dari `APPROVED`, alasan 10–500. Setelah dicairkan, uang muka hanya selesai lewat pertanggungjawaban. | DRAFT |
| D-07 | **Pencairan** oleh Keuangan dari `APPROVED` bila nominal > 0 dan perjalanan masih `APPROVED`/`ISSUED`: nominal selalu = nominal disetujui (tidak diketik), tanggal antara tanggal persetujuan akhir dan hari ini, cara `CASH`/`TRANSFER` **di luar payroll**, nomor bukti ≤ 200, catatan ≤ 500, kunci idempotensi dengan aturan replay REIMB-001 D-10 (`IDEMPOTENCY_KEY_REUSED`, `TRIP_ADVANCE_ALREADY_DISBURSED`). | DRAFT |
| D-08 | **Pengajuan pertanggungjawaban** oleh pegawai dari `DISBURSED` (atau `APPROVED` dengan nominal Rp0), pada/sesudah tanggal kembali, atau kapan saja bila perjalanannya sudah dibatalkan/ditolak. Klaim REIMB-001 pegawai yang tertaut ke perjalanan tidak boleh masih `DRAFT` atau `IN_REVIEW` (`TRIP_ADVANCE_CLAIMS_OPEN`). Catatan opsional ≤ 1000. | DRAFT |
| D-09 | **Tenggat pertanggungjawaban**: **14 hari** setelah tanggal kembali (untuk perjalanan yang dibatalkan: setelah tanggal kembali atau tanggal pembatalan, mana yang lebih awal). Uang muka `DISBURSED` yang melewati tenggat ditandai **terlambat** di register, masuk ringkasan Keuangan, dan pegawai menerima pengingat NOTIF-003 seminggu sekali. | DRAFT |
| D-10 | **Penyelesaian** oleh Keuangan dari `SETTLEMENT_SUBMITTED`: semua klaim REIMB-001 milik pegawai yang tertaut ke perjalanan dan berstatus `VERIFIED` **diperhitungkan** (masing-masing menjadi `PAID` dengan cara `ADVANCE`, sebesar total disetujuinya); klaim yang masih `IN_REVIEW`/`APPROVED` menahan penyelesaian (`TRIP_ADVANCE_CLAIMS_PENDING`). Uang harian = hari (D-03) × tarif (D-02); tarif tidak ada untuk hari > 0 → 409 `TRIP_PER_DIEM_RATE_MISSING` (tidak ada nominal yang ditebak). **Selisih = uang harian + klaim − uang muka.** Selisih 0 → `SETTLED`; > 0 → `AWAITING_TOP_UP`; < 0 → `AWAITING_REFUND`. | DRAFT |
| D-11 | **Selisih kurang dibayar ke pegawai** oleh Keuangan dari `AWAITING_TOP_UP`: satu pembayaran sebesar selisih (tidak diketik), aturan tanggal/cara/idempotensi D-07; lalu `SETTLED`. | DRAFT |
| D-12 | **Selisih lebih adalah kewajiban pengembalian pegawai.** Keuangan mencatat setiap pengembalian yang diterima (boleh bertahap): nominal 1 sampai sisa kewajiban, tanggal antara tanggal penyelesaian dan hari ini, cara `CASH`/`TRANSFER`, kunci idempotensi. Saat sisa 0 → `SETTLED`. Tidak ada pemotongan gaji. | DRAFT |
| D-13 | Selama perjalanan punya uang muka yang belum diselesaikan (`IN_REVIEW`, `APPROVED`, `DISBURSED`, `SETTLEMENT_SUBMITTED`), klaim REIMB-001 tertaut **tidak dibayar sendiri**: `POST /admin/reimbursements/:id/pay` menjawab 409 `REIMBURSEMENT_SETTLED_THROUGH_ADVANCE`. Klaim yang terverifikasi sesudah penyelesaian dibayar biasa. | DRAFT |
| D-14 | Perjalanan yang **dibatalkan sesudah uang muka dicairkan** tetap dapat ditautkan ke klaim REIMB-001 (biaya yang terlanjur keluar, misalnya tiket tak dapat dikembalikan). Perluasan REIMB-001 D-06 hanya untuk perjalanan itu. | DRAFT |
| D-15 | **Izin:** `trip_advances.read` (register, detail, ekspor, typeahead) dibawa `finance_officer` dan `human_capital_admin`; `trip_advances.manage` (tolak, cairkan, selesaikan, bayar selisih, catat pengembalian) hanya `finance_officer`; `trip_per_diem.manage` (mencatat tarif) dibawa `finance_officer` dan `human_capital_admin`. Membaca tarif: `trip_advances.read` atau `trip_per_diem.manage`. Berscope organisasi; Super Admin tidak menerimanya lewat kompatibilitas legacy. | DRAFT |
| D-16 | **Pemisahan tugas:** pemegang `trip_advances.manage` tidak memproses uang mukanya sendiri (403 `TRIP_ADVANCE_SELF_ACTION_FORBIDDEN`). Approver uang muka itu, dan approver klaim REIMB-001 yang diperhitungkan, tidak mencairkan, menyelesaikan, atau membayar selisihnya (403 `TRIP_ADVANCE_APPROVER_CANNOT_PROCESS`); menolak dan mencatat pengembalian (uang masuk) tetap boleh. | DRAFT |
| D-17 | **Nominal tidak pernah muncul di log, notifikasi, pengingat, atau metadata riwayat** (sama dengan REIMB-001 D-14). | ACCEPTED |
| D-18 | Uang `bigint` rupiah, dihitung `bigint`; API membawa bilangan bulat JSON; pecahan/string ditolak 400 (REIMB-001 D-15). | ACCEPTED |
| D-19 | **Ekspor CSV** register: rentang tanggal pengajuan ≤ 366 hari, ≤ 20.000 baris (lebih: 422, tidak dipotong); setiap ekspor dicatat sebagai audit event. | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai | Melihat perkiraan uang harian dan penyetuju, mengajukan uang muka, membatalkan sebelum dicairkan, mengajukan pertanggungjawaban, melihat uang muka, transaksi, klaim yang diperhitungkan, dan riwayat miliknya |
| Approver tahap | Menyetujui/menolak tahap `pending` miliknya |
| `trip_advances.read` (Keuangan, HC) | Register, detail, ekspor, typeahead, membaca tarif |
| `trip_advances.manage` (Keuangan) | Menolak, mencairkan, menyelesaikan, membayar selisih, mencatat pengembalian (D-16) |
| `trip_per_diem.manage` (HC, Keuangan) | Mencatat versi tarif baru |
| Sistem | Snapshot rantai, transisi, invarian uang, audit, notifikasi, pengingat |

## 5. State

```text
IN_REVIEW            -> APPROVED             (tahap terakhir disetujui)
IN_REVIEW            -> REJECTED             (salah satu tahap menolak)
IN_REVIEW / APPROVED -> CANCELLED            (pegawai, alasan)
APPROVED             -> REJECTED             (Keuangan, alasan)
APPROVED             -> DISBURSED            (Keuangan mencairkan; nominal > 0)
APPROVED (Rp0)       -> SETTLEMENT_SUBMITTED (pegawai)
DISBURSED            -> SETTLEMENT_SUBMITTED (pegawai)
SETTLEMENT_SUBMITTED -> SETTLED | AWAITING_TOP_UP | AWAITING_REFUND (Keuangan menyelesaikan)
AWAITING_TOP_UP      -> SETTLED              (Keuangan membayar selisih)
AWAITING_REFUND      -> AWAITING_REFUND      (pengembalian sebagian)
AWAITING_REFUND      -> SETTLED              (pengembalian lunas)
SETTLED / REJECTED / CANCELLED -> terminal
```

Tahap approval: `waiting → pending → approved/rejected`; `waiting/pending → cancelled` saat dibatalkan. Satu `pending` per uang muka (indeks unik parsial).

Kegagalan umum (409 kecuali disebut): `TRIP_ADVANCE_TRIP_NOT_ELIGIBLE`, `TRIP_ADVANCE_EXISTS`, `TRIP_ADVANCE_AMOUNT_ABOVE_LIMIT`, `TRIP_ADVANCE_NOT_CANCELLABLE`, `TRIP_ADVANCE_NOT_REJECTABLE`, `TRIP_ADVANCE_NOT_DISBURSABLE`, `TRIP_ADVANCE_TRIP_NOT_ACTIVE`, `TRIP_ADVANCE_NOT_SETTLEABLE`, `TRIP_ADVANCE_TRIP_NOT_ENDED`, `TRIP_ADVANCE_CLAIMS_OPEN`, `TRIP_ADVANCE_CLAIMS_PENDING`, `TRIP_PER_DIEM_RATE_MISSING`, `TRIP_ADVANCE_PER_DIEM_DAYS`, `TRIP_ADVANCE_REDUCTION_NOTE_REQUIRED`, `TRIP_ADVANCE_NO_TOP_UP_DUE`, `TRIP_ADVANCE_NO_REFUND_DUE`, `TRIP_ADVANCE_REFUND_EXCEEDS_DUE`, `TRIP_ADVANCE_PAYMENT_DATE`, `IDEMPOTENCY_KEY_REUSED`; input tidak valid 400; uang muka orang lain 404 `TRIP_ADVANCE_NOT_FOUND`.

## 6. Alur

### 6.1 Pengajuan

`POST /trip-advances/me` dalam satu transaksi: kunci baris pegawai (`FOR NO KEY UPDATE`); replay bila kunci idempotensi sudah dipakai pegawai ini; kunci perjalanan (milik pegawai, status D-04); tidak ada uang muka hidup; hitung perkiraan dan batas D-04; salin rantai D-05; simpan `IN_REVIEW`, tahap pertama `pending`; audit `trip_advance.request.submitted`; notifikasi approver pertama.

`GET /trip-advances/me/estimate?tripId&zone` menjalankan perhitungan dan resolusi rantai tanpa menyimpan.

### 6.2 Penyelesaian (D-10)

Dalam satu transaksi dengan uang muka terkunci: replay bila kunci penyelesaian sama; kunci klaim tertaut (`FOR UPDATE`); periksa klaim tertunda; hitung hari maksimum, tarif, uang harian; untuk setiap klaim `VERIFIED`: tulis `reimbursement_payments` cara `ADVANCE` sebesar `verified_total`, klaim → `PAID`, riwayat klaim `reimbursement.paid` (metadata `method: ADVANCE`, `tripAdvanceId`), baris `trip_advance_settlement_claims`; simpan hari, tarif (id dan nominal), uang harian, total klaim, selisih; status sesuai D-10; audit `trip_advance.settled` (jumlah klaim, hari, hasil — tanpa nominal); notifikasi pegawai.

## 7. Audit dan riwayat

`trip_advance_events` append-only: `trip_advance.request.submitted`, `trip_advance.approval.approved_step`, `trip_advance.request.approved`, `trip_advance.request.rejected`, `trip_advance.request.cancelled`, `trip_advance.finance.rejected`, `trip_advance.disbursed`, `trip_advance.settlement.submitted`, `trip_advance.settled`, `trip_advance.top_up.paid`, `trip_advance.refund.recorded`, `trip_advance.closed`, `trip_advance.register.exported` (tanpa uang muka), `trip_advance.rate.created` (tanpa uang muka; metadata zona dan tanggal berlaku). Metadata tanpa nominal (D-17). Galat database dibersihkan dari `detail` seperti REIMB-001 §7.

## 8. Notifikasi dan pengingat

NOTIF-004 (kategori `system`, tanpa nominal): tahap `pending` → approver; disetujui/ditolak → pegawai; ditolak Keuangan, dicairkan, diselesaikan, selisih dibayar, lunas → pegawai.

NOTIF-003:

- `approval.pending_digest` ikut menghitung tahap uang muka `pending`;
- `trip_advance.settlement_overdue` (pegawai, 07.00 WIB setiap hari, sekali per minggu keterlambatan per uang muka, WhatsApp bawaan nyala): "uang muka dinas belum dipertanggungjawabkan", tautan `/app/trip-advances`;
- `trip_advance.finance_queue_digest` (pemegang `trip_advances.manage`, Senin–Sabtu 07.00 WIB): jumlah yang menunggu pencairan, penyelesaian, pembayaran selisih, pengembalian, dan yang terlambat; tautan `/admin/trip-advances`.

## 9. Penyimpanan (migrasi `0157`)

```text
trip_per_diem_rates             versi tarif, append-only
trip_advances                   uang muka, snapshot, hasil penyelesaian
trip_advance_approval_steps     snapshot rantai
trip_advance_transactions       DISBURSEMENT / TOP_UP / REFUND, append-only, unik (advance, idempotency_key)
trip_advance_settlement_claims  klaim REIMB-001 yang diperhitungkan, append-only, satu klaim satu uang muka
trip_advance_events             riwayat dan audit, append-only
```

`reimbursement_payments.method` menerima `ADVANCE`. Trigger invarian uang yang ditunda sampai COMMIT (`trip_advance_assert_money`): pencairan tepat satu sebesar nominal untuk status pasca-pencairan dan tidak ada sebelum itu; `per_diem_amount = hari × tarif`; `selisih = uang harian + total klaim − nominal`; total klaim = jumlah `verified_total` klaim yang diperhitungkan, dan setiap klaim itu milik pegawai dan perjalanan yang sama serta `PAID`; `AWAITING_TOP_UP` ⇒ selisih > 0 tanpa pembayaran selisih, `SETTLED` dengan selisih > 0 ⇒ tepat satu pembayaran selisih sebesar selisih; pengembalian tidak melebihi kewajiban dan lunas saat `SETTLED`. Pembayaran REIMB-001 cara `ADVANCE` wajib punya baris `trip_advance_settlement_claims` (trigger tunda). Tidak ada tabel `payroll_*` yang dibaca atau ditulis.

Izin (migrasi yang sama): `trip_advances.read`, `trip_advances.manage`, `trip_per_diem.manage` (D-15).

Rollback:

- **Kode:** rilis sebelumnya tidak mendaftarkan route `/trip-advances/*`; tabel baru tidak dibaca kode lama. Kode REIMB-001 lama tidak membaca baris pembayaran `ADVANCE` secara khusus (hanya label).
- **Skema:** perintah `-- Down:` di berkas migrasi, hanya sebelum ada uang muka di production; sesudahnya ekspor dulu.

## 10. API

Pegawai: `GET /trip-advances/me`, `GET /trip-advances/me/trips`, `GET /trip-advances/me/estimate`, `GET /trip-advances/me/:id`, `POST /trip-advances/me`, `POST /trip-advances/me/:id/cancel`, `POST /trip-advances/me/:id/settlement`.

Approver: `GET /trip-advances/approvals`, `POST /trip-advances/approvals/:stepId/decision`.

Keuangan/HC: `GET /admin/trip-advances` (halaman; filter status, pegawai, terlambat), `GET /admin/trip-advances/claimants`, `GET /admin/trip-advances/export.csv`, `GET /admin/trip-advances/:id` (termasuk pratinjau penyelesaian: klaim terverifikasi, klaim tertunda, tarif yang berlaku, hari maksimum), `POST /admin/trip-advances/:id/reject`, `/disburse`, `/settle`, `/top-up`, `/refunds`; `GET /admin/trip-per-diem-rates` (halaman, filter zona), `POST /admin/trip-per-diem-rates`.

Kontrak lengkap: `docs/api/trip-advances.openapi.yaml`. Daftar mengikuti ENG-LIST-001 (`page`/`pageSize` default 25 maks 100, filter sebelum `LIMIT`). Detail memuat ≤ 30 hari perjalanan, klaim tertaut satu perjalanan (beberapa), transaksi satu uang muka, dan riwayatnya.

## 11. Layar

- Pegawai: `/app/trip-advances` di Keuangan Saya — daftar berhalaman, formulir (pilih perjalanan, zona, perkiraan uang harian, nominal, rincian, penyetuju), detail pop-up (`?uangmuka=<id>`) dengan tahap, pencairan, klaim yang diperhitungkan, selisih, pengembalian, riwayat; batalkan; ajukan pertanggungjawaban (dengan tautan ke Reimbursement untuk mengklaim biaya).
- Approver: bagian "Uang Muka Dinas" di halaman Persetujuan.
- Keuangan/HC: `/admin/trip-advances` — register berhalaman (status, terlambat, typeahead pengaju), unduh CSV, detail pop-up (`?uangmuka=<id>`) dengan tindakan sesuai status, dan bagian **Tarif uang harian** (riwayat versi; formulir tambah bagi `trip_per_diem.manage`).

State loading, kosong, galat, terlarang, dan mobile wajib ada.

## 12. Acceptance criteria

- TRIP-002-A: pegawai mengajukan uang muka untuk perjalanannya sendiri; perjalanan orang lain, perjalanan berstatus lain, dan uang muka kedua untuk perjalanan yang sama ditolak; pegawai lain menerima 404.
- TRIP-002-B: rantai approval disalin dari perjalanan dan disnapshot; approver tidak aktif menggagalkan pengajuan tanpa menyimpan apa pun.
- TRIP-002-C: nominal di atas batas D-04, pecahan, atau string ditolak; kunci yang sama di-replay.
- TRIP-002-D: pencairan hanya dari `APPROVED` dengan nominal > 0, sebesar nominal disetujui, idempoten; pengaju dan approver tidak dapat mencairkan.
- TRIP-002-E: pertanggungjawaban ditolak sebelum tanggal kembali atau saat ada klaim tertaut `DRAFT`/`IN_REVIEW`.
- TRIP-002-F: penyelesaian memperhitungkan klaim `VERIFIED` (menjadi `PAID` cara `ADVANCE`), menghitung uang harian dari tarif berversi, dan menolak bila tarif tidak ada; selisih menentukan status.
- TRIP-002-G: selisih kurang dibayar tepat sekali; pengembalian bertahap tidak dapat melebihi kewajiban dan menutup uang muka saat lunas.
- TRIP-002-H: klaim tertaut tidak dapat dibayar sendiri selama uang muka belum diselesaikan.
- TRIP-002-I: tanpa `trip_advances.read` register menjawab 403; tanpa `trip_advances.manage` tindakan menjawab 403; tanpa `trip_per_diem.manage` tarif tidak dapat dicatat; Super Admin legacy tidak menerima izin ini.
- TRIP-002-J: database menolak pencairan yang tidak sama dengan nominal, selisih yang salah hitung, pengembalian berlebih, dan perubahan/penghapusan transaksi, tarif, atau riwayat.
- TRIP-002-K: riwayat, notifikasi, dan pengingat tidak memuat nominal; tidak ada tabel `payroll_*` yang disentuh.

Bukti test: `apps/api/test/trip-advances.test.ts` (aturan domain), `apps/api/test/trip-advances.postgres.test.ts` (A–K di atas skema nyata), `apps/web/src/lib/tripAdvances.test.ts`.

## 13. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| D-01 | Dimensi tarif? | Empat zona; tanpa golongan |
| D-02 | Besaran tarif? | **Kosong** — HC/Keuangan wajib mengisi; tanpa tarif uang harian tidak dapat dihitung |
| D-03 | Hari uang harian? | Hari kalender perjalanan inklusif; Keuangan boleh menurunkan |
| D-04 | Batas uang muka? | Rp10 jt + perkiraan uang harian |
| D-05 | Siapa menyetujui? | Rantai yang sama dengan perjalanannya |
| D-09 | Tenggat pertanggungjawaban? | 14 hari setelah kembali |
| D-12 | Pengembalian lewat potong gaji? | Tidak; dicatat Keuangan sebagai uang diterima |
| D-15 | Siapa mengelola tarif? | HC dan Keuangan |
