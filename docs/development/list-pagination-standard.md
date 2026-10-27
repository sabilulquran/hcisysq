# ENG-LIST-001 — Standar daftar panjang dan pagination SQ Core

**Status:** BERLAKU untuk HCIS sejak 26 Oktober 2026 (diusulkan 24 Oktober, di-merge lewat
sabilulquran/hcisysq#162). Penerapan ke repository SQ Core lain (SQ Hub, Aset SQ, Karir SQ, SPMB SQ,
Keluarga SQ) memerlukan PR terpisah di repository masing-masing.

**Dasar:** audit [list-pagination-audit-2026-10-24.md](list-pagination-audit-2026-10-24.md). Owner menemukan
layar yang menampilkan ratusan baris sekaligus tanpa pagination; audit juga menemukan daftar yang memotong data
tanpa pemberitahuan (contoh: SPMB "Riwayat PPDB lama" hanya menampilkan 500 dari 863 arsip di production).

## 1. Istilah

| Istilah | Arti |
|---|---|
| **Data bertumbuh** | Data yang jumlahnya naik seiring waktu atau transaksi: log, audit event, scan/punch, journal, notifikasi, pesan, pengajuan (cuti, lembur, klarifikasi, tukar shift), riwayat penugasan, baris import, slip gaji, pendaftaran, pelamar, aset. Ukurannya hari ini tidak relevan. |
| **Data terbatas** | Data master/konfigurasi yang dibatasi struktur organisasi dan tidak tumbuh dengan waktu: unit, jabatan, role, permission, mesin absensi, template shift, lokasi kerja, registry aplikasi. Maksimum realistis harus bisa ditulis (≤ 200 baris). Pegawai **bukan** data terbatas untuk keperluan dropdown: 99 aktif dan 330 total di production, terus bertambah karena pegawai resign tetap tersimpan. |
| **Pagination server-side** | API mengembalikan satu halaman dan total/kursor; filter, pencarian, scope otorisasi, dan pengurutan dijalankan di query sebelum `LIMIT`. |
| **Pagination client-side** | API mengembalikan seluruh data, UI membaginya per halaman. |
| **Pemotongan diam-diam** | API atau UI memotong hasil (`LIMIT`, `slice`) tanpa memberi tahu pengguna bahwa ada data lain. |

## 2. Aturan

### 2.1 API

1. **ENG-LIST-001-A — Data bertumbuh wajib server-side.** Setiap endpoint `GET` yang mengembalikan daftar data
   bertumbuh wajib memakai salah satu kontrak di §3. Tidak boleh ada query daftar tanpa `LIMIT` pada tabel yang
   bertumbuh.
2. **ENG-LIST-001-B — Ukuran halaman.** Default `pageSize` 25, maksimum 100. Permintaan di atas maksimum ditolak
   dengan `400` (validasi zod), bukan dipotong diam-diam. Kontrak kursor: default `limit` 50, maksimum 100.
3. **ENG-LIST-001-C — Tidak ada pemotongan diam-diam.** Batas keras (`LIMIT 500` dan sejenisnya) tanpa kontrak
   halaman tidak diizinkan untuk data bertumbuh. Jika batas pengaman tetap diperlukan pada data terbatas, response
   wajib membawa `total` atau `truncated: true` dan UI wajib menampilkan pemberitahuan.
4. **ENG-LIST-001-D — Filter dan otorisasi sebelum `LIMIT`.** Pencarian, filter status/unit/tanggal, dan scope
   otorisasi dijalankan di SQL sebelum `LIMIT/OFFSET`. Dilarang memfilter atau mencari di memori setelah halaman
   diambil (contoh yang dilarang: pencarian audit SQ Hub dan scope aset Aset SQ yang dijalankan setelah `LIMIT`).
5. **ENG-LIST-001-E — Urutan stabil.** Setiap daftar berhalaman memakai `ORDER BY` deterministik dengan tie-breaker
   unik (biasanya `id`), agar baris tidak hilang atau berulang antar halaman.
6. **ENG-LIST-001-F — Angka ringkasan dari agregat.** Jumlah di kartu ringkasan/badge dihitung dengan query agregat
   (`count(*)`, `GROUP BY`), bukan `items.length` dari daftar yang dibatasi.
7. **ENG-LIST-001-G — Daftar terikat rentang tanggal.** Daftar yang dibatasi rentang tanggal boleh tanpa
   pagination hanya jika rentang maksimum ditegakkan API **dan** jumlah baris kasus terburuk ≤ 500
   (contoh: rentang 93 hari × 99 pegawai ≈ 9.200 baris **tidak** memenuhi syarat).
8. **ENG-LIST-001-H — Ekspor.** Ekspor CSV/XLSX tidak tunduk pada ukuran halaman, tetapi wajib lengkap (streaming
   atau job asinkron) atau menolak secara eksplisit dengan pesan "persempit filter". Ekspor yang memakai ulang query
   daftar berbatas (contoh: ekspor SPMB yang ikut terpotong 500) dilarang.

### 2.2 Web

1. **ENG-LIST-001-I — Komponen bersama.** Daftar berhalaman memakai satu komponen bersama
   (`apps/web/src/components/PaginationBar.tsx`, diperluas untuk mode server-side) yang menampilkan
   "Menampilkan 26–50 dari 312", tombol sebelum/berikutnya, dan pilihan ukuran halaman 10/25/50/100.
   Pager inline baru tidak diizinkan.
2. **ENG-LIST-001-J — State di URL.** `page`, `pageSize`, filter, dan pencarian disimpan di query string sehingga
   bisa dibagikan, di-refresh, dan tombol back bekerja. Mengubah filter atau pencarian mengembalikan ke halaman 1.
3. **ENG-LIST-001-K — Pemilihan record (dropdown).** `<select>` biasa hanya untuk data terbatas dengan ≤ 50 opsi.
   Di atas itu, atau untuk data bertumbuh dan pegawai, pakai pencarian typeahead server-side (`q`,
   `pageSize` ≤ 20), mengikuti `components/attendance/workforce/EmployeeSearchField.tsx`. Dilarang mengambil semua
   halaman lalu menggabungkannya ke satu dropdown.
4. **ENG-LIST-001-L — Pagination client-side.** Hanya untuk data terbatas yang seluruhnya ≤ 200 baris. Tidak boleh
   dipakai untuk menutupi API yang mengembalikan seluruh data bertumbuh.
5. **ENG-LIST-001-M — State wajib.** Daftar berhalaman memeriksa loading, empty (termasuk "tidak ada hasil untuk
   filter ini"), error, forbidden, halaman di luar jangkauan, dan tampilan mobile (pager tetap terjangkau di 375 px).

## 3. Kontrak API

### 3.1 Offset (default untuk layar admin)

Pola yang sudah dipakai `GET /admin/employees` (`apps/api/src/modules/employees/admin-routes.ts`):

```http
GET /admin/employees?page=2&pageSize=25&q=...&status=active
```

```json
{
  "items": [],
  "pagination": { "page": 2, "pageSize": 25, "total": 312, "pageCount": 13 }
}
```

- `page` integer ≥ 1, default 1; `pageSize` integer 1–100, default 25. `pageCount` = `ceil(total / pageSize)`,
  minimal 1.
- Implementasi API memakai `apps/api/src/lib/pagination.ts` (`pageQuerySchema`, `pageOffset`, `pagination`);
  komponen OpenAPI `Page`, `PageSize`, dan schema `Pagination`.
- `total` dihitung dengan query `count(*)` yang memakai filter yang sama.
- `page` di atas `pageCount` mengembalikan `items: []` dengan `pagination` yang benar, bukan error.
- Nama parameter memakai bahasa Inggris (`page`, `pageSize`) di semua aplikasi SQ Core, termasuk yang saat ini
  memakai `batas`/`setelah`; migrasi parameter lama dilakukan per paket perbaikan.

### 3.2 Kursor/keyset (untuk log bervolume tinggi yang append-only)

Untuk tabel yang tumbuh ribuan baris per hari (journal/scan ADMS, notifikasi, pesan Kirim) dan selalu dibaca dari
yang terbaru, `OFFSET` makin lambat. Pakai keyset `(waktu, id)`:

```http
GET /admin/attendance/adms/transactions?limit=50&cursor=<opaque>&from=...&to=...
```

```json
{ "items": [], "nextCursor": "eyJ0IjoiMjAyNi0xMC0yNFQwMTowMDowMFoiLCJpZCI6Ii4uLiJ9" }
```

- `limit` 1–100, default 50; `cursor` opaque base64url, terikat ke filter (hash filter di dalam kursor, seperti
  `organization-directory` SQ Hub), ditolak `400` jika filter berubah.
- `nextCursor: null` berarti halaman terakhir. `total` opsional; jika ada, boleh berupa perkiraan dan diberi nama
  `approximateTotal`.
- HCIS `docs/api/openapi.yaml` sudah mendefinisikan parameter `Cursor` yang belum dipakai; paket fondasi
  menyatukannya dengan kontrak ini.

### 3.3 OpenAPI

Paket fondasi menambahkan komponen bersama di `docs/api/openapi.yaml`: parameter `Page`, `PageSize`, `Cursor`,
`Limit`, dan schema `Pagination`/`CursorPage`. Endpoint daftar baru mereferensikan komponen tersebut, tidak menulis
ulang.

## 4. Pengecualian yang diizinkan

Pengecualian harus ditulis di specification fitur dan diklasifikasikan di manifest (§5). Yang diizinkan:

| Pengecualian | Syarat |
|---|---|
| Data master/konfigurasi terbatas (unit, jabatan, role, mesin, template, lokasi) | Maksimum realistis ≤ 200 tertulis; dropdown ≤ 50 opsi, di atasnya typeahead. |
| Kartu ringkasan, dashboard, grafik | Hanya agregat (`GROUP BY`, `count`), bukan baris record. Daftar "top N" boleh dengan N ≤ 10 dan tautan ke daftar lengkap berhalaman. |
| Detail satu entitas dengan anak terbatas domain | Contoh: kontak keluarga (maks 4), langkah approval satu pengajuan, keputusan satu permintaan. Batas domain tertulis. |
| Antrean kerja yang dibatasi status | Contoh: approval `pending`. Boleh tanpa pagination hanya bila ada batas pengaman dan pemberitahuan (§2.1-3); begitu antrean bisa melewati 100, wajib berhalaman. |
| Daftar terikat rentang tanggal | Memenuhi §2.1-7. |
| Endpoint machine-to-machine berbentuk snapshot | Contoh: snapshot `organization-directory`, `governance/summary`. Ditandai sebagai snapshot di kontrak, ukurannya dipantau, tidak dipakai layar manusia. |
| Ekspor | Memenuhi §2.1-8. |

Daftar yang menyimpang hari ini dicatat sebagai utang di dokumen audit dan diperbaiki melalui paket berprioritas;
penyimpangan itu bukan preseden.

## 5. Penegakan

1. **Quality gate `AGENTS.md` §7** (usulan dalam PR ini): setiap daftar baru atau yang diubah mengikuti ENG-LIST-001.
2. **PR template**: checklist "Daftar/dropdown baru mengikuti ENG-LIST-001" pada bagian Verification.
3. **Helper bersama** (PAG-0, sudah ada): `apps/api/src/lib/pagination.ts` untuk kontrak offset; `GET /admin/employees`
   sudah memakainya. Helper kursor ditambahkan bersama konsumen pertamanya (PAG-3). Di web, `PaginationBar`
   sudah menerima `page/pageSize/total` dari server; hook yang mengikat state halaman ke URL ditambahkan bersama layar
   pertama yang memakainya (PAG-1), bukan sebagai kode tanpa pemakai.
4. **Test klasifikasi route** (PAG-0, sudah berjalan): `docs/development/list-endpoint-classification.json`
   mengklasifikasikan **setiap** rute `GET` yang terdaftar di `createApp` sebagai `paged`, `typeahead`, `range`,
   `bounded`, `aggregate`, `single`, `export`, `snapshot`, atau `debt`. `apps/api/test/list-endpoint-classification.test.ts`
   gagal jika ada rute `GET` baru tanpa klasifikasi, jika pengecualian tanpa alasan, atau jika pelanggaran (`debt`)
   tanpa paket PAG. Jumlah `debt` dipatok (56 pada 26 Oktober 2026, 51 setelah PAG-4 pada 27 Oktober) sehingga hanya boleh turun; menambahnya butuh
   pengecualian yang disetujui owner. File klasifikasi terpisah dari manifest AUTH-011 agar perubahan pagination tidak
   menyentuh berkas izin.
5. **Test per endpoint**: endpoint berhalaman memiliki test untuk halaman kedua, halaman di luar jangkauan,
   filter + `total`, dan urutan stabil (data sintetis).
6. **Review**: reviewer memeriksa `LIMIT` tanpa kontrak halaman, `.slice(` pada array dari API, dan `<select>` yang
   diisi daftar pegawai/data bertumbuh.

## 6. Status dan langkah berikut

- PAG-0 (fondasi) selesai: helper offset, komponen OpenAPI, dan test klasifikasi. PAG-2 (SPMB) selesai di
  sabilulquran/spmb-sq#32 (commit 9854c8a).
- Paket perbaikan berikutnya ada di dokumen audit §5. Setiap paket menurunkan angka `debt` yang dipatok.
- Untuk SQ Hub dan Aset SQ (yang memiliki `AGENTS.md`) serta Karir/SPMB/Keluarga SQ, aturan yang sama diusulkan
  lewat PR dokumentasi terpisah di masing-masing repository setelah owner menyetujui versi HCIS.
