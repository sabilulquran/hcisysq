# Laporan & Ekspor HR

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling ketat.
**Spesifikasi:** RPT-001
**Tanggal:** 2026-11-03
**Terkait:** AUTH-011 (`hcis-authorization-modernization.md` §Scope per peran, §Nama peran), ENG-LIST-001, ATT-014, TRIP-001, TRAIN-001, PAY-003
**Bukti legacy:** `Admin/ReportsController` (`employeesCsv`, `attendanceMonthly`, `leaveCsv`, `payrollCsv`) di `hcysq/hcis-ysq`; `docs/product/legacy-parity-audit-2026-11-02.md` (c)

## 1. Tujuan

Human Capital di HCIS lama mengunduh daftar pegawai dan rekap cuti untuk laporan rutin. HCIS baru sudah punya laporan kehadiran (ATT-009/ATT-014) dan rekap jam pelatihan di layar HC, tetapi belum punya daftar pegawai atau rekap cuti yang dapat diunduh. Dua peran, **Pembaca Laporan** (`finance`) dan **Pimpinan (Laporan)** (`management`), sudah memegang `reports.read.organization` / `reports.export.organization` sejak migrasi 0004, tetapi belum ada layar yang memeriksanya, sehingga keduanya tidak membuka apa pun.

Paket 1:

- lima laporan HR yang dapat dilihat per halaman dan diunduh sebagai CSV atau XLSX;
- kedua peran laporan akhirnya berfungsi, untuk seluruh organisasi atau untuk satu unit;
- setiap unduhan tercatat di audit tanpa data pribadi.

## 2. Batas

Termasuk (Paket 1):

| Laporan | Kunci | Isi satu baris |
| --- | --- | --- |
| Daftar pegawai | `employees` | satu pegawai |
| Rekap cuti | `leave` | satu pegawai dalam periode |
| Rekap lembur | `overtime` | satu pegawai yang punya pengajuan lembur dalam periode |
| Rekap perjalanan dinas | `trips` | satu perjalanan dinas yang disetujui dalam periode |
| Rekap pelatihan | `training` | satu pegawai dalam periode |

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Laporan payroll, nominal gaji, rekap potongan | Data sensitif, dan PAY-003 belum lulus parallel run (AGENTS.md §5). Laporan payroll final tetap di modul payroll dengan `payroll.reports.read.organization`. |
| Laporan kehadiran | Sudah ada di ATT-014 (`/admin/attendance/reports`, `attendance.reports.read`). Tidak diduplikasi. |
| NIK, nomor rekening, alamat, tanggal lahir, telepon, email, pendidikan | Lihat D-04. |
| Laporan terjadwal, kirim email, PDF | Belum ada kebutuhan tertulis. |
| Grafik dan dashboard | Panel Organ Yayasan (ORG-010) dan ringkasan admin sudah ada. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Siapa.** Pembaca Laporan (`finance`, `reports.read.organization`) melihat laporan. Pimpinan (Laporan) (`management`, `reports.read.organization` + `reports.export.organization`) melihat dan **mengunduh**. Permission tidak berubah dari migrasi 0004; yang baru adalah layar dan route yang memeriksanya. | DRAFT |
| D-02 | **Scope.** Kedua peran boleh diberikan untuk **seluruh organisasi** atau **satu unit** (`allowedScopes` = `organization`, `unit`). Peran ber-scope unit hanya melihat pegawai yang **saat ini** berada di unit itu (`employees.organizational_unit_id`). Beberapa penugasan unit digabung. Pegawai tanpa unit hanya terlihat oleh scope organisasi. Unit HCIS datar, jadi tidak ada turunan unit. | DRAFT |
| D-03 | **Populasi.** Hanya pegawai yang dikelola HCIS (`management_scope = 'MANAGED'`) dan tidak dihapus (`removed_at IS NULL`). Pegawai `OUTSIDE_HCIS` tidak pernah masuk laporan. Riwayat dilaporkan menurut unit pegawai **saat ini**, bukan unit pada saat kejadian. | DRAFT |
| D-04 | **Kolom sensitif.** Default paling ketat: Paket 1 **tidak memuat** NIK, nomor rekening, alamat, tanggal lahir, telepon, email, pendidikan, maupun nominal uang di laporan mana pun, dan tidak ada permission yang membukanya. Bila owner nanti memerlukannya, dibuat permission terpisah `reports.export.sensitive` (`TBD`) dengan keputusan owner tentang kolom dan pemegangnya. | DRAFT |
| D-05 | **Jenis cuti kesehatan tidak dirinci.** Rekap cuti hanya memisahkan Cuti Tahunan dan Cuti Tanpa Gaji. Semua jenis lain (sakit, hamil/melahirkan, keguguran, istirahat haid, haji, duka, dsb.) dijumlahkan sebagai "Cuti lainnya", karena jenisnya mengungkap data kesehatan atau agama. | DRAFT |
| D-06 | **Periode cuti.** Pengajuan `approved` dihitung penuh (`working_days`) pada periode tempat **tanggal mulainya** jatuh; tidak diprorata ke periode berikutnya. Pengajuan `in_review` dengan tanggal mulai dalam periode dihitung sebagai "Menunggu". | DRAFT |
| D-07 | **Lembur.** Menurut `work_date` dalam periode: jumlah pengajuan disetujui dan total menit disetujui (ditampilkan sebagai jam, dua desimal), serta jumlah pengajuan menunggu. Catatan pengajuan dan keputusan tidak dilaporkan. Hanya pegawai yang punya pengajuan lembur dalam periode. | DRAFT |
| D-08 | **Perjalanan dinas.** Satu baris per perjalanan berstatus `APPROVED`, `ISSUED`, atau `COMPLETED` yang **tanggal mulainya** dalam periode: tujuan, tanggal, jumlah hari, status. Maksud perjalanan dan laporan penyelesaian (teks bebas) tidak dilaporkan. Biaya tidak ada di TRIP-001. | DRAFT |
| D-09 | **Pelatihan.** Catatan `VERIFIED` yang **tanggal selesainya** dalam periode: jam peserta (internal, eksternal, total), jam sebagai pemateri, jumlah catatan peserta. Sama dengan TRAIN-001-J, setiap pegawai aktif muncul walau nol, ditambah pegawai nonaktif yang punya jam dalam periode. | DRAFT |
| D-10 | **Periode.** Laporan rekap memerlukan `from` dan `to` (tanggal, inklusif), paling panjang **366 hari**. Layar mengisi bulan berjalan. Rekap cuti (D-06) juga memuat setiap pegawai aktif walau nol. | DRAFT |
| D-11 | **Ekspor tidak memotong diam-diam.** Ekspor dihitung dulu (`COUNT`), lalu dibaca **per halaman 1.000 baris** dalam satu snapshot `REPEATABLE READ READ ONLY`, sehingga jumlah dan isi berasal dari data yang sama. Di atas **50.000 baris** ekspor ditolak `422 EXPORT_TOO_LARGE` dengan pesan untuk mempersempit filter. Ekspor tidak pernah mengirim sebagian baris. | ACCEPTED |
| D-12 | **Audit ekspor.** Setiap ekspor menulis `access_audit_events` dengan `action = 'reports.hr.exported'`, `entity_type = 'hr_report'`, dan payload `{report, format, filters, scope, unitCount, rows}`. `filters` hanya berisi filter terstruktur (`unitId`, `status`, `employmentType`, `from`, `to`); ekspor **tidak menerima** pencarian teks bebas, sehingga nama tidak pernah masuk audit. Audit ditulis sebelum file dikirim; bila gagal, file tidak dikirim. Melihat laporan di layar tidak diaudit, sama dengan ATT-014. | DRAFT |
| D-13 | **Super Admin dan bundel HC.** `reports.*` tidak ada di kompatibilitas legacy Super Admin dan tidak masuk bundel Human Capital. Petugas HC yang perlu mengunduh laporan diberi peran Pimpinan (Laporan) secara eksplisit lewat SQ Hub/Akses. | DRAFT |
| D-14 | **Pilihan filter.** Dropdown unit berisi unit dalam scope akun; unit adalah data referensi terbatas (puluhan) yang sama dengan dropdown unit di Daftar Pegawai admin, jadi dikecualikan dari aturan typeahead ENG-LIST-001 §4. Pilihan jenis kepegawaian adalah nilai berbeda dari pegawai dalam scope. Tidak ada dropdown pegawai. | ACCEPTED |
| D-15 | **Layar tahu scope unit.** Guard permission umum hanya membaca penugasan organisasi (AUTH-011). Agar menu muncul untuk peran ber-scope unit, `/auth/me` menambah `authorization.unitPermissions`: permission yang dipegang lewat penugasan unit **hanya untuk permission yang API-nya menghormati scope unit** (saat ini `reports.read.organization` dan `reports.export.organization`). Semua guard lain tetap membaca `organizationPermissions`. | ACCEPTED |

## 4. Aktor dan izin

| Aktor | Precondition | Boleh |
| --- | --- | --- |
| Pembaca Laporan | Akun `EMPLOYEE` aktif, pegawai aktif, penugasan `finance` berlaku hari ini (tanggal inklusif) dengan scope organisasi atau unit | `GET /admin/reports/hr/access`, `GET /admin/reports/hr/{report}` dalam scope-nya |
| Pimpinan (Laporan) | Sama, penugasan `management` | Di atas, ditambah `GET /admin/reports/hr/{report}/export` dalam scope-nya |
| Legacy Super Admin, Panel Organ Yayasan, pegawai biasa, HC tanpa peran laporan | — | Tidak ada (403) |

Scope ekspor = scope `reports.export.organization` **diiris** scope `reports.read.organization`, sehingga ekspor tidak pernah lebih luas daripada yang boleh dilihat.

## 5. Alur

### 5.1 Melihat

1. Layar memanggil `GET /admin/reports/hr/access`: daftar laporan, scope (`organization` atau daftar unit), boleh unduh atau tidak, pilihan unit dan jenis kepegawaian.
2. Pengguna memilih laporan dan filter. `GET /admin/reports/hr/{report}?page&pageSize&...` mengembalikan `{columns, items, pagination}`; `pageSize` default 25, maksimum 100 (ENG-LIST-001 §3.1). Predikat scope dan filter berada di `WHERE` query hitung dan query halaman, **sebelum** `LIMIT`.
3. `unitId` di luar scope → `403 REPORT_SCOPE_FORBIDDEN`; tidak pernah diam-diam diganti.

### 5.2 Mengunduh

1. `GET /admin/reports/hr/{report}/export?format=csv|xlsx&...` dengan filter yang sama tanpa `q`.
2. API memeriksa `reports.export.organization` dan scope (D-01, §4), lalu menjalankan D-11.
3. Audit (D-12), lalu file dikirim: `hcis-laporan-<report>-<tanggal>.csv|xlsx`, `Cache-Control: no-store`.
4. CSV memakai UTF-8 dengan BOM; sel yang diawali `= + - @` (atau tab/CR) diberi awalan `'` (SEC-13). XLSX memuat judul, scope, periode, dan siapa serta kapan mengunduh di atas tabel.

## 6. Kolom

| Laporan | Kolom |
| --- | --- |
| `employees` | NIP, Nama, Unit, Jabatan, Jenis kepegawaian, Status kepegawaian, Status, Mulai bekerja, Berakhir |
| `leave` | NIP, Nama, Unit, Cuti Tahunan (hari), Cuti Tanpa Gaji (hari), Cuti lainnya (hari), Total (hari), Pengajuan disetujui, Pengajuan menunggu |
| `overtime` | NIP, Nama, Unit, Lembur disetujui (kali), Jam lembur disetujui, Pengajuan menunggu |
| `trips` | NIP, Nama, Unit, Tujuan, Mulai, Selesai, Hari, Status |
| `training` | NIP, Nama, Unit, Jam internal, Jam eksternal, Total jam peserta, Jam pemateri, Catatan pelatihan |

Filter: semua laporan menerima `unitId`. `employees` menerima `status` (`active` default, `inactive`, `resigned`, `all`), `employmentType`, dan `q` (hanya layar). Laporan rekap menerima `from`, `to` (wajib) dan `q` (hanya layar). Urutan: nama pegawai, lalu NIP, lalu id (dan tanggal mulai untuk `trips`), sehingga halaman stabil.

## 7. Error

| Kode | HTTP | Kapan |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Tanpa sesi |
| `FORBIDDEN` | 403 | Tidak memegang permission yang diperlukan dalam scope apa pun |
| `REPORT_SCOPE_FORBIDDEN` | 403 | `unitId` di luar scope |
| `REPORT_NOT_FOUND` | 404 | Kunci laporan tidak dikenal |
| `INVALID_REPORT_QUERY` | 400 | Filter, halaman, format, atau tanggal tidak valid; periode terbalik atau lebih dari 366 hari |
| `EXPORT_TOO_LARGE` | 422 | Ekspor lebih dari 50.000 baris |

Layar menampilkan state memuat, kosong ("Tidak ada data pada filter ini"), terlarang (pesan dan nama peran yang membukanya), dan error; tabel dapat digulir horizontal di ponsel.

## 8. Audit event

| Event | Tabel | Payload |
| --- | --- | --- |
| `reports.hr.exported` | `access_audit_events` | `report`, `format`, `filters` (D-12), `scope` (`organization`/`unit`), `unitCount`, `rows` |

Tidak ada nama, NIP, pencarian teks, atau isi baris di audit maupun log.

## 9. Perubahan database

Migrasi `0126_hr_reports_roles.sql` hanya memperbarui `roles.description` untuk `finance` dan `management` (sebelumnya "Belum berfungsi"). Tidak ada tabel, kolom, atau permission baru. Rollback: kembalikan deskripsi dari migrasi 0109 (tertulis di kepala migrasi). Perubahan scope (`allowedScopes`) ada di kode (`ROLE_SCOPES`), bukan di database.

## 10. Acceptance

- RPT-001-A: tanpa `reports.read.organization` dalam scope apa pun → 403 untuk semua route; Super Admin legacy → 403.
- RPT-001-B: peran ber-scope unit hanya melihat pegawai unitnya di kelima laporan, `total` hanya menghitung unitnya, dan `unitId` unit lain → 403.
- RPT-001-C: Pembaca Laporan → 403 pada ekspor; Pimpinan (Laporan) → file CSV/XLSX.
- RPT-001-D: ekspor menulis tepat satu audit `reports.hr.exported` dengan jumlah baris yang benar dan tanpa nama/NIP.
- RPT-001-E: tidak ada kolom NIK, rekening, alamat, telepon, email, atau nominal di respons maupun file.
- RPT-001-F: ekspor di atas batas → 422 tanpa audit dan tanpa file.
- RPT-001-G: `pageSize` > 100 → 400; periode > 366 hari → 400.
- RPT-001-H: peran `finance` dan `management` menerima scope `unit`; `/auth/me` memuat `unitPermissions` untuk penugasan unit.
