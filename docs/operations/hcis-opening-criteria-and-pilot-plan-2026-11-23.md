# Kriteria go/no-go pembukaan HCIS dan rencana pilot terbatas

**Spec ID:** OPS-OPEN-001
**Status:** PROPOSED untuk kriteria G1–G13; **tiga keputusan §9 sudah diambil owner pada 2026-11-25** — D1 (bertahap lewat pilot), D2 (unit pilot **Taman Tahfizh**, modul **Cuti Tahunan**), dan D3b (menyiapkan baris pengaturan rollout untuk node unit itu). Selebihnya tetap diajukan, belum berlaku.
**Disiapkan:** 2026-11-23
**Pembaruan 2026-11-25:** pengukuran unit pilot, penghambat yang ditemukan, dan daftar prasyaratnya ada di `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001). Tiga hal dari sana yang mengubah isi dokumen ini ditandai di §3.2, §7.1, §7.1a, dan §7.6. **G12 kini terpenuhi** untuk ketiga perilaku yang dibutuhkan pilot: ketiganya berjalan di production sejak `hcis-f6edebd4-20261125`.
**Keputusan yang ditopang:** "Pilot ready" dan "Production ready" di `docs/product/scope.md`, yang penandatanganannya terjadi di `go-live-decision-record-template.md` (OPS-GOLIVE-001), bukan di sini.
**Sumber angka production:** pengukuran baca-saja owner pada 2026-11-20 dan 2026-11-23, sebagaimana dicatat `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) §3 dan §4. Penulis dokumen ini tidak punya akses production, **tidak menurunkan ulang angka itu, dan tidak menyalin tabelnya**. Dua pengukuran baca-saja 2026-11-23 yang dipakai di sini belum masuk OPS-CLOSE-001 — penelusuran bagan terbit dan kelengkapan email — dan ditandai di tempatnya masing-masing (§10).
**Sumber angka repository:** `origin/main` pada `1e5d46fd` (merge #399, 2026-11-23).

---

## 0. Untuk apa dokumen ini, dan untuk apa ia bukan

OPS-CLOSE-001 menjawab **di mana posisi tiap butir hari ini**. Ia sengaja tidak menjawab dua pertanyaan lain, dan kedua pertanyaan itulah isi dokumen ini:

1. **Apa yang harus benar sebelum pintu dibuka** — dirumuskan sebagai pertanyaan ya/tidak yang dapat diperiksa, dengan pemeriksanya dan caranya.
2. **Seperti apa percobaan terbatas yang pertama** — satu unit, sedikit orang, pekerjaan nyata, berbatas waktu, dengan ukuran keberhasilan, syarat berhenti, dan jalan mundur.

Tiga aturan pemakaian dokumen ini:

- **Bukti tidak diulang di sini.** Setiap kriteria menunjuk ke baris OPS-CLOSE-001 atau OPS-READY-001 yang memegang buktinya, atau menyatakan terus terang bahwa buktinya **belum ada**. Bila dua dokumen berbeda angka, yang berlaku adalah OPS-CLOSE-001, karena di sanalah pengukurannya dicatat.
- **Dokumen ini tidak memerintahkan satu tindakan pun.** Mengaktifkan akun, menulis baris pengaturan rollout, mengirim undangan, melebarkan daftar izin WhatsApp, menyalakan saklar, atau memindahkan jalur payroll adalah **keputusan owner, HCM, atau HC yang belum diambil**. Yang ditulis di sini adalah *syarat*, bukan *instruksi*, dan urutan di §6 menjelaskan ketergantungan **bila** keputusan itu diambil — bukan mengusulkan agar diambil sekarang.
- **Rekomendasi diberi label.** Kalimat yang diawali **Rekomendasi penulis** adalah pendapat penyusun dokumen ini, bukan kesepakatan. Keputusan milik orang lain ditulis di §9 sebagai keputusan yang menunggu, lengkap dengan pemiliknya.

Satu hal yang tidak dilunakkan: **tidak satu pun kriteria pintu di §3 terpenuhi hari ini.** Yang belum terpenuhi dan yang belum terverifikasi dibedakan, karena keduanya menuntut pekerjaan yang berbeda.

*Pembaruan 2026-11-25: satu baris sudah berubah — **G12 terpenuhi** untuk ketiga perilaku yang dibutuhkan pilot, lewat rilis `hcis-f6edebd4-20261125`. Dua belas baris lainnya belum.*

## 1. Dua keputusan yang berbeda, dan tidak boleh digabung

| | Keputusan A — **membuka pintu sama sekali** | Keputusan B — **membuka satu modul** |
|---|---|---|
| Pertanyaannya | Bolehkah ada pegawai di luar HC yang memakai HCIS sebagai sistem kerja? | Bolehkah modul X dipakai oleh populasi yang pintunya sudah dibuka? |
| Yang menentukan | Kriteria pintu G1–G13 (§3) | Kriteria pintu **ditambah** kriteria modulnya (§4) |
| Siapa yang memutuskan | Owner, dicatat di OPS-GOLIVE-001 | Owner atas usulan HCM, dicatat di catatan yang sama |
| Akibat bila dicampur | Menyalakan satu modul dianggap sudah menjawab pertanyaan pintu — padahal kehadiran yang dibuka bukan payroll yang dibuka | Pintu dibuka untuk menu penuh, lalu sebagian besar menu menjawab 409/422 (OPS-CLOSE-001 W11) |

Dua keputusan ini berurutan: **B tidak pernah dinilai sebelum A terpenuhi untuk populasi yang bersangkutan.** Pilot di §7 adalah bentuk paling kecil dari keputusan A — pintunya dibuka, tetapi hanya untuk satu unit.

## 2. Cara membaca kolom status

| Nilai | Artinya |
|---|---|
| **BELUM TERPENUHI** | Sudah diperiksa, jawabannya tidak. |
| **BELUM TERVERIFIKASI** | Belum diperiksa. Tidak boleh dibaca sebagai "kemungkinan sudah". |
| **TERPENUHI** | Ada bukti bertanggal yang menjawab persis pertanyaannya. **Tidak ada baris yang bernilai ini pada 2026-11-23**; pada 2026-11-25 hanya G12, dan hanya untuk ketiga perilaku yang dibutuhkan pilot. |

Status "TERPENUHI" hanya boleh ditulis dengan bukti bertanggal pada baris yang sama, sejalan dengan aturan OPS-CLOSE-001 §2.

## 3. Kriteria pintu — harus benar sebelum pembukaan apa pun, termasuk pilot

Setiap baris adalah satu pertanyaan ya/tidak. "Cakupan" berarti populasi yang pintunya sedang dinilai: satu unit untuk pilot, seluruh yayasan untuk pembukaan penuh. Kriteria yang sama dipakai untuk keduanya; yang berubah hanya populasinya.

| # | Pertanyaan ya/tidak | Siapa yang memeriksa | Cara memeriksa | 2026-11-23 | Rujukan bukti |
|---|---|---|---|---|---|
| **G1** | Apakah setiap pegawai dalam cakupan berada di unit yang penyetuju cutinya berakun `active`? | HC bersama operator (baca saja) | Telusuri penyetuju unit cakupan, lalu periksa status akun orang itu; buktikan dengan satu pengajuan uji yang melewati langkah penyetuju tanpa `409 APPROVER_ACCOUNT_NOT_READY` — kode yang sama pada `LEGACY` maupun `STRUCTURE` (§7.1a) | **BELUM TERPENUHI** | OPS-CLOSE-001 W2 — dari sembilan unit berpegawai aktif, hanya Human Capital Management yang penyetujunya berakun aktif |
| **G2** | Apakah rantai persetujuan yang **benar-benar berjalan** menemukan penyetuju untuk setiap pegawai dalam cakupan? | Operator menjalankan, HC membaca hasilnya | Mode resolusi untuk cakupan itu memang `STRUCTURE` (ada baris pengaturan rollout yang menjangkaunya), lalu **satu pengajuan nyata benar-benar dirutekan** | **BELUM TERPENUHI** — tetapi sebabnya bukan lagi ketersediaan data; lihat §3.1 | OPS-CLOSE-001 W1, L3, V17, V18 |
| **G3** | Apakah setiap pegawai dalam cakupan, **kepala unit dan penyetujunya lebih dulu**, punya akun `active`? | HC | Cacah akun per status untuk daftar pegawai cakupan, baca saja | **BELUM TERPENUHI** | OPS-CLOSE-001 W3 — 4 akun aktif untuk seluruh yayasan, 74 `invited` |
| **G4** | Apakah setiap pegawai dalam cakupan punya alamat email? | HC | Cacah pegawai cakupan yang `email` kosong, baca saja (V3) | **BELUM TERPENUHI** | Pengukuran owner 2026-11-23: **23 pegawai aktif tanpa email sama sekali**, sehingga mereka tidak dapat diundang (§10) |
| **G5** | Apakah pemberitahuan benar-benar sampai kepada orang-orang dalam cakupan? | Operator memeriksa keberadaan kunci, HC memeriksa hasil kirim | Periksa mode penerima di `final.env` **berdasarkan nama kunci**, lalu hitung hasil `not_allowlisted` setelah satu pengiriman uji | **BELUM TERPENUHI** untuk siapa pun di luar daftar izin; isi daftarnya sendiri **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W9 dan V11 — mode daftar izin berlaku sejak 2026-11-11, sehingga undangan ke luar daftar tidak sampai ke mana pun |
| **G6** | Apakah jalur pemulihan kata sandi, atau fallback manual yang diterima, sudah tertulis? | Owner memutuskan, HCM menjalankan | Dokumen jalurnya ada dan disebut di catatan go-live | **BELUM TERPENUHI** | OPS-READY-001 P9 (MISSING) |
| **G7** | Apakah pemilik insiden, pemilik stop, pemilik rollback, dan cadangannya sudah bernama; RPO dan RTO sudah diputuskan; dan kanal peringatan pernah diuji sekali? | Owner mengisi, operator menguji kanalnya | OPS-GOLIVE-001 §2 dan §4 terisi tanpa `TBD`, ditambah satu bukti uji kanal | **BELUM TERPENUHI** | OPS-CLOSE-001 W14; OPS-READY-001 P6 dan R3 |
| **G8** | Apakah ada latihan restore terisolasi **penuh** yang PASS pada skema yang sedang berjalan — yaitu HCIS benar-benar dinyalakan di atas database hasil pulihan, bukan berhenti di `pg_restore`? | Operator menjalankan **setelah owner menyetujui pelaksanaannya**, hasilnya dicatat sebagai `docs/operations/hcis-restore-drill-<tanggal>.md` | Prosedur OPS-MI8-DRILL-001 apa adanya | **BELUM TERPENUHI** | OPS-CLOSE-001 W12 — latihan penuh terakhir 2026-10-16 pada 55 migrasi, production hari ini 145. **Butir ini tidak boleh dianggap beres:** pemeriksaan 2026-11-20 membuktikan berkasnya pulih, bukan bahwa HCIS berjalan di atasnya, dan latihan penuhnya menuntut persetujuan owner per pelaksanaan |
| **G9** | Apakah tidak ada temuan keamanan High yang terbuka, setiap Medium sudah diperbaiki atau diterima tertulis, dan test matriks izin hijau di CI? | Peninjau keamanan; CI untuk bagian testnya | Status SEC-07 bagian SPA/edge (V7) ditambah tinjauan ulang rute yang lahir sejak 2026-10-16 | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W13 dan V7; OPS-READY-001 R2 (PARTIAL) |
| **G10** | Apakah sudah diputuskan apa yang dilihat pengguna untuk modul yang **tidak** dibuka, dan apakah layarnya cocok dengan keputusan itu? | Owner memutuskan, HCM memeriksa layarnya | Keputusan tertulis di catatan go-live, lalu satu penelusuran layar dengan akun pegawai biasa | **BELUM TERPENUHI** | OPS-CLOSE-001 W11 |
| **G11** | Apakah topik Pusat Bantuan untuk setiap layanan yang dibuka sudah **terbit**, dan satu pengumuman pembukaan sudah siap? | HC | Hitung topik berstatus terbit untuk layanan cakupan (V12) | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W10 dan V12 |
| **G12** | Apakah rilis yang **sedang berjalan** memuat perilaku yang dijanjikan kepada pengguna cakupan? | Operator | Bandingkan `cwd` proses yang berjalan dengan daftar PR tertahan; catatan rilis baru per OPS-MI8-REL-001 | **TERPENUHI 2026-11-25** untuk ketiga perilaku yang dibutuhkan pilot | Rilis `hcis-f6edebd4-20261125`, 156 migrasi, tertinggi `0184`; `cmdline` kedua proses menunjuk rilis itu. Bukti `docs/development/production-release-verification-2026-11-25-f6edebd4.md`. Pada 23 November baris ini **BELUM TERPENUHI** — production berhenti di `hcis-127b6068-20261118`, migrasi tertinggi `0167` (OPS-CLOSE-001 W15 dan §4). Perubahan OPS-PILOT-TT-001 sendiri — panel mode persetujuan dan dialog Tolak — ikut **dirilis pada hari yang sama** sebagai `hcis-27f10ccd-20261125` (12:17 WIB, tanpa migrasi; bukti `…-2026-11-25-27f10ccd.md`), sehingga keduanya pun ada di production |
| **G13** | Apakah keputusan pembukaannya sendiri — cakupan, tanggal, pemilik, syarat berhenti, jalan mundur — sudah tertulis dan ditandatangani? | Owner | Satu berkas hasil salinan OPS-GOLIVE-001 yang terisi penuh, tanpa `TBD` | **BELUM TERPENUHI** | OPS-READY-001 P10 |

**Bagaimana membaca tabel ini.** Sepuluh baris BELUM TERPENUHI dan tiga baris mengandung BELUM TERVERIFIKASI. G1 dan G3 adalah yang mengunci semua yang lain, dan keduanya tentang **akun**, bukan tentang data organisasi.

### 3.1 Apa yang berubah pada G2: datanya ada, sambungannya yang belum dinyalakan

Penelusuran baca-saja owner pada 2026-11-23 terhadap **bagan Struktur Organisasi yang sudah terbit di production** mengubah isi G2, bukan statusnya:

- **Bagan menemukan kepala untuk setiap pegawai aktif — 96 dari 96, tidak ada yang kosong.** Penelusuran dilakukan lewat binding `LEADER` dengan pendakian node.
- **Bagan sudah memuat lapisan koordinator**, yang sebelumnya dikira harus diputuskan HC satu per satu. Sebarannya: SDIT Tahfizh (46 pegawai) ke lima kepala — Milda Nursaadah 19, Siti Rita Anita 15, Abdullah Izzan Rashif 7, Abdu Tawab 3, Roy Hanulloh 2; Pesantren Tahfizh (22) ke enam kepala — Mus'af 9, Muhammad Amer Mushaf 5, Bilal Satria Wirda Aji 4, Zaky 3, Puguh Trianto 1, Abdurrohman 1; General Affair (12) — Abdul Kholik 9, Roanah 3; Taman Tahfizh (9) — Pipit Fithriyah 9.
- **Bagan yang sudah diisi HCM adalah sumber penetapan kepala unit** (penegasan Kepala HCM, 2026-11-23). **Tidak ada SK atau dokumen pembanding yang menjadi syarat**, dan dokumen ini tidak memintanya.

Akibatnya untuk kriteria:

| Yang berubah | Isinya |
|---|---|
| **Mengisi kolom atasan lama bukan prasyarat pilot** | Rute berbasis bagan tidak membaca kolom itu. Di bawah mode `STRUCTURE`, pengaju yang `employees.direct_manager_employee_id`-nya `NULL` tetap menghasilkan rantai lengkap, sementara pengaju yang sama ditolak di bawah `LEGACY` — dinyatakan dan diuji di `docs/domain/dynamic-organization-structure.md` dan `apps/api/test/org004-rollout-switch.postgres.test.ts`. Pengisian kolom tetap relevan **hanya sebagai jalur alternatif untuk unit yang tidak ikut pilot** dan tetap berjalan `LEGACY` (§6 baris 4) |
| **Kursi kosong, rangkap jabatan, dan sub-bagian tanpa kursi kepala bukan penghambat** | Pencarian naik melewatinya. Sudah diperiksa pada 2026-11-23: Bidang Operasional kosong dan tidak ada orang yang tersangkut karenanya; Tata Usaha tidak punya kursi kepala dan orangnya naik satu tingkat. Ketiganya **keadaan yang sudah diperiksa dan tidak berakibat**, bukan pekerjaan yang tertunda |
| **Yang tersisa pada G2 tinggal satu hal** | Belum pernah ada **satu pun pengajuan nyata yang dirutekan lewat bagan di production**. Penelusuran dan test ORG-004 seluruhnya memakai data sintetis dalam transaksi yang di-rollback dan tidak menyalakan apa pun. Bukti itu hanya dapat datang dari pengajuan sungguhan, dan karena itu ia menjadi salah satu syarat keberhasilan pilot (§7.6) |

### 3.2 Tiga perilaku yang dibutuhkan pilot — tertahan di `main` pada 23 November, **sudah di production sejak 25 November**

Dua yang pertama masuk `main` lewat #399 (`1e5d46fd`, 2026-11-23); yang ketiga menyusul 2026-11-23. Ketiganya ikut rilis `hcis-f6edebd4-20261125` (bukti `docs/development/production-release-verification-2026-11-25-f6edebd4.md`), sehingga **G12 terpenuhi untuk ketiganya** dan kalimat "belum ada di production" di bawah terbaca sebagai keadaan pada 23 November:

1. **Satu baris pengaturan pada node unit kini menjangkau seluruh sub-nodenya.** Sebelumnya Taman Tahfizh menuntut 18 baris karena orangnya duduk di tiga node berbeda. Baris pada leluhur mana pun menjangkau seluruh subtree-nya pada kedalaman berapa pun — yang juga berarti baris di node akar memindahkan seluruh yayasan sekaligus, jadi pemilihan node adalah cakupannya.
2. **Saklarnya kini dapat dimatikan kembali** lewat `POST /admin/organization/rollout/:id/end` (izin `approvals.policy.manage`, alasan wajib, teraudit sebagai `organization.rollout.ended`, paling awal berakhir hari ini). Sebelum ini rollout hanya bisa dinyalakan, sehingga bagian jalan mundur pilot tidak punya jalur nyata di luar rollback migrasi. Sekarang punya (§7.8).
3. **Penyetuju yang akunnya belum aktif tidak lagi dilewati diam-diam dalam mode `STRUCTURE`** (ORG-004 D-R5). Sebelum ini `vacancy_policy` memperlakukan kursi yang pejabatnya ada tetapi akunnya belum `active` persis seperti kursi kosong: kursi kepala unit itu dilewati tanpa galat, rantainya naik ke kursi induk, dan di unit kandidat §7.1 kedua langkahnya menyusut menjadi satu orang — cutinya disetujui, kepala unitnya tidak pernah melihatnya, dan tidak ada pesan apa pun yang mengatakan demikian. **Pengukuran owner, baca saja terhadap bagan terbit 2026-11-23: seluruh 63 ikatan wewenang dan seluruh 29 jabatan memakai `CLIMB_TO_PARENT`, tanpa satu pun pengecualian**, sementara 74 akun pegawai masih `invited` (G3) — jadi tidak ada satu kursi pun pada bagan yang kebijakannya akan menahan keadaan itu. Sekarang keadaan itu **menolak**, dengan kode yang sama seperti `LEGACY` (`409 APPROVER_ACCOUNT_NOT_READY`) dan kalimat berbahasa Indonesia yang menyebut kursinya, orangnya, dan bahwa yang perlu diselesaikan adalah aktivasi akunnya, bukan bagannya. Kursi yang benar-benar **kosong** tetap memanjat seperti sebelumnya, jadi kebijakan kekosongan binding node pilot tetap perlu dibaca dan dicatat sebelum baris rollout ditulis (§7.1). **Tiga hal yang ikut berubah dan perlu diketahui operator pada hari pertama:** (a) kursi yang dipegang **akun organ** tidak ikut — di sana akun yang belum aktif masih dilewati diam-diam (production hari ini: 2 kursi dipegang akun, 2 pendudukan akun, 1 binding `GOVERNANCE_APPROVER`), jadi kursi organ diperiksa dengan membaca status akunnya; (b) pemberitahuan pengawasan satu tingkat di atas akan banyak berhenti selama 74 akun masih `invited`, dan diamnya harus dibaca sebagai akibat akun yang belum aktif, bukan jalur notifikasi yang rusak; (c) layar pratinjau HC akan berubah dari "sebagian besar teresolusi" menjadi "sebagian besar bermasalah" dan menampilkan kode mentah `AUTHORITY_INELIGIBLE`, sehingga layar itu belum ikut membedakan "akun belum aktif" dari "bagan bermasalah".

## 4. Kriteria per modul — membuka kehadiran bukan membuka payroll

Berlaku **sesudah** seluruh kriteria pintu terpenuhi untuk populasi yang bersangkutan, bukan sebagai penggantinya.

| Modul | Pertanyaan ya/tidak tambahan | Pemeriksa | 2026-11-23 | Rujukan |
|---|---|---|---|---|
| **Kehadiran dari mesin (ADMS)** | Apakah perangkat kembali mengirim log kehadiran secara rutin, dan apakah unit cakupan pernah menghasilkan satu scan nyata? | Pemilik perangkat bersama operator | **BELUM TERPENUHI** — perangkat diam sejak 17 November; hanya satu unit yang pernah menghasilkan scan | OPS-CLOSE-001 W5, V19 |
| **Clock in/out mobile (ATT-006)** | (a) Apakah kebijakan retensi dan penghapusan foto kehadiran sudah tertulis? (b) Apakah rilis yang berjalan memuat perubahan alur yang dibuat setelah pengujian HCM? | (a) owner memutuskan, (b) operator memeriksa | **BELUM TERPENUHI** untuk keduanya | OPS-CLOSE-001 W7, W15 |
| **Cuti dan izin (LEAVE-001/002, APR-001)** | Apakah satu pengajuan nyata dari pegawai cakupan sampai ke penyetujunya dan **diputuskan**, dengan saldo berubah sesuai LEAVE-002? | HC mencatat nomor dan tanggalnya | **BELUM TERPENUHI** — nol pengajuan cuti sepanjang umur sistem | OPS-CLOSE-001 W4 |
| **Slip gaji (PAY-001/PAY-002)** | Apakah minimal satu pegawai per unit cakupan membuka slipnya dan mengonfirmasi isinya cocok dengan slip kertas bulan yang sama? | HC | **BELUM TERPENUHI** di luar pengujian HCM yang cakupannya tidak tercatat | OPS-CLOSE-001 W8, V5 |
| **Notifikasi (NOTIF-003/004)** | (a) Apakah jendela pengingat yang disetujui sudah berlaku di rilis yang berjalan? (b) Apakah sepuluh aturan pengingat yang masih `DRAFT` sudah diputuskan — disetujui atau dimatikan? | (a) operator, (b) owner | **BELUM TERPENUHI** untuk keduanya | OPS-CLOSE-001 W9, W15 |
| **Pusat Bantuan dan Pengumuman** | Apakah topik untuk layanan cakupan terbit, bukan draf? | HC | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W10, V12 |
| **Modul lain** | — | — | **Tidak dinilai.** Berada di luar cakupan pilot; alasannya di §8 | OPS-CLOSE-001 §7 |

## 5. Dua kriteria yang paling sering disalahbaca

Keduanya ditulis terpisah karena pernah hampir ditutup dengan bukti dari tingkat yang salah.

1. **G2 tidak ditutup oleh penelusuran.** Menelusuri bagan dan mendapatkan nama kepala menjawab *siapa yang seharusnya menyetujui*, dan sejak 2026-11-23 jawabannya memang lengkap untuk seluruh 96 pegawai (§3.1). Yang tidak dijawabnya: apakah orang itu punya akun aktif dan izin yang diperlukan, dan apakah pengajuan nyata benar-benar sampai kepadanya. Hal itu baru teruji ketika bagan **dipakai untuk merutekan**, bukan ketika ia dibaca. Test ORG-004 yang sudah ada pun memakai data sintetis dalam transaksi yang di-rollback dan tidak menyalakan apa pun.
2. **G8 tidak ditutup oleh pemeriksaan berkas cadangan.** Dump yang pulih dengan setiap cacah baris cocok membuktikan **berkasnya** utuh. Yang belum dibuktikan sejak skema `0167` adalah bahwa **HCIS berjalan** di atas database hasil pulihan. Latihan yang menjawab itu menuntut persetujuan owner untuk setiap pelaksanaan, dan persetujuan itu belum ada (OPS-CLOSE-001 W12; OPS-MI8-DRILL-001).

## 6. Urutan prasyarat — mana yang tidak dapat dibalik

Beberapa kriteria pintu bergantung satu sama lain, dan urutannya bukan selera. Daftar ini menjelaskan **bila** owner memutuskan membuka; ia tidak mengusulkan langkah mana pun dijalankan sekarang.

| Urutan | Apa | Mengapa tidak dapat dibalik |
|---|---|---|
| 1 | **Email ada** (G4) sebelum akun mana pun dapat diundang (G3) | Jalur undangan menolak `409 EMPLOYEE_EMAIL_MISSING` sebelum Akun SQ dipanggil; tanpa email, undangan tidak pernah dibuat. **23 pegawai aktif hari ini tidak punya email sama sekali dan karena itu tidak dapat diundang** |
| 2 | **Jalur pemberitahuan dan undangan dibuka bersama** (G5 bersama G3) | Selama mode daftar izin berlaku, undangan kepada siapa pun di luar daftar berakhir `not_allowlisted` dan **tidak sampai ke mana pun**. Mengundang lebih dulu berarti mengirim ke ruang kosong, lalu harus mengundang ulang |
| 3 | **Kepala unit dan penyetuju unit lebih dulu daripada pegawainya** (G1 dan bagian pertama G3) | Pengajuan pegawai berhenti di `409 APPROVER_ACCOUNT_NOT_READY` selama penyetuju unitnya belum berakun aktif — kode yang sama pada kedua mode (§7.1a) — berapa pun jumlah pegawai yang sudah masuk. Membalik urutan ini menghasilkan satu unit penuh orang yang bisa masuk tetapi tidak bisa mengajukan apa pun |
| 4 | **Mode resolusi menjangkau cakupan** (G2) sebelum pengajuan pertama | Untuk unit pilot ini berarti satu baris pengaturan rollout pada node unitnya — **bukan** pengisian kolom atasan lama, yang tidak dibaca rute berbasis bagan. Untuk unit yang **tidak** ikut pilot dan tetap berjalan `LEGACY`, pengisian kolom itu tetap jalur alternatif yang sah, dan jalur tulis massalnya sendiri masih tertahan di `main`, jadi G12 mendahuluinya |
| 5 | **Rilis** (G12) sebelum perilaku yang dijanjikan dipakai orang | Perilaku yang masih di `main` tidak ada di production, termasuk dua hal yang dibutuhkan pilot: satu baris pengaturan yang menjangkau seluruh sub-node, dan saklar yang dapat dimatikan kembali (§3.2) |
| 6 | **Latihan restore penuh** (G8) sebelum orang mulai menulis data nyata | Setelah pegawai menulis cuti dan kehadiran, data itu tidak ada duanya di tempat lain. Membuktikan pemulihannya setelah ada data yang hilang bukan pembuktian |
| 7 | **Kepemilikan dan kanal peringatan** (G7) sebelum, bukan sesudah | Selama HCIS tidak punya pengguna, tidak ada yang terdampak bila ia mati. Pada hari pertama ada pengguna, "siapa yang dihubungi" menjadi pertanyaan nyata |
| 8 | **Isi bantuan dan pengumuman** (G11) pada hari yang sama dengan pembukaan | Pengguna pertama mencari penjelasan pada jam pertama. Pusat bantuan yang masih draf memindahkan seluruh beban ke WhatsApp pribadi HC |

Tiga di antaranya mengikat erat dan paling sering dipisah keliru: **1 → 2 → 3**. Email harus ada sebelum undangan; undangan tidak berguna sebelum jalurnya terbuka; dan kepala unit beserta penyetujunya harus siap sebelum pegawainya, bukan sesudah.

## 7. Rencana pilot terbatas

### 7.1 Unit kandidat

**Taman Tahfizh diajukan sebagai kandidat, bukan sebagai keputusan.** Pemilihan unit pilot adalah keputusan owner bersama HCM dan dicatat pada formulir `docs/development/org004-pilot-unit-validation.md` (OPS-READY-001 P1), yang pada 2026-10-16 masih berstatus "NO REAL UNIT SELECTED".

Alasan unit ini diajukan:

| Alasan | Dasarnya |
|---|---|
| Besarnya pas — 9 pegawai aktif | Cukup kecil untuk didampingi satu orang HC sepanjang jendela, cukup besar untuk menghasilkan lebih dari satu pengajuan dalam dua minggu |
| **Bagannya lengkap dan sudah ditelusuri** | Penelusuran baca-saja 2026-11-23: kesembilan orang menemukan **Pipit Fithriyah** sebagai kepala — satu langsung, delapan dengan naik satu tingkat dari node Guru dan node Tata Usaha. Tidak ada yang tersangkut |
| Rantai persetujuannya pendek dan jelas terbaca | Penyetuju unitnya **Muchsalmina** (Kepala Bidang Pendidikan), **bukan** Pipit Fithriyah; bagan memang memisahkan kepala unit dari penyetuju unit. Dengan dua peran yang terpisah dan satu unit, kegagalan routing terbaca sebagai satu sebab |
| Unit ini punya jadwal kehadiran tetapi **belum pernah menghasilkan satu scan pun** | Pilotnya menjawab dua hal sekaligus: apakah layanannya jalan, dan apakah unit kedua dapat menghasilkan kehadiran dari mesin (OPS-CLOSE-001 W5) |
| Pekerjaan persiapannya terbatas | Dua akun dan satu baris pengaturan, bukan sembilan puluh enam akun dan pengisian kolom massal |

**Yang tersisa untuk unit ini tinggal dua hal, dan keduanya keputusan HCM yang belum diambil:**

1. **Mengaktifkan akun Pipit Fithriyah dan Muchsalmina.** Tanpa keduanya, G1 dan G3 tidak terpenuhi untuk unit ini dan setiap pengajuan berhenti di `409 APPROVER_ACCOUNT_NOT_READY`, pada `LEGACY` maupun `STRUCTURE` (§7.1a).
2. **Menuliskan satu baris pengaturan rollout untuk node Taman Tahfizh.** Satu baris menjangkau seluruh sub-nodenya, tetapi perilaku itu sendiri masih tertahan di `main` (§3.2), sehingga G12 mendahuluinya.

Keduanya ditulis di sini sebagai **keputusan yang belum diambil**, bukan sebagai langkah yang akan dijalankan. Satu hal yang masih perlu diukur sebelum hari pertama: kelengkapan email kesembilan pegawainya, karena yang terukur baru angka seluruh yayasan — **23 pegawai aktif tanpa email** (§10).

**Pembaruan 2026-11-25 (owner memilih unit ini; pengukurannya menambah satu penghambat yang dokumen ini lewatkan).** Pengukuran baca-saja terhadap unit ini ada di OPS-PILOT-TT-001 §4 dan tidak disalin ke sini. Tiga hal yang mengubah isi §7.1:

1. **Email kesembilan pegawainya kini terukur:** delapan punya email dan akun `invited`; satu — Siska Malika N. — tanpa email dan tanpa akun, dan punya **dua baris pegawai** (satu `resigned`, satu `active`) yang mana yang benar adalah keputusan HC (D12). Jadi delapan dapat diundang hari ini.
2. **Penghambat yang lebih awal daripada akun: kelompok hak cuti.** Cuti Tahunan individual hanya berlaku untuk `non_education` (`docs/domain/leave-policy-ysq.md`), dan di production kolom itu **kosong untuk kesembilan pegawai unit ini** — serta untuk 91 dari 97 pegawai aktif se-yayasan. Pengajuan dari pegawai yang kelompoknya kosong dijawab `409 UNSUPPORTED_ENTITLEMENT_GROUP` **sebelum rantai penyetuju disentuh**, jadi tanpa langkah ini pilot tidak membuktikan apa pun, termasuk hal-hal yang sebenarnya sudah benar. Spesifikasi melarang HCIS menebak klasifikasinya dari nama unit atau jabatan, sehingga ini keputusan HC, bukan migrasi. Jalannya ada di layar: **Admin → Konfigurasi Cuti**.
3. **Akibatnya bagi "sembilan pegawai".** Unit ini sekolah: tujuh dari sembilan orangnya pengajar, dan pengajar memang tidak berhak atas Cuti Tahunan individual — haknya Cuti Akhir Semester, yang berbentuk peristiwa kalender. Yang benar-benar dapat mengajukan Cuti Tahunan di sini paling banyak **dua** orang. Itu tidak membatalkan unit ini sebagai kandidat, tetapi membatalkan satu ukuran keberhasilan di §7.6.

### 7.1a Dua hal yang ditemukan di `STRUCTURE`, dan apa yang terjadi padanya

Ditemukan 2026-11-23 dari uji sintetis yang menjalankan alur cuti penuh dalam mode `STRUCTURE` lewat route API sungguhan (`apps/api/test/org004-structure-leave-flow.postgres.test.ts`), di atas fixture berbentuk unit ini — node unit dengan binding `LEADER` ke kursi pada node yang sama, binding `UNIT_APPROVER` ke kursi `Kepala Bidang`, dua anak node tanpa binding sendiri, dan seluruh kolom atasan lama kosong.

**Keduanya sudah diperbaiki hari yang sama lewat ORG-004 D-R5, dan perbaikannya ikut tertahan di `main` (§3.2 butir 3).** Catatan di bawah tetap ditulis apa adanya — temuannya, lalu perbaikannya — karena operator yang membaca dokumen ini perlu tahu mana perilaku yang berlaku di production hari ini (`LEGACY`, tidak berubah) dan mana yang baru. Keduanya tidak mengubah kedua keputusan HCM di §7.1 dan tidak menambah keputusan baru.

1. **Kode penolakan untuk akun yang belum aktif sempat berbeda, dan kini kembali sama.** Kalimat "setiap pengajuan berhenti di `409 APPROVER_ACCOUNT_NOT_READY`" benar untuk `LEGACY`, yaitu mode yang production jalankan hari ini. Dalam `STRUCTURE`, penyetuju yang akunnya bukan `active` ditolak lebih awal oleh resolver, dan penolakan itu dijawab **`409 AUTHORITY_INELIGIBLE`** dengan pesan berbahasa Inggris yang tidak menyebut nama siapa pun: "The configured incumbent is not eligible for this authority." Alasan sebenarnya (`ACCOUNT_NOT_ACTIVE`) ada di `details` galat itu, tetapi tidak diteruskan ke respons — sehingga kode yang terbaca tidak lagi membedakan "akun belum aktif" dari "bagan atau kursinya bermasalah", padahal pembedaan itulah yang §7.5 minta dicacah. **Diperbaiki (D-R5):** keadaan akun kini dijawab `409 APPROVER_ACCOUNT_NOT_READY` pada kedua mode, dengan kalimat berbahasa Indonesia yang menyebut kursinya, orangnya, dan bahwa yang perlu diselesaikan adalah aktivasi akunnya, bukan bagannya. `AUTHORITY_INELIGIBLE` tetap dipakai untuk pegawai yang memang sudah tidak dapat menjadi penyetuju, jadi pembedaan §7.5 terbaca dari kodenya saja.

2. **Kebijakan kekosongan sempat menentukan apakah penolakannya terjadi sama sekali.** Yang di atas hanya terjadi bila `vacancy_policy` binding-nya `BLOCK`. Dengan `CLIMB_TO_PARENT` — dan pengukuran owner 2026-11-23 menunjukkan **seluruh 63 ikatan wewenang dan seluruh 29 jabatan** pada bagan terbit memakainya, tanpa satu pun pengecualian — kursi kepala unit yang akunnya belum aktif **dilewati diam-diam**: rantainya naik ke kursi induk, di unit ini `Kepala Bidang`, yang orangnya sama dengan penyetuju unit, sehingga dua langkah menyusut menjadi satu, pengajuannya berjalan sampai disetujui, kepala unitnya tidak pernah melihatnya, dan tidak ada pesan apa pun yang mengatakan demikian. **Diperbaiki (D-R5):** kursi yang pejabatnya ada tetapi akunnya belum siap bukan kursi kosong, dan tidak lagi dilewati, apa pun kebijakannya. Kursi yang benar-benar **kosong** tetap memanjat seperti sebelumnya, jadi **kebijakan kekosongan pada binding `LEADER` dan `UNIT_APPROVER` node Taman Tahfizh tetap perlu dibaca sebelum baris pengaturan rollout ditulis**, dan hasil bacaannya dicatat.

   **Terpenuhi 2026-11-25.** Pembacaan baca-saja: binding `LEADER` node Taman Tahfizh menunjuk kursi `Kepala` pada node yang sama (pejabat **Pipit Fithriyah**), binding `UNIT_APPROVER` menunjuk kursi `Kepala` pada node **Bidang Pendidikan** (pejabat **Muchsalmina**), dan **keduanya `CLIMB_TO_PARENT`**, demikian pula kebijakan kedua kursinya. Kedua anak node — **Guru** dan **Tata Usaha** — tidak punya ikatan sendiri, sehingga orangnya mendaki ke node unit dan satu baris pada node unit cukup. Dicatat di OPS-PILOT-TT-001 §3.

**Rekomendasi penulis:** bila kandidat ini ditolak, unit pengganti dipilih dengan sifat yang sama — di bawah sepuluh orang, kepala unit dan penyetuju unit yang terbaca jelas di bagan, dan punya jadwal kehadiran. Unit terbesar adalah kandidat terburuk untuk percobaan pertama, karena satu kesalahan routing di sana menyentuh paling banyak orang sekaligus, dan karena pegawainya tersebar ke lima atau enam kepala (§3.1).

### 7.2 Siapa yang ikut

| Peran dalam pilot | Jumlah | Yang dikerjakan |
|---|---|---|
| Pegawai unit kandidat | 9 | Memakai HCIS untuk pekerjaan nyata sehari-hari dalam cakupan modul §7.3 |
| Kepala unit | 1 | Langkah atasan pada rantai persetujuan; akunnya harus `active` sebelum hari pertama |
| Penyetuju unit | 1 | Langkah penyetuju unit; akunnya harus `active` sebelum hari pertama (G1) |
| Pendamping HC | 1 | Menerima pertanyaan, mencatat tiket, mencatat ukuran harian |
| Operator Mi8VPS | 1 | Rilis, rollback, pembacaan kesehatan; tidak ikut sebagai pengguna |
| Pemilik stop | 1 | Boleh menghentikan pilot kapan saja tanpa persetujuan lebih lanjut (OPS-GOLIVE-001 §2) |

### 7.3 Modul dalam cakupan, dan yang tegas di luar

**Di dalam:**

| Modul | Batasnya |
|---|---|
| Masuk dan profil pegawai | Baca |
| Slip gaji (PAY-001/PAY-002) | **Baca saja**, slip hasil impor historis; tidak ada perhitungan |
| Kehadiran: clock in/out mobile dan penyerapan dari mesin | Hanya bila kriteria modulnya (§4) terpenuhi; retensi foto tertulis adalah syarat, bukan catatan kaki |
| Cuti dan izin (LEAVE-001/002, APR-001) | Pengajuan nyata sampai keputusan; inilah yang sebenarnya diuji |
| Notifikasi dalam aplikasi | WhatsApp hanya sejauh yang diizinkan keputusan owner atas G5 |
| Pusat Bantuan dan Pengumuman | Baca |

**Di luar, dan tidak dibuka dengan alasan apa pun selama pilot:** kasbon, reimbursement, perjalanan dinas dan uang sakunya, kinerja, pelatihan daring, aset pegawai, penghargaan, kartu pegawai, kepanitiaan, perhitungan payroll, keputusan organ, dan pembacaan gaji per orang. Alasannya di §8.

### 7.4 Lama dan titik tinjauan

| | |
|---|---|
| Lama | Dua minggu kerja penuh |
| Tinjauan tengah | Hari kerja ke-5 — pilot diteruskan, dipersempit, atau dihentikan |
| Tinjauan penutup | Hari kerja ke-10, hasilnya ditulis di bagian penutup catatan go-live (OPS-GOLIVE-001 §8) |
| Bukan pilot | Jendela yang diperpanjang tanpa batas. Bila pada hari ke-10 keputusan belum dapat diambil, jawabannya adalah menghentikan dan memperbaiki, bukan memperpanjang |

### 7.5 Yang diukur

Dicatat pendamping HC setiap hari kerja, dari pembacaan baca-saja dan dari tiket.

| Ukuran | Mengapa diukur |
|---|---|
| Jumlah pengajuan cuti yang selesai **diputuskan** | Satu-satunya bukti bahwa routing bekerja; pengajuan yang dibuat tetapi tidak diputuskan tidak dihitung |
| Jumlah pengajuan yang gagal, **beserta kode kegagalannya** (`APPROVER_ACCOUNT_NOT_READY`, `AUTHORITY_INELIGIBLE`, `AUTHORITY_VACANT`, `UNIT_APPROVER_MISSING`, lainnya) | Membedakan akun yang belum aktif dari kerusakan; kode inilah yang menjelaskan mana yang mana. Sejak ORG-004 D-R5 pembedaan itu terbaca dari kodenya pada kedua mode: `APPROVER_ACCOUNT_NOT_READY` berarti akun penyetuju belum siap, `AUTHORITY_INELIGIBLE` dan `AUTHORITY_VACANT` berarti bagan atau kursinya (§7.1a) |
| Berapa pengajuan yang modenya benar-benar `STRUCTURE`, dan baris pengaturan mana yang berlaku | Setiap hasil resolusi membawa baris yang menentukannya, sehingga "mengapa ini masih `LEGACY`" punya jawaban tersimpan, bukan tebakan |
| Waktu dari pengajuan sampai keputusan | Menjawab apakah alurnya layak dipakai, bukan sekadar tidak error |
| Punch mobile per hari dan punch dari mesin per hari, terpisah | Dua jalur dengan kegagalan yang berbeda; digabung, keduanya tidak terbaca |
| Berapa pegawai berhasil masuk pertama kali **tanpa bantuan** | Memperkirakan beban HC bila populasinya dikalikan sepuluh |
| Jumlah tiket ke HC, dikelompokkan per sebab | Sama |
| Notifikasi terkirim berbanding `not_allowlisted` | Membuktikan pesan benar-benar sampai, bukan sekadar dikirim |
| Jumlah pegawai yang membuka slipnya dan mengonfirmasi isinya | Satu-satunya pembuktian PAY-001/PAY-002 dari sisi pegawai |

### 7.6 Apa yang dihitung berhasil

Pilot dinyatakan berhasil hanya bila **seluruh** baris berikut benar pada hari ke-10:

1. **Minimal satu pengajuan nyata benar-benar dirutekan lewat bagan di production, dan diputuskan.** Ini bukti yang paling penting dan tidak dapat digantikan uji sintetis: seluruh test ORG-004 berjalan atas data buatan dalam transaksi yang di-rollback, dan sampai hari ini belum ada satu pun pengajuan sungguhan yang dirutekan lewat bagan.
2. Setiap pegawai dalam cakupan berhasil masuk setidaknya sekali.
3. Minimal lima pengajuan cuti nyata selesai diputuskan, berasal dari lebih dari satu orang. **Tidak dapat dipenuhi di unit yang dipilih owner, dan menunggu keputusan owner (2026-11-25).** Taman Tahfizh adalah unit sekolah: setelah klasifikasi kelompok hak cuti, paling banyak **dua** orangnya dapat mengajukan Cuti Tahunan (§7.1 pembaruan butir 3). Tiga jalan, dengan rekomendasi penulis pada yang pertama, dibentangkan di OPS-PILOT-TT-001 §8: **(A)** turunkan angkanya menjadi dua pengajuan dari dua orang, sesuai empat sasaran yang owner tetapkan; **(B)** tambah unit kedua yang tenaganya non-pendidikan; **(C)** perluas ke jenis cuti lain. Sampai owner memilih, butir ini tidak dipakai menilai pilot.
4. **Nol** kegagalan routing yang tidak terjelaskan; setiap kegagalan punya kode dan sebab yang tertulis.
5. Minimal satu scan kehadiran nyata dari mesin di unit itu, bila kehadiran masuk cakupan.
6. Minimal satu pegawai membuka slipnya dan mengonfirmasi isinya cocok dengan slip kertas bulan yang sama.
7. Nol kejadian paparan data lintas pegawai atau lintas unit.
8. Nol tiket yang masih terbuka pada hari ke-10.

**Yang tidak dibuktikan pilot ini, dan tidak boleh diklaim sesudahnya:** perilaku pada skala 96 orang; unit yang pegawainya tersebar ke lima atau enam kepala; unit yang belum pernah menghasilkan scan sama sekali; perhitungan payroll; dan setiap modul di §8. Pilot yang berhasil menjawab "satu unit dapat memakai HCIS", bukan "HCIS siap dibuka".

### 7.7 Kapan pilot dihentikan

Syarat berhenti OPS-GOLIVE-001 §5 berlaku apa adanya dan tidak disalin ulang di sini. Tiga tambahan yang khas pilot ini:

- **Kegagalan routing yang tidak terjelaskan masih terjadi setelah satu kali perbaikan.** Perbaikan kedua atas sebab yang sama berarti sebabnya belum dipahami.
- **Jalur mesin kehadiran tetap tidak mengirim log** sepanjang minggu pertama, sementara kehadiran termasuk cakupan — karena kehadiran yang tidak terkirim tidak dapat disusun ulang belakangan (OPS-CLOSE-001 W5).
- **Beban HC melampaui satu orang pendamping** — bila sembilan orang sudah menuntut lebih dari satu pendamping, pembukaan yang lebih luas tidak boleh diputuskan dari pilot ini.

### 7.8 Jalan mundur

Lapisan rollback aplikasi dan data mengikuti OPS-GOLIVE-001 §6 apa adanya. Tiga hal yang khas pilot dan harus ditulis di catatan go-live sebelum hari pertama:

| Lapisan | Pemicu | Tindakan | Pemilik |
|---|---|---|---|
| Mode routing | Kegagalan routing yang tidak terjelaskan | **Tutup baris pengaturan rollout unit itu** lewat `POST /admin/organization/rollout/:id/end` — izin `approvals.policy.manage`, alasan wajib, teraudit, paling awal berakhir hari ini — sehingga unit itu kembali `LEGACY`. **Snapshot persetujuan pada pengajuan yang sudah terkirim tidak disentuh.** Jalur ini baru ada sejak #399 dan karena itu menuntut G12 lebih dulu (§3.2) | Pemilik rollback bersama HC |
| Pengajuan baru | Pilot dihentikan | Hentikan pengajuan baru untuk unit itu; pengajuan yang sudah berjalan **diselesaikan HC di luar sistem dan dicatat**, bukan ditinggalkan menggantung | Pemilik stop bersama HC |
| Data yang sudah ditulis pegawai | Kerusakan data | Restore ke database **baru**, lalu pindah; tidak pernah menimpa yang hidup (OPS-MI8-BAK-001 §7) | Owner |

Dua catatan tentang jalan mundur ini. Pertama, ia hanya dapat dipercaya bila G8 sudah terpenuhi — yaitu bila pemulihan pernah dibuktikan pada skema yang sedang berjalan, bukan pada skema Oktober. Kedua, satu baris pengaturan menjangkau seluruh subtree node yang dipilih, jadi **cakupan ditentukan saat memilih node dan tidak ada yang mempersempitnya setelah itu**; node yang dipilih untuk pilot harus node unitnya, bukan leluhurnya.

## 8. Yang tegas di luar cakupan pilot, dan alasannya

| Yang tidak dibuka | Alasan |
|---|---|
| **Perhitungan payroll (PAY-003)** | PAY-001/PAY-002 tetap jalur slip resmi sampai owner menutup parallel run (AGENTS.md §5). Di production mesinnya belum pernah menghitung satu periode pun, dan empat kebijakan pajak serta tata letak slip belum punya versi (OPS-CLOSE-001 §6, L1). Yang dibuka ke pegawai adalah slip hasil impor, bukan hasil hitung — dan memindahkan jalur itu adalah keputusan owner tersendiri, bukan langkah pilot |
| **Perjalanan dinas dan uang saku (TRIP-001/TRIP-002)** | Golongan pegawai ditentukan dari pemetaan kode klasifikasi jabatan ke golongan. Katalog klasifikasi ORG-011 di production **kosong**, jadi tidak ada satu pun pegawai yang golongannya dapat diresolusi dan setiap pengajuan dijawab `409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED`. **Uang saku dinas karena itu tidak dapat dipakai siapa pun.** Ini bukan fitur yang belum jadi, melainkan data yang menopangnya yang belum ada; apakah dan kapan katalog diisi adalah keputusan HCM dan owner yang belum diambil (OPS-CLOSE-001 L16, L10) |
| **Kasbon, reimbursement, kinerja** | Bagian penting dari ketiganya masih tertahan di `main` dan belum ada di production, termasuk migrasi yang membawa tabel baru (OPS-CLOSE-001 L6, L7, L11, §4) |
| **Apa pun di balik saklar yang mati** | Pembacaan gaji per orang oleh Pengurus Yayasan, keputusan organ, potongan angsuran lewat payroll, penyerahan reimbursement ke payroll, dan modul pelatihan daring semuanya menunggu saklar yang mati. **Menyalakan saklar adalah keputusan owner tersendiri, bukan langkah operasional pilot** (OPS-CLOSE-001 §6) |
| **Pengumpulan biometrik (ATT-005)** | Mati karena kebijakan, bukan karena belum selesai, dan ketiadaannya diperiksa pada setiap preflight rilis. **Jangan diubah** (OPS-CLOSE-001 L15; OPS-READY-001 P7) |
| **Aset pegawai, penghargaan, kartu pegawai, kepanitiaan** | Menunggu pihak atau data di luar HCIS (OPS-CLOSE-001 L13, L14) |

Aturan tunggal yang merangkum tabel ini: **pilot tidak menyalakan apa pun yang hari ini mati, kecuali satu baris pengaturan rollout untuk node unit pilot** — dan baris itu sendiri adalah keputusan HCM yang belum diambil (§9 D3b). Setiap penyalaan lain adalah keputusan tersendiri dengan pemiliknya sendiri, dan tidak satu pun ikut terbawa oleh keputusan membuka pilot.

## 9. Keputusan yang menunggu, dan siapa pemiliknya

Tidak satu pun dapat diputuskan di dalam dokumen ini. **Tiga di antaranya sudah diputuskan owner pada 2026-11-25 dan ditandai begitu di bawah**; sisanya masih menunggu.

| # | Keputusan | Pemilik | Mengapa bukan keputusan dokumen ini |
|---|---|---|---|
| ~~D1~~ **diputuskan 2026-11-25** | Membuka bertahap lewat pilot satu unit, atau sekaligus untuk seluruh pegawai | Owner | **Bertahap**, sejalan dengan rekomendasi penulis. Aktivasi massal menunggu hasil pilot |
| ~~D2~~ **diputuskan 2026-11-25** | Unit pilot dan pesertanya | Owner bersama HCM | **Taman Tahfizh, modul Cuti Tahunan.** Peserta: kepala unit **Pipit Fithriyah**, penyetuju unit **Muchsalmina**, dan satu pegawai pilot — usul penulis **Rosaliana** (OPS-PILOT-TT-001 §5.2), menunggu penegasan HCM |
| D3a | Mengaktifkan akun kepala unit dan penyetuju unit pilot — untuk Taman Tahfizh, Pipit Fithriyah dan Muchsalmina | HCM | Menyentuh orang dan jadwal kerja mereka. Dokumen ini hanya mencatat bahwa tanpa itu G1 dan G3 tidak dapat terpenuhi untuk unit mana pun. **Masih menunggu**; urutannya di OPS-PILOT-TT-001 §5.3 |
| ~~D3b~~ **diputuskan 2026-11-25, pelaksanaannya menunggu D3a** | Menuliskan satu baris pengaturan rollout untuk node unit pilot | HCM | Owner meminta pengaturan khusus unit pilot disiapkan agar data atasan cukup dipelihara di bagan. Sejak 2026-11-25 baris itu ditulis **dan diakhiri dari layar** (Admin → Struktur Organisasi → Mode persetujuan per unit), jadi jalur mundur §7.8 punya tombolnya sendiri, bukan hanya route. Nilai persisnya di OPS-PILOT-TT-001 §5.5 |
| **D13** (baru 2026-11-25) | Kelompok hak cuti peserta pilot: siapa `non_education`, siapa `education` | HC | Cuti Tahunan individual hanya untuk `non_education`, dan spesifikasi melarang HCIS menebaknya dari nama unit atau jabatan. Kosong untuk kesembilan pegawai unit pilot, jadi **ini penghambat paling awal** (§7.1 pembaruan butir 2) |
| D4 | Apakah mode daftar izin pemberitahuan dilonggarkan, untuk siapa, dan kapan | Owner | Keputusan jangkauan pesan ke orang sungguhan |
| D5 | Jalur pemulihan kata sandi atau fallback manual yang diterima | Owner bersama HCM | OPS-READY-001 P9 |
| D6 | Nama pemilik stop, rollback, dan insiden beserta cadangannya; nilai RPO dan RTO | Owner | OPS-GOLIVE-001 §2 dan §4; tidak ada default yang masuk akal untuk diambil sendiri |
| D7 | Satu pelaksanaan latihan restore penuh pada skema yang berjalan | Owner | OPS-MI8-DRILL-001 menuntut persetujuan per pelaksanaan. **Rekomendasi penulis:** dapatkan bukti ini sebelum pegawai mulai menulis data nyata, bukan sesudah |
| D8 | Apakah, kapan, dan dengan kode apa katalog klasifikasi jabatan diisi | Owner bersama HCM | Tidak ada pekerjaan repository yang tersisa untuk membuatnya terisi (OPS-CLOSE-001 L16) |
| D9 | Apakah gerbang rilis yang menuntut golongan boleh menghentikan setiap rilis berikutnya selama katalog kosong | Owner | Keputusan yang masih terbuka pada PR yang menunggu (OPS-CLOSE-001 §4) |
| D10 | Menu pendek berisi layanan yang benar-benar dibuka, atau menu penuh dengan label jujur | Owner | OPS-CLOSE-001 W11, yang merekomendasikan menu pendek |
| D11 | Bagaimana unit yang **tidak** ikut pilot dilayani: tetap `LEGACY` dengan kolom atasan diisi, atau menyusul ke `STRUCTURE` | Owner bersama HCM | Untuk unit pilot pertanyaan ini sudah tidak berlaku — rute berbasis bagan tidak membaca kolom itu (§3.1). Untuk unit lain, keduanya sah dan harus dipilih |
| D12 | Catatan pegawai yang berstatus aktif tetapi sudah ditandai terhapus — mana yang benar | HC | Keputusan data; menentukan siapa yang masuk cakupan pembukaan (OPS-CLOSE-001 V21) |

## 10. Catatan terhadap sumber

Ditulis supaya perbedaannya terbaca, bukan dirapikan:

- **Penelusuran bagan 2026-11-23 belum masuk OPS-CLOSE-001.** Angka 96 dari 96 pegawai aktif yang menemukan kepala lewat binding `LEADER`, lapisan koordinator beserta sebarannya, dan rincian Taman Tahfizh di §3.1 dan §7.1 berasal dari penelusuran baca-saja owner pada 2026-11-23 terhadap bagan terbit di production. OPS-CLOSE-001 masih mencatat W1 dengan kata "hampir seluruh" dan V17 sebagai butir terbuka. Pembaruan OPS-CLOSE-001 berikutnya adalah tempat angka ini dicatat.
- **Kelengkapan email baru terukur dan juga belum masuk OPS-CLOSE-001.** Pengukuran baca-saja owner 2026-11-23 mencatat **23 pegawai aktif tanpa email sama sekali**; OPS-CLOSE-001 masih mencatat V3 sebagai terbuka dan W3 masih menulis bahwa kelengkapan email belum diukur. Pembagiannya per unit belum ada, termasuk untuk unit kandidat pilot.
- **Penyebut kelayakan adalah 96, bukan 97.** OPS-CLOSE-001 §3 (koreksi 2026-11-23) menetapkan bahwa alur yang berjalan memakai predikat yang lebih ketat, sehingga **96** benar untuk setiap pernyataan tentang kelayakan proses, sementara 97 hanya benar sebagai cacah baris berstatus aktif. Dokumen ini memakai 96 dan tidak mengulang penurunannya.
- **Jumlah unit yang penyetujunya belum siap: tujuh `invited`, satu tanpa akun, satu aktif.** Rincian 2026-11-20 yang sempat beredar (delapan `invited`) sudah dinyatakan keliru saat dituliskan dan diperbaiki pada 2026-11-23; datanya sendiri tidak berubah.
- **Satu kalimat di OPS-CLOSE-001 perlu dibaca hati-hati.** Setelah koreksi 96/97, W2 menuliskan bahwa "96 pegawai aktif yang layak diproses" berada di unit yang penyetujunya belum bisa bertindak, sementara unit Human Capital Management — yang berisi satu pegawai aktif — justru penyetujunya berakun aktif. Kedua pernyataan itu tidak dapat benar bersamaan tanpa penjelasan tambahan. Dokumen ini karena itu **tidak menuliskan angka tersendiri** untuk populasi yang terhambat, dan menyebutnya "setiap unit kecuali Human Capital Management". Rekonsiliasinya milik OPS-CLOSE-001.
- **Tidak ada dokumen pembanding yang disyaratkan untuk penetapan kepala unit.** Bagan Struktur Organisasi yang sudah diisi HCM adalah sumbernya (penegasan Kepala HCM, 2026-11-23). Dokumen ini tidak meminta SK atau dokumen lain sebagai syarat, dan setiap versi sebelumnya yang terbaca demikian digantikan oleh §3.1.

## 11. Hubungan dengan dokumen lain

- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) — **di mana posisi tiap butir**, dengan bukti bertanggal. Dokumen ini tidak mengulang isinya dan tidak menggantikannya; ia menunjuk ke sana untuk setiap bukti.
- `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001) — penilaian gate Pilot ready dan Production ready per 2026-10-16. Gerbang G1–G13 di sini tidak menambah gate baru pada `docs/product/scope.md`; ia merumuskan gate yang sudah ada menjadi pertanyaan ya/tidak dengan pemeriksanya, dan menambahkan lapisan per modul yang belum pernah dipisahkan.
- `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001) — **tempat keputusannya ditandatangani**. G13 ditutup dengan satu salinan terisi dari template itu; syarat berhenti dan jalan mundur pilot di §7.7 dan §7.8 adalah tambahan di atas §5 dan §6 template, bukan penggantinya.
- `docs/operations/hcis-isolated-restore-drill.md` (OPS-MI8-DRILL-001) — prosedur yang menutup G8, dengan persetujuan owner per pelaksanaan.
- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) — satu-satunya jalur rilis; G12 ditutup lewat itu.
- `docs/domain/dynamic-organization-structure.md` — perilaku saklar rollout ORG-004 yang dipakai §3.2, §6, dan §7.8: pendakian node, jangkauan satu baris atas seluruh subtree, dan jalur mematikannya kembali.
- `docs/development/org004-pilot-unit-validation.md` dan `org004-operational-validation.md` — formulir pemilihan unit pilot dan tahapan validasi operasionalnya.

Dokumen ini diperbarui ketika salah satu kriterianya berubah status, dengan bukti bertanggal baru, atau ketika owner memutuskan salah satu butir §9. Kriteria tidak boleh naik status tanpa bukti.
