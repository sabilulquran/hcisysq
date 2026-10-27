# Audit daftar panjang dan pagination SQ Core — 24 Oktober 2026

**Status:** DISCOVERY. Hasil inspeksi kode statis dan hitungan agregat production read-only. Belum ada perbaikan.
Aturan yang diusulkan: [ENG-LIST-001](list-pagination-standard.md).

## 1. Latar dan cakupan

Owner menemukan layar HCIS yang menampilkan deretan data panjang tanpa pagination, misalnya dropdown pegawai dan
riwayat di Pola jadwal serta laporan kehadiran. Audit ini memeriksa setiap layar dan endpoint daftar di aplikasi
SQ Core yang kodenya ada di workstation owner:

| Aplikasi | Repository | Revisi diaudit | Database production |
|---|---|---|---|
| HCIS | `sabilulquran/hcisysq` | `main` 151f1cc | `sqcore_hcis` |
| SQ Hub | `sabilulquran/SQ-Hub` | `main` b711fc7 | `sqcore_hub` |
| Aset SQ | `sabilulquran/Aset-SQ` | `main` 70d69bd | `sqcore_aset` |
| Karir SQ | `sabilulquran/karir-sq` | `main` 9ba6f06 | `sqcore_karir` |
| SPMB SQ | `sabilulquran/spmb-sq` | `main` d9ff3af | `sqcore_spmb` |
| Keluarga SQ | `sabilulquran/keluarga-sq` | `main` 4114079 | `sqcore_keluarga` |

Akun SQ (Keycloak) dan perangkat lunak vendor ADMS tidak diaudit karena bukan kode SQ Core.

## 2. Metode

- Inspeksi kode: setiap `GET` yang mengembalikan array di `apps/api`, dan setiap tabel, daftar, kartu, dan
  `<select>` berisi record di `apps/web`. Dicatat: jenis pagination, batas `LIMIT`, filter yang membatasi, tabel
  sumber, dan apakah tabel itu bertumbuh.
- Production: `ssh mi8vps-root` → `psql` sebagai user Termux pemilik PostgreSQL, dengan
  `PGOPTIONS='-c default_transaction_read_only=on'`; setiap sesi memverifikasi `transaction_read_only = on`.
  Hanya `count(*)`, `min/max` tanggal, dan `GROUP BY status`. Tidak ada baris data yang dibaca atau disalin.
- Catatan: temuan baris kode dirangkum per layar; nomor baris mengacu ke revisi di atas dan bisa bergeser.

## 3. Jumlah baris production (24 Oktober 2026)

Hanya tabel yang relevan dengan daftar. "Laju" dihitung dari rentang tanggal data yang ada.

| Database | Tabel | Baris | Catatan pertumbuhan |
|---|---|---:|---|
| HCIS | `employees` | 330 | 99 active, 231 resigned. Dropdown pegawai aktif sudah 99 opsi. |
| HCIS | `attendance_adms_request_journal` | 776.673 | Sejak 28 Agt 2026; 88.668 dalam 7 hari (±12.700/hari). |
| HCIS | `attendance_adms_events` | 3.508 | Scan mesin sejak 28 Agt; baru 46 pegawai terpetakan. Dengan 99 pegawai × 2 scan × ±25 hari ≈ 5.000/bulan. |
| HCIS | `attendance_adms_quarantines` | 4.773 | |
| HCIS | `attendance_daily_records` | 293 | 44 hari sejak 31 Agt; target ±99 baris/hari kerja. |
| HCIS | `attendance_schedule_assignments` | 50 | Riwayat Pola jadwal, bertambah setiap perubahan pola. |
| HCIS | `payslips` | 5.202 | ±12 per pegawai per tahun. |
| HCIS | `payslip_import_rows` | 5.299 | Dalam **1** batch; detail batch mengirim seluruhnya dalam satu response. |
| HCIS | `employee_import_rows` | 1.542 | 6 job (rata-rata ±257 baris/job; pratinjau dipotong 200). |
| HCIS | `organization_memberships` / `organization_nodes` | 1.342 / 1.060 | Designer organisasi. |
| HCIS | `access_audit_events` / `organization_audit_events` / `auth_audit_events` | 362 / 313 / 135 | Audit, bertumbuh. |
| HCIS | `in_app_notifications` | 60 | Baru mulai; akan menjadi tabel tercepat di sisi pegawai. |
| Hub | `kirim_events` / `kirim_messages` / `kirim_media` | 5.663 / 3.977 / 3.148 | Pesan sejak 18 Okt 2026 (±570/hari). |
| Hub | `organization_directory_sync_attempts` | 7.228 | Log sinkronisasi. |
| Hub | `platform_audit_events` | 59 | |
| Aset | `assets` | 0 | Belum ada aset; impor massal bisa 1.000 baris per batch. |
| Karir | `candidates` / `applications` | 1 / 0 | Belum diluncurkan publik; impor SIRE ±2.800 riwayat direncanakan. |
| SPMB | `registrations` | 863 | Seluruhnya status `arsip` (impor PPDB lama). |
| SPMB | `questionnaire_answers` | 6.404 | |
| Keluarga | `families` / `guardians` / `children` | 405 / 804 / 471 | Tidak ada daftar staf; hanya data per keluarga. |

## 4. Temuan

Legenda pagination: **S** = server-side dengan total/kursor; **C** = client-side; **L** = batas keras tanpa halaman;
**N** = tanpa batas. Pertumbuhan: **T** = data bertumbuh, **B** = terbatas.

### 4.1 Pola umum

- HCIS sudah punya pola rujukan: `GET /admin/employees` (`page`, `pageSize` 1–100 default 25, response
  `pagination{page,pageSize,total,pageCount}`). Pola itu ditulis inline di route; **tidak ada helper bersama**, dan
  `GET /admin/employees` sendiri belum tercantum di `docs/api/openapi.yaml`.
- Di HCIS hanya dua endpoint yang benar-benar berhalaman di server: daftar pegawai dan kredensial biometrik
  (`/adms/biometric-control-plane/credentials`). Konsistensi kepegawaian menerima `page/pageSize` (maks 200) tetapi
  memotong di memori.
- Komponen `PaginationBar` ada, tetapi hanya mode client-side dan dipakai di beberapa layar; daftar pegawai dan
  batch slip gaji memakai pager inline masing-masing.
- Pola dominan di semua aplikasi: `LIMIT n` tetap (20–1.000, bahkan 50.000 untuk CSV) tanpa total dan tanpa
  pemberitahuan. Data di luar batas tidak bisa dijangkau sama sekali.
- SQ Hub punya tiga dialek (`page` tanpa `has_more`, `page` + `has_more`, kursor `batas/setelah`). Aset, Karir,
  SPMB, Keluarga tidak punya pagination sama sekali.
- Beberapa endpoint memfilter di memori **setelah** `LIMIT` (pencarian audit SQ Hub, scope aset di Aset SQ),
  sehingga hasil kurang dari yang seharusnya walaupun datanya ada.

### 4.2 HCIS — kehadiran dan ADMS

| Layar / endpoint | Pagination | Data | Masalah |
|---|---|---|---|
| Pola jadwal: dropdown pegawai (`AdminAttendanceConfigPages.tsx`, `loadActiveEmployees`) | menggabungkan **semua halaman** `/admin/employees` ke satu `<select>` | T (99 aktif) | Dropdown 99 opsi tanpa pencarian. |
| Pola jadwal: riwayat (`GET /admin/attendance/schedule-assignments`, `workforce-routes.ts:964`) | N, tanpa filter | T (50) | Seluruh riwayat semua pegawai dalam satu tabel; dimuat ulang setelah setiap aksi. |
| Laporan kehadiran (`AdminAttendanceReportsV2Page.tsx`, `GET /admin/attendance/report`) | N; rentang maks 93 hari; `scans` L 5.000 | T | Detail/jadwal/periode/unit: hari × pegawai aktif ≈ 9.200 baris dalam satu response dan satu tabel. |
| Pantauan Hari Ini (`GET /admin/attendance/today`) | N, satu baris per pegawai aktif | B per hari (99) | Dapat diterima sementara (§4 ENG-LIST-001: rentang satu hari), tetapi di atas 50 baris sebaiknya berhalaman. |
| Ringkasan kehadiran (`AdminAttendanceSummaryPage.tsx`) | angka = `items.length` | T | Angka salah begitu daftar sumber mencapai batas 500/1.000. |
| Klarifikasi, bukti absen HP, tukar shift HC | L 500 | T | Status `all` menampilkan riwayat terpotong. |
| Lembur HC | L 1.000 | T | |
| Roster mingguan (`/admin/attendance/rosters`) | N, 1 minggu × pegawai aktif dengan `<select>` per sel | B per minggu | ±700 `<select>`; perlu filter unit. |
| Transaksi mesin per perangkat (`/adms/devices/:id/transactions`) | L 200, **tanpa parameter tanggal**, C 25 | T | Scan lebih lama dari 200 terakhir tidak terjangkau (3.508 scan di 2 mesin hari ini). |
| Transaksi global (`/adms/transactions`) | L 1.000, default hari ini | T | Rentang panjang terpotong diam-diam. |
| Pekerjaan ADMS (`AdminAdmsJobsPage.tsx`) | hanya **page 1, pageSize 100** dari `/admin/employees` | T | Pegawai ke-101 akan hilang tanpa pemberitahuan (aktif 99 hari ini). |
| Biometrik perangkat (`AdminAdmsDeviceBiometricsPage.tsx`) | API S, UI hanya halaman 1 (100) | T | Tidak ada kontrol halaman. |
| Pengguna perangkat, mapping assistant, koreksi pengguna | N di API, C 25/10 di UI | T (riwayat mapping) | API mengirim seluruh riwayat. |
| Audit/jobs/user-sync/log ADMS | L 100–250 | T | Tanpa halaman berikutnya. |
| CSV mesin (`/devices/:id/transactions/export.csv`) | L 50.000; CSV kehadiran per mesin N | T | Ekspor perlu streaming/penolakan eksplisit. |
| Riwayat resolusi pegawai (`GET /attendance/resolutions/me`) | N, N+1 query | T | |
| Kehadiran saya, jadwal saya, detail per pegawai | rentang maks 31/62 hari | T, terikat rentang | Memenuhi syarat rentang tanggal. |

### 4.3 HCIS — modul lain

| Layar / endpoint | Pagination | Data | Masalah |
|---|---|---|---|
| Daftar pegawai (`GET /admin/employees`) | **S** (rujukan) | T | Pager inline, bukan `PaginationBar`; `pageSize` tidak bisa dipilih. |
| Konsistensi kepegawaian | S semu (maks 200, slice di memori) | B/T lambat | Kontrak berbeda (tanpa objek `pagination`). |
| Pratinjau import pegawai (`GET /admin/employee-imports/:id`) | N di API, UI `slice(0, 200)` | T | Baris > 200 tidak terlihat, tanpa pemberitahuan. |
| Riwayat import pegawai / riwayat batch slip gaji | L 50 | T | Riwayat lama tidak terjangkau. |
| Detail batch slip gaji (`GET /admin/payslip-imports/:batchId`) | N di API, C 100 di UI | T | 5.299 baris dalam satu response hari ini. |
| Notifikasi pegawai (`GET /notifications/me`) | `limit` maks 100, tanpa offset/kursor | T | Notifikasi lebih lama dari 50 terakhir tidak bisa dibuka. |
| Ringkasan cuti saya / cuti khusus saya | L 10 / L 20 | T | Riwayat lama hilang dari layar. |
| Cuti terencana saya (`/leave/planned/me/summary`), slip gaji saya (`/payslips`) | N | T per pegawai | Lambat tumbuh (±12/tahun); prioritas rendah. |
| Akses admin (`GET /admin/access`) | N; termasuk penugasan role yang sudah berakhir | B/T lambat | Daftar akun dan riwayat penugasan dalam satu layar. |
| Designer organisasi (`/admin/organization/designer/employees`) | N, termasuk pegawai resign (330) | T | Dropdown dan checklist anggota dari seluruh pegawai. |
| Konfigurasi cuti (`AdminLeaveConfigurationPage.tsx`) | N; `<select>` semua pegawai aktif **di setiap baris unit** | T | 17 unit × 99 opsi; ganti typeahead. |
| Detail pegawai: kandidat atasan | N, semua pegawai aktif | T | Ganti typeahead. |
| Antrean approval/validasi HC | N, dibatasi status pending | T, antrean kecil | Dapat diterima dengan batas pengaman. |
| Board, governance summary, snapshot organization-directory | agregat/snapshot | — | Pengecualian sah. |

### 4.4 SQ Hub

| Layar / endpoint | Pagination | Masalah |
|---|---|---|
| Antrean Kirim (`/api/admin/kirim/queue`) | S `page` + `has_more`, ukuran tetap 50 | Tanpa total; kontrak berbeda dari HCIS. |
| Jangan Hubungi, Aktivitas Kirim | S `page` tanpa `has_more`/total | UI menebak halaman terakhir dari `length < 50`. |
| Nomor Kirim (`/kirim/devices`) | N (terbatas) | Hitungan per nomor memindai seluruh `kirim_outbox` tanpa batas waktu. |
| Riwayat impor Kirim | L 500, UI `slice(0, 50)` | |
| Audit platform (`/api/admin/audit`) | L 100 (maks 200) | **Pencarian `q` di memori setelah `LIMIT`**: hanya mencari di 100 event terbaru. |
| Keanggotaan organ | L 500/500/20 | Terbatas organisasi; perlu pemberitahuan saja. |
| API internal percakapan/pesan Kirim, organization-directory | S kursor (`batas/setelah`, `limit/cursor`) | Contoh kontrak kursor yang baik; organization-directory memfilter seluruh snapshot di memori. |

### 4.5 Aset SQ

| Layar / endpoint | Pagination | Masalah |
|---|---|---|
| Register aset (`/api/v1/assets`) dan tiga dropdown "aset yang memenuhi syarat" | L 250, **scope otorisasi di memori setelah `LIMIT`** | Pengguna ber-scope bisa melihat < 250 walaupun datanya ada; dropdown kehilangan aset lama. |
| Audit fisik, kustodi, pemeliharaan | L 250 + N+1 `getAsset` | |
| Laporan (`/reports/summary`, `export.csv`) | N, membaca seluruh tabel | |
| Direktori unit/orang (`/directory/*`) | menjelajahi **semua** halaman kursor SQ Hub (hingga ±10.000) | Dropdown orang dari seluruh direktori. |
| Riwayat impor | L 20 | |

Production hari ini 0 aset, jadi belum ada yang terpotong; risiko muncul saat impor massal pertama (maks 1.000
baris per batch).

### 4.6 Karir SQ, SPMB SQ, Keluarga SQ

| Aplikasi | Layar / endpoint | Pagination | Masalah |
|---|---|---|---|
| **SPMB** | Daftar pendaftaran staf + **Riwayat PPDB lama** (`GET /api/staf/registrations`) | L 500, tanpa total | **Sudah memotong data di production: 500 dari 863 arsip ditampilkan; 363 tidak terlihat.** Web tidak mengirim `year` untuk arsip. |
| **SPMB** | Ekspor CSV pendaftaran | memakai query yang sama, L 500 | Ekspor kehilangan 363 baris tanpa pemberitahuan. |
| SPMB | Leads | L 1.000 per tahun | |
| SPMB | Pembayaran menunggu, keringanan | L 500 + N+1 | |
| Karir | Pipeline pelamar per lowongan | L 1.000; hitungan tahap tanpa batas | Daftar dan hitungan bisa tidak cocok tanpa pemberitahuan. |
| Karir | Dropdown permintaan formasi di form lowongan | filter client-side dari L 500 | Permintaan lama yang disetujui bisa hilang dari dropdown. |
| Karir | Lowongan, kandidat dibekukan, konflik migrasi | L 500 | Impor SIRE ±2.800 riwayat. |
| Karir | Permintaan penghapusan akun | N | |
| Keluarga | Endpoint keluarga | per keluarga, terbatas domain | Pengecualian sah. |
| Keluarga | `/internal/migration/runs/:id/map` | N, satu run penuh | Machine-to-machine; pantau ukuran. |

## 5. Paket perbaikan berprioritas (untuk persetujuan owner)

Prioritas: **P0** fondasi yang dibutuhkan paket lain; **P1** data sudah terpotong/tersembunyi atau layar yang
dikeluhkan owner; **P2** akan terpotong dalam hitungan minggu–bulan atau sebelum peluncuran; **P3** lambat tumbuh.
Setiap paket satu PR (atau satu PR per repository), dengan specification ID sendiri.

| Paket | Prioritas | Repository | Isi | Catatan |
|---|---|---|---|---|
| **PAG-0 Fondasi HCIS** | P0 | HCIS | Modul `pagination` di API (schema zod offset/kursor, builder response), `PaginationBar` mode server + hook `usePagedQuery` dengan state di URL, komponen OpenAPI bersama, `GET /admin/employees` didokumentasikan di OpenAPI, klasifikasi `list` per route di manifest AUTH-011 beserta test. | Tanpa perubahan perilaku layar. |
| **PAG-1 Kehadiran: Pola jadwal, laporan, pemilih pegawai** | P1 | HCIS | Riwayat pola jadwal berhalaman + filter pegawai/unit; laporan kehadiran berhalaman di server untuk tipe detail/jadwal/periode/unit (ekspor tetap lengkap); dropdown pegawai di Pola jadwal, Pekerjaan ADMS, konfigurasi cuti, kandidat atasan, designer organisasi → typeahead `EmployeeSearchField`; Ringkasan memakai hitungan agregat. | **Koordinasi dengan sesi ATT-014** sebelum menyentuh berkas kehadiran. Bisa dipecah: PAG-1a (Pola jadwal + pemilih pegawai), PAG-1b (laporan + ringkasan). |
| **PAG-2 SPMB pendaftaran dan ekspor** | P1 | SPMB SQ | Pagination server untuk daftar pendaftaran staf dan Riwayat PPDB lama; ekspor CSV lengkap terlepas dari ukuran halaman. | Satu-satunya temuan yang terbukti menyembunyikan data production hari ini (363 arsip). |
| **PAG-3 Transaksi mesin ADMS** | P1 | HCIS | Kursor + filter rentang tanggal untuk transaksi per perangkat dan global; biometrik perangkat memakai halaman server yang sudah ada; ekspor CSV streaming atau menolak eksplisit. | Koordinasi ATT/ADMS. |
| **PAG-4 Import dan slip gaji** | P1 | HCIS | Pratinjau import pegawai berhalaman (tanpa potongan 200); detail batch slip gaji berhalaman di server; riwayat import pegawai dan batch slip gaji berhalaman. | Payslip/payroll butuh review tambahan (AGENTS.md §8). |
| **PAG-5 Antrean dan riwayat kehadiran/cuti** | P2 | HCIS | Klarifikasi, bukti absen HP, lembur, tukar shift, resolusi, riwayat cuti/cuti khusus/cuti terencana → berhalaman; notifikasi → kursor. | Koordinasi ATT. |
| **PAG-6 ADMS admin lainnya** | P2 | HCIS | Audit, jobs, user-sync, log, mapping/roster (riwayat) berhalaman; daftar perangkat tanpa polling N per perangkat. | |
| **PAG-7 SQ Hub** | P2 | SQ Hub | Satukan kontrak Kirim (`page/pageSize/total` atau kursor) dan audit platform; pindahkan pencarian audit ke SQL; batasi hitungan per nomor ke jendela waktu; adopsi ENG-LIST-001 di `AGENTS.md` Hub. | `kirim_messages` ±570/hari. |
| **PAG-8 Karir SQ sebelum peluncuran publik** | P2 | Karir SQ | Pipeline pelamar dan daftar staf berhalaman; dropdown permintaan formasi dengan filter server; permintaan penghapusan akun berbatas. | Harus selesai sebelum impor SIRE dan peluncuran R1. |
| **PAG-9 Aset SQ sebelum impor massal** | P2 | Aset SQ | Register dan daftar operasional berhalaman dengan scope di SQL; dropdown aset/orang → typeahead; laporan berbasis agregat; adopsi ENG-LIST-001 di `AGENTS.md` Aset. | Belum ada aset di production; lakukan sebelum impor pertama. |
| **PAG-10 Sisa HCIS** | P3 | HCIS | Akses admin (riwayat penugasan), slip gaji saya, konsistensi kepegawaian ke kontrak standar, `PaginationBar` di daftar pegawai. | |
| **PAG-11 Keluarga dan sisa SPMB** | P3 | Keluarga SQ, SPMB SQ | Peta migrasi internal berhalaman atau streaming; leads/pembayaran/keringanan SPMB berhalaman. | |

**Status 26 Oktober 2026:** PAG-2 selesai (sabilulquran/spmb-sq#32, commit 9854c8a). PAG-0 selesai lewat PR fondasi
HCIS: helper offset, komponen OpenAPI, dan klasifikasi seluruh 127 rute `GET` di
[list-endpoint-classification.json](list-endpoint-classification.json); 56 rute tercatat sebagai `debt` per paket.

**Status 27 Oktober 2026:** PAG-4 selesai: riwayat import pegawai dan riwayat batch slip gaji berhalaman dengan total;
pratinjau import pegawai berhalaman dengan saringan "hanya yang bermasalah" dan ringkasan isu dari server (potongan
200 baris dihapus); review batch slip gaji (5.299 baris di production) diambil 100 per halaman dengan ringkasan galat
dari server. Utang tercatat turun ke 51 rute.

**Status 27 Oktober 2026 (lanjutan):** PAG-10 selesai: halaman Akses mencari dan membagi account per halaman di SQL
(ringkasan dari hitungan SQL, account untuk role dipilih dari kartunya); slip gaji pegawai dibaca per tahun; daftar
draf dan jurnal designer organisasi berhalaman (jurnal terbaru di atas); konsistensi kepegawaian dan daftar orang
organisasi membawa objek `pagination` bersama; semua batas `pageSize`/`limit` 200 diturunkan ke 100. Utang tercatat
turun ke 42 rute, sisanya PAG-1, PAG-3, PAG-5, dan PAG-6 (berkas kehadiran).

Urutan yang disarankan: PAG-0 → PAG-2 (repository lain, bisa paralel) → PAG-1 → PAG-4 → PAG-3, lalu P2 sesuai
jadwal peluncuran aplikasi masing-masing.

## 6. Risiko dan keterbatasan audit

- Inspeksi statis; perilaku layar belum diuji di browser. Beberapa baris kode dirujuk dari laporan agen audit dan
  sudah diperiksa ulang untuk temuan P1 (Pola jadwal, Pekerjaan ADMS, pratinjau import, notifikasi, SPMB).
- Hitungan production adalah snapshot 24 Oktober 2026; laju pertumbuhan diperkirakan dari rentang data yang masih
  pendek.
- Repository Aset, Karir, SPMB, Keluarga diaudit dari `origin/main`; working tree lokal di cabang lain tidak diubah.
