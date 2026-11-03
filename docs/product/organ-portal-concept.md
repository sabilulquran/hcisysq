# GOV-001 — Portal Organ Yayasan (konsep)

**Status:** DRAFT. Diskusi owner 2026-11-03. Belum menjadi ADR. Bila diterima, konsep ini menggantikan SQ Hub ADR-0009 "Ringkasan Yayasan" untuk pintu masuk organ, dan ADR penggantinya ditulis di repository portal.
**Related:** ORG-003, ORG-010, ORG-013 (`../domain/organ-account-approver.md`), SQ Hub ADR-0009 dan HUB-IMPL-021

## Gagasan

Organ Yayasan (Pembina, Pengurus, Pengawas; sekarang sekitar 6–7 orang, jumlahnya berubah per masa jabatan) tidak memakai modul seperti pegawai. Mereka melihat laporan dan memutuskan hal yang menjadi kewenangannya. Untuk itu mereka mendapat satu aplikasi sendiri di **`organ.sabilulquran.or.id`**, dengan login Akun SQ dan verifikasi dua langkah.

## Keputusan owner (2026-11-03)

| # | Keputusan |
|---|---|
| 1 | Aplikasi terpisah di `organ.sabilulquran.or.id` (opsi C). |
| 2 | Organ yayasan tidak mengakses modul secara langsung, hanya portal. |
| 3 | Pengecualian: Pengurus bergaji yang tercatat sebagai Employee tetap memakai layanan pegawai HCIS (cuti sendiri, presensi, slip gaji pribadi). |
| 4 | **Tampilan approval ada di portal. Mesin approval tetap di aplikasi asal** (HCIS, Karir SQ). |
| 5 | Akun Organ Yayasan boleh menjadi approver (ORG-013). |
| 6 | Tidak ada aturan approval baru. Alur yang dipakai adalah yang sudah ada: cuti Direktur (LEAVE-003-N) dan persetujuan akhir MPP bila Direktur kosong (Karir SQ REC-IMPL-006). |
| 7 | Laporan bersifat visual dan dibantu analisis Claude API. |
| 8 | Laporan bulanan dibuat otomatis setelah data sumber di masing-masing modul sudah disubmit atau disetujui. |

## Fungsi

### 1. Dasbor

Kartu dan grafik per aplikasi, dengan angka yang dimiliki aplikasi asal (prinsip ADR-0009 dan kontrak HUB-IMPL-021). Portal tidak menyimpan salinan data domain.

| Laporan | Grafik | Sumber | Status data |
|---|---|---|---|
| Pegawai aktif, masuk, keluar per bulan | Tren | HCIS | Ada |
| Sebaran pegawai per unit | Ranking | HCIS | Ada |
| Komposisi status kepegawaian | Composition (donut hanya bila ≤ 4 bagian) | HCIS | Ada |
| Kesiapan organisasi (unit tanpa approver, pegawai tanpa atasan) | Angka + "Perlu perhatian" | HCIS | Ada |
| Antrean persetujuan organ dan umurnya | Daftar | HCIS, Karir SQ | Setelah ORG-013 |
| Kebutuhan tenaga → lowongan → diterima | Stages | Karir SQ | Perlu governance summary |
| Siswa baru vs target per unit | Target | SPMB | Perlu governance summary |
| Nilai dan kondisi aset per unit | Composition | Aset SQ | Perlu governance summary |
| Kehadiran dan biaya gaji agregat | Tren | HCIS | Dilarang sampai semantik dan izinnya ditetapkan (ORG-003-F, ADR-0003) |

### 2. Kotak persetujuan

Menampilkan langkah approval milik orang yang login dari setiap aplikasi asal, dan meneruskan keputusannya ke aplikasi itu atas nama orang tersebut (token exchange). Aplikasi asal yang mencatat state, audit, dan notifikasi.

Untuk organ yang juga pegawai (misalnya Ketua yang merangkap Direktur), targetnya semua langkah approval miliknya tampil di portal, dan kotak approval HCIS untuk orang itu diganti tautan ke portal (`DRAFT`). Keputusan lewat portal membutuhkan jalur token exchange untuk mutasi, yang masih `TBD` (ORG-013-3). Sampai jalur itu ada, keputusan tetap memakai sesi cookie HCIS.

### 3. Laporan bulanan otomatis

- Setiap aplikasi menetapkan sendiri kapan bulannya **tutup**, yaitu saat data sumbernya sudah disubmit atau disetujui. Contoh (`DRAFT`): HCIS memakai periode payroll bulan itu yang mencapai `APPROVED`. Penanda ini diekspos hanya sebagai boolean "bulan final", tanpa ID periode atau nominal, sehingga batas payroll ADR-0003 tidak tersentuh. Karir SQ, SPMB, dan Aset SQ menetapkan penandanya di spesifikasi masing-masing.
- Saat penanda tutup tercapai, aplikasi asal menerbitkan **snapshot ringkasan bulan itu** (angka agregat, versi kontrak, waktu terbit). Snapshot tidak berubah. Bila periode dibuka ulang dan ditutup lagi, terbit revisi baru yang menyebut revisi sebelumnya.
- Portal menyusun laporan bulanan dari snapshot yang sudah terbit. Bagian dari aplikasi yang belum tutup ditandai "Belum final", bukan diisi angka sementara.
- Organ mendapat notifikasi saat laporan bulan itu lengkap.
- Laporan bisa diunduh sebagai PDF untuk arsip rapat.

### 4. Catatan analisis (Claude API)

- Kotak "Catatan analisis" berisi 3–5 poin dalam bahasa biasa, di dasbor dan di laporan bulanan.
- Masukan ke Claude hanya **angka agregat yang sudah tampil**. Tidak ada nama, identitas, atau baris per orang. Batas privasinya sama dengan dasbor. Antrean persetujuan hanya dikirim sebagai jumlah dan umur.
- Setiap poin wajib merujuk angka di grafik. Poin tanpa rujukan dibuang sebelum ditampilkan.
- Teks diberi label "dibuat AI", disimpan bersama laporan bulanan, dan tidak dihitung ulang diam-diam.
- Tahap lanjut: organ bisa bertanya tentang dasbor, dan jawabannya tetap hanya dari data agregat.

### 5. Arsip keputusan

Riwayat keputusan organ dari kotak persetujuan: apa, siapa, kapan, dan alasannya. Data diambil dari audit aplikasi asal.

## Prasyarat

1. ORG-004 `STRUCTURE` aktif untuk workflow cuti (masih `LEGACY` per 2026-11-03).
2. ORG-013 diimplementasikan.
3. Jabatan Pembina, Bendahara, dan Pengawas ditambahkan ke bagan.
4. Karir SQ, SPMB, dan Aset SQ menerbitkan governance summary dan penanda tutup bulan.
5. Client Keycloak untuk portal dan konfigurasi token exchange.

## Pertanyaan terbuka

- Keputusan kolektif (rapat atau sirkuler) belum ada di workflow mana pun. Sampai ada spesifikasinya, semua keputusan organ bersifat perorangan.
- Penanda tutup bulan untuk aplikasi selain HCIS.
- Repository dan stack portal.
