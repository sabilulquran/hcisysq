# Ringkas layar Kehadiran pegawai (`/app/attendance`)

**Spec ID:** UI-TYPE-001 (lanjutan), ATT-014 §6.5c
**Tanggal:** 26 November 2026
**Basis:** rilis `6694a49e` — kode yang dilaporkan pengguna masih bertumpuk di produksi.
**Status kode:** cabang `feat/kehadiran-ringkas`, PR sabilulquran/hcisysq#426.

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

### 4a. Uji browser, 27 November 2026

Chromium 158 headless terhadap dev server loopback dengan fixture sintetis
(`apps/web/uji/attendance-fixture.mjs`, lihat §6). Setiap baris di bawah adalah langkah yang
lulus; langkah yang gagal menghentikan skenario, jadi tidak ada klaim tanpa bukti.

| Yang diuji | Ukuran | Hasil |
|---|---|---|
| Satu tombol Clock In/Out, satu Tukar Shift, tanpa baris lima tombol | 1440 | lulus — pohon aksesibilitas hanya memuat satu tautan tiap tujuan |
| Blok Hari Ini (status, jadwal, Masuk, Keluar) + grup "Rincian hari ini" | 1440 | lulus |
| Tabel riwayat 7 baris, "Menampilkan 1–7 dari 30", pager 1/5 | 1440 | lulus |
| Tabel desktop tampil, daftar HP tersembunyi | 768 | lulus |
| Daftar HP satu tombol per hari (tanggal, jam scan, status) | 375 | lulus |
| Keyboard: ArrowRight Riwayat→Jadwal→Pengajuan, Home kembali ke Riwayat | 375 | lulus, alamat ikut `#jadwal` / `#pengajuan` / kosong |
| Pager: Berikutnya → "Menampilkan 8–14 dari 30", 2/5 | 375 | lulus |
| `#overtime` → tab Pengajuan **dengan formulir lembur terbuka** | 1440 | lulus |
| `#clarifications` → tab Pengajuan, bagian Klarifikasi tampak, formulir lembur **tetap tertutup** | 1440 | lulus |
| `?transaksi=2026-11-24` → dialog hari dari tautan langsung | 375 | lulus |
| Dialog hari → "Ajukan klarifikasi" → `?klarifikasi=2026-11-24`, alasan "Keterlambatan" terpilih | 375 | lulus |
| Alur lembur: Ajukan lembur → isi 45 menit → Kirim → "Pengajuan lembur dikirim ke atasan Anda" | 768 | lulus |
| Keadaan kosong: tanpa tabel, "Belum ada hari yang tercatat", Jadwal "belum tersedia" | 375 | lulus |
| Keadaan error: banner "Scan terbaru tidak dapat dimuat", riwayat tetap terbaca | 375 | lulus |
| Keadaan loading: Segarkan scan nonaktif dengan pemutar, riwayat tetap terbaca | 375 | lulus |
| Scan sebelum kalkulasi ("Belum dihitung") dan sesudah ("Ada scan baru") | 1440/375 | lulus, terbaca pada baris 26–27 Nov dan penanda scan baru |

Tidak ada `page-error` pada seluruh skenario.

### 4b. Tangkapan layar, 27 November 2026

Chromium 158, viewport sesungguhnya, data fixture terisi:

| Ukuran | Berkas |
|---|---|
| 375 | [`kehadiran-2026-11-26/sesudah-375.png`](kehadiran-2026-11-26/sesudah-375.png) |
| 768 | [`kehadiran-2026-11-26/sesudah-768.png`](kehadiran-2026-11-26/sesudah-768.png) |
| 1440 | [`kehadiran-2026-11-26/sesudah-1440.png`](kehadiran-2026-11-26/sesudah-1440.png) |

Pada 375 terlihat tanpa menggulir: judul, satu tombol **Clock In/Out**, **Tukar Shift**, blok
Hari Ini, ketiga tab dengan Riwayat terpilih, dan baris riwayat pertama.

### 4c. Verifikasi manual Codex, 27 November 2026

Diperiksa terpisah di browser pada fixture lokal yang sama, dan **menemukan satu cacat label
yang tidak tertangkap uji otomatis** (lihat §4d):

- Rincian hari membuka tanggal yang benar dan menulis query transaksi.
- `#overtime` membuka panel Pengajuan beserta formulirnya; `#clarifications` membuka bagian
  Klarifikasi.
- ArrowRight mengaktifkan tab Jadwal; Enter pada pager memindahkan 1–7 ke 8–14 pada lebar 375,
  tanpa overflow halaman.

### 4d. Cacat label yang diperbaiki

Tombol rincian pada riwayat desktop berbunyi **"Lihat hari ini"** untuk **setiap** baris,
termasuk tanggal lampau — janji yang salah: tombol itu membuka tanggal pada barisnya, bukan hari
ini. Label itu tulisan saya sendiri pada perubahan ini, dan uji otomatis tidak menangkapnya
karena yang diuji perilakunya, bukan maknanya.

Perbaikan: label tampak menjadi **"Lihat rincian"** (jumlah scan tetap, mis. "Lihat rincian (2)"),
dan nama aksesibelnya menyebut tanggalnya — `historyDetailLabel()`, mis.
*"Lihat rincian Rab, 25 Nov 2026, 2 scan"*. Nama itu tetap memuat label yang terlihat
(WCAG 2.5.3). Dialog dan hitungan scan tidak diubah.

Terbukti di browser pada 1440: tidak ada lagi tombol `Lihat hari ini`; menekan
*"Lihat rincian Rab, 25 Nov 2026, 2 scan"* mengubah alamat menjadi `?transaksi=2026-11-25` dan
membuka dialog berjudul **Rab, 25 Nov 2026** — bukan 27 Nov, tanggal hari itu. Tiga test baru
mengunci maknanya di `EmployeeAttendanceLayout.test.tsx`.

Satu hal yang **bukan** cacat dan sengaja dipertahankan: hari berstatus "Hadir" tidak menawarkan
"Ajukan klarifikasi". Itu aturan `canClarifyDate` — hanya hari terlambat, belum lengkap, atau
tidak hadir, dan paling lama 7 hari ke belakang.

Tujuh test baru di `EmployeeAttendanceLayout.test.tsx` mengunci: pemetaan hash→tab untuk
`#overtime`, `#clarifications`, `#jadwal`, dan hash tak dikenal; alamat yang ditulis tiap tab;
tablist dengan `role`, `aria-selected`, roving `tabindex`, dan cincin fokus; panel yang
disembunyikan dan `aria-labelledby`-nya; serta halaman riwayat 7 hari (30 baris → 5 halaman,
halaman terakhir 29–30). `AttendanceDiscovery.test.tsx` diperbarui: baris layanan hilang di
`/app/attendance` **tanpa** kehilangan tautan Clock In/Out dan Tukar Shift.

## 5. Yang belum terbukti

| Belum ada | Alasan |
|---|---|
| Tangkapan "sebelum" | Yang dibandingkan adalah sumber rilis `6694a49e` (§1), bukan gambar layar lama. |
| Uji dengan basis data sungguhan | Basis data uji berada di luar direktori kerja sesi ini. Fixture memakai kontrak API yang sama, tetapi tidak membuktikan perilaku server. |
| Pembacaan oleh pembaca layar sungguhan | Peran dan nama diperiksa dari pohon aksesibilitas, bukan dari NVDA/VoiceOver. |

## 6. Fixture uji

`apps/web/uji/attendance-fixture.mjs` dipasang sebagai middleware dev **hanya** bila
`UJI_KEHADIRAN=1` atau penanda lokal `apps/web/uji/aktif` ada. Saat aktif, dev server mengikat ke
`127.0.0.1` dan proxy ke API sungguhan dihapus, sehingga server itu tidak dapat menyentuh backend
mana pun. Tidak pernah ikut ke hasil build; `uji/aktif` tidak di-commit.

Cara memakai: `npm run dev:web` dari worktree, lalu buka
`http://127.0.0.1:5173/app/attendance`. Mode lewat `?uji=` pada halaman: `terisi` (bawaan),
`kosong`, `error`, `lambat`. Mode diingat server sampai diganti. Seluruh angkanya karangan —
tidak ada data production, tidak ada panggilan keluar dari mesin.
