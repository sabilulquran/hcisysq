# Payroll Calculation v1

**Status:** ACCEPTED (parameter bertanda `DRAFT` adalah default keputusan agent, menunggu konfirmasi process owner)  
**Specification:** PAY-003 (v1)  
**ADR:** ADR-0003 (ACCEPTED)  
**Related:** PAY-001, PAY-002, PAYSLIP-001..006, ATT-010, EMP-005, AUTH-011, ORG-010  
**Evidence:** `docs/domain/payroll-legacy-flow-audit.md` (aturan legacy dan keputusan D1–D11), `docs/domain/payroll-engine-discovery.md` (arah arsitektur)

Spesifikasi ini mendefinisikan versi pertama perhitungan payroll di HCIS. Nilai parameter berasal dari spreadsheet legacy dan berstatus `DISCOVERY` sampai disahkan process owner melalui tabel kebijakan berversi. ADR-0003 sudah `ACCEPTED` (2026-10-27), sehingga implementasi bertahap diizinkan. Setiap tahap tetap memiliki spesifikasi implementasi dan rollback plan sendiri.

## 1. Cakupan

### 1.1 Termasuk v1

- Pegawai dengan employment aktif kategori tetap, masa percobaan, kontrak bergaji, dan kontrak honorer/PKWT (EMP-005).
- Pemetaan kategori EMP-005 ke dasar bayar. Pegawai kontrak ada **dua jenis** (keputusan owner 2026-11-04): kontrak bergaji penuh yang dibayar seperti pegawai tetap, dan kontrak honorer yang dibayar per kehadiran (transport) dan per jam mengajar.
  - `TETAP` → pegawai tetap; `PERCOBAAN` → masa percobaan; `KONTRAK` → **kontrak bergaji**, dihitung dengan rumus §5.1 seperti pegawai tetap (gaji pokok, tunjangan, lembur, BPJS, faktor masa kerja awal), tanpa transport. Ini mayoritas pegawai kontrak; spreadsheet legacy menghitung mereka di `DATA OLAHAN GAJI` bersama pegawai tetap.
  - `KONTRAK_HONORER` → **PKWT/honorer** (§5.2): transport per kehadiran dan honor per jam mengajar. Di master SDM legacy mereka berstatus `Aktif PKWT` dan dibayar lewat `Gaji Honorer` (3 orang pada Oktober 2026).
  - `LEPAS` → PKWT/honorer (`DRAFT`, default agent 2026-10-27), karena pekerja lepas dibayar per kehadiran dan per jam mengajar seperti PKWT.
  - `MAGANG` dan `BELUM_DIKLASIFIKASIKAN` **di luar populasi payroll v1**: keduanya tidak dihitung dan tidak menghasilkan blocker, karena blocker atas kategori yang memang di luar cakupan tidak dapat diselesaikan dari dalam modul payroll.
- Komponen pegawai tetap/percobaan/kontrak bergaji: gaji pokok, kelebihan/kekurangan jam, tunjangan kinerja, tunjangan pasangan, tunjangan anak, tunjangan fungsional, tunjangan jabatan, tunjangan kualifikasi khusus, tunjangan BPJS Kesehatan, lembur, rapel, penyesuaian gaji.
- Komponen PKWT/honorer (`KONTRAK_HONORER`, `LEPAS`): transport per kehadiran, honor per jam mengajar, pemasukan lain.
- Potongan: kasbon, iuran BPJS Kesehatan, iuran anggota keluarga tambahan, pendidikan anak, kekurangan jam, penyesuaian.
- Insentif Pj. Media untuk pegawai aktif (input periode).
- Netto 80% selama 2 bulan pertama masa kerja; prorata sebagai penyesuaian berwenang.
- Pinjaman LOAN-001 dipotong lewat register yang sama bila sakelar §3.5 menyala; pelunasannya tercatat di LOAN-001 saat periode disahkan.
- Potongan kasbon diambil dari register kasbon (§3.4), bukan diketik sebagai input periode: sisa pinjaman dihitung dari pokok dikurangi potongan pada periode lain, dan potongan periode berjalan dibandingkan dengan sisa itu.
- Lifecycle periode dengan pengesahan Direktur, laporan untuk Keuangan/Direktur/Pengurus, publikasi slip lewat PAY-002, laporan PPh21 TER.

### 1.2 Di luar v1

Penerima non-pegawai/pengabdian/honor lain, THR, modul laporan konten Pj. Media (v1 hanya menerima rekap), reimbursement, integrasi transfer bank, multi legal entity (ORG-007), akuntansi.

## 2. Aktor dan permission

Permission mengikuti pola `<resource>.<action>[.<scope>]`. Semua permission baru wajib automated test (AGENTS.md §7) termasuk daftar test minimum `roles-permissions.md`.

| Aktor | Permission (usulan) | Scope |
|---|---|---|
| Kepala HCM / staf HC | `payroll.policies.manage`, `payroll.profiles.manage`, `payroll.periods.manage`, `payroll.inputs.manage`, `payroll.calculate`, `payroll.submit` | organization |
| Keuangan (pengelola kasbon) | `payroll.loans.manage` | organization |
| Kepala Keuangan | `payroll.transfers.read.organization`, `payroll.reports.read.organization`, `payroll.results.read.organization`, `payroll.payments.confirm` | organization |
| Direktur | `payroll.approve`, `payroll.reopen.approve`, `payroll.reports.read.organization`, `payroll.results.read.organization` | organization |
| Pengurus Yayasan | **tidak ada permission payroll di v1** | — |
| Pegawai | `payslips.read.own` (sudah ada) | own |

Penamaan mengikuti `<resource>.<action>[.<scope>]`; `payroll.reopen.approve` adalah resource `payroll.reopen` dengan action `approve`, bukan scope. Daftar final dicatat di `docs/domain/roles-permissions.md` saat implementasi permission.

**Batas Pengurus Yayasan (`DRAFT`, perbaikan review 2026-10-27).** ORG-003-F dan ORG-010-F melarang Pengurus melihat agregat payroll, dan PAYSLIP-001-F melarang akses slip perorangan. Batas itu **tetap berlaku**: v1 tidak memberi Pengurus Yayasan permission payroll apa pun. Membuka akses laporan payroll untuk Pengurus adalah perubahan batas governance tersendiri yang membutuhkan ADR baru, review keamanan, dan test otorisasi; tidak boleh diturunkan dari spesifikasi ini.

Aturan:

- Tidak ada self-approval: akun yang mengajukan (`payroll.submit`) tidak dapat mengesahkan periode yang sama.
- **Konflik kepentingan atas gaji sendiri.** Pemegang `payroll.profiles.manage`/`payroll.inputs.manage` tidak dapat mengubah profil kompensasi atau input periode miliknya sendiri; perubahan atas dirinya dilakukan aktor lain. Baris hasil milik pengaju dan pengesah ditandai pada layar review dan menghasilkan audit event tersendiri (`payroll.self_row.reviewed`). Direktur tetap boleh mengesahkan periode yang memuat gajinya sendiri — ia tidak dapat mengubah nilainya — dan penandaan itulah kontrolnya.
- **Pemisahan kasbon dan konfirmasi bayar.** Kasbon terkunci begitu periode mencapai `CALCULATED`; perubahan kasbon setelah itu hanya mungkin lewat kembalikan ke `COLLECTING` oleh Direktur, sehingga pemegang `payroll.loans.manage` tidak dapat mengubah nominal yang sedang dikonfirmasinya.
- Super Admin tidak otomatis mendapat permission payroll.
- Laporan payroll per orang adalah data sensitif: setiap baca dicatat `payroll.report.read`.
- **Angka per orang punya izin baca sendiri** (`payroll.results.read.organization`, migration 0151; §7.3). Menjalankan lifecycle (`payroll.periods.manage`), memutus periode (`payroll.approve`, `payroll.payments.confirm`), atau membaca rekap (`payroll.reports.read.organization`) tidak membukanya.

## 3. Data dasar (berlaku-efektif)

Semua data dasar memiliki `effective_from`/`effective_to` (tanggal Asia/Jakarta, inklusif). Perubahan tidak menimpa histori: membuka versi baru menutup pendahulunya sehari sebelumnya, sehingga rantainya kontigu dan tidak tumpang tindih.

**Berlaku mundur (`DRAFT`, default agent 2026-10-27).** Membuka versi kebijakan atau profil kompensasi yang tanggal berlakunya mencapai periode yang sudah `CALCULATED` ke atas ditolak, kecuali penulis menyatakan alasannya secara eksplisit (`backdateReason`), yang ikut tersimpan pada catatan versi. Tanpa penolakan ini, menghitung ulang bulan yang sudah disahkan akan menghasilkan angka berbeda dari yang dibayarkan. Setiap baris hasil juga menyimpan id profil dan id versi kebijakan yang dipakainya, sehingga nilai lama tetap dapat dijelaskan.

### 3.1 Katalog komponen

Setiap komponen memiliki kode stabil, nama tampilan, kategori (`EARNING`, `DEDUCTION`, `EMPLOYER_COST`), penanda **tunjangan tetap** untuk dasar BPJS, penanda masuk dasar PPh21, dan urutan tampil di slip. Dasar PPh21 v1: seluruh komponen `EARNING` yang benar-benar dibayar, kecuali `BPJS_KES_ALLOW` yang efek bersihnya nol (§5.3).

Komponen awal v1 (kode final saat implementasi):

| Kode (usulan) | Komponen | Kategori | Tunjangan tetap? |
|---|---|---|---|
| `BASIC` | Gaji pokok | EARNING | ya (gaji pokok) |
| `TEACH_OVER` | Kelebihan jam | EARNING | tidak (§10 butir 2) |
| `PERF` | Tunjangan kinerja | EARNING | ya (§10 butir 2) |
| `SPOUSE` | Tunjangan pasangan | EARNING | ya |
| `CHILD` | Tunjangan anak | EARNING | ya |
| `FUNC` | Tunjangan fungsional | EARNING | ya |
| `POS` | Tunjangan jabatan | EARNING | ya |
| `SPECIAL_QUAL` | Tunjangan kualifikasi khusus | EARNING | ya (§10 butir 2) |
| `BPJS_KES_ALLOW` | Tunjangan BPJS Kesehatan | EARNING | tidak |
| `OVERTIME` | Lembur | EARNING | tidak |
| `ARREARS` | Rapel gaji | EARNING | tidak |
| `PJ_MEDIA` | Insentif Pj. Media | EARNING | tidak |
| `TRANSPORT` | Transport PKWT | EARNING | tidak |
| `TEACH_FEE` | Honor mengajar PKWT | EARNING | tidak |
| `OTHER_INCOME` | Pemasukan lain | EARNING | tidak |
| `LOAN` | Potongan kasbon | DEDUCTION | — |
| `BPJS_KES` | Iuran BPJS Kesehatan | DEDUCTION | — |
| `BPJS_KES_EXTRA` | Iuran anggota keluarga tambahan | DEDUCTION | — |
| `CHILD_EDU` | Pendidikan anak | DEDUCTION | — |
| `TEACH_SHORT` | Kekurangan jam | DEDUCTION | — |
| `ADJUST_DEDUCT` | Penyesuaian gaji (potongan) | DEDUCTION | — |
| `ADJUST_EARN` | Penyesuaian gaji (penambah) | EARNING | tidak |
| `PRORATA` | Faktor prorata masuk/keluar | — (faktor atas netto, §5.1) | — |
| `PPH21_EMPLOYER` | PPh21 ditanggung yayasan | EMPLOYER_COST | — |

### 3.2 Tabel kebijakan berversi

| Kebijakan | Isi (nilai legacy, `DISCOVERY`) |
|---|---|
| Skala gaji pokok | Pendidikan terakhir (SD, SMP, SLTA, D1/D2, D3/D4, S1, S2/S3) × MKG 0–27 → nominal dan pangkat. MKG di luar tabel tidak ditebak (§7). |
| Pengali gaji pokok | Unit Taman Tahfizh 50%; pola kerja Half Day 60%, Half Day II 65%. Disimpan sebagai atribut unit/pola kerja, bukan pencocokan teks jabatan. |
| Jam mengajar | Batas 96 jam/bulan (24 jam/pekan × 4); tarif kelebihan dan kekurangan Rp10.000/jam. |
| Tunjangan kinerja | Dasar Rp100.000 dibagi 60% tahunan / 40% bulanan; dasar khusus Rp150.000 untuk jabatan yang ditetapkan (legacy: Kepala General Affair). |
| Tunjangan keluarga | Pasangan 5% × gaji pokok per orang; anak 2% × gaji pokok per anak, tanpa batas jumlah (D4). |
| Tunjangan fungsional | Tabel per jabatan fungsional; 70% bila merangkap jabatan struktural; unit yang tidak memberi tunjangan fungsional ditandai di kebijakan (legacy: Pesantren Tahfizh). |
| Tunjangan jabatan | Tabel per jabatan struktural; pengali per unit (legacy: Kepala Unit di Taman Tahfizh 50%). |
| Lembur | Gaji pokok / 173 × jam lembur, tanpa pengali (D3). |
| BPJS Kesehatan | 5% × dasar; dasar = gaji pokok + komponen bertanda tunjangan tetap; batas bawah UMK Kota Cirebon; batas atas Rp12.000.000; anggota keluarga tambahan +1% × dasar per orang (D11). Sumber: Perpres 82/2018 s.d. Perpres 59/2024, wajib diverifikasi ke naskah resmi sebelum `ACCEPTED`. |
| UMK | Nilai per tahun berlaku (legacy 2026: Rp2.878.646). |
| PKWT | Transport Rp15.000/kehadiran; honor Rp15.400/jam. |
| Masa kerja awal | Netto dibayar 80% bila masa kerja < 2 bulan pada tanggal gajian (D8). |
| PPh21 TER | Tabel TER A/B/C dengan pemetaan status PTKP; kode objek 21-100-01. |
| `PERFORMANCE_PERCENT` (opsional, sakelar) | Predikat penilaian kinerja PERF-001 → persentase kinerja, sekaligus sakelar sambungan PERF-001 (§5.5). Tidak ada versi = mati. Usulan `DRAFT`: A 100%, B 90%, C 75%, D 50%. |

### 3.3 Profil kompensasi pegawai

Per employment, berlaku-efektif:

- pendidikan terakhir untuk skala gaji, TMT masa kerja (dari EMP-005), dan dasar MKG;
- jumlah pasangan dan anak tertanggung;
- pola kerja (penuh / Half Day / Half Day II);
- jam mengajar per pekan (kosong = tidak terkena aturan jam);
- persentase kinerja tahunan dan bulanan (default eksplisit, bukan diketik ulang per bulan; kebijakan default untuk masa kerja < 1 tahun: §10 butir 3). Bila sambungan PERF-001 menyala (§5.5), penilaian final menggantikan nilai profil untuk periode itu; profil tetap menjadi cadangan;
- target kualifikasi khusus (opsional);
- kepesertaan BPJS Kesehatan: segmen (`PPU_YAYASAN`, `PBI`, `MANDIRI`, `BELUM_TERDAFTAR`), tanggal aktif, jumlah anggota keluarga tambahan, referensi SK (D2). Anggota tambahan **diturunkan**, tidak diketik: `anggota_tambahan = max(0, tanggungan_terdaftar − (pasangan + min(anak, 3)))`, sesuai batas penanggungan pasangan + 3 anak pada iuran 5%. Nilai manual hanya boleh sebagai override dengan alasan dan selisihnya ditampilkan saat review;
- status PTKP, dan **pengecualian pelaporan PPh21** (`pph21_report_excluded` + alasan wajib, migration 0147; §5.3);
- rekening bank dan nama pemilik rekening;
- tugas tambahan Pj. Media (placement `ADDITIONAL`, EMP-005) dengan tarif per konten.

Jabatan fungsional dan struktural dibaca dari placement EMP-005 dan dipetakan ke tabel tunjangan lewat referensi stabil, bukan label teks.

### 3.4 Kasbon

Kasbon adalah pinjaman per pegawai: tanggal, pokok, dan potongan per periode (tetap atau ditentukan Keuangan per periode). Sisa = pokok − total potongan **final**, yaitu potongan yang melekat pada periode yang sudah mencapai `APPROVED` ke atas; potongan pada periode yang masih dikerjakan tidak mengurangi sisa. Potongan tidak boleh melebihi sisa. Hanya `payroll.loans.manage`.

### 3.5 Potongan cicilan LOAN-001 (dibangun 2026-11-17, sakelar default MATI)

Kontrak: `docs/domain/employee-loans.md` §9.2. Implementasi: `apps/api/src/modules/payroll/employee-loan-link.ts`, migration 0157. Sakelar: variabel lingkungan `LOAN_PAYROLL_DEDUCTION_ENABLED` (bawaan `0`), pola yang sama dengan `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED`. **Menyalakannya menunggu keputusan owner bahwa PAY-003 menjadi jalur slip resmi** (LOAN-001 §9.2 butir 6) dan merupakan perubahan konfigurasi production yang dilaporkan.

| Saat | Yang terjadi | Bergantung sakelar? |
|---|---|---|
| hitung | Usulan `PROPOSED` periode itu dibuang lalu diturunkan ulang, sehingga usulan lama (pegawai keluar dari periode, pinjaman lunas tunai) tidak tertinggal. Setiap pinjaman LOAN-001 `DISBURSED` milik pegawai di periode mendapat satu baris cermin di register kasbon (`payroll_loans.employee_loan_id`, unik). Cicilan yang jatuh pada bulan periode dan belum terbayar menurut D-11 diusulkan sebagai potongan periode (`payroll_loan_deductions.origin = PROPOSED`), dibatasi sisa pinjaman. Hitung ulang memperbarui usulan; potongan yang ditetapkan Keuangan (`MANUAL`) tidak pernah ditimpa. | ya; saat mati, hitung hanya membuang usulan `PROPOSED` periode itu sendiri, sehingga periode yang tidak pernah melihat sakelar menyala tidak tersentuh |
| sahkan (`approve`) | Dalam transaksi yang sama, setiap potongan pada cermin LOAN-001 menjadi satu pembayaran `PAYROLL_DEDUCTION` dengan sumber `(period_id, loan_id)` — unik selama `ACTIVE`, sehingga mengulang tidak menggandakan. Tanggal bayar = tanggal gajian; referensi `Payroll YYYY-MM`; perekam = pengesah. Bila sisa LOAN-001 tidak lagi cukup (ada pembayaran tunai atau koreksi setelah hitung), pengesahan ditolak 409 `PAYROLL_LOAN_BALANCE_CHANGED`; Direktur mengembalikan periode dan HC menghitung ulang. Tidak ada pemangkasan diam-diam. | tidak — digerakkan data potongan, agar slip dan pinjaman selalu sama |
| setujui buka ulang | Pembayaran yang bersumber dari periode itu dibalik (`REVERSED`, LOAN-001 D-12) dengan alasan otomatis; pengesahan berikutnya mencatatnya lagi. | tidak |

Sisa yang dipakai untuk cermin LOAN-001 — oleh mesin (`LOAN_EXCEEDS_BALANCE`), oleh pengisian potongan Keuangan, dan oleh register kasbon — adalah sisa LOAN-001 (pokok − pembayaran berlaku, termasuk tunai/transfer), bukan pokok − potongan payroll final. Kasbon yang diketik Keuangan (tanpa `employee_loan_id`) tetap memakai aturan §3.4.

**Keputusan `DRAFT` (default agent 2026-11-17):**

| # | Keputusan | Default |
|---|---|---|
| L1 | Cicilan yang terlambat | Tidak ditarik otomatis ke bulan berjalan; hanya cicilan bulan periode yang diusulkan. Mengejar tunggakan adalah keputusan Keuangan (potongan `MANUAL`). |
| L2 | Menunda satu bulan | Keuangan mengisi potongan 0 untuk cermin itu: tersimpan sebagai `MANUAL` bernilai 0 (satu-satunya baris bernilai 0 yang diizinkan), sehingga hitung ulang tidak mengusulkannya lagi. |
| L3 | Tanggal dan perekam pembayaran | Tanggal gajian periode, tetapi tidak pernah setelah hari pengesahan (WIB); perekam = akun pengesah. Pemisahan tugas D-14 tidak berlaku karena pembayaran ini turunan slip yang disahkan, bukan pencatatan Keuangan; bila pengesah sendiri peminjamnya, event `loan.payment.recorded` menandainya (`approverIsBorrower`). Hanya potongan milik pegawai yang punya hasil di periode itu yang dicatat. |
| L4 | Pencatatan manual `PAYROLL_DEDUCTION` di LOAN-001 | Ditolak `LOAN_PAYROLL_DEDUCTION_AUTOMATIC` selama sakelar menyala, dan untuk pinjaman yang sudah punya cermin payroll walau sakelar sudah dimatikan (mencegah dobel). Pembayaran tunai/transfer tetap boleh dan mengurangi usulan berikutnya. Pembayaran bersumber payroll tidak dapat dikoreksi dari register pinjaman (`LOAN_PAYMENT_FROM_PAYROLL`); koreksinya lewat buka ulang periode. |
| L6 | Buka ulang bulan lama setelah bulan berikutnya disahkan | Usulan dihitung dari sisa saat itu (D-11 kumulatif): bila bulan berikutnya sudah membayar cicilannya, bulan yang dibuka ulang dapat mengusulkan 0. Total pinjaman tetap benar; potongan per slip dapat bergeser. Keuangan memakai potongan `MANUAL` bila ingin mempertahankan angka slip lama. |
| L5 | Kasbon legacy ganda | Bila Keuangan juga mengetik kasbon yang sama secara manual di register PAY-003, keduanya terpotong. Sebelum menyalakan sakelar, Keuangan menutup kasbon manual yang sudah menjadi pinjaman LOAN-001. |

Audit: `payroll.period.calculated` menambah `employee_loan_deduction_enabled` dan `employee_loan_proposed_count`; transisi `approve`/`approve_reopen` menambah `loan_payments_settled`/`loan_payments_reversed` — hitungan saja. Event dan notifikasi LOAN-001 tidak memuat nominal (D-15).

Rollback: sakelar `0` menghentikan usulan baru tanpa rilis; pembayaran yang sudah tercatat tetap fakta dan tetap dibalik bila periodenya dibuka ulang. Skema: `-- Down:` migration 0157.

## 4. Input periode

| Input | Sumber v1 | Catatan |
|---|---|---|
| Jam lembur | Lembur disetujui ATT-010 (`approved_minutes`) dalam jendela cutoff periode, hanya untuk pegawai tetap, masa percobaan, dan kontrak bergaji (`KONTRAK`) | Menggantikan input manual. Jendela cutoff §10 butir 1 (23–22). Menjalankan resolver mengganti **seluruh** isi kedua kunci berasal-kehadiran: baris yang tidak lagi didukung kehadiran dihapus, sehingga lembur yang dibatalkan berhenti dibayar. |
| Kehadiran PKWT (transport) | Hasil kehadiran ATT dalam jendela cutoff, hanya untuk `KONTRAK_HONORER` dan `LEPAS` | Definisi "hadir": §10 butir 4. Kontrak bergaji tidak mendapat transport (legacy tidak membayarnya). |
| Jam mengajar PKWT | Input HC per periode | |
| Potongan pendidikan anak | Impor/entri HC per periode (rincian SPP, katering/laundry, PPDB, buku, kegiatan) | Integrasi langsung sistem SPP di luar v1. |
| Insentif Pj. Media | Rekap periode: jumlah konten disetujui × tarif penugasan | Modul laporan konten di luar v1. |
| Rapel | Input HC dengan alasan | |
| Penyesuaian gaji | Input HC dengan alasan dan referensi keputusan | Wajib untuk kasus yang dulu memakai kualifikasi khusus negatif (D1). |
| Prorata | Penyesuaian berwenang dengan alasan | |
| Override kinerja/jam | Input HC untuk periode itu | Mengalahkan profil — dan penilaian PERF-001 bila sambungan §5.5 menyala — hanya pada periode tersebut. |

Setiap input mencatat aktor, waktu, alasan bila diwajibkan, dan audit event.

## 5. Perhitungan

Semua uang dalam **rupiah bulat** (integer); tidak ada satuan di bawah rupiah dan tidak ada pembulatan ke ratusan. Satu pengecualian pada data masukan, bukan pada uang yang dibayar: nominal tabel skala gaji pokok disimpan apa adanya dari legacy (pecahan), karena `BASIC` dibulatkan sekali setelah pengali (PAY-003-MIG §3.4). Fungsi perhitungan murni dan deterministik untuk snapshot input + versi kebijakan yang sama.

**Aturan pembulatan (lengkap, perbaikan review 2026-10-27).**

| Tahap | Mode | Komponen |
|---|---|---|
| Per baris komponen | `ROUNDUP` ke rupiah bulat (menjauhi nol) | `BASIC`, `TEACH_OVER`, `TEACH_SHORT`, `PERF`, `SPOUSE`, `CHILD`, `FUNC`, `POS`, `SPECIAL_QUAL`, `OVERTIME` |
| Per baris komponen | `ROUND` setengah menjauhi nol | `BPJS_KES_ALLOW`, `BPJS_KES`, `BPJS_KES_EXTRA` |
| Per baris komponen | tanpa pembulatan (input sudah bulat) | `ARREARS`, `PJ_MEDIA`, `TRANSPORT`, `TEACH_FEE`, `OTHER_INCOME`, `LOAN`, `CHILD_EDU`, `ADJUST_EARN`, `ADJUST_DEDUCT` |
| Dasar BPJS | `clamp` sebelum pembulatan iuran | §5.1 |
| Total | dijumlahkan dari baris yang **sudah** dibulatkan; total tidak dibulatkan ulang | `BRUTO`, `POTONGAN`, `NETTO` |
| Nilai dibayar | `ROUNDUP` setelah faktor prorata atau faktor masa kerja awal | `DIBAYAR` |

Mode ini mengikuti `ROUNDUP`/`ROUND` spreadsheet legacy agar parallel run dapat dibandingkan baris per baris.

### 5.1 Pegawai tetap / masa percobaan / kontrak bergaji

```text
MKG          = tahun penuh dari TMT s.d. tanggal gajian (0 bila TMT > tanggal gajian)
BASIC        = ROUNDUP(skala[pendidikan, MKG] × pengali_unit_atau_pola)
jam_bulan    = jam_per_pekan × kebijakan.pekan_per_bulan
               bila jam_per_pekan kosong atau ≤ 0 → pegawai tidak terkena aturan jam:
               TEACH_OVER = TEACH_SHORT = 0 dan kedua baris tidak dirender di slip
TEACH_OVER   = max(0, jam_bulan − kebijakan.batas_jam) × kebijakan.tarif_kelebihan
TEACH_SHORT  = max(0, kebijakan.batas_jam − jam_bulan) × kebijakan.tarif_kekurangan
PERF         = %tahunan × dasar_kinerja × 60% + %bulanan × dasar_kinerja × 40%
SPOUSE       = ROUNDUP(BASIC × pasangan × 5%)
CHILD        = ROUNDUP(BASIC × anak × 2%)
FUNC         = tabel_fungsional × (70% bila punya jabatan struktural)   (0 bila unit dikecualikan)
POS          = tabel_struktural × pengali_unit
SPECIAL_QUAL = target − (BASIC + TEACH_OVER + PERF + SPOUSE + CHILD + FUNC + POS), bila target ada
               nilai < 0 → blocker sampai PENYESUAIAN ditetapkan (D1)
OVERTIME     = ROUNDUP(BASIC / 173 × jam_lembur)
dasar_bpjs   = clamp(BASIC + Σ komponen tunjangan tetap, kebijakan.umk, kebijakan.batas_atas)
BPJS_KES_ALLOW = BPJS_KES = ROUND(dasar_bpjs × kebijakan.tarif_iuran)   (hanya segmen PPU_YAYASAN yang aktif pada tanggal gajian)
BPJS_KES_EXTRA = ROUND(dasar_bpjs × kebijakan.tarif_anggota_tambahan × anggota_tambahan)
BRUTO        = Σ EARNING
POTONGAN     = LOAN + BPJS_KES + BPJS_KES_EXTRA + CHILD_EDU + TEACH_SHORT + ADJUST_DEDUCT
NETTO        = BRUTO − POTONGAN
DIBAYAR      = ROUNDUP(NETTO × faktor_bayar)
```

**Faktor bayar: prorata dan masa kerja awal saling meniadakan** (`DRAFT`, perbaikan review 2026-10-27). Legacy memperlakukan prorata sebagai pengganti netto 80%, bukan tambahannya. v1 mengikuti itu:

```text
faktor_bayar = faktor_prorata                       bila periode punya faktor prorata (0 < f ≤ 1)
             = kebijakan.tarif_masa_kerja_awal      bila tidak ada prorata dan
                                                     masa kerja < kebijakan.bulan_masa_kerja_awal
             = 1                                    selain itu
```

Prorata adalah **faktor pada periode**, bukan komponen `ADJUST_DEDUCT`, sehingga tidak ikut mengurangi `NETTO` dan tidak menghasilkan potongan ganda. Faktor prorata diisi HC dengan alasan dan referensi keputusan (masuk atau keluar di tengah bulan), dan dicatat pada hasil periode agar terlihat saat review.

Tunjangan BPJS ditampilkan sebagai pendapatan sekaligus potongan agar sama dengan slip legacy; efek bersihnya nol bagi pegawai dan seluruh iuran menjadi biaya yayasan.

### 5.2 PKWT / honorer (`KONTRAK_HONORER`, `LEPAS`)

```text
TRANSPORT   = kehadiran × kebijakan.transport_per_kehadiran
TEACH_FEE   = jam_mengajar × kebijakan.honor_per_jam
BRUTO       = TRANSPORT + TEACH_FEE + OTHER_INCOME + PJ_MEDIA + ADJUST_EARN
POTONGAN    = LOAN + CHILD_EDU + ADJUST_DEDUCT
NETTO       = BRUTO − POTONGAN
DIBAYAR     = NETTO
```

Catatan v1 (`DRAFT`):

- Komponen PKWT terbatas pada kode di atas; tidak ada "potongan lain" tanpa kode komponen.
- Faktor masa kerja awal **tidak berlaku** untuk PKWT: pembayaran sudah mengikuti kehadiran dan jam nyata, sehingga memotong 20% lagi berarti memotong dua kali. Faktor prorata juga tidak berlaku.
- Komponen gaji pokok, tunjangan, lembur, dan BPJS Kesehatan tidak berlaku untuk PKWT.
- Seluruh blocker §5.4 yang relevan tetap berlaku: netto/dibayar negatif, kasbon melebihi sisa, rekening kosong, dan input berubah setelah perhitungan terakhir.

### 5.3 PPh21

PPh21 tidak dipotong dari gaji di v1. Apakah yayasan menanggungnya — dicatat sebagai `PPH21_EMPLOYER` — ditentukan kebijakan `PPH21_SETTINGS` (§7.5; bawaan `DRAFT`: tidak ditanggung, tidak ada baris). Penghasilan bruto pelaporan diturunkan dari hasil final yang **benar-benar dibayar** (D9), memakai TER sesuai status PTKP. Pengecualian pelaporan per orang disimpan sebagai atribut eksplisit dengan alasan, bukan NIK hard-coded.

Rumus laporan v1 (implementasi `apps/api/src/modules/payroll/pph21.ts`, fungsi murni tanpa akses database seperti engine):

```text
bruto_employment = Σ baris EARNING hasil terakhir employment itu, kecuali BPJS_KES_ALLOW
              lalu, bila faktor_bayar ≠ 1: ROUNDUP(bruto_employment × faktor_bayar)   (sama dengan DIBAYAR, §5)
bruto_lapor = Σ bruto_employment per orang (employment tanpa blocker), §7.2 P11
kategori    = PPH21_TER.ptkpCategory[status PTKP profil]   (dicocokkan tanpa spasi, huruf besar)
tarif       = lapisan pertama kategori itu dengan upTo ≥ bruto_lapor (upTo null = tanpa batas atas)
PPh21       = FLOOR(bruto_lapor × tarif)   ke rupiah bulat (DRAFT); 0 bila bruto_lapor ≤ 0
```

Status implementasi dan keputusan `DRAFT` laporan ini: §7.2.

### 5.4 Blocker (fail closed)

- predikat penilaian kinerja yang tidak ada di kebijakan `PERFORMANCE_PERCENT` saat sambungan §5.5 menyala (`PERFORMANCE_PREDICATE_UNMAPPED`);

Periode tidak dapat diajukan bila ada blocker:

- MKG di luar tabel skala (D7);
- kepegawaian sudah berakhir tetapi tanggal akhirnya `UNKNOWN` di EMP-005 (pegawai tidak dibayar sebulan penuh hanya karena tanggalnya belum diresolusi);
- TMT berada setelah tanggal gajian (pegawai belum mulai bekerja pada periode ini);
- pegawai berhenti di tengah periode tanpa faktor prorata atau pernyataan eksplisit dibayar penuh;
- faktor prorata di luar rentang 0 < f ≤ 1;
- pendidikan, jabatan, atau unit tidak terpetakan ke kebijakan;
- kualifikasi khusus negatif tanpa penyesuaian;
- netto atau nilai dibayar negatif;
- potongan kasbon melebihi sisa pinjaman;
- kebijakan statutori tidak tersedia untuk tanggal periode;
- rekening kosong atau tidak valid untuk penerima transfer;
- profil kompensasi yang dipakai perhitungan dicatat pada baris hasil (`compensation_profile_id`), bersama versi kebijakan, agar periode lampau dapat dijelaskan;
- satu rekening dipakai lebih dari satu pegawai;
- input periode berubah setelah perhitungan terakhir.

Tiga blocker terakhir bersifat **tingkat periode**, bukan per pegawai, sehingga diperiksa pada lapisan periode saat perhitungan dijalankan, bukan di fungsi perhitungan per pegawai: satu rekening dipakai lebih dari satu pegawai, kebijakan statutori tidak tersedia untuk tanggal periode, dan input berubah setelah perhitungan terakhir (dibandingkan lewat `input_snapshot` hasil terakhir).

Peringatan (tidak memblokir, wajib ditinjau): selisih per komponen dibanding periode lalu di atas ambang §10 butir 6, pegawai baru/keluar, input manual bernilai besar.

### 5.5 Sambungan penilaian kinerja PERF-001 (dibangun 2026-11-17, sakelar default MATI)

Kontrak: `docs/domain/performance-review.md` §11. Implementasi: `apps/api/src/modules/payroll/performance-link.ts` (fungsi murni pemetaan) dan `calculation.ts` (pemilihan penilaian). PAY-001/PAY-002 tetap jalur slip resmi; sambungan ini hanya mengubah hasil PAY-003.

**Sakelar = kebijakan berversi.** Kebijakan opsional `PERFORMANCE_PERCENT` berbentuk `{ enabled: boolean, byPredicate: { <kode predikat>: <persen 0..2, ≤ 4 desimal> } }`. Sambungan **mati** bila tidak ada versi yang berlaku pada tanggal gajian (keadaan setelah migrasi 0153 — migrasi itu hanya membuka kunci kebijakan, tidak menulis versi) atau versinya `enabled: false`. Selama mati, tidak satu pun penilaian dibaca, `input_snapshot` dan `policy_version_ids` sama persis dengan sebelum sambungan ada, sehingga hasil tidak berubah sedikit pun. Karena berupa versi kebijakan, menyalakannya berlaku-efektif per tanggal gajian, dicatat audit `payroll.policy.*`, dan dilindungi aturan berlaku-mundur §3. Payload yang tidak sesuai bentuk menggagalkan perhitungan (`PAYROLL_POLICY_MISSING`, kode `INVALID`), bukan diam-diam kembali ke profil.

**Sumber (hanya saat menyala).**

| Persentase | Dibaca dari |
|---|---|
| `%bulanan` periode bulan *M* | penilaian `FINALIZED` pegawai itu pada siklus `MONTHLY` yang periodenya mulai tanggal 1 bulan *M−1* |
| `%tahunan` | penilaian `FINALIZED` pegawai itu pada **satu** siklus `ANNUAL` dengan awal periode terbaru di antara siklus yang sudah ditutup |

Siklus dihitung "sudah ditutup" bila berstatus `CLOSED` dan tanggal tutupnya (Asia/Jakarta) tidak setelah tanggal gajian, sehingga menghitung ulang periode lama setelah siklus berikutnya ditutup tidak membaca ke depan. `UNRATED`, `REMOVED`, penilaian yang belum final, dan siklus yang belum ditutup tidak pernah dibaca. Penilaian dimiliki pegawai (`employee_id`), sehingga dua employment orang yang sama memakai penilaian yang sama.

**Urutan.** `override HC periode itu` > `penilaian final` > `profil kompensasi` (> default masa kerja < 1 tahun §10 butir 3 bila keduanya kosong). Pegawai tanpa penilaian final memakai profil seperti hari ini; tidak ada nilai yang ditebak. Bila hanya `%bulanan` yang berasal dari penilaian dan `%tahunan` profil kosong, `%tahunan` = 0 (bukan `PERFORMANCE.unratedBelowOneYear.annualRate`), sama seperti profil yang hanya mengisi satu persen hari ini; default masa kerja < 1 tahun hanya dipakai bila kedua persen kosong. Pegawai honorer (`KONTRAK_HONORER`, `LEPAS`) tidak mendapat `PERF` (§5.2), sehingga penilaiannya tidak dibaca dan tidak memblokir.

**Predikat tanpa pemetaan.** Siklus boleh memakai kode predikat sendiri (PERF-001 D-06). Kode yang tidak ada di `byPredicate` menjadi blocker per pegawai `PERFORMANCE_PREDICATE_UNMAPPED`; HC menambah kodenya lewat versi kebijakan baru lalu menghitung ulang.

**Jejak.** Setiap baris hasil menyimpan `input_snapshot.performance_link = { policy_version_id, monthly, annual }`, masing-masing `{ review_id, cycle_id, cycle_kind, cycle_period_start, predicate, rate }` atau `null`. Audit `payroll.period.calculated` hanya menambah `performance_link_enabled` dan `performance_linked_count` (jumlah employment yang memakai sedikitnya satu penilaian) — tanpa predikat, persen, atau nominal per orang (§8).

**Keputusan `DRAFT` (default agent 2026-11-17, menunggu konfirmasi owner):**

| # | Keputusan | Default |
|---|---|---|
| K1 | Pemetaan predikat | A 100%, B 90%, C 75%, D 50% (usulan PERF-001 §11 butir 2); disimpan sebagai payload yang diisi HC, **bukan** di kode atau seed. |
| K2 | Bentuk sakelar | Versi kebijakan `PERFORMANCE_PERCENT` (bukan variabel lingkungan), agar berlaku-efektif dan teraudit seperti kebijakan lain. |
| K3 | Siklus tahunan tanpa penilaian final pegawai | Kembali ke profil, tidak mencari siklus tahunan yang lebih lama. |
| K4 | Siklus ditutup setelah perhitungan | Tidak membuat periode basi otomatis; HC menghitung ulang setelah menutup siklus. Penilaian yang dipakai terlihat di `performance_link`. |
| K5 | Kapan dinyalakan | Setelah owner menjadikan PAY-003 jalur slip resmi dan menyetujui K1 (PERF-001 §11 butir 6). Menyalakannya adalah perubahan kebijakan production yang dilaporkan. |

Rollback: menutup versi `PERFORMANCE_PERCENT` (versi baru `{ "enabled": false }`; `byPredicate` boleh dihilangkan selama mati) mematikan sambungan untuk tanggal gajian berikutnya tanpa rilis; rollback skema di komentar `-- Down:` migrasi 0153.

## 6. Lifecycle periode

```text
DRAFT → COLLECTING → CALCULATED → SUBMITTED → APPROVED → PAYMENT_CONFIRMED → PUBLISHED
            ↑              ↑          │              │             │                │
            └─ kembalikan ─┴──────────┘              │             │                │
            ↑                                        │             │                │
            └──── buka ulang disetujui ── REOPEN_REQUESTED ←──────────┴───────────────┘
```

`REOPENED` tidak dipakai sebagai state tersendiri: persetujuan buka ulang mengembalikan periode langsung ke `COLLECTING` dalam satu transisi, sehingga tidak ada state tanpa aktor dan tanpa audit event. "Kembalikan" oleh Direktur juga berakhir di `COLLECTING`, karena alasan pengembalian selalu berupa input atau profil yang harus diperbaiki.

| Transisi | Aktor | Precondition | Audit event |
|---|---|---|---|
| buat periode | HC | belum ada periode untuk bulan itu | `payroll.period.created` |
| mulai kumpulkan input | HC | DRAFT | `payroll.period.collecting` |
| hitung / hitung ulang | HC | COLLECTING atau CALCULATED | `payroll.period.calculated` (jumlah pegawai, total, blocker) |
| ajukan | HC (`payroll.submit`) | CALCULATED, tanpa blocker, hasil terbaru | `payroll.period.submitted` |
| kembalikan | Direktur | SUBMITTED, alasan wajib, tujuan COLLECTING | `payroll.period.returned` |
| sahkan | Direktur (`payroll.approve`), bukan pengaju | SUBMITTED; potongan pinjaman LOAN-001 masih muat dalam sisanya (§3.5) | `payroll.period.approved` (+ `loan_payments_settled`) |
| konfirmasi bayar | Keuangan (`payroll.payments.confirm`) | APPROVED | `payroll.payment.confirmed` |
| siapkan slip | HC (`payroll.periods.manage`) | PAYMENT_CONFIRMED atau PUBLISHED, tanpa blocker | `payroll.payslips.drafted` |
| terbitkan slip | pemegang `payslips.publish` | ada draft dari periode ini | `payroll.payslips.published` |
| minta buka ulang | HC | APPROVED/PAYMENT_CONFIRMED/PUBLISHED, alasan wajib | `payroll.reopen.requested` |
| setujui buka ulang | Direktur | REOPEN_REQUESTED | `payroll.reopen.approved` (periode kembali ke COLLECTING; pembayaran LOAN-001 dari periode ini dibalik, §3.5) |
| tolak buka ulang | Direktur | REOPEN_REQUESTED, alasan wajib | `payroll.reopen.rejected` (periode kembali ke state sebelumnya) |

Aturan:

- Satu periode per bulan per legal entity; operasi bersifat idempoten (mengulang aksi tidak menggandakan hasil).
- APPROVED mengunci snapshot input, versi kebijakan, dan baris hasil. Hasil revisi menyimpan lineage ke versi sebelumnya.
- Slip yang sudah dipublikasikan tidak diubah (PAYSLIP-001). Koreksi setelah publikasi memakai slip revisi yang membawa baris penanda `Status: Revisi` pada slip itu sendiri; slip lama ditandai `superseded_by_id` dan tidak lagi muncul di daftar slip pegawai, tetapi tetap tersimpan. Mekanismenya §10 butir 8.
- **Buka ulang setelah bayar atau setelah publikasi** tidak membatalkan pembayaran yang sudah terjadi. Hasil periode yang baru menyimpan `selisih_bayar = dibayar_baru − dibayar_lama` per pegawai. Selisih positif dibayarkan sebagai `ARREARS` pada periode berikutnya; selisih negatif menjadi `ADJUST_DEDUCT` pada periode berikutnya dengan alasan dan referensi keputusan. Konfirmasi bayar lama tetap tercatat sebagai fakta dan tidak dihapus.
- Laporan payroll baru terlihat oleh pembaca laporan setelah APPROVED. Sebelum itu, hanya aktor yang menyusun angkanya (`payroll.calculate`, `payroll.inputs.manage`) yang melihatnya. `payroll.periods.manage` saja tidak membuka angka apa pun (§7.3).

## 7. Output

Dua laporan terpisah, bukan satu (perbaikan review 2026-10-27):

- **Daftar transfer** (`payroll.transfers.read.organization`, hanya Keuangan dan Kepala Keuangan): per penerima — NIP, nama, unit, nominal dibayar, bank, nomor rekening, nama pemilik rekening, status konfirmasi bayar. Bank disimpan pada profil kompensasi (`bank_name`), bukan ditebak dari nomor rekening. Ekspor CSV UTF-8 dengan BOM dan akhir baris CRLF agar nama berdiakritik dan nomor rekening berawalan nol selamat di spreadsheet (§10 butir 7). Penerima dengan nominal nol tidak muncul; nominal negatif tetap muncul supaya Keuangan melihatnya. Setiap baca dan setiap ekspor dicatat sebagai akses sensitif.
- **Laporan payroll final** (`payroll.reports.read.organization` atau izin baca per orang §7.3; penyusun angka — `payroll.calculate`, `payroll.inputs.manage` — juga membacanya selama periode berjalan): rekap per unit dan per komponen, jumlah penerima, total bruto/potongan/netto/dibayar, dan biaya yayasan. **Tanpa nomor rekening.** Memegang `payroll.approve` atau `payroll.payments.confirm` saja tidak cukup untuk membacanya. Unit diambil dari profil yang dipakai saat hitung, sehingga laporan periode lampau terbaca seperti saat dibayar.
- Pengurus Yayasan tidak memperoleh kedua laporan di v1 (§2).
- **Perbandingan periode** (izin baca per orang §7.3): selisih per pegawai per komponen terhadap periode sebelumnya pada legal entity yang sama, disaring ambang §10 butir 6. Pegawai yang baru masuk atau keluar dilaporkan satu baris, bukan satu baris per komponen. Periode pertama menjawab perbandingan kosong, bukan error.
- **Slip pegawai:** hasil final dipetakan ke draft slip (`lines` label/value sesuai urutan katalog komponen) setelah pembayaran dikonfirmasi, lalu diterbitkan lewat aksi tersendiri yang meminta `payslips.publish` — payroll menyiapkan, pemegang permission itu menerbitkan. Jalur publish batch PAY-002 bekerja per batch impor dan tidak dapat melihat slip bersumber periode, sehingga payroll memakai pintunya sendiri dengan permission yang sama. Slip bersumber periode payroll (`payslips.source_period_id`), bukan batch impor; tepat satu sumber per baris. Slip yang belum terbit diperbarui di tempat; slip yang sudah terbit tidak pernah diubah. Bila slip berlaku untuk bulan itu ternyata milik batch impor PAY-001, payroll tidak menyentuhnya dan melaporkan pegawainya sebagai konflik, supaya batch impor tidak kehilangan draftnya.
- **Laporan PPh21 TER** per masa pajak dari hasil final — **sudah diimplementasikan** sebagai laporan (§7.2); baris `PPH21_EMPLOYER` ditulis perhitungan hanya bila PPh ditanggung yayasan (§7.5, mati secara bawaan).
- **Ringkasan biaya yayasan:** BPJS dan PPh21 yang ditanggung yayasan — `employerCostSummary` pada laporan periode (§7.5).

## 7.1 Layar operator (`DRAFT`, default agent 2026-10-27)

Satu layar daftar periode (`/admin/payroll`) dan satu layar periode (`/admin/payroll/{id}`). Keduanya terbuka bagi siapa pun yang memegang salah satu permission payroll; setiap angka di dalamnya tetap diotorisasi ulang oleh API, dan bagian yang ditolak (laporan sebelum disahkan, daftar transfer tanpa permission rekening) hilang dari layar tanpa menggagalkan sisanya.

Layar periode menampilkan status, tindakan yang benar-benar tersedia bagi aktor itu, rekap, daftar "perlu ditinjau", hasil per pegawai berikut blocker-nya, daftar transfer bagi yang berhak, dan riwayat keputusan berikut alasannya. Hasil dan daftar "perlu ditinjau" disertai nama dan NIP pegawai: `GET /payroll/periods/{id}/results` dan `.../variance` mengembalikan `employees`, satu baris identitas per employment, karena pengesah membaca nama dan bukan identifier. Identitas hanya terbaca oleh aktor yang sudah berhak membaca angka di sebelahnya, sehingga tidak menambah paparan data. Daftar pada `.../variance` dipersempit ke employment yang memang muncul sebagai baris varian, karena `payroll.calculate` membuka perbandingan ini tetapi tidak membuka daftar hasil. Frontend tidak memuat satu pun aturan payroll: tindakan lifecycle datang dari `availableActions`, pekerjaan di luar lifecycle (ambil input kehadiran, siapkan slip, terbitkan slip) dari `availableOperations`, dan tindakan mana yang mewajibkan alasan dari `reasonRequiredActions` — semuanya diputuskan server.

Daftar transfer tidak diambil otomatis: ia memuat nomor rekening dan setiap pembacaannya dicatat sebagai akses sensitif, sehingga operator membukanya dengan sengaja. Bagian yang ditolak menampilkan satu kalimat penjelasan, bukan ruang kosong, supaya Direktur tidak mengesahkan periode yang tampak kosong padahal hanya belum boleh dibaca.

Layar periode memuat panel **Input periode**: rapel, penyesuaian, prorata, konten Pj. Media, dan override yang diketik operator, berikut tombol hapus per baris. Lembur dan hari hadir PKWT tidak dapat diketik di sini karena resolver kehadiran menimpanya setiap kali dijalankan. Jenis input yang boleh diketik, yang wajib beralasan, yang wajib menyebut referensi keputusan, dan apakah periode ini masih menerima perubahan sama sekali (`editable`) datang dari `period.inputRules` — daftar dan syarat yang sama yang dipakai server untuk menolak, sehingga layar tidak menyimpan salinan aturan payroll. `PUT .../inputs` menolak kunci milik resolver dengan `PAYROLL_INPUT_RESOLVER_OWNED`: nilai yang diketik akan ditimpa resolve berikutnya dan menyimpang dari lembur yang sudah disetujui di ATT.

Membaca input satu periode diperlakukan seperti membaca hasil: sebelum periode disahkan hanya penjalan periode yang boleh membacanya, dan setiap pembacaan dicatat sebagai akses sensitif (`scope: period_inputs`). Satu baris input memuat rapel atau penyesuaian satu orang, jadi ia sama sensitifnya dengan hasil yang disuapinya.

Layar data acuan (`/admin/payroll/reference`) berisi tiga bagian yang dibuka oleh izin masing-masing: **Kebijakan** (`payroll.policies.manage`), **Kasbon** (`payroll.loans.manage`), dan **Profil kompensasi** (`payroll.profiles.manage`). Izinnya berbeda dari izin membaca periode: pengesah periode tidak boleh menulis ulang kebijakan yang dipakai menghitungnya, dan Keuangan yang memegang register kasbon tidak dengan sendirinya membuka periode. Bagian yang tidak dipegang aktor tidak ditampilkan, dan setiap permintaan tetap diotorisasi ulang oleh API. Profil kompensasi menyimpan nama bank di samping nomor rekening, karena daftar transfer mencetak keduanya.

**Profil baru tidak menghapus isian lama.** Satu profil adalah baris baru, bukan suntingan, sehingga field yang tidak disebut akan menjadi NULL dan "isi rekening" berubah menjadi "lupakan unit, jabatan, dan nilai kinerja". Karena itu server membedakan dua hal: field yang **tidak dikirim** dibawa dari profil yang berlaku pada tanggal baru, dan field yang dikirim bernilai **`null`** memang dikosongkan dengan sengaja. Layar operator hanya menampilkan sebagian field dan mengatakan apa yang dibawa.

Data acuan dibaca berhalaman: `GET /payroll/loans` dan `GET /payroll/employments` (pencarian typeahead untuk memilih pegawai) memakai `page`/`pageSize` default 25 maksimum 100 dengan `total`. Register kasbon bertambah setiap kali kasbon diberikan, dan daftar pegawai jauh di atas 50 opsi, sehingga keduanya tidak pernah dibaca utuh. Pemilih pegawai menyebut nama orang, jadi ia meminta permission yang sudah menjangkau nama: `payroll.profiles.manage`, `payroll.calculate`, atau `payroll.loans.manage` — Keuangan mencatat kasbon atas nama pegawai, sehingga harus dapat mencarinya. Employment yang sudah di-void tidak ikut muncul, karena perhitungan pun tidak melihatnya.

**Pengecualian ENG-LIST-001 untuk daftar kebijakan (`DRAFT`).** `GET /payroll/policies` mengembalikan seluruh versi tanpa halaman. Jumlahnya terbatas pada belasan kunci kebijakan dikali beberapa versi per kunci, dan daftar itu memang dibaca utuh untuk melihat rentang berlaku yang bersambung. Bila satu kunci melewati sekitar 200 versi, daftar ini dipindahkan ke endpoint berhalaman.

**Pengecualian ENG-LIST-001 (`DRAFT`).** Daftar periode berhalaman server-side. Dua tabel pada layar periode — hasil per pegawai dan daftar transfer — menampilkan seluruh baris satu periode tanpa halaman, karena keduanya adalah satu periode gaji yang dibatasi jumlah pegawai aktif yayasan (±330 pada 2026) dan keduanya memang dibaca utuh saat ditinjau atau dibayarkan. Bila jumlah pegawai melewati sekitar 1.000, keduanya dipindahkan ke endpoint berhalaman.

## 7.2 Laporan PPh21 TER (status implementasi)

**Endpoint.** `GET /payroll/periods/{id}/pph21?format=json|csv` (`docs/api/payroll.openapi.yaml`). Pembacanya pembaca angka per orang (§7.3): `payroll.results.read.organization`, `payroll.calculate`, atau `payroll.inputs.manage`. **`payroll.periods.manage` saja tidak cukup**: peran `hcis_module_admin` memegangnya untuk menjalankan lifecycle, dan itu bukan izin membaca bruto dan pajak per orang. Memegang `payroll.approve`, `payroll.payments.confirm`, atau rekap `payroll.reports.read.organization` saja juga tidak cukup. Pengurus Yayasan dan Super Admin tidak membacanya (§2). Penyempitan yang sama untuk `/report`, `/results`, `/inputs`, dan `/variance` sudah diterapkan (§7.3).

**Layar.** Bagian "Laporan PPh21 (TER)" pada layar periode, dibuka dengan sengaja seperti daftar transfer (tidak diambil otomatis), menampilkan total, baris per pegawai berikut penandanya, sumber tabel TER, dan unduhan CSV. Penolakan yang memang diharapkan (belum disahkan, tanpa akses, tabel TER belum dimuat) ditampilkan sebagai penjelasan, bukan galat.

**Baris dan penanda.** Satu baris **per orang** (`employee_id`) dari hasil perhitungan terakhir. TER adalah tarif atas penghasilan bruto bulanan seseorang, sehingga dua employment orang yang sama dalam satu periode dijumlahkan dulu sebelum lapisan dicari. Dengan satu pemberi kerja, dua employment hanya bertemu dalam satu periode secara berurutan (constraint `employments_no_overlap`), misalnya pindah status di tengah bulan. Employment yang hasilnya masih memiliki blocker tidak ikut dijumlahkan. Status PTKP dan pengecualian dibaca dari profil yang dipakai saat hitung (`compensation_profile_id`), sama seperti unit pada laporan payroll, sehingga masa pajak lampau terbaca seperti saat dibayar. Orang yang dikecualikan diletakkan setelah semua orang yang dilaporkan.

| Penanda | Arti | Akibat |
|---|---|---|
| `PTKP_MISSING` | status PTKP kosong atau tidak ada di `ptkpCategory` | tarif dan PPh21 kosong; tetap dihitung di jumlah pegawai dan bruto; `ptkpMissingCount` memberi tahu total pajak belum lengkap |
| `PTKP_CONFLICT` | dua employment orang yang sama membawa status PTKP berbeda | seperti `PTKP_MISSING`; HC menyamakan profilnya lalu periode dihitung ulang |
| `EXCLUDED` | salah satu profil orang itu menandai pengecualian, alasan ditampilkan | tidak dihitung pajaknya dan tidak masuk total; tetap tampil, di urutan terakhir |
| `ANNUAL_CALCULATION_REQUIRED` | masa pajak Desember, atau employment berakhir di dalam periode **dan** orang itu tidak memiliki employment lain dengan pemberi kerja yang sama yang berlanjut melewati periode | angka TER tetap ditampilkan tetapi dinyatakan **bukan angka final** |
| `NON_PERMANENT_TERMS` | kategori kontrak pada tanggal gajian (`employment_terms`) adalah `KONTRAK_HONORER` atau `LEPAS` | tetap dihitung dengan TER bulanan 21-100-01 (P10); penanda ini hanya memberi tahu bahwa aturannya menunggu konfirmasi |

Hasil yang masih memiliki blocker tidak dibayar, sehingga tidak dilaporkan (`skippedBlockedCount`).

**Keputusan `DRAFT` (default agent 2026-11-11, menunggu konfirmasi process owner):**

| # | Keputusan | Default v1 |
|---|---|---|
| P1 | Bentuk kebijakan `PPH21_TER` | `{ source, objectCode: "21-100-01", ptkpCategory: { <status>: A/B/C }, categories: { A, B, C: [{ upTo, rate }] } }`; lapisan naik berurutan, hanya lapisan terakhir `upTo: null`, tarif 0..1, `upTo` rupiah bulat. Divalidasi saat ditulis (route dan CLI pemuatan awal). **Tidak ada nilai tabel TER di kode, seed, atau test**; tabel dimuat process owner dari lampiran PP 58/2023 setelah diverifikasi (§10 butir 9, PAY-003-MIG §3.2). |
| P2 | Pembulatan PPh21 | `FLOOR` ke rupiah bulat atas bruto × tarif. |
| P3 | Status gerbang | Laporan baru terbuka setelah periode `APPROVED` ke atas **bagi semua pembaca, termasuk penjalan periode**, karena dibangun dari hasil final; berbeda dari laporan payroll yang dibaca penjalan periode sejak awal. Sebelum itu `409 PAYROLL_NOT_APPROVED_YET`. |
| P4 | Kebijakan tidak tersedia | `409 PPH21_TER_POLICY_MISSING` bila tidak ada versi `PPH21_TER` yang berlaku pada tanggal gajian; `409 PPH21_TER_POLICY_INVALID` bila versi yang berlaku (mis. dimuat sebelum skema ini ada) tidak sesuai bentuk. Kebijakan ini bukan kunci wajib perhitungan: ketiadaannya tidak memblokir periode. |
| P5 | Masa pajak terakhir | Desember dan bulan berakhirnya employment memakai perhitungan tahunan Pasal 17 menurut aturan. Laporan bulanan memberi baris itu `ANNUAL_CALCULATION_REQUIRED` dan angka TER-nya tetap tampil sebagai angka sementara; angka finalnya ada di rekap PPh21 tahunan dan bukti potong 1721-A1 (§7.4). |
| P6 | PPh21 ditanggung yayasan | **Mati secara bawaan**: tanpa `PPH21_SETTINGS.employerBorne`, laporan tidak menulis baris `PPH21_EMPLOYER` dan angka parallel run tetap stabil. Bila process owner menyatakan PPh ditanggung yayasan, perhitungan menulis baris itu (§7.5). |
| P7 | Pengecualian per orang | Atribut profil kompensasi `pph21_report_excluded` dengan `pph21_report_exclusion_reason` wajib (CHECK basis data, migration 0147). Mengikuti aturan profil: tidak dikirim = dibawa dari profil berlaku; `false` menghapus alasan. CLI pemuatan awal yang barisnya tidak menyebut pengecualian juga membawa nilai profil yang berlaku, bukan menulis `false`. Audit `payroll.profile.opened` mencatat `pph21_report_excluded` (penanda, bukan alasan). |
| P8 | Kolom ekspor | CSV UTF-8 dengan BOM dan CRLF: NIP, nama, status PTKP, kategori TER, penghasilan bruto, tarif (persen dengan koma desimal), PPh21, kode objek, dilaporkan (`Y`/`N`), catatan; orang yang dikecualikan di baris terakhir; nama berkas `pph21-ter-YYYY-MM.csv`. **Tanpa NIK/NPWP** — HCIS tidak menyimpannya untuk payroll; formulir DJP diisi dari lembar ini di luar HCIS. |
| P9 | Masa pajak | Masa pajak = bulan periode (`period_month`), bukan bulan tanggal gajian. Keduanya sama selama tanggal gajian berada di bulan periode, yang dijaga saat periode dibuat. |
| P10 | Kontrak honorer dan lepas | Bawaan (`DRAFT`, saklar mati): `KONTRAK_HONORER` dan `LEPAS` dilaporkan dengan kode objek 21-100-01 dan TER bulanan seperti pegawai tetap, ditandai `NON_PERMANENT_TERMS`. **Process owner wajib mengonfirmasi**: PMK 168/2023 dapat mewajibkan kode objek pegawai tidak tetap (21-100-03) dengan TER harian; aturan itu tersedia di balik `PPH21_SETTINGS.nonPermanentDailyTer` (§7.5). |
| P11 | Dua employment satu orang | Bruto dijumlahkan per orang sebelum lapisan dicari; satu pengecualian pada salah satu profil mengecualikan orangnya; status PTKP yang berbeda menghasilkan `PTKP_CONFLICT`, bukan memilih salah satu. |

**Privasi dan audit.** Setiap baca dan setiap ekspor dicatat `payroll.report.read` dengan `scope: pph21_report` atau `pph21_report_csv` dan jumlah baris, tanpa nominal. Respons `Cache-Control: no-store`.

**Yang tetap di luar v1** (bukan kekurangan implementasi, melainkan batas cakupan §1.2 dan keputusan di atas):

- ~~perhitungan tahunan Pasal 17 untuk masa pajak terakhir dan bukti potong 1721-A1~~ — **dibangun** (§7.4, migration 0157);
- ~~aturan PPh21 pegawai tidak tetap (21-100-03, TER harian)~~ — **dibangun** di balik saklar mati (§7.5); aturan Pasal 17 atas 50% bruto di atas plafon harian tetap di luar v1;
- ~~baris `PPH21_EMPLOYER` dan ringkasan biaya yayasan yang memuat PPh21 (P6)~~ — **dibangun** di balik saklar mati (§7.5);
- ~~NIK/NPWP~~ (disimpan tersegel sejak §7.4); berkas unggah e-Bupot/SPT Masa PPh21 dalam format DJP tetap di luar HCIS — rekap CSV §7.4 adalah bahan pengisiannya;
- THR;
- integrasi transfer bank (daftar transfer tetap CSV, §10 butir 7);
- penerima non-pegawai, reimbursement, multi legal entity, akuntansi.

## 7.3 Pembaca angka per orang (`DRAFT`, default agent 2026-11-17)

Angka per orang dipisahkan dari menjalankan periode dan dari membaca rekap. Sebelum perubahan ini `GET .../results`, `.../inputs`, `.../variance`, dan `.../report` menerima siapa pun yang memegang `payroll.periods.manage` — termasuk HCIS Module Admin (`hcis_module_admin`, AUTH-014), yang memegangnya hanya untuk menjalankan lifecycle — dan setelah periode disahkan, `.../results` dan `.../inputs` menerima pemegang permission payroll mana pun, termasuk `payroll.approve` atau `payroll.payments.confirm` saja.

| Bagian | Endpoint | Pembaca | Sebelum `APPROVED` |
|---|---|---|---|
| Angka per orang | `.../results`, `.../inputs` (GET), `.../variance`, `.../pph21` | `payroll.results.read.organization`, `payroll.calculate`, `payroll.inputs.manage` | hanya `payroll.calculate`/`payroll.inputs.manage` (PPh21: tidak ada, §7.2 P3) |
| Rekap periode | `.../report` | `payroll.reports.read.organization` atau salah satu pembaca angka per orang | hanya `payroll.calculate`/`payroll.inputs.manage` |
| Daftar transfer | `.../transfers` | `payroll.transfers.read.organization` (tidak berubah) | tidak ada |
| Periode itu sendiri | `GET .../periods`, `GET .../periods/{id}`, transisi | `PERIOD_READ_PERMISSIONS` + `payroll.results.read.organization` | — |

**Pemegang (`DRAFT`).** `payroll.results.read.organization` diberikan migration 0151 kepada **Direktur** (`director`, meninjau per orang sebelum mengesahkan) dan **Kepala Keuangan** (`finance_lead`, mencocokkan pembayaran dengan daftar transfer). Keduanya membaca angka per orang hari ini lewat `payroll.reports.read.organization`, sehingga tidak ada yang kehilangan akses yang memang dibutuhkannya. Kepala Human Capital membacanya lewat `payroll.calculate`/`payroll.inputs.manage`. HCIS Module Admin, Keuangan (`finance_officer`), Pengurus Yayasan, dan Super Admin tidak menerimanya. Matriks peran yang dipakai: tabel §2 dan `docs/domain/roles-permissions.md`.

**Layar.** `GET /payroll/periods/{id}` mengembalikan `period.readAccess` (`report`, `perPerson`, `transfers`), diputuskan server dari permission aktor. Layar periode tidak meminta dan tidak menampilkan panel yang `false` (rekap, perlu ditinjau, hasil per pegawai, input periode, laporan PPh21, daftar transfer), alih-alih menampilkan pesan "tidak memiliki akses". Panel yang hanya tertutup sementara (periode belum disahkan) tetap menjelaskan alasannya.

**Rilis.** Migration 0151 hanya menambah kunci; build lama tidak memeriksanya. Saat cutover, HCIS Module Admin kehilangan pembacaan angka per orang. Rollback: hapus kunci (komentar migration) dan rilis ulang build sebelumnya.

## 7.4 PPh21 masa pajak terakhir (Pasal 17) dan bukti potong 1721-A1

Ditambahkan 2026-11-17. Dasar hukum: PP 58/2023 dan PMK 168/2023 (TER selama tahun berjalan, penghitungan setahun dengan tarif Pasal 17 UU PPh sebagaimana diubah UU 7/2021 pada masa pajak terakhir), PER-2/PJ/2024 (bentuk 1721-A1). Implementasi: `apps/api/src/modules/payroll/pph21-annual.ts` (fungsi murni), `pph21-annual-store.ts`, `pph21-annual-routes.ts`; layar `/admin/payroll/pph21-annual` dan bagian **Bukti potong PPh21 (1721-A1)** di `/app/payslips`.

**Masa kerja dalam setahun.** Satu baris rekap adalah satu rentang masa kerja seorang pegawai dalam satu tahun pajak. Rentang ditutup oleh masa pajak terakhir: Desember, atau bulan berakhirnya employment tanpa employment lain yang berlanjut (aturan `ANNUAL_CALCULATION_REQUIRED` §7.2). Pegawai yang berhenti lalu masuk lagi dalam tahun yang sama mendapat dua rentang dan dua bukti potong (`DRAFT`). Bulan yang dihitung hanya periode yang sudah final (`APPROVED` ke atas, seperti laporan bulanan); periode lain dilaporkan sebagai `pendingPeriods`. Orang yang dikecualikan (§7.2 P7) dan employment yang masih memiliki blocker tidak masuk, sama seperti laporan bulanan.

**Rumus** (semua rupiah bulat; nilai dari kebijakan `PPH21_ANNUAL`, tidak ada di kode):

```text
bruto        = Σ bruto bulanan rentang itu (penghasilan yang benar-benar dibayar, §5.3; tanpa BPJS_KES_ALLOW)
biaya_jabatan = min(FLOOR(bruto × positionCost.rate), positionCost.monthlyCap × jumlah_bulan, positionCost.annualCap)
iuran_pensiun = Σ baris DEDUCTION yang kodenya ada di pensionContributionComponents (default kosong)
neto         = bruto − biaya_jabatan − iuran_pensiun          (tidak disetahunkan)
PTKP         = ptkp.taxpayer + (K: ptkp.married) + min(tanggungan, ptkp.maxDependents) × ptkp.perDependent
               status = status PTKP profil pada bulan pertama rentang
PKP          = FLOOR(max(0, neto − PTKP) / pkpRoundingUnit) × pkpRoundingUnit
PPh21_setahun = Σ lapisan brackets (Pasal 17) atas PKP, FLOOR ke rupiah
TER_sebelumnya = Σ PPh21 TER bulanan rentang itu kecuali bulan terakhirnya (§7.2)
PPh21_masa_terakhir = PPh21_setahun − TER_sebelumnya          (negatif = lebih potong, dikembalikan)
```

Contoh hitung manual (ada di test `payroll-pph21-annual.test.ts`): TK/0, Rp10.000.000 × 12 → biaya jabatan Rp6.000.000, neto Rp114.000.000, PKP Rp60.000.000, PPh21 setahun Rp3.000.000; TER Januari–November Rp200.000 × 11 = Rp2.200.000; Desember Rp800.000. K/2 berhenti Juni, Rp8.000.000 × 6, JHT Rp100.000/bulan → biaya jabatan Rp2.400.000, neto Rp45.000.000 < PTKP Rp67.500.000, PPh21 setahun 0, lebih potong Rp600.000.

**Penanda.** `OPEN` (masa pajak terakhir belum tiba; angka setahun belum dihitung dan bukti potong belum dapat dibuat), `PTKP_MISSING` (status awal rentang kosong atau bukan bentuk `TK/n`/`K/n`), `PRIOR_TAX_INCOMPLETE` (TER salah satu bulan sebelumnya tidak dapat dihitung — tabel TER belum dimuat atau PTKP bulan itu kosong — sehingga PPh21 masa terakhir kosong), `PERIOD_PENDING` (ada periode tahun itu sampai bulan terakhir rentang yang belum final — belum disahkan atau dibuka ulang — sehingga bulan itu hilang dari rentang; bukti potong ditolak `409 PPH21_A1_PERIOD_PENDING` dan tidak ditampilkan ke pegawai sampai periode itu final).

**Baris 1721-A1.** Komponen `EARNING` dipetakan ke baris formulir: `BASIC` → 1 gaji; `TEACH_FEE`, `PJ_MEDIA` → 4 honorarium; `THR`, `BONUS` → 7 tantiem/bonus/THR; lainnya → 3 tunjangan lainnya dan lembur. Kebijakan dapat menimpa per kode (`lineByComponent`). Dengan faktor bayar, tiap baris dikali faktor dan dibulatkan ke bawah, dan sisa rupiahnya masuk ke baris terbesar, sehingga jumlah baris 1–7 selalu sama dengan bruto §5.3. Baris 2 (tunjangan PPh), 5 (premi asuransi), 6 (natura) dan 13 (neto masa sebelumnya) bernilai 0 di v1.

**Keputusan `DRAFT` (default agent 2026-11-17, menunggu konfirmasi process owner):**

| # | Keputusan | Default |
|---|---|---|
| A1 | Bentuk kebijakan `PPH21_ANNUAL` | `{ source, ptkp: { taxpayer, married, perDependent, maxDependents }, positionCost: { rate, monthlyCap, annualCap }, brackets: [{ upTo, rate }], pkpRoundingUnit, pensionContributionComponents: [], lineByComponent: {}, withholder: { name, taxNumber } }`, divalidasi saat ditulis. Versi yang berlaku pada **31 Desember** tahun pajak dipakai. Ketiadaannya: `409 PPH21_ANNUAL_POLICY_MISSING`; tidak memblokir periode. Migration 0157 menambah kunci ini ke constraint `payroll_policy_versions`. |
| A2 | Status PTKP | Dari profil kompensasi bulan pertama rentang (keadaan awal tahun pajak/awal masa kerja). Bentuk lain dari `TK/n`/`K/n` (mis. `K/I/n`) tidak ditebak. Belum ada field PTKP baru: `ptkp_status` profil sudah berlaku-efektif. |
| A3 | Premi BPJS Kesehatan | Mengikuti dasar §5.3 (D9): `BPJS_KES_ALLOW` tidak masuk bruto dan baris 5 bernilai 0, karena efek bersihnya nol bagi pegawai. **Process owner perlu memastikan**: PMK 168/2023 memperlakukan premi yang dibayar pemberi kerja sebagai penghasilan; bila dikonfirmasi, kode itu dipindahkan ke baris 5 dan dasar §5.3 berubah bersamaan. |
| A4 | Pembulatan | PKP ke bawah kelipatan `pkpRoundingUnit` (Rp1.000); biaya jabatan dan pajak `FLOOR` ke rupiah. |
| A5 | Iuran pensiun/JHT | Belum ada komponen iuran JHT/JP pegawai di katalog v1, sehingga `pensionContributionComponents` default kosong. |
| A6 | Pegawai melihat bukti potong | Lewat endpoint self, hanya rentang yang sudah ditutup dan periode masa terakhirnya `PUBLISHED`. Endpoint self mensyaratkan pegawai dan akun aktif; pegawai yang sudah berhenti menerima cetakan dari HC (batas yang sama dengan paklaring DOC-001). |
| A7 | Nomor bukti potong | HCIS tidak menerbitkan nomor resmi; dokumen membawa referensi `HCIS-A1-<tahun>-<NIP>-<urut>`, nomor resmi berasal dari e-Bupot. |
| A8 | Pemotong dan penanda tangan | Nama dan NPWP pemotong dari `withholder` kebijakan (data yayasan, bukan data pribadi). Penanda tangan diselesaikan seperti PAYSLIP-005 (Kepala HCM, cadangan Direktur, tanpa menandatangani milik sendiri). |
| A9 | Pegawai tidak tetap | Selama P10 belum diputuskan, kontrak honorer/lepas dilaporkan TER bulanan 21-100-01 dan ikut rekap tahunan seperti pegawai tetap. |
| A10 | Dokumen dihitung saat dibaca | 1721-A1 tidak disimpan sebagai snapshot; ia dihitung ulang dari hasil final setiap kali dibuka dan mencetak versi kebijakan yang dipakai. Membuka ulang periode yang sudah final mengubah angkanya — karena itu rentang dengan periode yang tidak final ditolak (`PERIOD_PENDING`). Snapshot saat penerbitan resmi adalah tindak lanjut bila process owner menghendakinya. |
| A11 | Bulan sebelum HCIS | Bila payroll HCIS mulai di tengah tahun pajak, bulan yang dibayar lewat spreadsheet tidak ada di HCIS dan rentang terbaca seperti pegawai yang masuk di tengah tahun. Tahun pajak pertama HCIS karena itu dicocokkan manual dengan rekap legacy sebelum bukti potong diserahkan (baris 13 "neto masa sebelumnya" tetap 0 di v1). |
| A12 | Nomor yang tidak terbuka | NIK/NPWP yang tidak dapat dibuka (baris rusak atau kunci server dirotasi) tampil kosong, disebut di `unreadable` dokumen dan dihitung di audit ekspor (`unreadable_count`), tanpa menggagalkan seluruh rekap. |

**NIK dan NPWP (`DRAFT`).** Bukti potong wajib memuat NIK/NPWP penerima, dan HCIS sebelumnya tidak menyimpannya. Tabel `payroll_tax_identities` (migration 0157) menyimpan keduanya **tersegel** AES-256-GCM dengan kunci turunan HKDF dari kunci server dan label tersendiri; associated data mengikat nilai ke pegawai dan kolomnya. Hanya empat digit terakhir disimpan terbaca untuk tampilan tersamar. NIK 16 digit; NPWP 15 atau 16 digit. Ditulis lewat `PUT /payroll/employees/{id}/tax-identity` oleh pemegang `payroll.profiles.manage`, tidak atas dirinya sendiri (aturan konflik kepentingan §2); field yang tidak dikirim dibiarkan, `null` mengosongkan. Nilai utuh **hanya** dibuka untuk dokumen 1721-A1 dan rekap CSV e-Bupot; layar rekap JSON hanya menyebut ada/tidaknya. Rotasi kunci server membutuhkan penyegelan ulang (tindak lanjut operasional).

**Endpoint dan izin.**

| Endpoint | Pembaca | Audit (tanpa nominal, tanpa NIK/NPWP) |
|---|---|---|
| `GET /payroll/pph21/annual?year=` (`format=csv`) | pembaca angka per orang §7.3 | `payroll.report.read` scope `pph21_annual` / `pph21_annual_csv` (+`includes_tax_identity`) |
| `GET /payroll/pph21/annual/{year}/employees/{employeeId}/a1/{index}` | pembaca angka per orang §7.3 | `payroll.a1.read` scope `pph21_a1` |
| `GET /payroll/me/a1`, `GET /payroll/me/a1/{year}/{index}` | pegawai sendiri (aktif) | `payroll.a1.read` scope `pph21_a1_self` (dokumen saja) |
| `GET`/`PUT /payroll/employees/{id}/tax-identity` | `payroll.profiles.manage` | `payroll.tax_identity.updated` (nama field dan yang dikosongkan) |

**Pengecualian ENG-LIST-001 (`DRAFT`).** Rekap tahunan dibaca utuh tanpa halaman, sama seperti laporan PPh21 bulanan: satu tahun pajak dibatasi jumlah pegawai yayasan dan memang dibaca utuh untuk pelaporan. Bila jumlah baris melewati sekitar 1.000, rekap dipindahkan ke endpoint berhalaman.

**Layar.** `/admin/payroll/pph21-annual` (menu **PPh21 Tahunan & 1721-A1**) terbuka bagi pembaca angka per orang: pilih tahun, rekap per rentang, unduh CSV e-Bupot, tombol **1721-A1** pada rentang yang sudah ditutup (pop-up A4, **Cetak / Simpan PDF**), dan tombol **NIK/NPWP** bagi pemegang `payroll.profiles.manage`. Pegawai melihat bukti potongnya di bawah slip gaji.

**Rollback.** Migration 0157: `-- Down:` di berkasnya (menghapus tabel identitas — catat sumber dokumen sebelum menghapus — dan mengembalikan constraint kunci kebijakan). Kode: rilis ulang build sebelumnya; tidak ada data hasil payroll yang ditulis oleh fitur ini.

## 7.5 PPh21 ditanggung yayasan dan pegawai tidak tetap (`DRAFT`, default agent 2026-11-17)

Ditambahkan 2026-11-17 untuk keputusan P6 dan P10 §7.2. Keduanya berada di balik satu kebijakan berversi `PPH21_SETTINGS` (migration 0159) yang **mati secara bawaan**: tanpa baris kebijakan, perhitungan, laporan PPh21, dan rekap tahunan berperilaku persis seperti sebelumnya, sehingga angka parallel run tidak bergeser.

```text
PPH21_SETTINGS = {
  source,
  employerBorne: false,            // P6: PPh21 ditanggung yayasan
  nonPermanentDailyTer: false,     // P10: honorer/lepas memakai TER harian 21-100-03
  daily: null | { objectCode: "21-100-03", brackets: [{ upTo, rate }], dailyCeiling }
}
```

Bentuknya divalidasi saat ditulis; `nonPermanentDailyTer: true` tanpa tabel `daily` ditolak. Tabel TER harian dimuat process owner dari lampiran PP 58/2023 seperti `PPH21_TER` — tidak ada nilai tabel di kode. Baris yang tidak terbaca ditolak, bukan dianggap mati: laporan bulanan menjawab `409 PPH21_SETTINGS_POLICY_INVALID` dan perhitungan gagal tertutup seperti kebijakan statutori lain (§5.4).

**P6 — `PPH21_EMPLOYER` (`employerBorne`).** Bila aktif, setiap hitung/hitung ulang periode menulis satu baris `PPH21_EMPLOYER` (kategori `EMPLOYER_COST`) per orang pada employment pertamanya yang dibayar; nilainya juga masuk `employer_cost` hasil dan total `biaya yayasan` periode. Angkanya sama dengan laporan PPh21 bulanan untuk orang itu: TER bulanan 21-100-01, TER harian 21-100-03 (bila P10 aktif), atau — pada masa pajak terakhir — PPh21 masa terakhir hasil perhitungan tahunan Pasal 17 §7.4 (PPh21 setahun dikurangi TER bulan-bulan sebelumnya; negatif berarti lebih potong yang dikembalikan, sehingga baris itu mengurangi biaya yayasan). Bila kebijakan `PPH21_ANNUAL` belum ada, atau ada bulan sebelumnya dalam tahun itu yang belum final (belum disahkan, dibuka ulang) atau tanpa tabel TER, masa terakhir memakai angka TER dengan dasar "perhitungan tahunan belum lengkap" — tidak pernah menyelesaikan tahun atas bulan yang hilang. Hasil mencatat id versi `PPH21_SETTINGS`, `PPH21_TER`, dan `PPH21_ANNUAL` yang dipakai pada `policy_version_ids` (ADR-0003). Orang yang dikecualikan (§7.2 P7) atau yang PPh21-nya tidak dapat dihitung (PTKP kosong, hari hadir kosong) tidak mendapat baris; laporannya tetap menandai mereka. `employerBorne` aktif tanpa `PPH21_TER` yang valid pada tanggal gajian menolak perhitungan (`PPH21_TER` `MISSING`/`INVALID`). Baris ini tidak dicetak di slip pegawai (slip hanya memuat `EARNING` dan `DEDUCTION`), dan PPh21 yang ditanggung tidak digross-up ke penghasilan pegawai (`DRAFT`).

**Ringkasan biaya yayasan.** `GET /payroll/periods/{id}/report` menambah `employerCostSummary: { bpjsKesehatan, pph21, total }` — BPJS Kesehatan yang dibiayai yayasan lewat `BPJS_KES_ALLOW` dan PPh21 `PPH21_EMPLOYER` — dan layar periode menampilkannya di bawah **Biaya yayasan**. Agregat periode, bukan angka per orang.

**P10 — TER harian (`nonPermanentDailyTer`).** Bila aktif, orang yang kategori kontraknya pada tanggal gajian `KONTRAK_HONORER` atau `LEPAS` dilaporkan dengan kode objek **21-100-03**:

```text
hari        = CONTRACT_ATTENDANCE_DAYS dari snapshot input hasil (Σ antar-employment)
rata_harian = bruto_lapor / hari
tarif       = lapisan pertama daily.brackets dengan upTo ≥ rata_harian
PPh21       = FLOOR(bruto_lapor × tarif)        (setara Σ per hari karena semua hari jatuh di lapisan rata-rata, DRAFT)
```

Hanya berlaku bila **semua** employment orang itu yang dibayar bulan itu tidak tetap; orang yang juga memiliki employment tetap pada bulan yang sama tetap memakai TER bulanan 21-100-01 atas seluruh bruto dan diberi penanda `MIXED_TERMS` (gaji tetap tidak pernah dibagi hari hadir honorer). TER harian tidak memerlukan PTKP dan tidak ada perhitungan tahunan: baris itu tidak diberi `ANNUAL_CALCULATION_REQUIRED` dan bulannya tidak ikut rekap tahunan/1721-A1 (§7.4). Penanda baru: `DAILY_DAYS_MISSING` (hari hadir kosong; pajak kosong) dan `DAILY_ABOVE_CEILING` (rata-rata harian di atas `dailyCeiling`; PMK 168/2023 memakai tarif Pasal 17 atas 50% bruto, yang **tidak** dihitung HCIS v1). Kolom "Kode objek" CSV kini per baris.

Contoh hitung manual (test `payroll-pph21-employer.test.ts`, tabel sintetis 0% s.d. Rp450.000/hari, 0,5% di atasnya): honorer Rp11.000.000 dalam 20 hari hadir → Rp550.000/hari → 0,5% × Rp11.000.000 = **Rp55.000**; Rp9.000.000/20 hari = Rp450.000 → 0. Desember TK/0 Rp10.000.000 × 12 dengan TER Rp200.000/bulan → `PPH21_EMPLOYER` Desember **Rp800.000** (= 1721-A1 baris 19).

**Keputusan `DRAFT` tambahan:** rata-rata harian mewakili setiap hari; ambang di atas plafon tidak dihitung; PPh21 ditanggung tidak digross-up; dasar penghasilan tetap §5.3 (tanpa `BPJS_KES_ALLOW`). Process owner yang menyalakan salah satu saklar wajib memuat tabelnya lebih dulu dan menghitung ulang periode yang masih dikerjakan; periode yang sudah disahkan tidak berubah.

**Rollback.** Matikan saklar dengan versi kebijakan baru (`employerBorne: false`) lalu hitung ulang periode yang masih dikerjakan; migration 0159 `-- Down:` mengembalikan constraint kunci kebijakan.

## 8. Privasi dan audit

- **Dilarang** di application log dan payload audit: nominal **per orang**, nomor rekening, nama pemilik rekening, NIK, dan isi baris slip.
- **Diizinkan** di payload audit: identifier (periode, employment id, aktor), jumlah baris/pegawai, status, kode blocker, dan **total agregat periode** (bruto, potongan, netto, dibayar, biaya yayasan). Total agregat bukan data perorangan, sehingga `payroll.period.calculated` dan `payroll.period.approved` boleh memuatnya.
- Respons laporan dan slip memakai `Cache-Control: no-store`.
- Laporan per orang dan ekspor dicatat sebagai akses sensitif.
- Pengurus Yayasan tidak memiliki permission payroll di v1 (§2): tidak membaca laporan, input, maupun profil.
- NIK dan NPWP disimpan tersegel (§7.4), tidak pernah ditulis ke log atau audit, dan hanya dibuka pada dokumen 1721-A1 dan rekap e-Bupot.

## 9. Migrasi dan verifikasi

### 9.1 Migrasi data awal

- Tabel kebijakan dari tab `FORMULA GAJI` dan parameter terkait (dicatat sumber dan tanggal berlaku).
- Profil kompensasi dari master SDM dan input kinerja/jam terakhir; kepesertaan BPJS dari data kepesertaan + SK pendaftaran bertahap.
- Saldo kasbon berjalan dari tab kasbon.
- Histori `PAYROLL` lama tidak dihitung ulang; tetap sebagai arsip/slip impor PAY-001.

Setiap migration memiliki rollback/recovery plan pada spesifikasi implementasinya.

Spesifikasi implementasi pemuatan data awal: **PAY-003-MIG** `docs/domain/payroll-initial-data-load.md` (CLI `payroll:initial-load`, dry-run default, idempoten, rollback §8). Pemuatan itu juga membuat skema `SALARY_SCALE` menerima nominal skala pecahan; `BASIC` tetap rupiah bulat.

### 9.2 Parallel run

- Minimal 2–3 periode berturut-turut HCIS dan spreadsheet dijalankan bersamaan.
- Bandingkan per pegawai per komponen. Gate: selisih nol, atau setiap selisih dijelaskan oleh perubahan yang disengaja:
  - dasar BPJS (D11);
  - lembur lebih dari satu baris per periode (A3);
  - pemisahan penyesuaian gaji dari kualifikasi khusus (D1);
  - dasar PPh21 dari nominal yang benar-benar dibayar (D9);
  - presedensi prorata atas faktor masa kerja awal (§5.1), yang di legacy diterapkan manual;
  - anggota keluarga tambahan BPJS yang diturunkan dari tanggungan, bukan diketik (§3.3).
- Selisih di luar daftar ini menggagalkan gate; tidak boleh dijelaskan setelah fakta.
- Selama parallel run, PAY-001/PAY-002 tetap jalur slip resmi.

### 9.3 Test minimum

- Potongan LOAN-001 (§3.5): usulan cicilan eksak (bigint), sakelar mati tanpa cermin dan tanpa potongan, pengesahan mencatat sekali (idempoten), buka ulang membalik, pengesahan ulang mencatat lagi, pembayaran tunai dihitung lebih dulu, potongan `MANUAL` dan penundaan 0 dipertahankan, sisa berubah menolak pengesahan, route LOAN-001 menolak `PAYROLL_DEDUCTION` manual (`test/payroll-employee-loan-link.test.ts`, `test/payroll-calculation.integration.test.ts`, `test/loans.postgres.test.ts`).
- Sambungan PERF-001 (§5.5): sakelar mati menghasilkan baris dan snapshot identik; pemetaan A–D tepat ke rupiah; urutan override > penilaian > profil; siklus terbuka, `UNRATED`, dan siklus ditutup setelah tanggal gajian tidak dibaca; predikat tanpa pemetaan memblokir (`test/payroll-performance-link.test.ts`, `test/payroll-calculation.integration.test.ts`).
- Unit test fungsi perhitungan per komponen dengan kasus batas: MKG 0/27/28, jam 0/96/lebih/kurang, BPJS di bawah UMK dan di atas Rp12 juta, segmen PBI, anggota tambahan, masa kerja 1/2/3 bulan, kualifikasi khusus negatif, kasbon melebihi sisa.
- Golden test dari data sintetis yang meniru struktur spreadsheet (bukan data produksi).
- Test otorisasi untuk setiap permission di §2, termasuk larangan self-approval dan read-only Pengurus.
- Test transisi lifecycle, idempotensi, dan blocker.

## 10. Keputusan yang sudah ditetapkan (default `DRAFT`)

Butir berikut sebelumnya terbuka. Agar implementasi dapat berjalan, setiap butir memakai default paling masuk akal, ditandai `DRAFT`, dan disimpan sebagai parameter kebijakan berversi sehingga process owner dapat mengubahnya tanpa perubahan kode.

| # | Keputusan | Default v1 (`DRAFT`) | Dasar |
|---|---|---|---|
| 1 | Jendela cutoff lembur dan kehadiran PKWT | Tanggal **23 bulan sebelumnya s.d. 22 bulan periode** (Asia/Jakarta, inklusif), sama dengan cutoff Pj. Media legacy. Disimpan sebagai `cutoff_start_day`/`cutoff_end_day` per periode, dapat diubah per periode oleh HC dengan alasan. | Audit legacy §Pj. Media langkah 3 (23–22); satu jendela untuk semua input menghindari dua kalender. |
| 2 | Komponen bertanda tunjangan tetap (dasar BPJS) | `PERF` (tunjangan kinerja) **ya**; `SPECIAL_QUAL` **ya**; `TEACH_OVER` (kelebihan jam) **tidak**. | Tunjangan kinerja dan kualifikasi khusus dibayar rutin tanpa bergantung kehadiran → tunjangan tetap. Kelebihan jam berubah tiap bulan mengikuti beban mengajar → tunjangan tidak tetap (Perpres 82/2018 Pasal 30). |
| 3 | Default kinerja masa kerja < 1 tahun | `%tahunan = 0`, `%bulanan` diisi penilai; bila belum ada penilaian pada periode itu, `%bulanan = 0` — tunjangan kinerja tidak dibayar sampai ada penilaian (**keputusan owner 2026-11-04**, mengganti default agent 100%). Penetapan persentase dilakukan atasan langsung dan disahkan Kepala HCM lewat profil kompensasi berlaku-efektif. Disimpan di kebijakan `PERFORMANCE.unratedBelowOneYear`. | Sama dengan spreadsheet legacy, yang membayar 0 kepada pegawai di bawah setahun tanpa penilaian; default 100% sebelumnya akan membayar porsi bulanan kepada mereka. |
| 4 | Definisi "hadir" untuk transport PKWT | Hari kerja dengan **check-in tercatat** pada versi hasil kehadiran terbaru dalam jendela cutoff, satu hari dihitung satu kali, tanpa memperhitungkan keterlambatan. Hari cuti/izin/libur tidak menghasilkan transport, kecuali hari libur yang memang dijadwalkan kerja (`holiday_scheduled_work`). Hari yang tercatat sebelum ATT-014 menambahkan jenis hari dianggap hari kerja. Hari tugas luar ATT-015 yang `APPROVED` tanpa check-in (`field_assignment`) juga menghasilkan transport; WFH/WFA (`remote_work`) tanpa check-in tidak (ATT-015 D-07, ACCEPTED owner 2026-11-03). Hari dinas TRIP-001 Paket 2 (`business_trip`, perjalanan `ISSUED`/`COMPLETED`) diperlakukan sama dengan tugas luar: dihitung hadir satu kali, tanpa komponen biaya perjalanan apa pun di payroll (`docs/domain/business-travel.md` §9.2, D-17 `DRAFT`). | Transport mengganti ongkos perjalanan; dasarnya pegawai berangkat untuk bekerja (ke lokasi kerja atau ke tempat tugas luar), bukan kelengkapan jam. |
| 5 | Tarif dan verifikator Pj. Media | Tarif per konten disimpan pada penugasan Pj. Media (`ADDITIONAL` placement) berlaku-efektif; nilai awal Rp30.000, Rp40.000 untuk penugasan yang ditetapkan tertulis. Rekap periode diverifikasi **Kepala HCM** sebelum menjadi input. | Legacy memilih tarif manual tanpa aturan (temuan audit); mengikat tarif ke penugasan menghilangkan pilihan per bulan. |
| 6 | Ambang peringatan selisih antar periode | Peringatan bila selisih mutlak komponen > **10%** dan > **Rp50.000** dibanding periode sebelumnya. Pegawai baru/keluar dilaporkan satu baris dengan nominal utuh **tanpa memandang ambang**, dan input manual > **Rp1.000.000** adalah pemicu tersendiri. Ambang disimpan sebagai kebijakan; nilai yang tidak masuk akal (negatif, bukan angka) jatuh ke default. Pembanding adalah periode sebelumnya yang sudah `APPROVED` ke atas. | Dua syarat sekaligus menekan peringatan palsu pada komponen kecil; pegawai baru/keluar adalah fakta yang harus dilihat peninjau apa pun nominalnya. |
| 7 | Format ekspor laporan Keuangan | **CSV UTF-8** (satu baris per penerima: NIP, nama, unit, nominal dibayar, bank, nomor rekening, nama pemilik rekening) dan tampilan HTML di HCIS. Tanpa pembuatan surat/memorandum (ADR-0003 keputusan 6). Setiap ekspor dicatat sebagai akses sensitif. | CSV cukup untuk pembuatan daftar pindah buku dan tidak mengunci ke format bank tertentu. |
| 8 | Slip revisi setelah publikasi | Slip terbit tidak diubah. Reopen yang disetujui Direktur menghasilkan **slip revisi** dengan `revision_of` menunjuk slip sebelumnya; slip lama ditandai `superseded_by_id` dan tetap dapat dibaca pegawai. Tepat satu slip berlaku per pegawai per bulan, dijaga unique index parsial. | PAYSLIP-001 melarang mutasi slip terbit; lineage menjaga jejak audit. |
| 9 | Verifikasi naskah BPJS dan tabel TER | Nilai statutori (5%, +1% per anggota tambahan, batas atas Rp12.000.000, batas bawah UMK, tabel TER A/B/C) disimpan sebagai **baris kebijakan berversi dengan kolom sumber dan tanggal berlaku**, bukan konstanta kode. Verifikasi naskah resmi dilakukan saat pengisian data kebijakan, bukan saat implementasi engine. Bentuk payload `PPH21_TER` divalidasi sejak laporan PPh21 dibangun (§7.2 P1); isinya tetap dimuat dan diverifikasi process owner. | Menghindari engine menunggu verifikasi dokumen; perubahan peraturan cukup menambah versi kebijakan. |

Perubahan atas default di atas dilakukan dengan menambah versi kebijakan (bukan menimpa), sehingga periode lama tetap dapat dihitung ulang secara sah. Satu pengecualian sempit: versi yang dibuka pemuatan awal PAY-003-MIG dan **belum dipakai hasil perhitungan mana pun** boleh dikoreksi di tempat oleh CLI pemuatan awal dengan alasan tertulis, karena versi itu belum pernah membayar siapa pun (PAY-003-MIG §5.4; audit `payroll.policy.version_corrected` menyimpan payload sebelumnya).
