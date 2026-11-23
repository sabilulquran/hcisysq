# Kriteria go/no-go pembukaan HCIS dan rencana pilot terbatas

**Spec ID:** OPS-OPEN-001
**Status:** PROPOSED — kriteria dan rencana di sini **diajukan untuk diputuskan owner**, belum berlaku. Tidak ada satu butir pun di dokumen ini yang dinyatakan siap.
**Disiapkan:** 2026-11-23
**Keputusan yang ditopang:** "Pilot ready" dan "Production ready" di `docs/product/scope.md`, yang penandatanganannya terjadi di `go-live-decision-record-template.md` (OPS-GOLIVE-001), bukan di sini.
**Sumber angka production:** pengukuran baca-saja owner pada 2026-11-20 dan 2026-11-23, sebagaimana dicatat `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) §3 dan §4. Penulis dokumen ini tidak punya akses production, **tidak menurunkan ulang angka itu, dan tidak menyalin tabelnya**. Satu angka yang dipakai di sini belum ada di OPS-CLOSE-001 dan disebut sumbernya di tempatnya (§7).
**Sumber angka repository:** `origin/main` pada `1ccb7e6c` (merge #402, 2026-11-23).

---

## 0. Untuk apa dokumen ini, dan untuk apa ia bukan

OPS-CLOSE-001 menjawab **di mana posisi tiap butir hari ini**. Ia sengaja tidak menjawab dua pertanyaan lain, dan kedua pertanyaan itulah isi dokumen ini:

1. **Apa yang harus benar sebelum pintu dibuka** — dirumuskan sebagai pertanyaan ya/tidak yang dapat diperiksa, dengan pemeriksanya dan caranya.
2. **Seperti apa percobaan terbatas yang pertama** — satu unit, sedikit orang, pekerjaan nyata, berbatas waktu, dengan ukuran keberhasilan, syarat berhenti, dan jalan mundur.

Tiga aturan pemakaian dokumen ini:

- **Bukti tidak diulang di sini.** Setiap kriteria menunjuk ke baris OPS-CLOSE-001 atau OPS-READY-001 yang memegang buktinya, atau menyatakan terus terang bahwa buktinya **belum ada**. Bila dua dokumen berbeda angka, yang berlaku adalah OPS-CLOSE-001, karena di sanalah pengukurannya dicatat.
- **Dokumen ini tidak memerintahkan satu tindakan pun.** Mengaktifkan akun, mengirim undangan, melebarkan daftar izin WhatsApp, menyalakan saklar, atau memindahkan jalur payroll adalah **keputusan owner dan HCM yang belum diambil**. Yang ditulis di sini adalah *syarat*, bukan *instruksi*, dan urutan di §6 menjelaskan ketergantungan **bila** keputusan itu diambil — bukan mengusulkan agar diambil sekarang.
- **Rekomendasi diberi label.** Kalimat yang diawali **Rekomendasi penulis** adalah pendapat penyusun dokumen ini, bukan kesepakatan. Keputusan milik orang lain ditulis di §9 sebagai keputusan yang menunggu, lengkap dengan pemiliknya.

Satu hal yang tidak dilunakkan: **tidak satu pun kriteria pintu di §3 terpenuhi hari ini.** Yang belum terpenuhi dan yang belum terverifikasi dibedakan, karena keduanya menuntut pekerjaan yang berbeda.

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
| **TERPENUHI** | Ada bukti bertanggal yang menjawab persis pertanyaannya. **Tidak ada baris yang bernilai ini pada 2026-11-23.** |

Status "TERPENUHI" hanya boleh ditulis dengan bukti bertanggal pada baris yang sama, sejalan dengan aturan OPS-CLOSE-001 §2.

## 3. Kriteria pintu — harus benar sebelum pembukaan apa pun, termasuk pilot

Setiap baris adalah satu pertanyaan ya/tidak. "Cakupan" berarti populasi yang pintunya sedang dinilai: satu unit untuk pilot, seluruh yayasan untuk pembukaan penuh. Kriteria yang sama dipakai untuk keduanya; yang berubah hanya populasinya.

| # | Pertanyaan ya/tidak | Siapa yang memeriksa | Cara memeriksa | 2026-11-23 | Rujukan bukti |
|---|---|---|---|---|---|
| **G1** | Apakah setiap pegawai dalam cakupan berada di unit yang penyetuju cutinya berakun `active`? | HC bersama operator (baca saja) | Cocokkan unit cakupan → `organizational_units.leave_approver_employee_id` → status akun orang itu; lalu buktikan dengan satu pengajuan uji yang benar-benar melewati langkah penyetuju tanpa `409 APPROVER_ACCOUNT_NOT_READY` | **BELUM TERPENUHI** | OPS-CLOSE-001 W2 — dari sembilan unit berpegawai aktif, hanya Human Capital Management yang penyetujunya berakun aktif |
| **G2** | Apakah rantai persetujuan yang **benar-benar berjalan** menemukan penyetuju untuk setiap pegawai dalam cakupan? | Operator menjalankan, HC membaca hasilnya | Bukan pratinjau bagan. Salah satu dari dua: `without_direct_manager` = 0 pada `GET /governance/summary` untuk cakupan itu, atau perbandingan `SHADOW` ORG-004 tanpa ketidakcocokan yang tak terjelaskan | **BELUM TERPENUHI** | OPS-CLOSE-001 W1 dan V17; OPS-READY-001 P3 |
| **G3** | Apakah setiap pegawai dalam cakupan, **penyetujunya lebih dulu**, punya akun `active`? | HC | Cacah akun per status untuk daftar pegawai cakupan, baca saja | **BELUM TERPENUHI** | OPS-CLOSE-001 W3 — 4 akun aktif untuk seluruh yayasan, 74 `invited` |
| **G4** | Apakah setiap pegawai dalam cakupan punya alamat email? | HC | Cacah pegawai cakupan yang `email` kosong, baca saja (V3) | **BELUM TERPENUHI** | Pengukuran owner 2026-11-23: **23 pegawai aktif tanpa email sama sekali** (§7 dan §10; OPS-CLOSE-001 masih mencatat V3 sebagai terbuka) |
| **G5** | Apakah pemberitahuan benar-benar sampai kepada orang-orang dalam cakupan? | Operator memeriksa keberadaan kunci, HC memeriksa hasil kirim | Periksa mode penerima di `final.env` **berdasarkan nama kunci**, lalu hitung hasil `not_allowlisted` setelah satu pengiriman uji | **BELUM TERPENUHI** untuk siapa pun di luar daftar izin; isi daftarnya sendiri **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W9 dan V11 — `WHATSAPP_RECIPIENT_MODE=allowlist` sejak 2026-11-11 |
| **G6** | Apakah jalur pemulihan kata sandi, atau fallback manual yang diterima, sudah tertulis? | Owner memutuskan, HCM menjalankan | Dokumen jalurnya ada dan disebut di catatan go-live | **BELUM TERPENUHI** | OPS-READY-001 P9 (MISSING) |
| **G7** | Apakah pemilik insiden, pemilik stop, pemilik rollback, dan cadangannya sudah bernama; RPO dan RTO sudah diputuskan; dan kanal peringatan pernah diuji sekali? | Owner mengisi, operator menguji kanalnya | OPS-GOLIVE-001 §2 dan §4 terisi tanpa `TBD`, ditambah satu bukti uji kanal | **BELUM TERPENUHI** | OPS-CLOSE-001 W14; OPS-READY-001 P6 dan R3 |
| **G8** | Apakah ada latihan restore terisolasi **penuh** yang PASS pada skema yang sedang berjalan — yaitu HCIS benar-benar dinyalakan di atas database hasil pulihan, bukan berhenti di `pg_restore`? | Operator menjalankan **setelah owner menyetujui pelaksanaannya**, hasilnya dicatat sebagai `docs/operations/hcis-restore-drill-<tanggal>.md` | Prosedur OPS-MI8-DRILL-001 apa adanya | **BELUM TERPENUHI** | OPS-CLOSE-001 W12 — latihan penuh terakhir 2026-10-16 pada 55 migrasi, production hari ini 145. **Butir ini tidak boleh dianggap beres:** pemeriksaan 2026-11-20 membuktikan berkasnya pulih, bukan bahwa HCIS berjalan di atasnya, dan latihan penuhnya menuntut persetujuan owner per pelaksanaan |
| **G9** | Apakah tidak ada temuan keamanan High yang terbuka, setiap Medium sudah diperbaiki atau diterima tertulis, dan test matriks izin hijau di CI? | Peninjau keamanan; CI untuk bagian testnya | Status SEC-07 bagian SPA/edge (V7) ditambah tinjauan ulang rute yang lahir sejak 2026-10-16 | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W13 dan V7; OPS-READY-001 R2 (PARTIAL) |
| **G10** | Apakah sudah diputuskan apa yang dilihat pengguna untuk modul yang **tidak** dibuka, dan apakah layarnya cocok dengan keputusan itu? | Owner memutuskan, HCM memeriksa layarnya | Keputusan tertulis di catatan go-live, lalu satu penelusuran layar dengan akun pegawai biasa | **BELUM TERPENUHI** | OPS-CLOSE-001 W11 |
| **G11** | Apakah topik Pusat Bantuan untuk setiap layanan yang dibuka sudah **terbit**, dan satu pengumuman pembukaan sudah siap? | HC | Hitung topik berstatus terbit untuk layanan cakupan (V12) | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W10 dan V12 |
| **G12** | Apakah rilis yang **sedang berjalan** memuat perilaku yang dijanjikan kepada pengguna cakupan? | Operator | Bandingkan `cwd` proses yang berjalan dengan daftar PR tertahan; catatan rilis baru per OPS-MI8-REL-001 | **BELUM TERPENUHI** | OPS-CLOSE-001 W15 dan §4 — production berhenti di `hcis-127b6068-20261118`, migrasi tertinggi `0167`, empat belas PR dan delapan migrasi menunggu |
| **G13** | Apakah keputusan pembukaannya sendiri — cakupan, tanggal, pemilik, syarat berhenti, jalan mundur — sudah tertulis dan ditandatangani? | Owner | Satu berkas hasil salinan OPS-GOLIVE-001 yang terisi penuh, tanpa `TBD` | **BELUM TERPENUHI** | OPS-READY-001 P10 |

**Bagaimana membaca tabel ini.** Sepuluh baris BELUM TERPENUHI dan tiga baris mengandung BELUM TERVERIFIKASI. G1, G2, dan G3 adalah yang mengunci semua yang lain: selama ketiganya tidak benar, pegawai yang masuk akan menemui penolakan pada hampir setiap layanan yang mereka coba, dan penolakan itu terbaca sebagai kerusakan sistem, bukan sebagai data yang belum terisi (OPS-CLOSE-001 §1).

## 4. Kriteria per modul — membuka kehadiran bukan membuka payroll

Berlaku **sesudah** seluruh kriteria pintu terpenuhi untuk populasi yang bersangkutan, bukan sebagai penggantinya.

| Modul | Pertanyaan ya/tidak tambahan | Pemeriksa | 2026-11-23 | Rujukan |
|---|---|---|---|---|
| **Kehadiran dari mesin (ADMS)** | Apakah perangkat kembali mengirim log kehadiran secara rutin, dan apakah unit cakupan pernah menghasilkan satu scan nyata? | Pemilik perangkat bersama operator | **BELUM TERPENUHI** — jalur mesin enam hari tanpa kehadiran per 2026-11-23; hanya satu unit yang pernah menghasilkan scan | OPS-CLOSE-001 W5, V19 |
| **Clock in/out mobile (ATT-006)** | (a) Apakah kebijakan retensi dan penghapusan foto kehadiran sudah tertulis? (b) Apakah rilis yang berjalan memuat perubahan alur yang dibuat setelah pengujian HCM? | (a) owner memutuskan, (b) operator memeriksa | **BELUM TERPENUHI** untuk keduanya | OPS-CLOSE-001 W7, W15 |
| **Cuti dan izin (LEAVE-001/002, APR-001)** | Apakah satu pengajuan nyata dari pegawai cakupan sampai ke penyetujunya dan **diputuskan**, dengan saldo berubah sesuai LEAVE-002? | HC mencatat nomor dan tanggalnya | **BELUM TERPENUHI** — nol pengajuan cuti sepanjang umur sistem | OPS-CLOSE-001 W4 |
| **Slip gaji (PAY-001/PAY-002)** | Apakah minimal satu pegawai per unit cakupan membuka slipnya dan mengonfirmasi isinya cocok dengan slip kertas bulan yang sama? | HC | **BELUM TERPENUHI** di luar pengujian HCM yang cakupannya tidak tercatat | OPS-CLOSE-001 W8, V5 |
| **Notifikasi (NOTIF-003/004)** | (a) Apakah jendela pengingat yang disetujui sudah berlaku di rilis yang berjalan? (b) Apakah sepuluh aturan pengingat yang masih `DRAFT` sudah diputuskan — disetujui atau dimatikan? | (a) operator, (b) owner | **BELUM TERPENUHI** untuk keduanya | OPS-CLOSE-001 W9, W15 |
| **Pusat Bantuan dan Pengumuman** | Apakah topik untuk layanan cakupan terbit, bukan draf? | HC | **BELUM TERVERIFIKASI** | OPS-CLOSE-001 W10, V12 |
| **Modul lain** | — | — | **Tidak dinilai.** Berada di luar cakupan pilot; alasannya di §8 | OPS-CLOSE-001 §7 |

## 5. Dua kriteria yang paling sering disalahbaca

Keduanya ditulis terpisah karena pernah hampir ditutup dengan bukti dari tingkat yang salah.

1. **G2 tidak ditutup oleh pratinjau.** Menelusuri bagan organisasi dan mendapatkan nama penyetuju hanya menjawab *siapa yang seharusnya menyetujui*. Ia tidak membuktikan orang itu punya akun aktif, punya izin yang diperlukan, atau bahwa pengajuan nyata sampai kepadanya. Hanya `SHADOW` atau pengajuan nyata yang menutup G2 — dan `SHADOW` sekaligus mengubah "hampir seluruh pegawai" menjadi angka (OPS-CLOSE-001 V17, V18).
2. **G8 tidak ditutup oleh pemeriksaan berkas cadangan.** Dump yang pulih dengan setiap cacah baris cocok membuktikan **berkasnya** utuh. Yang belum dibuktikan sejak skema `0167` adalah bahwa **HCIS berjalan** di atas database hasil pulihan. Latihan yang menjawab itu menuntut persetujuan owner untuk setiap pelaksanaan, dan persetujuan itu belum ada (OPS-CLOSE-001 W12; OPS-MI8-DRILL-001).

## 6. Urutan prasyarat — mana yang tidak dapat dibalik

Beberapa kriteria pintu bergantung satu sama lain, dan urutannya bukan selera. Daftar ini menjelaskan **bila** owner memutuskan membuka; ia tidak mengusulkan langkah mana pun dijalankan sekarang.

| Urutan | Apa | Mengapa tidak dapat dibalik |
|---|---|---|
| 1 | **Email ada** (G4) sebelum akun mana pun dapat diundang (G3) | Jalur undangan menolak `409 EMPLOYEE_EMAIL_MISSING` sebelum Akun SQ dipanggil; tanpa email, undangan tidak pernah dibuat. 23 pegawai aktif hari ini tidak punya email sama sekali (§7) |
| 2 | **Jalur pemberitahuan dan undangan dibuka bersama** (G5 bersama G3) | Selama mode daftar izin berlaku, undangan kepada siapa pun di luar daftar berakhir `not_allowlisted` dan **tidak sampai ke mana pun**. Mengundang lebih dulu berarti mengirim ke ruang kosong, lalu harus mengundang ulang |
| 3 | **Penyetuju lebih dulu daripada pegawai biasa** (G1 dan bagian penyetuju dari G3) | Pengajuan pegawai berhenti di `409 APPROVER_ACCOUNT_NOT_READY` selama penyetuju unitnya belum berakun aktif, berapa pun jumlah pegawai yang sudah masuk. Membalik urutan ini menghasilkan satu unit penuh orang yang bisa masuk tetapi tidak bisa mengajukan apa pun |
| 4 | **Sambungan data atasan** (G2) sebelum pengajuan pertama | Tanpa atasan, pengajuan tidak pernah sampai ke langkah penyetuju unit: ia gagal lebih awal dengan `DIRECT_MANAGER_MISSING`. Dua jalur yang sah dan **harus dipilih salah satu** diuraikan di OPS-CLOSE-001 W1; bila jalur pengisian kolom yang dipilih, jalur tulis massalnya masih tertahan di `main`, jadi G12 mendahuluinya |
| 5 | **Rilis** (G12) sebelum perilaku yang dijanjikan dipakai orang | Perilaku yang masih di `main` tidak ada di production. Yang menyentuh pembukaan: jendela pengingat, masa kritis cuti, dan jalur tulis atasan massal |
| 6 | **Latihan restore penuh** (G8) sebelum orang mulai menulis data nyata | Setelah pegawai menulis cuti dan kehadiran, data itu tidak ada duanya di tempat lain. Membuktikan pemulihannya setelah ada data yang hilang bukan pembuktian |
| 7 | **Kepemilikan dan kanal peringatan** (G7) sebelum, bukan sesudah | Selama HCIS tidak punya pengguna, tidak ada yang terdampak bila ia mati. Pada hari pertama ada pengguna, "siapa yang dihubungi" menjadi pertanyaan nyata |
| 8 | **Isi bantuan dan pengumuman** (G11) pada hari yang sama dengan pembukaan | Pengguna pertama mencari penjelasan pada jam pertama. Pusat bantuan yang masih draf memindahkan seluruh beban ke WhatsApp pribadi HC |

Tiga di antaranya mengikat erat dan paling sering dipisah keliru: **1 → 2 → 3**. Email harus ada sebelum undangan; undangan tidak berguna sebelum jalurnya terbuka; dan penyetuju harus siap sebelum pegawainya, bukan sesudah.

## 7. Rencana pilot terbatas

### 7.1 Unit kandidat

**Taman Tahfizh diajukan sebagai kandidat, bukan sebagai keputusan.** Pemilihan unit pilot adalah keputusan owner bersama HCM dan dicatat pada formulir `docs/development/org004-pilot-unit-validation.md` (OPS-READY-001 P1), yang pada 2026-10-16 masih berstatus "NO REAL UNIT SELECTED".

Alasan unit ini diajukan:

| Alasan | Dasarnya |
|---|---|
| Besarnya pas — 9 pegawai aktif | Cukup kecil untuk didampingi satu orang HC sepanjang jendela, cukup besar untuk menghasilkan lebih dari satu pengajuan dalam dua minggu. Cacah per unit ada di OPS-CLOSE-001 §3 |
| Satu unit, satu kepala unit | Rantai persetujuan pendek, sehingga kegagalan routing terbaca sebagai satu sebab, bukan campuran beberapa sebab |
| Unit ini punya jadwal kehadiran tetapi **belum pernah menghasilkan satu scan pun** | Pilotnya menjawab dua hal sekaligus: apakah layanannya jalan, dan apakah unit kedua dapat menghasilkan kehadiran dari mesin (OPS-CLOSE-001 W5) |
| Pekerjaan persiapannya terbatas | Sembilan pegawai dan satu penyetuju, bukan sembilan puluh enam |

Tiga hal yang harus diperiksa ulang sebelum kandidat ini dipakai, dan **tidak satu pun diturunkan ulang di dokumen ini**:

1. **Kelengkapan pengikatan bagan untuk unit ini** berasal dari pekerjaan pratinjau baca-saja terdahulu. Pratinjau menjawab *siapa yang seharusnya*, bukan *siapa yang bisa* (§5 butir 1), jadi ia harus diperiksa ulang dengan resolver sebenarnya.
2. **Penyetuju unit Taman Tahfizh termasuk yang akunnya belum aktif.** Hanya Human Capital Management yang penyetujunya berakun aktif (OPS-CLOSE-001 W2). Jadi pilot ini, seperti unit lain, **tidak dapat dimulai sebelum G1 dan G3 terpenuhi untuk unit itu** — dan apakah serta kapan akun penyetuju diaktifkan adalah keputusan owner dan HCM yang belum diambil.
3. **Kelengkapan email kesembilan pegawainya belum diukur per unit.** Yang terukur adalah angka seluruh yayasan: pengukuran baca-saja owner 2026-11-23 mencatat **23 pegawai aktif tanpa email sama sekali**. Angka ini menjawab V3 yang di OPS-CLOSE-001 masih tercatat sebagai terbuka (§10); pembagiannya per unit belum ada.

**Rekomendasi penulis:** bila kandidat ini ditolak, unit pengganti dipilih dengan tiga sifat yang sama — di bawah sepuluh orang, satu kepala unit, dan punya jadwal kehadiran. Unit terbesar adalah kandidat terburuk untuk percobaan pertama, karena kesalahan routing di sana menyentuh paling banyak orang sekaligus.

### 7.2 Siapa yang ikut

Nama orang tidak ditulis di Git; peran saja, sejalan dengan aturan OPS-GOLIVE-001.

| Peran dalam pilot | Jumlah | Yang dikerjakan |
|---|---|---|
| Pegawai unit kandidat | 9 | Memakai HCIS untuk pekerjaan nyata sehari-hari dalam cakupan modul §7.3 |
| Penyetuju unit | 1 | Memutuskan pengajuan nyata; harus berakun `active` sebelum hari pertama (G1) |
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

Dicatat pendamping HC setiap hari kerja, dari pembacaan baca-saja dan dari tiket. Tidak ada data pribadi dalam catatan ini.

| Ukuran | Mengapa diukur |
|---|---|
| Jumlah pengajuan cuti yang selesai **diputuskan** | Satu-satunya bukti bahwa routing bekerja; pengajuan yang dibuat tetapi tidak diputuskan tidak dihitung |
| Jumlah pengajuan yang gagal, **beserta kode kegagalannya** (`APPROVER_ACCOUNT_NOT_READY`, `DIRECT_MANAGER_MISSING`, `UNIT_APPROVER_MISSING`, lainnya) | Membedakan data yang belum terisi dari kerusakan; kode inilah yang menjelaskan mana yang mana |
| Waktu dari pengajuan sampai keputusan | Menjawab apakah alurnya layak dipakai, bukan sekadar tidak error |
| Punch mobile per hari dan punch dari mesin per hari, terpisah | Dua jalur dengan kegagalan yang berbeda; digabung, keduanya tidak terbaca |
| Berapa pegawai berhasil masuk pertama kali **tanpa bantuan** | Memperkirakan beban HC bila populasinya dikalikan sepuluh |
| Jumlah tiket ke HC, dikelompokkan per sebab | Sama |
| Notifikasi terkirim berbanding `not_allowlisted` | Membuktikan pesan benar-benar sampai, bukan sekadar dikirim |
| Jumlah pegawai yang membuka slipnya dan mengonfirmasi isinya | Satu-satunya pembuktian PAY-001/PAY-002 dari sisi pegawai |

### 7.6 Apa yang dihitung berhasil

Pilot dinyatakan berhasil hanya bila **seluruh** baris berikut benar pada hari ke-10:

1. Setiap pegawai dalam cakupan berhasil masuk setidaknya sekali.
2. Minimal lima pengajuan cuti nyata selesai diputuskan, berasal dari lebih dari satu orang.
3. **Nol** kegagalan routing yang tidak terjelaskan; setiap kegagalan punya kode dan sebab yang tertulis.
4. Minimal satu scan kehadiran nyata dari mesin di unit itu, bila kehadiran masuk cakupan.
5. Minimal satu pegawai membuka slipnya dan mengonfirmasi isinya cocok dengan slip kertas bulan yang sama.
6. Nol kejadian paparan data lintas pegawai atau lintas unit.
7. Nol tiket yang masih terbuka pada hari ke-10.

**Yang tidak dibuktikan pilot ini, dan tidak boleh diklaim sesudahnya:** perilaku pada skala 96 orang; unit yang belum pernah menghasilkan scan sama sekali; perhitungan payroll; dan setiap modul di §8. Pilot yang berhasil menjawab "satu unit dapat memakai HCIS", bukan "HCIS siap dibuka".

### 7.7 Kapan pilot dihentikan

Syarat berhenti OPS-GOLIVE-001 §5 berlaku apa adanya dan tidak disalin ulang di sini. Tiga tambahan yang khas pilot ini:

- **Kegagalan routing yang tidak terjelaskan masih terjadi setelah satu kali perbaikan.** Perbaikan kedua atas sebab yang sama berarti sebabnya belum dipahami.
- **Jalur mesin kehadiran tetap tidak mengirim log** sepanjang minggu pertama, sementara kehadiran termasuk cakupan — karena kehadiran yang tidak terkirim tidak dapat disusun ulang belakangan (OPS-CLOSE-001 W5).
- **Beban HC melampaui satu orang pendamping** — bila sembilan orang sudah menuntut lebih dari satu pendamping, pembukaan yang lebih luas tidak boleh diputuskan dari pilot ini.

### 7.8 Jalan mundur

Lapisan rollback aplikasi, routing, dan data mengikuti OPS-GOLIVE-001 §6 apa adanya. Tiga hal yang khas pilot dan harus ditulis di catatan go-live sebelum hari pertama:

| Lapisan | Pemicu | Tindakan | Pemilik |
|---|---|---|---|
| Pengajuan baru | Pilot dihentikan | Hentikan pengajuan baru untuk unit itu; pengajuan yang sudah berjalan **diselesaikan HC di luar sistem dan dicatat**, bukan ditinggalkan menggantung | Pemilik stop bersama HC |
| Mode routing | Kegagalan routing yang tidak terjelaskan, bila jalur `STRUCTURE` yang dipakai | Kembalikan pengaturan rollout unit itu ke `LEGACY` dengan berlaku ke depan; **snapshot persetujuan yang sudah terkirim tidak disentuh** | Pemilik rollback bersama HC |
| Data yang sudah ditulis pegawai | Kerusakan data | Restore ke database **baru**, lalu pindah; tidak pernah menimpa yang hidup (OPS-MI8-BAK-001 §7) | Owner |

Jalan mundur ini hanya dapat dipercaya bila G8 sudah terpenuhi — yaitu bila pemulihan pernah dibuktikan pada skema yang sedang berjalan, bukan pada skema Oktober.

## 8. Yang tegas di luar cakupan pilot, dan alasannya

| Yang tidak dibuka | Alasan |
|---|---|
| **Perhitungan payroll (PAY-003)** | PAY-001/PAY-002 tetap jalur slip resmi sampai owner menutup parallel run (AGENTS.md §5). Di production mesinnya belum pernah menghitung satu periode pun, dan empat kebijakan pajak serta tata letak slip belum punya versi (OPS-CLOSE-001 §6, L1). Yang dibuka ke pegawai adalah slip hasil impor, bukan hasil hitung — dan memindahkan jalur itu adalah keputusan owner tersendiri, bukan langkah pilot |
| **Perjalanan dinas dan uang saku (TRIP-001/TRIP-002)** | Golongan pegawai ditentukan dari pemetaan kode klasifikasi jabatan ke golongan. Katalog klasifikasi ORG-011 di production **nol di setiap kolom**, jadi tidak ada satu pun pegawai yang golongannya dapat diresolusi dan setiap pengajuan dijawab `409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED`. Ini bukan fitur yang belum jadi, melainkan data yang menopangnya yang belum ada; apakah dan kapan katalog diisi adalah keputusan HCM dan owner yang belum diambil (OPS-CLOSE-001 L16, L10) |
| **Kasbon, reimbursement, kinerja** | Bagian penting dari ketiganya masih tertahan di `main` dan belum ada di production, termasuk empat migrasi yang membawa tabel baru (OPS-CLOSE-001 L6, L7, L11, §4) |
| **Apa pun di balik saklar yang mati** | Pembacaan gaji per orang oleh Pengurus Yayasan, keputusan organ, potongan angsuran lewat payroll, penyerahan reimbursement ke payroll, dan modul pelatihan daring semuanya menunggu saklar yang mati. **Menyalakan saklar adalah keputusan owner tersendiri, bukan langkah operasional pilot** (OPS-CLOSE-001 §6) |
| **Pengumpulan biometrik (ATT-005)** | Mati karena kebijakan, bukan karena belum selesai, dan ketiadaannya diperiksa pada setiap preflight rilis. **Jangan diubah** (OPS-CLOSE-001 L15; OPS-READY-001 P7) |
| **Aset pegawai, penghargaan, kartu pegawai, kepanitiaan** | Menunggu pihak atau data di luar HCIS (OPS-CLOSE-001 L13, L14) |

Aturan tunggal yang merangkum tabel ini: **pilot tidak menyalakan apa pun yang hari ini mati.** Setiap penyalaan adalah keputusan tersendiri dengan pemiliknya sendiri, dan tidak satu pun ikut terbawa oleh keputusan membuka pilot.

## 9. Keputusan yang menunggu, dan siapa pemiliknya

Tidak satu pun dapat diputuskan di dalam dokumen ini.

| # | Keputusan | Pemilik | Mengapa bukan keputusan dokumen ini |
|---|---|---|---|
| D1 | Membuka bertahap lewat pilot satu unit, atau sekaligus untuk seluruh pegawai | Owner | Kebijakan, bukan temuan teknis. **Rekomendasi penulis:** bertahap, karena kriteria G1–G3 gagal dengan cara yang sama untuk satu unit maupun untuk sembilan, dan satu unit jauh lebih murah untuk diperbaiki |
| D2 | Unit pilot dan pesertanya | Owner bersama HCM | OPS-READY-001 P1; formulirnya di luar Git karena memuat nama |
| D3 | Apakah, kapan, dan dengan urutan apa akun penyetuju diaktifkan | Owner bersama HCM | Menyentuh orang dan jadwal kerja mereka; dokumen ini hanya mencatat bahwa tanpa itu G1 tidak dapat terpenuhi |
| D4 | Apakah mode daftar izin pemberitahuan dilonggarkan, untuk siapa, dan kapan | Owner | Keputusan jangkauan pesan ke orang sungguhan |
| D5 | Jalur pemulihan kata sandi atau fallback manual yang diterima | Owner bersama HCM | OPS-READY-001 P9 |
| D6 | Nama pemilik stop, rollback, dan insiden beserta cadangannya; nilai RPO dan RTO | Owner | OPS-GOLIVE-001 §2 dan §4; tidak ada default yang masuk akal untuk diambil sendiri |
| D7 | Satu pelaksanaan latihan restore penuh pada skema yang berjalan | Owner | OPS-MI8-DRILL-001 menuntut persetujuan per pelaksanaan. **Rekomendasi penulis:** dapatkan bukti ini sebelum pegawai mulai menulis data nyata, bukan sesudah |
| D8 | Apakah, kapan, dan dengan kode apa katalog klasifikasi jabatan diisi | Owner bersama HCM | Tidak ada pekerjaan repository yang tersisa untuk membuatnya terisi (OPS-CLOSE-001 L16) |
| D9 | Apakah gerbang rilis yang menuntut golongan boleh menghentikan setiap rilis berikutnya selama katalog kosong | Owner | Keputusan yang masih terbuka pada PR yang menunggu (OPS-CLOSE-001 §4) |
| D10 | Menu pendek berisi layanan yang benar-benar dibuka, atau menu penuh dengan label jujur | Owner | OPS-CLOSE-001 W11, yang merekomendasikan menu pendek |
| D11 | Jalur mana yang dipakai untuk menyambungkan data atasan: mengisi kolom, atau memindahkan mode resolusi | Owner | Keduanya sah; mengerjakan keduanya setengah-setengah tidak menutup G2 (OPS-CLOSE-001 W1) |
| D12 | Catatan pegawai yang berstatus aktif tetapi sudah ditandai terhapus — mana yang benar | HC | Keputusan data; menentukan siapa yang masuk cakupan pembukaan (OPS-CLOSE-001 V21) |

## 10. Catatan terhadap sumber

Ditulis supaya perbedaannya terbaca, bukan dirapikan:

- **Kelengkapan email baru terukur dan belum masuk OPS-CLOSE-001.** Pengukuran baca-saja owner 2026-11-23 mencatat **23 pegawai aktif tanpa email sama sekali**. OPS-CLOSE-001 masih mencatat V3 sebagai butir terbuka dan W3 masih menulis "kelengkapan email 97 pegawai belum diukur". Angka ini dipakai di G4 dan §6 atas dasar pengukuran owner itu; OPS-CLOSE-001 adalah tempat ia seharusnya dicatat pada pembaruan berikutnya, berikut pembagiannya per unit yang belum ada.
- **Penyebut kelayakan adalah 96, bukan 97.** OPS-CLOSE-001 §3 (koreksi 2026-11-23) menetapkan bahwa alur yang berjalan memakai predikat yang lebih ketat, sehingga **96** adalah angka yang benar untuk setiap pernyataan tentang kelayakan proses, sementara 97 hanya benar sebagai cacah baris berstatus aktif. Dokumen ini memakai 96 dan tidak mengulang penurunannya.
- **Jumlah unit yang penyetujunya belum siap: tujuh `invited`, satu tanpa akun, satu aktif.** Rincian 2026-11-20 yang sempat beredar (delapan `invited`) sudah dinyatakan keliru saat dituliskan dan diperbaiki pada 2026-11-23; datanya sendiri tidak berubah.
- **Satu kalimat di OPS-CLOSE-001 perlu dibaca hati-hati.** Setelah koreksi 96/97, W2 menuliskan bahwa "96 pegawai aktif yang layak diproses" berada di unit yang penyetujunya belum bisa bertindak, sementara unit Human Capital Management — yang berisi satu pegawai aktif — justru penyetujunya berakun aktif. Kedua pernyataan itu tidak dapat benar bersamaan tanpa penjelasan tambahan. Dokumen ini karena itu **tidak menuliskan angka tersendiri** untuk populasi yang terhambat, dan menyebutnya sebagai "setiap unit kecuali Human Capital Management". Rekonsiliasinya milik OPS-CLOSE-001.

## 11. Hubungan dengan dokumen lain

- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) — **di mana posisi tiap butir**, dengan bukti bertanggal. Dokumen ini tidak mengulang isinya dan tidak menggantikannya; ia menunjuk ke sana untuk setiap bukti.
- `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001) — penilaian gate Pilot ready dan Production ready per 2026-10-16. Gerbang G1–G13 di sini tidak menambah gate baru pada `docs/product/scope.md`; ia merumuskan gate yang sudah ada menjadi pertanyaan ya/tidak dengan pemeriksanya, dan menambahkan lapisan per modul yang belum pernah dipisahkan.
- `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001) — **tempat keputusannya ditandatangani**. G13 ditutup dengan satu salinan terisi dari template itu; syarat berhenti dan jalan mundur pilot di §7.7 dan §7.8 adalah tambahan di atas §5 dan §6 template, bukan penggantinya.
- `docs/operations/hcis-isolated-restore-drill.md` (OPS-MI8-DRILL-001) — prosedur yang menutup G8, dengan persetujuan owner per pelaksanaan.
- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) — satu-satunya jalur rilis; G12 ditutup lewat itu.
- `docs/development/org004-pilot-unit-validation.md` dan `org004-operational-validation.md` — formulir pemilihan unit pilot dan tahapan `SHADOW` yang menutup G2.

Dokumen ini diperbarui ketika salah satu kriterianya berubah status, dengan bukti bertanggal baru, atau ketika owner memutuskan salah satu butir §9. Kriteria tidak boleh naik status tanpa bukti.
