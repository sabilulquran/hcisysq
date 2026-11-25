# LEAVE-003 R2 — 6 hari kerja per semester: implementasi dan bukti uji

**Status:** IMPLEMENTED — TANGGAL EFEKTIF MENUNGGU PEMILIK (`DRAFT`)
**Spesifikasi:** LEAVE-003 R2 (`docs/domain/leave-policy-ysq.md` §"LEAVE-003 R2")
**Terkait:** LEAVE-001, LEAVE-004, LEAVE-008, ATT-004, HELP-001
**Tanggal:** 25 November 2026

## 1. Apa yang berubah

Instruksi pemilik 25 November 2026: batas pemakaian Cuti Tahunan berpindah dari **3 hari kerja per
triwulan** (Jan-Mar, Apr-Jun, Jul-Sep, Okt-Des) menjadi **6 hari kerja per semester kalender**
(Januari-Juni, Juli-Desember). Hak tahunan tetap **12 hari kerja**.

Tidak berubah: kelompok yang berhak (`non_education`), masa kerja 12 bulan, H-7, kalender hari
kerja, dan sisa kuota yang tidak otomatis dibawa ke periode berikutnya.

## 2. Tanggal efektif — satu-satunya yang `DRAFT`

Aturan baru berlaku berdasarkan **tanggal cuti**, dan tanggal mulainya diambil dari pengaturan
`ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM`.

| | Nilai | Akibat |
| --- | --- | --- |
| Default yang dirilis, production termasuk | tidak diisi | aturan triwulan berlaku untuk **semua** tanggal, persis seperti sekarang |
| Usulan untuk rancangan dan pengujian | `2027-01-01` | dipakai di seluruh uji; belum dipasang di production |

Jadi menggabungkan perubahan ini dan bahkan merilisnya **tidak mengubah apa pun** bagi pegawai
sampai pemilik menetapkan tanggalnya. Layar Admin → Konfigurasi Cuti menyebutkan aturan yang sedang
berlaku dan tanggal mulai aturan semester, dibaca dari API, bukan ditulis di halaman.

### Cara memberlakukannya setelah pemilik menetapkan tanggal

1. Tambahkan `ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM=<YYYY-MM-DD>` pada
   `/srv/hcis/shared/final.env` di Mi8VPS.
2. Mulai ulang layanan API (`sq-core-launch.sh`), sekitar 30 detik.
3. Periksa Admin → Konfigurasi Cuti: aturan dan tanggalnya harus tampil sesuai.

Tidak ada migrasi data pada langkah ini, dan mengosongkan kembali nilainya mengembalikan aturan
triwulan untuk semua tanggal. Pengajuan yang sudah tersimpan tidak ikut berubah: masing-masing
sudah menyimpan periode dan batas yang dipakai saat divalidasi.

## 3. Aturan berlaku berdasarkan tanggal cuti

```text
tanggal mulai cuti  <  tanggal efektif  ->  3 hari kerja per triwulan
tanggal mulai cuti  >= tanggal efektif  ->  6 hari kerja per semester
```

Dua akibat yang disengaja:

- pengajuan yang sudah dikirim, termasuk yang **masih menunggu persetujuan**, tetap dibaca dengan
  aturan tanggal cutinya; tidak ada pengajuan yang berpindah aturan di tengah jalan;
- rentang tanggal yang memuat tanggal efektif dibaca dengan **satu** aturan, yaitu aturan tanggal
  mulainya, bukan dipecah menjadi dua aturan di dalam satu pengajuan.

## 4. Rekonsiliasi: setiap hari mengurangi kuota tepat sekali

Tidak ada baris yang ditulis ulang. Pengajuan lama tetap memegang kunci triwulannya
(`JAN_MAR`/`APR_JUN`/`JUL_SEP`/`OCT_DEC`) dan batas yang tersimpan padanya; pengajuan baru memegang
`JAN_JUN` atau `JUL_DEC`. Pemakaian dihitung dari **tanggal mulai** tiap pengajuan, bukan dari kunci
yang tersimpan, dan karena satu triwulan tidak pernah melintasi batas semester:

```text
Januari-Juni  terpakai = Jan-Mar terpakai + Apr-Jun terpakai
Juli-Desember terpakai = Jul-Sep terpakai + Okt-Des terpakai
```

Yang dihitung tetap pengajuan berstatus `in_review` dan `approved`; yang dibatalkan dan ditolak
tidak, seperti sebelumnya.

**Batas semester mengikat kedua aturan.** Begitu ada tanggal efektif, batas 6 hari berlaku untuk
seluruh setengah tahun, termasuk tanggal yang masih dibaca dengan aturan triwulan. Ini hanya
berpengaruh bila tanggal efektif jatuh di tengah semester — justru di situlah kedua aturan bertemu.
Pengajuan untuk Mei bisa dikirim lebih dulu di bawah aturan semester, lalu pengajuan untuk Maret di
bawah aturan triwulan; pemeriksaan triwulan yang hanya melihat triwulannya sendiri akan menumpuk 3
hari di atas 6 hari pada setengah tahun yang sama. Tahun yang seluruhnya di bawah aturan triwulan
tidak pernah ikut terbatasi, karena 3 + 3 memang sudah sama dengan batas semester.

Temuan ini datang dari putaran tinjauan independen; pada rancangan awal lubang itu ada, dan contoh
di bawah menutupnya untuk tanggal efektif mana pun serta urutan pengiriman mana pun.

### Contoh saldo sebelum dan sesudah tanggal efektif

Pegawai sudah genap 12 bulan, tanggal efektif 1 Januari 2027.

| Tanggal baca | Aturan | Periode yang tampil | Tersedia |
| --- | --- | --- | --- |
| 15 Desember 2026 | triwulan | Jan-Mar 3, Apr-Jun 3, Jul-Sep 3, Okt-Des 3 | 3 (Okt-Des) |
| 15 Januari 2027 | semester | Jan-Jun 6, Jul-Des 6 | 6 (Jan-Jun) |

Dengan tanggal efektif **1 April 2027** (pergantian di tengah tahun), dan 3 hari sudah dipakai pada
Februari di bawah aturan lama:

| Pengajuan | Aturan | Periode | Batas | Terpakai sebelumnya | Tersedia |
| --- | --- | --- | ---: | ---: | ---: |
| Februari 2027 | triwulan | Jan-Mar | 3 | 0 | 3 |
| Mei 2027 | semester | Jan-Jun | 6 | 3 | 3 |
| Agustus 2027 | semester | Jul-Des | 6 | 0 | 6 |

Total setahun: 3 + 3 + 6 = **12 hari kerja**. Tiga hari Februari dihitung satu kali, yaitu sebagai
bagian dari semester Januari-Juni.

Urutan pengiriman tidak mengubah hasilnya. Dengan tanggal efektif yang sama, bila pengajuan Mei
(6 hari, aturan semester) dikirim lebih dulu, pengajuan Maret berikutnya melihat semester Januari-Juni
sudah habis dan ditolak — bukan melihat triwulan Januari-Maret yang masih kosong.

## 5. Satu pengajuan, satu periode

Pola lama dipertahankan; hanya batasnya yang bergeser.

| Rentang | Sebelum tanggal efektif | Sesudah tanggal efektif |
| --- | --- | --- |
| 30 Maret - 2 April | ditolak (melewati batas triwulan) | **boleh** (masih satu semester) |
| 29 Juni - 2 Juli | ditolak | ditolak (melewati 30 Juni-1 Juli) |
| 29 Desember - 3 Januari | ditolak | ditolak (pergantian tahun) |

Penolakannya `409 CROSS_PERIOD_REQUEST_UNSUPPORTED`, dan pesannya menyebut batas yang harus dipecah
("Tanggal yang melewati 30 Juni-1 Juli atau pergantian tahun diajukan terpisah."). Petunjuk yang
sama tampil di layar Cuti Tahunan sebelum pegawai memilih tanggal, bukan hanya saat ditolak.

## 6. Yang disentuh

| Bagian | Berkas | Perubahan |
| --- | --- | --- |
| Domain | `annual-leave-policy.ts` | skema kuota, kunci semester, batas per skema, label, rentang bulan, pemakaian per periode |
| Domain | `annual-leave-request.ts` | skema diambil dari tanggal mulai; pesan lintas periode mengikuti skema |
| Domain | `attendance-resolution.ts` | konversi klarifikasi kehadiran memakai periode dan batas yang berlaku |
| Konfigurasi | `config/env.ts` | `ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM` + pembacaannya |
| API | `leave/employee-routes.ts` | pemakaian dihitung per triwulan dari `start_on`; pratinjau, pengiriman, ringkasan, dan audit membawa `quotaScheme` |
| API | `leave/postponement-routes.ts` | usulan tanggal lain dibaca dengan aturan tanggal usulannya |
| API | `leave/attendance-resolution-routes.ts` | pemakaian dihitung per rentang tanggal periode; batas yang tersimpan mengikuti skema |
| API | `leave/admin-routes.ts` | `/admin/leave/configuration` melaporkan aturan yang berlaku dan tanggal mulainya |
| Basis data | `0185_annual_leave_semester_quota.sql` | kunci `JAN_JUN`/`JUL_DEC` diizinkan; indeks pemakaian per tanggal; tanpa perubahan data |
| Pusat Bantuan | `0186_help_center_annual_leave_quota.sql` | FAQ hak cuti tahunan menyebut kedua aturan dan tanggal berlakunya |
| Layar | `EmployeeLeavePage`, `EmployeeDashboardPage`, `EmployeeAnnualLeavePage`, `AdminLeaveConfigurationPage` | batas dibaca dari API; petunjuk batas periode |
| Kontrak | `docs/api/leave.openapi.yaml` | `AnnualLeaveQuotaScheme`, `AnnualLeavePeriodKey`, `quotaScheme` |

## 7. Bukti uji

Dijalankan pada 25 November 2026 di checkout kerja, PostgreSQL 16 lokal.

| Gate | Hasil |
| --- | --- |
| `npm run typecheck` (web + api) | lulus |
| `npm run lint` | 0 error (63 warning lama, tidak bertambah) |
| Suite API penuh (`vitest run --no-file-parallelism`) | **3243 lulus**, 91 dilewati, 287 berkas |
| Empat suite tata kelola (`HCIS_AUTH011_TEST_DATABASE_URL`) | **124 lulus** (AUTH-011 30, ORG-010 39, ORG-013 13, ADR-0008 8, dan dua berkas pendukung) |
| Suite web | **765 lulus**, 103 berkas |
| `npm run build` | lulus |

### Uji yang khusus membuktikan aturan ini

`apps/api/test/leave-policy.test.ts` — 11 kasus domain:

- skema diambil dari tanggal cuti, bukan tanggal pengajuan; tanpa tanggal efektif semuanya triwulan;
- pemetaan tanggal ke triwulan dan ke semester, serta batas 3 dan 6;
- **saldo sebelum dan sesudah**: 15 Des 2026 menampilkan empat periode 3 hari, 15 Jan 2027 dua
  periode 6 hari, dan jatah setahun tetap 12 pada keduanya;
- pemakaian semester dibaca sebagai jumlah dua triwulan yang ditulis aturan lama, dan semester
  satunya tidak ikut terpotong;
- **6 hari kerja diterima, 7 ditolak**;
- pemakaian yang sudah ada, termasuk pengajuan yang masih menunggu, mengurangi kuota semester;
- rentang melintasi batas triwulan lama di dalam satu semester diterima;
- rentang melintasi 30 Juni-1 Juli dan pergantian tahun ditolak, dengan pesan yang menyebut batasnya;
- tanggal cuti sebelum tanggal efektif tetap memakai aturan triwulan walau diajukan sesudahnya;
- rentang yang memuat tanggal efektif dibaca dengan satu skema, skema tanggal mulainya;
- **total setahun tetap 12** saat aturan berganti di tengah tahun (3 + 3 + 6), termasuk penolakan
  hari keempat di semester pertama.

`apps/api/test/attendance-resolution.test.ts` — 4 kasus konversi klarifikasi kehadiran: konversi
masuk ke periode semester dengan batas 6, tanggal melintasi batas triwulan lama di dalam satu
semester diterima, tanggal melintasi 30 Juni-1 Juli ditolak, dan tanggal sebelum tanggal efektif
tetap memakai aturan triwulan.

`apps/api/test/leave-semester-quota.postgres.test.ts` — **9 kasus terhadap skema basis data yang
sebenarnya**. Uji ini menjalankan **dua aplikasi pada satu transaksi**: `legacyApp` dengan
konfigurasi yang dipakai production hari ini (tanpa tanggal efektif) dan `app` dengan tanggal
efektif terpasang. Baris "lama" karena itu benar-benar ditulis oleh konfigurasi lama lewat route
pengiriman biasa, bukan disisipkan tangan:

1. enam hari kerja tersimpan sebagai `JAN_JUN` dengan batas tersimpan 6, dan hari berikutnya ditolak;
2. tujuh hari kerja ditolak langsung, pesannya menyebut "Januari-Juni";
3. **catatan lama tetap terbaca**: baris `JAN_MAR` berbatas 3 yang ditulis `legacyApp` terbaca
   sebagai bagian semester Januari-Juni, menyisakan 3 dari 6; hari keempat ditolak, tiga hari
   diterima, dan baris lamanya tetap `JAN_MAR` dengan batas 3 — tidak ditulis ulang, tidak dihitung
   dua kali;
4. pengajuan yang masih `in_review` menahan kuota, dan setelah dibatalkan kuotanya kembali penuh;
5. satu pengajuan melintasi batas triwulan lama di dalam satu semester diterima (`JAN_JUN`, 4 hari);
6. satu pengajuan melintasi 30 Juni-1 Juli ditolak `CROSS_PERIOD_REQUEST_UNSUPPORTED`;
7. **tanggal efektif di tengah semester** (1 April): pengajuan Mei 6 hari dikirim lebih dulu di
   bawah aturan semester, lalu pengajuan Maret di bawah aturan triwulan ditolak walau triwulannya
   sendiri masih kosong, dan ringkasan menunjukkan 0 hari tersedia;
8. pengajuan Desember terhitung pada periode Juli-Desember — batas bulan ke-12 pada kueri pemakaian;
9. ringkasan pegawai menampilkan empat periode 3 hari pada `legacyApp` dan dua periode 6 hari pada
   `app`, dengan hak tahunan tetap 12.

Satu uji web, `apps/web/src/lib/annualQuotaHint.test.ts`, menjaga petunjuk di layar: selama tanggal
efektif masih di depan, kotak hak cuti menyebut tanggal itu dan menerangkan bahwa yang berlaku
adalah aturan pada tanggal cuti — bukan membiarkan aturan hari ini berbicara untuk tanggal
sesudahnya.

## 8. Risiko dan jalur mundur

- **Migrasi `0185`** hanya melonggarkan satu `CHECK`; tidak ada `UPDATE` atau `DELETE`. Rilis yang
  sedang berjalan tidak pernah menulis kunci semester, jadi ia berjalan apa adanya di atas
  constraint baru. Jalur mundurnya ada di kepala berkas migrasinya, beserta kueri pemeriksa yang
  harus kosong sebelum constraint lama dipasang kembali.
- **Migrasi `0186`** hanya menyentuh satu artikel Pusat Bantuan, dan hanya selama isinya masih teks
  awal 0130; suntingan HC selalu menang. Perbandingannya membuang CR lebih dulu di kedua sisi:
  baris yang pernah ditanam dari checkout CRLF berisi kata yang sama dengan akhir baris berbeda,
  dan pencocokan persis akan diam-diam tidak menemukan apa pun lalu melaporkan sukses — tanpa galat
  dan tanpa jumlah baris yang terlihat siapa pun. Tetap periksa sesudah rilis:
  `SELECT left(body, 80) FROM help_articles WHERE id = '33b7ee82-a5df-5249-9d20-722b12b83e74'`.
- **Pengaturan tanggal efektif** dapat dikosongkan kembali kapan saja untuk kembali ke aturan
  triwulan, tanpa migrasi.
- Yang tidak dapat dikembalikan dengan mengosongkan pengaturan: baris yang sudah tersimpan dengan
  kunci semester. Baris itu tetap sah dan tetap terbaca — pemakaiannya dihitung dari tanggal
  mulainya — tetapi kunci `JAN_JUN`/`JUL_DEC`-nya hanya bisa dihapus dari constraint setelah tidak
  ada lagi baris yang memakainya.

## 9. Dampak pada pilot Cuti Tahunan Taman Tahfizh

Tidak ada, selama tanggal efektif belum ditetapkan — dan tanggal usulannya (1 Januari 2027) jatuh
setelah pilot. Pilot berjalan dengan aturan 3 hari per triwulan, persis seperti yang direncanakan di
`docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md`.

Dua catatan untuk pilot:

- prasyarat pilot tidak bertambah; yang masih diperlukan tetap keempat butir pada OPS-PILOT-TT-001
  §5, dengan kelompok hak cuti sebagai yang pertama;
- bila nanti aturan semester berlaku, pengajuan pilot yang sudah tercatat tidak ikut berubah, karena
  aturan mengikuti tanggal cutinya.

Sebaliknya, pilot berguna bagi perubahan ini: layar yang menampilkan batas periode kini membaca
angkanya dari API, sehingga pilot sekaligus menguji jalur yang akan dipakai aturan semester.
