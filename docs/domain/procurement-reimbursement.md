# Reimbursement Pengadaan atas Nama Yayasan

**Status:** DRAFT — spesifikasi ini **belum** mengizinkan implementasi. Seluruh aturan bisnis yang belum diputuskan owner ditandai `DRAFT` dengan default paling masuk akal (aturan owner 2026-10-26); tabel §13 berisi pertanyaan yang hanya dapat dijawab owner.
**Spesifikasi:** REIMB-002 (Procurement reimbursement)
**Tanggal:** 2026-11-18
**Permintaan owner:** "tolong rancangkan juga untuk reimburse pengadaan untuk keperluan yayasan."
**Terkait:** REIMB-001 (`docs/domain/reimbursement.md`), ASSET-001 (`docs/domain/employee-assets.md`), LOAN-001, TRIP-001, TRIP-002, APR-001, ORG-002, ORG-004, NOTIF-003, NOTIF-004, AUTH-011, ENG-LIST-001, HELP-001; Aset SQ ADR-0001, ASQ-001, ASQ-004
**Implementasi yang dikaji:** `apps/api/src/modules/reimbursements/`, `apps/api/src/modules/employee-assets/` (`aset-sq-client.ts`, `routes.ts`)

## 1. Tujuan

REIMB-001 dibangun untuk **biaya pegawai atas kegiatannya sendiri**: transport, penginapan, konsumsi rapat, perlengkapan kecil. Pengadaan adalah hal lain yang memakai baju yang sama. Pegawai membeli barang yang **sejak dibayar menjadi milik yayasan**, sering atas instruksi orang lain, sering lebih besar nominalnya, dan barangnya sesudah itu adalah aset yang harus tercatat.

Tiga perbedaan itu yang membuat pengadaan tidak dapat dibiarkan masuk sebagai kategori `OPERATIONAL` di REIMB-001:

1. **Pemiliknya bukan pengaju.** Klaim REIMB-001 mengembalikan uang yang sudah habis; klaim pengadaan mengembalikan uang **dan** memindahkan barang ke yayasan. Tanpa penyerahan, yayasan membayar barang yang tidak dipegangnya.
2. **Keputusannya mendahului belanjanya.** Biaya konsumsi rapat diputuskan oleh rapat yang memang terjadi; pembelian barang Rp8 juta diputuskan sebelum uangnya keluar, atau tidak diputuskan sama sekali.
3. **Rantai persetujuannya berbeda.** Owner baru memutuskan untuk pinjaman bahwa uang yang keluar dari yayasan melewati **Kepala Keuangan ke atas**. Pengadaan adalah uang yayasan yang keluar untuk membeli barang yayasan; rantai atasan langsung → approver unit saja (REIMB-001 D-01) tidak memadai.

## 2. Batas

Termasuk (Paket 1 yang diusulkan):

- **Izin pengadaan** (pra-persetujuan) opsional di bawah ambang dan wajib di atasnya, berisi keperluan, pagu, dan masa berlaku;
- **klaim pengadaan**: baris barang/jasa, bukti pembelian, penunjukan siapa yang menginstruksikan, bukti barang diterima;
- persetujuan APR-001 dengan tahap tambahan Kepala Keuangan (dan Direktur di atas ambang);
- verifikasi dan pembayaran oleh Keuangan, **persis mekanisme REIMB-001 §5.6–§5.7** tanpa perubahan;
- **penyerahan ke pencatatan aset**: daftar "menunggu dicatat di Aset SQ", deep-link, dan penandaan sudah dicatat;
- register, ringkasan, ekspor CSV, notifikasi, pengingat — seluruhnya memakai yang sudah ada.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Vendor, purchase order, tender, perbandingan harga otomatis | Ini aplikasi pengadaan, bukan reimbursement. Bila yayasan membutuhkannya, itu aplikasi tersendiri di SQ Suite, bukan modul HCIS. |
| Pembayaran langsung yayasan ke vendor | Di luar HCIS seluruhnya. Di atas batas P-05, pengadaan **tidak boleh** lewat reimbursement sama sekali. |
| Uang muka pengadaan / kas kecil | TRIP-002 mengerjakan uang muka perjalanan; uang muka pengadaan belum ada aturannya. Paket 1 tetap "beli dulu, diganti kemudian". |
| Menulis data aset ke Aset SQ secara otomatis | Aset SQ adalah system of record aset (ASSET-001 §1); API tulis belum ada — satu-satunya kontrak mesin hari ini adalah **baca** (ASQ-004). Lihat P-09. |
| Penyusutan, inventarisasi, label aset | Aset SQ. |
| Pajak atas pembelian | Penggantian biaya bukan penghasilan (REIMB-001 R2); urusan pajak vendor di luar HCIS. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| P-01 | **Jenis klaim baru di dalam REIMB-001, bukan modul terpisah.** Klaim memiliki `claim_type` (`EXPENSE` bawaan, `PROCUREMENT`), berbagi tabel, bukti terenkripsi, snapshot rantai, verifikasi per baris, pembayaran idempoten, register, ekspor, audit, dan notifikasi. Yang benar-benar baru hanya empat: izin pengadaan, tahap approval Kepala Keuangan, bukti tambahan, dan penyerahan aset. Memisahkannya menjadi modul sendiri berarti menyalin ulang seluruh infrastruktur bukti dan uang REIMB-001 beserta trigger invariannya — pekerjaan besar tanpa manfaat yang sepadan. **Pemicu memisahkan kelak:** begitu pengadaan membutuhkan vendor, PO, atau perbandingan penawaran yang disimpan sebagai entitas, ia berhenti menjadi reimbursement. | DRAFT |
| P-02 | **Izin pengadaan wajib di atas Rp1.000.000** sebelum belanja: keperluan (10–1000), pagu rupiah, masa berlaku **30 hari**, disetujui rantai P-07. Di bawah ambang, boleh beli dulu. Pagu adalah batas atas klaim yang menautnya; klaim melebihi pagu ditolak sampai izinnya diperbarui. | DRAFT |
| P-03 | **Yang terlanjur beli tanpa izin tidak ditolak otomatis.** Klaim tetap dapat diajukan dengan penanda `TANPA_IZIN_AWAL` dan wajib menyebut **siapa yang menginstruksikan** (P-04). Rantai persetujuannya sama. Menolaknya otomatis berarti pegawai menanggung sendiri barang yang kini milik yayasan, dan itu keputusan kebijakan, bukan keputusan mesin. Klaim bertanda ini masuk laporan bulanan Keuangan sebagai angka tersendiri, sehingga pola "selalu beli dulu" terlihat tanpa perlu menghukum orang per orang. | DRAFT |
| P-04 | **Bukti yang diwajibkan**, di luar bukti pembayaran REIMB-001 D-05: (a) **pemberi instruksi** sebagai pegawai konkret yang dipilih dari struktur, bukan teks bebas — pegawai aktif, bukan pengaju sendiri; (b) **bukti barang diterima** (foto/berita acara) untuk setiap baris `GOODS`; (c) **dua penawaran pembanding** untuk klaim di atas Rp5.000.000. Berkas memakai batas REIMB-001 D-05 (PDF/JPG/PNG ≤ 4 MB), dengan kuota dinaikkan menjadi **20 berkas** per klaim pengadaan. | DRAFT |
| P-05 | **Batas nominal.** Baris pengadaan **tidak** memakai batas kategori REIMB-001 D-02. Total klaim pengadaan ≤ **Rp25.000.000**; batas Rp10.000.000 REIMB-001 D-03 tetap berlaku untuk klaim `EXPENSE` dan tidak diubah. Di atas Rp25.000.000 pengadaan tidak lagi berjalan sebagai reimbursement: yayasan membayar vendor langsung di luar HCIS. Alasan batas: seorang pegawai tidak boleh menalangi uang yayasan dalam jumlah yang tidak dapat ia tanggung bila klaimnya ternyata ditolak. | DRAFT |
| P-06 | **Kategori baris pengadaan** tersendiri: `GOODS` (barang yang menjadi aset), `CONSUMABLE` (habis pakai), `SERVICE` (jasa, perbaikan, instalasi), `SHIPPING` (ongkos kirim, pajak pembelian). Hanya `GOODS` yang memicu penyerahan aset (P-09). Tanpa batas per baris; yang membatasi adalah pagu izin dan total klaim. | DRAFT |
| P-07 | **Rantai persetujuan:** atasan langsung → approver unit → **Kepala Keuangan** → **Direktur** (hanya bila total > Rp10.000.000). Kunci alur ORG-004 baru: `PROCUREMENT`. Dua tahap terakhir **wajib berbasis seat ORG-004**, bukan pencocokan teks jabatan — resolver APR-001 tidak boleh membaca teks jabatan (REIMB-001 D-01, LOAN-001 D-01), dan inilah bagian yang paling mahal dari paket ini (§12). Izin pengadaan (P-02) memakai rantai yang sama, sehingga yang menyetujui belanja adalah orang yang sama dengan yang menyetujui penggantiannya. | DRAFT |
| P-08 | **Verifikasi dan pembayaran tidak berubah.** Keuangan memverifikasi per baris dan mencatat pembayaran dengan aturan REIMB-001 D-09/D-10 apa adanya, termasuk idempotensi, pemisahan tugas D-13, dan larangan koreksi pembayaran D-18. Penyerahan ke payroll (D-11) **tidak** berlaku untuk pengadaan: barang yayasan tidak dibayar lewat slip gaji. | DRAFT |
| P-09 | **Penyerahan ke pencatatan aset.** Setiap baris `GOODS` wajib menyatakan apakah barangnya menjadi aset yayasan. Saat klaim `PAID`, HCIS **tidak menulis apa pun ke Aset SQ**: ASSET-001 §1 menetapkan HCIS tidak membangun modul aset, dan kontrak mesin yang ada hari ini hanya baca (ASQ-004). Yang dibangun di HCIS adalah daftar **"Menunggu dicatat di Aset SQ"** berisi baris `GOODS` yang sudah dibayar, dengan deep-link ke Aset SQ dan penandaan manual "sudah dicatat" beserta kode aset (≤ 64 karakter) oleh pemegang `reimbursements.manage`. Kontrak tulis otomatis adalah pekerjaan di repo Aset SQ (ASQ baru), di luar paket ini. | DRAFT |
| P-10 | **Barang milik yayasan sejak dibayar**, bukan milik pengaju, walaupun pengaju yang memegangnya. Kepemilikan pegang-memegang dicatat sebagai custody di Aset SQ, yang kemudian terbaca di **Asset Saya** dan di peringatan Pemberhentian (ASSET-001) tanpa perubahan apa pun di HCIS. | DRAFT |
| P-11 | **Barang yang belum diserahkan menahan pembayaran, bukan menahan persetujuan.** Baris `GOODS` di atas Rp2.000.000 tanpa bukti barang diterima tidak dapat diverifikasi (`PROCUREMENT_DELIVERY_EVIDENCE_REQUIRED`). Di bawah ambang, bukti tetap wajib saat pengajuan (P-04) tetapi tidak diperiksa ulang Keuangan. | DRAFT |
| P-12 | **Pemisahan tugas diperluas:** pemberi instruksi (P-04) tidak dapat menjadi pemverifikasi atau pencatat pembayaran klaim itu, sebagaimana approver tidak dapat (REIMB-001 D-13). Pengaju tidak pernah menjadi pemberi instruksi bagi dirinya sendiri. | DRAFT |
| P-13 | **Permission:** memakai `reimbursements.read` dan `reimbursements.manage` yang sudah ada. Satu kunci baru `reimbursements.procurement.submit` **tidak** dibuat: setiap pegawai aktif boleh mengajukan, karena yang menjaga adalah rantai persetujuan, bukan hak mengajukan. Yang ditambahkan hanya kemampuan menandai aset sudah dicatat, yang melekat pada `reimbursements.manage`. | DRAFT |
| P-14 | **Nominal tidak pernah muncul di log, notifikasi, pengingat, atau metadata riwayat** — REIMB-001 D-14 berlaku tanpa pengecualian, termasuk pada event izin pengadaan dan penyerahan aset. | ACCEPTED (mengikuti REIMB-001 D-14) |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai (pengaju) | Mengajukan izin pengadaan; menyusun draf klaim pengadaan, mengunggah bukti, menautkan izin, menunjuk pemberi instruksi, mengajukan, membatalkan sebelum verifikasi |
| Pemberi instruksi | Tidak melakukan apa pun di sistem; namanya tersimpan sebagai fakta dan ia diberi tahu (NOTIF-004) bahwa sebuah pengadaan diajukan atas instruksinya, sehingga instruksi palsu terlihat oleh orang yang disebut |
| Approver tahap (atasan, approver unit, Kepala Keuangan, Direktur) | Menyetujui atau menolak tahap `pending` miliknya, dengan melihat baris, bukti, izin, dan pemberi instruksi |
| Pemegang `reimbursements.read` | Register, detail, bukti, ringkasan, ekspor, daftar menunggu pencatatan aset |
| Pemegang `reimbursements.manage` (Keuangan) | Verifikasi, penolakan, pencatatan pembayaran, penandaan aset sudah dicatat — kecuali klaim sendiri, klaim yang ia setujui, dan klaim atas instruksinya (P-12) |
| Sistem | Snapshot rantai, transisi, invarian uang, audit, notifikasi, pengingat |

## 5. Alur dan state

### 5.1 Izin pengadaan

```text
DRAFT     -> IN_REVIEW   (pegawai mengajukan)
IN_REVIEW -> APPROVED    (tahap terakhir disetujui)
IN_REVIEW -> REJECTED    (salah satu tahap menolak)
IN_REVIEW -> CANCELLED   (pegawai, dengan alasan)
APPROVED  -> EXPIRED     (lewat masa berlaku P-02 tanpa klaim)
APPROVED  -> CONSUMED    (klaim yang menautnya dibayar)
```

Izin tidak memindahkan uang, sehingga tidak ada verifikasi Keuangan di dalamnya. Pagu izin adalah batas atas, bukan janji: klaim yang lebih kecil tetap sah dan sisanya tidak dapat dipakai lagi.

### 5.2 Klaim pengadaan

State klaim **sama persis** dengan REIMB-001 §5.3 (`DRAFT → IN_REVIEW → APPROVED → VERIFIED → PAID`, dengan `REJECTED`/`CANCELLED`), ditambah satu keadaan sesudah uang keluar yang **bukan** state klaim melainkan penanda baris:

```text
baris GOODS: PENDING_ASSET_RECORD -> ASSET_RECORDED   (ditandai Keuangan, dengan kode aset)
                                  -> NOT_AN_ASSET     (pengaju/Keuangan menyatakan bukan aset, dengan alasan)
```

Klaim yang sudah `PAID` tidak pernah kembali terbuka karena asetnya belum dicatat; yang tertahan hanya daftar kerja Keuangan, bukan uang pegawai. Membalikkan uang yang sudah dibayarkan tidak mungkin (REIMB-001 D-18), dan itu justru alasan P-11 menahan **sebelum** pembayaran, bukan sesudahnya.

### 5.3 Validasi saat pengajuan

Di luar validasi REIMB-001 §5.2 yang tetap berlaku: izin wajib bila total > ambang P-02 (`PROCUREMENT_AUTHORIZATION_REQUIRED`); izin harus milik pengaju, `APPROVED`, belum kedaluwarsa, belum terpakai (`PROCUREMENT_AUTHORIZATION_NOT_ELIGIBLE`); total ≤ pagu (`PROCUREMENT_EXCEEDS_AUTHORIZED_CEILING`); total ≤ P-05 (`PROCUREMENT_CLAIM_TOO_LARGE`); pemberi instruksi pegawai aktif dan bukan pengaju (`PROCUREMENT_INSTRUCTOR_INVALID`); bukti terima ada untuk setiap `GOODS` (`PROCUREMENT_DELIVERY_EVIDENCE_REQUIRED`); dua penawaran pembanding di atas ambang P-04 (`PROCUREMENT_QUOTATIONS_REQUIRED`).

Tanggal pembelian memakai REIMB-001 D-04 apa adanya: tidak di masa depan, paling lama 90 hari sebelum pengajuan.

## 6. Permission dan visibilitas

Tanpa kunci izin baru (P-13). Yang berubah hanya cakupan: register `reimbursements.read` kini memuat dua jenis klaim dengan filter jenis, dan daftar "menunggu dicatat di Aset SQ" mengikuti `reimbursements.read` dengan tindakan di `reimbursements.manage`.

`payroll.*` tetap tidak membuka REIMB; `reimbursements.*` tetap tidak membuka payroll maupun LOAN-001; dan tidak satu pun kunci REIMB membuka data aset — Asset Saya dan peringatan Pemberhentian tetap memakai jalur ASSET-001 sendiri.

## 7. Audit, riwayat, dan kerahasiaan

Event baru pada `reimbursement_events` dan tabel izin, seluruhnya append-only dan **tanpa nominal** (P-14): `procurement.authorization.submitted`, `procurement.authorization.approved`, `procurement.authorization.rejected`, `procurement.authorization.cancelled`, `procurement.authorization.expired`, `procurement.claim.instructed_by_recorded`, `procurement.asset.recorded`, `procurement.asset.declared_not_asset`.

Metadata memuat id, kategori baris, jenis bukti, kode aset, dan `via`; tidak pernah rupiah. Kerahasiaan log mengikuti REIMB-001 §7.

## 8. Notifikasi dan pengingat

NOTIF-004 (kategori `system`), tanpa nominal: tahap `pending` → approver; izin disetujui/ditolak → pengaju; **pengadaan diajukan atas instruksi Anda → pemberi instruksi** (penjaga paling murah terhadap instruksi palsu); klaim diverifikasi/ditolak/dibayar → pengaju; izin akan kedaluwarsa H-3 → pengaju.

NOTIF-003: aturan `reimbursement.finance_queue_digest` yang sudah ada ikut menghitung klaim pengadaan, dan satu aturan baru `procurement.asset_handover_digest` (mingguan) bila ada baris `GOODS` dibayar yang belum ditandai tercatat, berisi **jumlah baris saja**.

## 9. Penyimpanan

```text
reimbursement_claims              + claim_type, procurement_authorization_id, instructed_by_employee_id,
                                    without_prior_authorization
reimbursement_items               + asset_record_state, asset_code, asset_note
reimbursement_receipts            + receipt_kind (PAYMENT | DELIVERY | QUOTATION)
procurement_authorizations        izin pengadaan, pagu, masa berlaku, snapshot rantai
procurement_authorization_steps   snapshot rantai APR-001 untuk izin
```

Aturan yang wajib: uang tetap `bigint`; trigger invarian uang REIMB-001 diperluas, **tidak** diganti; `claim_type` tidak dapat berubah setelah draf diajukan; `asset_record_state` hanya ada pada baris `GOODS` klaim `PAID`; izin append-only kecuali transisi state-nya; tidak ada endpoint hapus selain bukti draf.

## 10. API

Pegawai: `POST /reimbursements/me/procurement-authorizations`, `GET …/procurement-authorizations` (halaman), `POST …/:id/cancel`; klaim memakai route REIMB-001 yang ada dengan `claimType` dan field tambahan.

Keuangan/HC: `GET /admin/reimbursements` dengan filter `claimType`; `GET /admin/reimbursements/asset-handovers` (halaman, baris `GOODS` menunggu dicatat); `POST /admin/reimbursements/:id/items/:itemId/asset-record`.

Daftar mengikuti ENG-LIST-001 tanpa pengecualian baru.

## 11. Layar

- Pegawai: `/app/reimbursements` mendapat pilihan jenis saat membuat draf, formulir izin pengadaan tersendiri, pemilih pemberi instruksi (typeahead pegawai aktif), dan unggahan bukti yang menyebut jenisnya.
- Approver: bagian "Pengadaan" di halaman Persetujuan dengan izin, pemberi instruksi, dan penanda `TANPA_IZIN_AWAL` terlihat jelas.
- Keuangan/HC: filter jenis di register, dan halaman **Menunggu dicatat di Aset SQ** dengan tombol buka Aset SQ serta formulir kode aset.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 12. Apa yang dipakai ulang, apa yang baru, dan seberapa besar

| Bagian | Dipakai ulang dari REIMB-001 | Yang baru |
| --- | --- | --- |
| Draf, bukti terenkripsi, idempotensi | Seluruhnya | Satu kolom jenis bukti, kuota 20 berkas |
| Approval APR-001, snapshot rantai | Mesin dan tabelnya | **Dua tahap berbasis seat** (Kepala Keuangan, Direktur bersyarat nominal) dan kunci alur ORG-004 `PROCUREMENT` |
| Verifikasi, pembayaran, invarian uang | Seluruhnya, tanpa perubahan | Satu blocker verifikasi (P-11) |
| Register, ringkasan, CSV, audit, notifikasi | Seluruhnya | Satu filter, satu daftar, satu aturan pengingat |
| Izin pengadaan | — | **Objek baru** beserta state, approval, dan masa berlaku |
| Penyerahan aset | — | **Daftar dan penandaan**, tanpa integrasi tulis |

Ukuran kasarnya: **sekitar setengah REIMB-001 Paket 1**, dan dua pertiga dari setengah itu terletak pada dua hal — objek izin pengadaan dengan rantainya sendiri, dan tahap approval berbasis seat untuk Kepala Keuangan/Direktur yang **belum pernah dibangun di HCIS** (semua modul sekarang memakai rantai atasan langsung → approver unit). Dua migration diperkirakan: satu skema, satu izin/alur ORG-004. Karena menyentuh approval dan uang keluar, PR-nya wajib melewati satu putaran review independen.

Kalau owner ingin yang lebih murah dan lebih cepat: lepaskan izin pengadaan (P-02) dan tahap Direktur, sisakan tahap Kepala Keuangan, bukti terima, dan daftar penyerahan aset. Itu sekitar sepertiga pekerjaan dan sudah menutup risiko terbesar — yayasan membayar barang yang tidak pernah sampai. Yang hilang adalah kendali **sebelum** uang keluar, dan dengan itu pegawai tetap menalangi lebih dulu tanpa kepastian.

## 13. Pertanyaan yang hanya dapat dijawab owner

| # | Pertanyaan | Default `DRAFT` yang dipakai |
| --- | --- | --- |
| 1 | Batas nominal pengadaan yang boleh lewat reimbursement sama sekali? | ≤ Rp25.000.000; di atasnya yayasan membayar vendor langsung (P-05) |
| 2 | Izin sebelum belanja wajib mulai nominal berapa? | > Rp1.000.000, berlaku 30 hari (P-02) |
| 3 | Apa yang terjadi pada orang yang terlanjur beli tanpa izin? | Tetap dapat diklaim, ditandai, dan dilaporkan — tidak ditolak otomatis (P-03) |
| 4 | Siapa yang menyetujui pengadaan? | Atasan langsung → approver unit → Kepala Keuangan → Direktur di atas Rp10 juta (P-07) |
| 5 | Dua penawaran pembanding wajib mulai nominal berapa? | > Rp5.000.000 (P-04) |
| 6 | Apakah bukti barang diterima wajib untuk semua barang atau hanya di atas ambang? | Wajib saat pengajuan untuk semua `GOODS`; diperiksa Keuangan di atas Rp2.000.000 (P-04, P-11) |
| 7 | Siapa yang bertanggung jawab mencatat barang di Aset SQ? | Keuangan menandainya di HCIS; pencatatannya sendiri dilakukan di Aset SQ (P-09) |
| 8 | Apakah HCIS boleh menulis langsung ke Aset SQ kelak? | Tidak di paket ini; butuh kontrak baru di repo Aset SQ (P-09, ASSET-001 §1) |
| 9 | Pengadaan dibangun sekarang atau nanti? | Belum diputuskan — §12 menyediakan versi penuh dan versi sepertiga agar owner dapat memilih |
| 10 | Apakah pegawai boleh menolak menalangi, dan adakah jalur uang muka pengadaan? | Belum ada; Paket 1 tetap "beli dulu, diganti kemudian" (§2) |

Selama pertanyaan di atas belum dijawab, tidak ada bagian dokumen ini yang boleh diimplementasikan.
