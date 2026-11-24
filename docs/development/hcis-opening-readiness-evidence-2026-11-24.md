# Bukti kesiapan pembukaan HCIS — audit dan perbaikan 24 November 2026

**Spec ID:** OPS-EVID-001
**Status:** CATATAN BUKTI (bukan gate). Dokumen ini tidak menaikkan status satu butir pun di `hcis-closure-list.md` (OPS-CLOSE-001) dan tidak menggantikan kriteria pintu di `hcis-opening-criteria-and-pilot-plan-2026-11-23.md` (OPS-OPEN-001). Ia mencatat **apa yang benar-benar diuji pada 24 November 2026, dengan cara apa, dan apa hasilnya.**
**Rilis production saat ditulis:** `hcis-734be5ca-20261124` (155 migrasi, tertinggi `0183`), dibuktikan dari `cwd` proses yang berjalan, bukan dari CI.
**Repository:** `origin/main` pada `b9969d63`; satu-satunya selisih terhadap rilis adalah commit dokumen.

---

## 1. Jawaban singkat

**HCIS belum dapat dibuka hari ini, tetapi penghalangnya bukan lagi cacat perangkat lunak pada jalur cuti.** Dua cacat yang benar-benar menghentikan pegawai sudah diperbaiki dan dibuktikan uji; keduanya **belum dirilis**. Yang tersisa sebagai penghalang adalah pekerjaan HCM dan keputusan owner: akun, email, pilihan sumber penyetuju, dan isi Pusat Bantuan.

Yang akan dialami pegawai **begitu akunnya diaktifkan**, pada rilis yang berjalan hari ini:

| | Keadaan pada rilis berjalan (`734be5ca`) | Setelah perbaikan 24 Nov dirilis |
|---|---|---|
| Masuk, lihat profil, baca slip | Berjalan | Berjalan |
| Ajukan cuti | **Gagal untuk hampir semua orang**: 94 dari 96 pegawai aktif tidak punya atasan langsung, dan 8 dari 9 unit penyetujunya belum berakun aktif | Tidak berubah — ini data dan akun, bukan kode |
| Ajukan cuti sebagai penyetuju unit | **Gagal selalu**, termasuk untuk 8 pegawai yang menjadi penyetuju unitnya sendiri | Berjalan: rantainya ke atasan langsung |
| Tahu hasil pengajuannya | **Tidak diberi tahu sama sekali** | Satu notifikasi saat disetujui atau ditolak |
| Langkah tersangkut karena penyetuju kehilangan akses | Hanya dapat dibebaskan dengan menyunting basis data | HCM mengalihkan langkahnya, teraudit |
| Buka "Semua Layanan" | 31 layanan tertulis "Tersedia", termasuk yang server tolak | Label mengikuti gerbang server |

---

## 2. Apa yang diuji, dan dengan apa

| Lapisan | Cakupan | Hasil |
|---|---|---|
| **Produksi (baca-saja)** | Versi berjalan, migrasi, akun, unit, bagan terbit, saklar, jalur mesin absensi | Dibaca pada 24 Nov 13.21 WIB lewat sesi `default_transaction_read_only=on`. Tidak ada yang diubah |
| **Uji otomatis API** | Seluruh suite pada database bersih | Lihat §6 |
| **Uji otomatis web** | 101 berkas, 752 uji | Lulus; lint 0 galat |
| **Skenario sintetis lewat HTTP** | 98 skenario sebagai pegawai, kepala unit, penyetuju unit, Plt, dan HCM | 97 sesuai rancangan, 1 temuan terbuka (C23/D16) |
| **Penelusuran layar** | Login, Beranda, wizard cuti, Persetujuan, Semua Layanan, Pusat Bantuan, layar HCM | Lihat §5 |

Lingkungan uji: database PostgreSQL terpisah di workstation, data **sepenuhnya sintetis** (sepuluh pegawai uji, bagan terbit buatan, akun uji berkata sandi lokal). Tidak ada akun produksi yang diaktifkan, tidak ada undangan yang dikirim, dan tidak ada data produksi yang disentuh.

---

## 3. Perbaikan yang diselesaikan dan dibuktikan

Ketiganya ada di `main` dan **belum dirilis**. Sampai dirilis, perilaku production tidak berubah.

| # | Perbaikan | Apa yang salah | Bukti |
|---|---|---|---|
| 1 | **ORG-004 D-R6** — penyetuju unit dapat mengajukan cutinya sendiri | Rungnya memang harus dibuang (APR-001, LEAVE-004-G), tetapi dibuang tanpa jejak, sehingga pemeriksaan di hilir menolak `409 UNIT_APPROVER_MISSING` dan menyalahkan konfigurasi yang benar. Mengenai **8 dari 9** penyetuju unit di produksi | `org004-unit-approver-self-leave.postgres.test.ts` (15 uji); skenario D01–D02 |
| 2 | **LEAVE-010-F** — pemohon diberi tahu keputusan akhir | Setiap penyetuju diberi tahu, pemohon tidak satu pun. Intent sudah ditulis ke `leave_notification_outbox` sejak awal, tetapi tidak ada yang membacanya | `leave010-requester-decision-notification.postgres.test.ts` (6 uji); skenario D03–D05 |
| 3 | **APR-001 Reassignment** — `POST /admin/leave/approvals/:stepId/reassign` | Spesifikasi memintanya sejak awal; cuti tidak pernah punya jalurnya, sehingga langkah yang penyetujunya kehilangan akses berhenti selamanya | Lima uji di berkas (1); skenario D06–D12 |
| 4 | **SVC-001** — `GET /me/services`, label layanan dari server | Katalog layar menuliskan sendiri "Tersedia" untuk 31 layanan, termasuk Uang Muka Dinas yang server tolak `409 TRIP_PER_DIEM_NOT_ACTIVE` | `svc001-employee-service-status.test.ts` (6 uji); skenario D13–D14 |
| 5 | **Indikator kesiapan Konfigurasi Cuti** membaca sumber yang sama dengan rute yang merutekan | Layar menghitung kolom atasan lama untuk semua orang, termasuk unit yang sudah berjalan di atas bagan — menyuruh HC mengisi kolom yang tidak dibaca siapa pun | Dua uji di berkas (1); skenario D15 |
| 6 | **Pesan penolakan resolver berbahasa Indonesia** | Pegawai membaca "Authority resolution cannot resolve to the requester" | Skenario D16 |
| 7 | **Tautan masuk pada halaman aktivasi lama** | Menuju `/login`, rute yang tidak ada, menampilkan "404 Halaman tidak tersedia". Ada 80 token aktivasi lama di produksi | `AccountActivationPage.test.tsx` |

---

## 4. Jalur persetujuan berbasis bagan: apa yang terbukti

Dibuktikan pada unit pilot sintetis yang bentuknya meniru bagan terbit produksi (seluruh kebijakan kekosongan `CLIMB_TO_PARENT`, kepala unit dan penyetuju unit dua orang berbeda, pegawai duduk di sub-node tanpa binding sendiri, **kolom atasan lama kosong**).

| Skenario | Hasil | Bukti |
|---|---|---|
| Pegawai tanpa kolom atasan lama dirutekan ke pejabat yang benar | Kepala unit → penyetuju unit, diputuskan sampai `approved` | C05, C06 |
| Satu baris pengaturan pada node unit menjangkau sub-nodenya; unit lain tidak ikut | Benar | C03, C04, C07 |
| Pergantian pejabat lewat Perancang Organisasi berlaku untuk pengajuan **baru** | Benar, tanpa input lain | C10, C12 |
| Pengajuan yang sudah masuk tetap pada pejabat lama | Benar; pejabat baru ditolak 403 | C13, C14 |
| Akun penyetuju belum aktif | `409 APPROVER_ACCOUNT_NOT_READY`, menyebut kursi, orang, dan bahwa yang perlu diselesaikan adalah aktivasi akunnya | C11 |
| Plt (`ACTING`) menyelamatkan kursi yang pejabat tetapnya kosong | Benar; Plt memutuskan; Plt tidak menyetujui dirinya sendiri | C16–C19 |
| Pejabat tetap yang masih layak didahulukan atas Plt | Benar | C20 |
| Kursi benar-benar kosong, kebijakan memanjat | Naik ke kursi induk | C21 |
| Kepala unit mengajukan cutinya sendiri | Langsung ke penyetuju unit | C22 |
| Penerbitan bagan menuntut orang kedua | Penyusun ditolak `409 ORGANIZATION_PUBLISH_REQUIRES_SECOND_PERSON` | C09 |
| Jalan mundur: mengakhiri baris pengaturan | 200, teraudit; berlaku mulai hari berikutnya | C24–C27 |
| **Pucuk bagan tanpa kursi induk dan tanpa binding organ** | **Terbuka**: `409 AUTHORITY_SELF_RESOLUTION`. Kalimatnya kini berbahasa Indonesia dan menyebut Human Capital, tetapi orang itu memang tidak punya penyetuju sampai ada binding `GOVERNANCE_APPROVER` atau kursi induk | C23, D16 |

**Yang belum dibuktikan di sini:** kursi yang dipegang akun Organ Yayasan (ORG-013) — di produksi ada 2 kursi semacam itu dan 1 binding `GOVERNANCE_APPROVER`. Uji otomatisnya ada (`org013-organ-account-approver.postgres.test.ts`) tetapi menuntut database khusus dan **tidak ikut berjalan pada suite harian**; celah V22 (akun organ yang belum aktif masih dilewati diam-diam) belum tertutup.

### Alur yang masih membaca pengaturan lama

| Pembaca | Berkas | Akibat bila unitnya sudah memakai bagan | Syarat memindahkannya |
|---|---|---|---|
| Notifikasi atasan pada **cuti khusus** | `leave/special-leave-routes.ts` | Pemberitahuan tidak terkirim bila kolom atasan kosong | Cuti khusus belum punya kunci workflow ORG-004; menambahkannya menuntut kunci baru + migrasi constraint |
| **Lembur perintah atasan**: daftar bawahan dan tanda "saya atasan" | `attendance/workforce-routes.ts` | Atasan menurut bagan tidak melihat bawahannya | Ganti dua kueri `direct_manager_employee_id` dengan pembacaan bagan (arah terbalik: resolve per pegawai lalu saring) |
| **Pratinjau rantai di Admin Cuti** | `leave/admin-routes.ts` | Selalu menampilkan rantai lama | Panggil resolver, atau sembunyikan untuk unit `STRUCTURE` |
| **Angka kesiapan Portal Organ dan admin kepegawaian** | `board/aggregates.ts`, `employment/admin-routes.ts` | Tampil "belum siap" padahal bagan lengkap | Sama seperti indikator Konfigurasi Cuti yang sudah diperbaiki |
| **Layar input penyetuju dan atasan** | `AdminLeaveConfigurationPage.tsx`, `AdminEmployeeDetailPage.tsx` | HC diminta mengetik yang sudah diketahui bagan | Jadikan baca-saja untuk unit `STRUCTURE` |

Indikator kesiapan Konfigurasi Cuti sudah dipindahkan (§3 nomor 5); sisanya belum.

---

## 5. Penelusuran layar

Dijalankan di browser terhadap API lokal dan data sintetis.

| Layar | Hasil |
|---|---|
| Halaman masuk, login pegawai uji | Berjalan; sesi terbentuk, Beranda menampilkan nama, saldo cuti, dan riwayat pengajuan yang benar |
| Wizard Cuti Tahunan (UX-FLOW-001) | Satu langkah per layar; langkah "Periksa" menampilkan alur persetujuan sebelum dikirim; "Pengajuan terkirim" |
| Pesan saat akun penyetuju belum aktif | Tampil di atas formulir, menyebut nama, kursi, dan bahwa bagan tidak perlu diubah |
| Layar Persetujuan (penyetuju) | Pengajuan tampil; **Setujui** berjalan dan antrean berkurang |
| Tombol **Tolak** | **Belum teruji di layar**: memakai dialog bawaan browser (`window.prompt`), yang tidak dapat dioperasikan dari otomasi. Perlu satu kali uji manual, atau diganti dialog di halaman |
| Semua Layanan | 31 layanan; sebelum perbaikan semuanya "Tersedia" |
| Pusat Bantuan | "Panduan sedang disiapkan" dan "Kontak resmi Human Capital belum diisi" — 87 topik seluruhnya draf |
| Konfigurasi Cuti (HCM) | Angka kesiapan tampil; daftar akun dan peran benar |
| Rute admin oleh pegawai biasa | 403/404 di setiap layar yang dicoba |

---

## 6. Uji otomatis

| Suite | Hasil |
|---|---|
| API, seluruh berkas, database bersih | Lihat catatan di bawah |
| Web | 101 berkas, 752 uji, lulus |
| Lint API dan web | 0 galat (62 peringatan lama di web) |
| Typecheck | Lulus |

**Empat berkas dilewati pada setiap kali jalan** karena menuntut `HCIS_AUTH011_TEST_DATABASE_URL`: matriks izin AUTH-011 (30 uji), Portal Organ ORG-010 (39), kursi akun organ ORG-013 (13), dan pembacaan gaji ADR-0008 (8). Artinya **90 uji yang justru menjaga batas peran dan jalur organ tidak ikut berjalan di gerbang harian.** Menjalankannya menuntut satu database tambahan; itu pekerjaan yang belum dilakukan dan dicatat di §7.

**Catatan tentang kebersihan database.** Menjalankan seluruh suite dua kali berturut-turut pada database yang sama membuat beberapa berkas gagal (`break-glass`, `auth014-module-admin-migration`, `leave-postponement`) karena baris yang di-commit berkas lain. Ketiganya lulus pada database bersih. Ini sifat suite, bukan akibat perubahan 24 November, dan sudah tercatat sebelumnya.

---

## 7. Sisa pekerjaan

### Perbaikan sistem

| # | Pekerjaan | Penanggung jawab | Bukti yang menutupnya |
|---|---|---|---|
| S1 | Rilis perbaikan 24 November ke production (OPS-MI8-REL-001) | Operator | Catatan verifikasi rilis bertanggal, `cwd` proses menunjuk rilis baru |
| S2 | Tombol **Tolak** diuji di layar, atau dialognya dipindahkan ke halaman | Pengembang bersama HCM | Satu penolakan nyata lewat layar, atau uji otomatis atas dialog barunya |
| S3 | Jalankan empat berkas uji yang dilewati (AUTH-011, ORG-010, ORG-013, ADR-0008) di CI | Pengembang | 90 uji itu hijau pada gerbang yang sama dengan suite harian |
| S4 | Tutup celah V22: kursi yang dipegang akun organ dan akunnya belum aktif masih dilewati diam-diam | Pengembang, setelah keputusan ORG-013-1 | Uji yang menolak kursi organ berakun belum aktif, seperti D-R5 untuk kursi pegawai |
| S5 | Pindahkan pembaca kolom lama yang tersisa (§4) | Pengembang | Untuk tiap alur: satu pengajuan `STRUCTURE` yang layar dan prosesnya menunjuk orang yang sama |
| S6 | Menu pendek atau label jujur untuk modul di luar cakupan (W11) | Owner memutuskan, pengembang mengerjakan | Akun pegawai biasa hanya melihat layanan cakupan |

### Persiapan HCM dan operasional

| # | Pekerjaan | Penanggung jawab | Bukti yang menutupnya |
|---|---|---|---|
| H1 | Lengkapi email **22 pegawai aktif**; siapkan akun **23 pegawai** yang belum punya | HCM | Cacah baca-saja: nol pegawai aktif tanpa email, nol tanpa akun |
| H2 | Aktifkan penyetuju lebih dulu: **16 pemegang kursi berakun `invited`**, **3 tanpa akun** | HCM | Satu pengajuan uji per unit melewati langkah penyetuju tanpa `APPROVER_ACCOUNT_NOT_READY` |
| H3 | Pilih sumber penyetuju: baris pengaturan bagan per unit, **atau** isi kolom atasan 94 pegawai | Owner bersama HCM | Untuk cakupan yang dipilih: mode resolusi terbaca `STRUCTURE`, atau kolom terisi |
| H4 | Terbitkan topik Pusat Bantuan, isi kontak HC, siapkan pengumuman pembukaan | HCM | Cacah topik terbit untuk layanan cakupan > 0; kontak terisi |
| H5 | Lengkapi jadwal kehadiran (93 penugasan untuk 96 pegawai); hidupkan kembali mesin absensi — diam sejak **17 Nov 14.36** | HCM bersama pemilik perangkat | Satu scan nyata dari mesin di unit cakupan |
| H6 | Keputusan owner: daftar izin WhatsApp, retensi foto kehadiran, penerbit bagan kedua, pemilik insiden dan rollback, latihan restore penuh | Owner | OPS-GOLIVE-001 terisi tanpa `TBD`; catatan latihan restore bertanggal |
| H7 | Isi katalog klasifikasi jabatan bila uang saku dinas akan dibuka | Owner bersama HCM | Penyalaan uang saku diterima (hari ini ditolak `409 TRIP_PER_DIEM_NOT_READY`) |

---

## 8. Hubungan dengan dokumen lain

- `hcis-closure-list.md` (OPS-CLOSE-001) — posisi tiap butir; pembaruan 24 November mencatat ketiga perbaikan di atas sebagai "di `main`, belum dirilis".
- `hcis-opening-criteria-and-pilot-plan-2026-11-23.md` (OPS-OPEN-001) — kriteria pintu G1–G13. Audit ini tidak menaikkan satu pun; yang berubah adalah dua penghalang perangkat lunak pada G2/G4 modul cuti hilang dari daftar.
- `docs/domain/dynamic-organization-structure.md` — D-R6.
- `docs/domain/workflows/leave-request.md` — LEAVE-010-F dan pengalihan langkah.
- `docs/api/employee-services.openapi.yaml` — SVC-001.
