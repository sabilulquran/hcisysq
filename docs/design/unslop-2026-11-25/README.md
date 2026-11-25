# UI-TYPE-001 — Pemeriksaan desain seluruh halaman HCIS (25 November 2026)

**Status:** SELESAI, menunggu tinjauan. Branch `design/unslop-web-ui`, basis `c360d1bb`.

Pemeriksaan desain seluruh rute web HCIS memakai skill `unslop`, diminta owner pada 25 November 2026:
ukuran font dan hierarki teks, tata letak responsif, dan pagination. URL, hak akses, fitur, alur
bisnis, dan perilaku data tidak diubah.

## 1. Hasil audit: mode polish, bukan rancang ulang

HCIS sudah memakai sistem desain nyata (SQ-Hub direction C): satu ramp netral bernuansa, satu aksen
teal, Inter, token semantik dan kategori, tema terang/gelap, dan aturan cetak. Tanda-tanda khas UI
"vibecoded" yang dicari `unslop` **tidak ditemukan**: tidak ada emoji di antarmuka, tidak ada
gradien warna pada permukaan, tidak ada teks bergradien, tidak ada glow atau bayangan berwarna,
tidak ada `animate-pulse`/`animate-ping`/`hover:scale`.

Karena itu arah desain tidak diganti. Logo, aset identitas, keluarga font, palet, warna status, dan
tema dipertahankan apa adanya, sesuai permintaan owner.

Yang ditemukan dan diperbaiki:

| # | Temuan | Jumlah | Di mana |
|---|---|---|---|
| 1 | Label HURUF BESAR dengan tracking lebar | 115 titik di 77 berkas | label bagian, eyebrow, kepala tabel |
| 2 | Nilai tracking berbeda-beda | 12 nilai (0,08em–0,18em) | label dan judul |
| 3 | Dua ukuran mengerjakan semua tugas | `text-sm` 2.216 + `text-xs` 1.805 = 94% seluruh teks | seluruh aplikasi |
| 4 | Ukuran lepas di bawah skala | `text-[11px]` 273, `text-[10px]` 80, `text-[9px]` 1 | metadata, lencana, tab HP |
| 5 | Teks di bawah 11px | 81 titik | tab bawah HP, lencana hitung |
| 6 | Hierarki dibawa ketebalan huruf | `font-bold` 1.384 + `font-extrabold` 17 lawan `font-medium` 58 | judul, label, penekanan |
| 7 | Pager inline, bukan komponen bersama | 9 pager di 6 berkas | melanggar ENG-LIST-001-I |
| 8 | Label menu terpotong | rail 248px | "Sertifikat Akan Ber…", "Dokumen Kepegaw…" |
| 9 | Slot logo 216px ≠ rail 248px | 1 | kepala halaman tidak segaris dengan rail |
| 10 | Meluber mendatar di 375px | 2 halaman | parity ADMS, Penghargaan |

## 2. Perubahan

### 2.1 Tipografi dan hierarki

`apps/web/src/styles.css` sekarang mendeklarasikan skalanya, bukan mewarisi bawaan Tailwind:

- `text-2xs` **11px** menjadi lantai. Tidak ada lagi teks di bawah itu; tab bawah HP dan lencana
  hitung sebelumnya 9–10px.
- `line-height` `text-xs` dan `text-sm` dilonggarkan (18px dan 22px) supaya metadata dua baris dan
  teks isi tidak sesak.
- Bobot dipetakan ulang: `semibold` 560 dan `bold` 640, memakai Inter sebagai variable font. Satu
  perubahan ini menenangkan 2.535 titik pemanggilan yang ada tanpa mengubah elemen mana yang
  ditekankan — hierarki kembali dibawa ukuran dan warna, bukan tebal huruf.
- Satu utilitas `sq-eyebrow` menggantikan 115 varian label bagian (sentence case, 11px, bobot 560,
  tanpa tracking). Warna tetap ditentukan di tempat pemakaian.
- 296 ukuran lepas turun ke skala. Judul halaman `sm:text-[1.75rem]` dan display auth
  `sm:text-[2.15rem]` ikut ke `sm:text-3xl` / `sm:text-4xl`.
- Dokumen cetak (slip gaji, SK, kartu) **tidak disentuh**: ukuran `pt` dan gaya kertasnya memang
  tipografi cetak, bukan antarmuka.

### 2.2 Tata letak

- Lebar rail navigasi menjadi satu token `--spacing-sidebar` (17rem / 272px) yang dipakai sidebar,
  padding konten, dan slot logo. Ketiganya kini segaris, dan label menu panjang tidak terpotong.
- Label menu memakai bobot 500. Baris aktif ditandai permukaan dan warna, bukan huruf tebal.
- Dua halaman yang meluber mendatar di 375px diperbaiki: frasa perintah mono pada parity ADMS
  (`SYNC TIME …`, `UPSERT USER …`) dan template CSV pada Penghargaan kini memecah baris.
- Ubin akses cepat di beranda HP diberi ruang sedikit lebih lebar supaya "Clock In/Out" tetap satu
  baris pada ukuran huruf 11px yang baru.

### 2.3 Pagination (ENG-LIST-001)

`PaginationBar` dipakai ulang di seluruh 9 pager inline yang tersisa — Data Pegawai, Lembur Tim,
Aturan Lembur (daftar dan riwayat), Planner Jadwal (kalender dan riwayat), Unscheduled (pegawai dan
PIN), dan Struktur Organisasi. Tidak ada lagi pager inline di `apps/web`.

Pager bersamanya diperbaiki:

- tombol **halaman pertama** dan **halaman terakhir**, sehingga halaman terakhir terjangkau tanpa
  menekan "Berikutnya" berulang kali;
- target sentuh 40px (sebelumnya 32px), supaya tetap terjangkau di 375px — ENG-LIST-001-M;
- angka memakai `tabular-nums`, ringkasan "Menampilkan 51–68 dari 68" diumumkan `aria-live`;
- **halaman di luar jangkauan kembali ke halaman terakhir yang ada**. Inilah kasus "baris terakhir
  pada suatu halaman dihapus": sebelumnya daftar menampilkan tabel kosong di bawah nomor halaman
  yang sudah tidak berarti.
- Data Pegawai kini punya pilihan jumlah per halaman 10/25/50/100 (ENG-LIST-001-B); sebelumnya
  terkunci di 25.

Aritmetika pager dipisahkan menjadi fungsi murni `paginationView()` dan diuji di
`apps/web/src/components/PaginationBar.test.tsx` (8 test), termasuk kasus halaman di luar jangkauan.

## 3. Bukti uji

Semua dijalankan di worktree ini pada 25 November 2026.

| Gate | Hasil |
|---|---|
| `npm run typecheck:web` | lulus |
| `npm run lint:web` | lulus (0 error, 63 warning yang sudah ada sebelumnya) |
| `npm run test:web` | **760 test lulus**, 102 berkas (naik dari 752; 8 test pager baru) |
| `npm run build:web` | lulus |
| `npm run typecheck:api` / `lint:api` / `build:api` | lulus |

`npm run test:api` tidak dijalankan: tidak ada kode API yang berubah pada branch ini. CI tetap
menjalankannya.

### Lingkungan uji

API dan web lokal dengan PostgreSQL sendiri, basis data `hcis_ui` berisi data sintetis: 8 unit, 68
pegawai (58 aktif, 6 tidak aktif, 4 keluar), 34 pengajuan cuti, 45 slip gaji, 3 pengumuman, 1 mesin
fingerprint, dan satu periode payroll. Empat akun uji: Human Capital (peran lengkap), pegawai biasa,
kepala unit, dan Organ Yayasan. Tidak ada data production yang dipakai.

### Alur yang diuji ulang setelah perubahan tata letak

- **Login** — berhasil pada akun HC dan akun Organ Yayasan; logout dan login ulang berjalan.
- **Pencarian dan filter** — mencari di Data Pegawai, memfilter status, dan mengganti unit.
- **Pindah halaman** — halaman 1 → 2 → terakhir → pertama; filter diterapkan saat berada di
  halaman 2 mengembalikan ke halaman 1 dan jumlahnya ikut menyesuaikan (68 → 4 untuk status
  "Keluar"); ukuran halaman 10 menghasilkan 7 halaman dengan halaman terakhir berisi 8 baris;
  pencarian tanpa hasil menampilkan keadaan kosong tanpa pager.
- **Pengajuan dan persetujuan** — layar alur bertahap Cuti & Izin, Persetujuan, dan antrean HC
  dibuka dan diperiksa tata letaknya; tidak ada pengajuan baru yang dikirim.

### Pemeriksaan otomatis per rute

Setiap rute dibuka di browser pada 1440px dan 375px, lalu diperiksa di dalam halaman: lebar gulir
dokumen (meluber mendatar), ukuran huruf terkecil yang terlihat, sisa label HURUF BESAR
ber-tracking, dan elemen yang keluar dari viewport. Hasil akhir: **0 rute meluber mendatar, 0 teks
di bawah 11px, 0 label ber-tracking** (kecuali dokumen cetak yang memang dikecualikan).

## 4. Tangkapan layar

| Layar | Sebelum | Sesudah |
|---|---|---|
| Data Pegawai, desktop 1440px | [sebelum](sebelum-pegawai-desktop.jpg) | [sesudah](sesudah-pegawai-desktop.jpg) |
| Data Pegawai, HP 375px | [sebelum](sebelum-pegawai-hp.jpg) | [sesudah](sesudah-pegawai-hp.jpg) |
| Beranda pegawai, desktop | [sebelum](sebelum-beranda-desktop.jpg) | [sesudah](sesudah-beranda-desktop.jpg) |
| Beranda pegawai, HP | [sebelum](sebelum-beranda-hp.jpg) | [sesudah](sesudah-beranda-hp.jpg) |
| Cuti & Izin (alur bertahap), desktop | [sebelum](sebelum-cuti-desktop.jpg) | [sesudah](sesudah-cuti-desktop.jpg) |
| Portal Organ `/board`, desktop | — | [sesudah](sesudah-board-desktop.jpg) |

Tangkapan "sebelum" diambil dari worktree pada commit basis `c360d1bb` yang dijalankan berdampingan
dengan versi baru terhadap basis data yang sama, sehingga isinya identik dan hanya desainnya berbeda.

Data Pegawai pada HP hampir tidak berubah — tata letak HP-nya memang sudah benar. Itu hasil yang
diharapkan: yang diperbaiki hanya yang bermasalah.

## 5. Inventaris rute

110 rute halaman dan 14 pengalihan lama, dihitung ulang dari `apps/web/src/router.tsx` pada
`c360d1bb` — sama dengan patokan audit sebelumnya.

Arti status:

- **Diperbarui** — berkas halamannya ikut berubah pada branch ini, lalu dibuka dan diperiksa.
- **Diperiksa, sesuai** — hanya menerima perubahan lapisan bersama (skala tipografi, shell, pager);
  dibuka dan diperiksa pada 1440px dan 375px, tidak ada temuan.
- **Sebagian** — dibuka, tetapi ada keadaan layar yang belum bisa diperiksa; alasannya ditulis.

Ringkasan: **78 diperbarui, 28 diperiksa dan sudah sesuai, 4 sebagian**. Tidak ada rute yang tidak
dibuka.

| Rute | Status | Catatan |
|---|---|---|
| `/` | Diperbarui |  |
| `/activate` | Diperbarui |  |
| `/admin` | Diperiksa, sesuai |  |
| `/admin/access` | Diperbarui |  |
| `/admin/announcements` | Diperbarui |  |
| `/admin/attendance` | Diperiksa, sesuai |  |
| `/admin/attendance/action-queue` | Diperiksa, sesuai |  |
| `/admin/attendance/adms` | Diperiksa, sesuai |  |
| `/admin/attendance/adms/audit` | Diperiksa, sesuai |  |
| `/admin/attendance/adms/health` | Diperiksa, sesuai |  |
| `/admin/attendance/adms/jobs` | Diperbarui |  |
| `/admin/attendance/adms/transactions` | Diperiksa, sesuai |  |
| `/admin/attendance/adms/users` | Diperbarui |  |
| `/admin/attendance/arrangements` | Diperbarui |  |
| `/admin/attendance/corrections` | Diperiksa, sesuai |  |
| `/admin/attendance/daily` | Diperiksa, sesuai |  |
| `/admin/attendance/devices` | Diperbarui |  |
| `/admin/attendance/devices/$deviceId` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/biometrics` | Sebagian | Dibuka; menampilkan status terkunci karena `BIOMETRIC_COLLECTION_ENABLED=0` di lingkungan uji. Layar isinya belum diperiksa. |
| `/admin/attendance/devices/$deviceId/commands` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/data` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/diagnostics` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/maintenance` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/operations` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/settings` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/transactions` | Diperiksa, sesuai |  |
| `/admin/attendance/devices/$deviceId/users` | Diperiksa, sesuai |  |
| `/admin/attendance/overtime` | Diperiksa, sesuai |  |
| `/admin/attendance/reports` | Diperbarui |  |
| `/admin/attendance/reports/print` | Sebagian | Dibuka; halaman cetak kosong tanpa parameter laporan. Tata letak cetaknya belum diperiksa dengan laporan nyata. |
| `/admin/attendance/schedules` | Diperbarui |  |
| `/admin/attendance/schedules/calendar` | Diperbarui |  |
| `/admin/attendance/schedules/dates` | Diperbarui |  |
| `/admin/attendance/schedules/swaps` | Diperbarui |  |
| `/admin/attendance/settings/locations` | Diperbarui |  |
| `/admin/attendance/settings/overtime-rules` | Diperbarui |  |
| `/admin/attendance/shifts` | Diperbarui |  |
| `/admin/committees` | Diperbarui |  |
| `/admin/decision-documents` | Diperiksa, sesuai |  |
| `/admin/documents` | Diperbarui |  |
| `/admin/employee-cards` | Diperbarui |  |
| `/admin/employee-cards/print` | Diperiksa, sesuai | Dibuka; antrean cetak kosong karena belum ada kartu yang diterbitkan di data uji. |
| `/admin/employee-documents` | Diperbarui |  |
| `/admin/employees` | Diperbarui |  |
| `/admin/employees/$employeeId` | Diperiksa, sesuai | Diperiksa dengan satu pegawai uji. |
| `/admin/employees/certificates/expiring` | Diperbarui |  |
| `/admin/employees/data-changes` | Diperiksa, sesuai |  |
| `/admin/employees/import` | Diperbarui |  |
| `/admin/employees/imports` | Diperbarui |  |
| `/admin/employment/consistency` | Diperiksa, sesuai |  |
| `/admin/help` | Diperbarui |  |
| `/admin/job-classifications` | Diperbarui |  |
| `/admin/leave` | Diperbarui |  |
| `/admin/leave/calendar` | Diperbarui |  |
| `/admin/leave/critical-periods` | Diperbarui |  |
| `/admin/letters` | Diperiksa, sesuai |  |
| `/admin/loans` | Diperbarui |  |
| `/admin/organization` | Diperbarui |  |
| `/admin/payroll` | Diperiksa, sesuai |  |
| `/admin/payroll/$periodId` | Diperbarui | Diperiksa dengan satu periode payroll uji (2026-10). |
| `/admin/payroll/pph21-annual` | Diperiksa, sesuai |  |
| `/admin/payroll/reference` | Diperbarui |  |
| `/admin/payslips` | Diperbarui |  |
| `/admin/performance` | Diperbarui |  |
| `/admin/reimbursements` | Diperbarui |  |
| `/admin/reports` | Diperbarui |  |
| `/admin/rewards` | Diperbarui |  |
| `/admin/services` | Diperbarui |  |
| `/admin/services/$serviceKey` | Diperbarui | Diperiksa dengan `payroll`: mengalihkan ke /admin/payroll sesuai katalog modul. |
| `/admin/training` | Diperbarui |  |
| `/admin/trip-advances` | Diperbarui |  |
| `/admin/trips` | Diperbarui |  |
| `/app` | Diperbarui |  |
| `/app/announcements` | Diperbarui |  |
| `/app/approvals` | Diperbarui |  |
| `/app/attendance` | Diperbarui |  |
| `/app/attendance-resolution` | Diperbarui |  |
| `/app/attendance/arrangements` | Diperbarui |  |
| `/app/attendance/clock` | Diperbarui |  |
| `/app/attendance/shift-swap` | Diperbarui |  |
| `/app/attendance/team-overtime` | Diperbarui |  |
| `/app/calendar` | Diperbarui |  |
| `/app/committees` | Diperbarui |  |
| `/app/documents` | Diperbarui |  |
| `/app/employee-card` | Diperbarui |  |
| `/app/hc/attendance-resolution` | Diperbarui |  |
| `/app/hc/leave` | Diperbarui |  |
| `/app/hc/planned-leave` | Diperbarui |  |
| `/app/help` | Diperbarui |  |
| `/app/leave` | Diperbarui |  |
| `/app/leave/annual` | Diperbarui |  |
| `/app/leave/planned` | Diperbarui |  |
| `/app/leave/special` | Diperbarui |  |
| `/app/letters` | Diperbarui |  |
| `/app/loans` | Diperbarui |  |
| `/app/my-data` | Diperiksa, sesuai |  |
| `/app/notifications` | Diperbarui |  |
| `/app/payslips` | Diperbarui |  |
| `/app/performance` | Diperbarui |  |
| `/app/reimbursements` | Diperbarui |  |
| `/app/rewards` | Diperbarui |  |
| `/app/services` | Diperbarui |  |
| `/app/services/$serviceKey` | Diperbarui | Diperiksa dengan `quran`. |
| `/app/services/assets` | Diperbarui |  |
| `/app/training` | Diperbarui |  |
| `/app/trip-advances` | Diperbarui |  |
| `/app/trips` | Diperbarui |  |
| `/board` | Diperbarui | Diperiksa dengan akun uji ber-role `foundation_board_viewer`. |
| `/cek/$code` | Sebagian | Diperiksa pada keadaan kode tidak dikenal. Keadaan kartu sah belum diperiksa (butuh data kartu + foto). |
| `/verifikasi/penghargaan/$code` | Sebagian | Diperiksa pada keadaan kode tidak dikenal. Keadaan sertifikat sah belum diperiksa (butuh data penghargaan). |

### Pengalihan lama (14) — semuanya terverifikasi

Diuji di browser; setiap pengalihan mendarat di tujuan yang didokumentasikan di
`apps/web/src/lib/attendanceNavigation.ts` dan merender halaman yang benar.

| Dari | Mendarat di | Halaman |
|---|---|---|
| `/admin/attendance/workforce` | `/admin/attendance` | Waktu & Kehadiran |
| `/admin/attendance/workforce/locations` | `/admin/attendance/settings/locations` | Lokasi kerja |
| `/admin/attendance/workforce/schedules` | `/admin/attendance/shifts` | Shift |
| `/admin/attendance/workforce/assignments` | `/admin/attendance/schedules/calendar` | Jadwal |
| `/admin/attendance/workforce/roster` | `/admin/attendance/schedules/calendar` | Jadwal |
| `/admin/attendance/workforce/clarifications` | `/admin/attendance/corrections` | Perbaikan Absen |
| `/admin/attendance/workforce/mobile` | `/admin/attendance/reports?tab=transactions&source=mobile` | Laporan dan Kalkulasi |
| `/admin/attendance/workforce/overtime` | `/admin/attendance/overtime` | Lembur |
| `/admin/attendance/workforce/shift-swaps` | `/admin/attendance/schedules/swaps` | Tukar shift |
| `/admin/attendance/workforce/reports` | `/admin/attendance/reports` | Laporan dan Kalkulasi |
| `/admin/attendance/settings/recalculate` | `/admin/attendance/reports` | Laporan dan Kalkulasi |
| `/admin/attendance/calculation` | `/admin/attendance/reports` | Laporan dan Kalkulasi |
| `/admin/attendance/clarifications` | `/admin/attendance/corrections` | Perbaikan Absen |
| `/admin/attendance/mobile-evidence` | `/admin/attendance/reports?tab=transactions&source=mobile` | Laporan dan Kalkulasi |

## 6. Yang sengaja tidak diubah

- **Sapaan Islami di beranda pegawai.** Skill `unslop` melarang judul berupa sapaan, tetapi
  "Assalamu'alaikum, <nama>." adalah suara yayasan, bukan basa-basi, dan baris tanggal di atasnya
  sudah menyebut konteks halaman. Mengubahnya keputusan isi, bukan perbaikan desain.
- **Ikon navigasi berwarna per kategori.** Bagian dari sistem token kategori HCIS
  (`--cat-attendance`, `--cat-leave`, dan seterusnya), bukan ikon asal warna.
- **Tipografi dokumen cetak** (slip gaji, SK, kartu pegawai): ukuran `pt` dan gaya kertasnya memang
  dipilih untuk cetak.
- **Lebar isi 1280px (`max-w-7xl`)** dan tinggi baris navigasi 40px: keduanya sudah sesuai untuk
  aplikasi padat yang juga dipakai di HP.

## 7. Yang belum diperiksa

| Hal | Alasan |
|---|---|
| `/admin/attendance/devices/$deviceId/biometrics` | Fitur biometrik mati (`BIOMETRIC_COLLECTION_ENABLED=0`) di lingkungan uji, sehingga yang tampil hanya layar terkunci. |
| Tata letak cetak `/admin/attendance/reports/print` | Perlu parameter laporan nyata; tanpa itu halaman cetaknya kosong. |
| `/cek/$code` dan `/verifikasi/penghargaan/$code` pada kode yang sah | Perlu data kartu pegawai beserta fotonya dan data penghargaan; keduanya rantai data yang belum dibuat di basis data uji. Keadaan "kode tidak dikenal" sudah diperiksa. |
| Tampilan cetak slip gaji dan SK pada kertas | Hanya diperiksa di layar; aturan `@media print` tidak disentuh pada perubahan ini. |
