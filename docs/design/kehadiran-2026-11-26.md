# Ringkas layar Kehadiran pegawai (`/app/attendance`)

**Spec ID:** UI-TYPE-001 (lanjutan), ATT-014 §6.5c
**Tanggal:** 26 November 2026
**Basis:** rilis `6694a49e` — kode yang dilaporkan pengguna masih bertumpuk di produksi.
**Status kode:** belum di-commit. Lihat §5.

## 1. Yang ditemukan di rilis 6694a49e

Dibaca dari sumber rilis, cocok dengan laporan pengguna:

| Hal | Di mana |
|---|---|
| Lima tombol layanan menjajar di atas judul | `AppShell.tsx` memanggil `EmployeeAttendanceNavigation` untuk setiap layar kehadiran |
| Clock In/Out terulang sebagai tombol tersendiri | nav layanan **dan** tombol "Buka Clock In / Out" di badan halaman |
| Ringkasan, formulir Lembur, Jadwal 14 hari, Klarifikasi, Riwayat 30 hari tampil bersamaan | lima `<section>` berurutan, semuanya terbuka |
| Riwayat desktop memaksa tabel 900 px | `min-w-[900px]` pada tabel riwayat |
| Baris HP mengulang tombol | tiap hari membawa "Transaksi" + "Ajukan klarifikasi" |
| Istilah internal terlihat pegawai | "dibaca dari satu hasil kehadiran **canonical**", "Belum ada hasil **materialized**" |

Ringkasan hari ini juga bertingkat: kartu besar berisi empat kartu kecil (Jadwal, Lokasi, Masuk,
Keluar) ditambah blok Sesi kerja.

## 2. Bentuk barunya

- **Satu header**: judul Kehadiran, satu kalimat biasa, satu tombol utama **Clock In/Out**, dan
  **Tukar Shift** di sebelahnya. Baris lima tombol tidak lagi dipasang pada halaman ini; di layar
  kehadiran lain (Clock In/Out, Tukar Shift) baris itu tetap ada sebagai jalan menyeberang.
- **Hari Ini** satu blok datar: status, jam jadwal, scan Masuk dan Keluar. Lokasi, sesi kerja, dan
  hasil kalkulasi masuk ke `<details>` "Rincian hari ini".
- **Tiga tab**: Riwayat (bawaan), Jadwal, Pengajuan. Tab disimpan di hash alamat, jadi tautan
  langsung dan tombol kembali mendarat di tempat yang sama.
- **Riwayat**: daftar ringkas 7 hari per halaman memakai `PaginationBar`, tombol **Segarkan scan**
  tetap di kepalanya. Desktop: Tanggal, Status, Masuk, Keluar, Kerja, satu aksi — tanpa lebar
  paksa 900 px. HP: satu baris = tanggal, status, dan dua jam scan, seluruh barisnya satu tombol
  menuju detail hari. Transaksi, jadwal, menit hasil, dan "Ajukan klarifikasi" ada di detail itu.
- **Jadwal**: dua minggu di tab sendiri.
- **Pengajuan**: Lembur dan Klarifikasi dipisah. Formulir lembur muncul setelah menekan
  **Ajukan lembur**; melihat, membatalkan, dan menjawab perintah atasan tidak berubah.

## 3. Kontrak yang dipertahankan

- `/app/attendance#overtime` → tab Pengajuan dengan formulir lembur terbuka; `#clarifications` →
  tab Pengajuan. Keduanya tautan layanan yang sudah diterbitkan sejak ATT-011 dan diuji di
  `AttendanceDiscovery.test.tsx`.
- `?transaksi=<tanggal>` dan `?klarifikasi=<tanggal>` tetap membuka dialognya, termasuk dari
  tautan langsung dan tombol kembali (`useDialogParam`).
- Scan mentah tetap real-time dengan penyegaran 60 detik dan saat tab kembali terlihat; status,
  menit kerja, telat, dan lembur tetap hanya dari kalkulasi HC. `historyCells()` tidak diubah.
- Tidak ada perubahan API, izin, atau rute.

## 4. Bukti yang ada

`npm run typecheck:web`, `lint:web` (0 error), `test:web` **792 test lulus / 107 berkas**,
`build:web` — semuanya hijau.

Tujuh test baru di `EmployeeAttendanceLayout.test.tsx` mengunci: pemetaan hash→tab untuk
`#overtime`, `#clarifications`, `#jadwal`, dan hash tak dikenal; alamat yang ditulis tiap tab;
tablist dengan `role`, `aria-selected`, roving `tabindex`, dan cincin fokus; panel yang
disembunyikan dan `aria-labelledby`-nya; serta halaman riwayat 7 hari (30 baris → 5 halaman,
halaman terakhir 29–30). `AttendanceDiscovery.test.tsx` diperbarui: baris layanan hilang di
`/app/attendance` **tanpa** kehilangan tautan Clock In/Out dan Tukar Shift.

## 5. Yang belum terbukti, dan penghambatnya

Sesi ini tidak punya izin untuk tiga hal, sehingga bukti berikut **belum ada**:

| Belum ada | Penghambat |
|---|---|
| Tangkapan sebelum/sesudah di 375, 768, 1440 | Alat browser menolak berjalan tanpa persetujuan interaktif |
| Uji keyboard pada tab dan pagination di browser sungguhan | sama |
| Uji alur lembur/klarifikasi ujung ke ujung dengan data | Basis data uji di luar direktori kerja sesi; `pg_ctl`, `curl`, dan variabel lingkungan inline butuh persetujuan |
| Commit, PR, CI, rilis | Operasi tulis git butuh persetujuan |

Yang sudah terbukti hanyalah lewat SSR dan gate repo di §4. Klaim tentang tampilan di tiga
viewport, perilaku keyboard, dan alur ujung ke ujung belum boleh dianggap lulus.
