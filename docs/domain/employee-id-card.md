# Kartu Pegawai

**Status:** ACCEPTED (Paket 1). Owner menyetujui desain gaya B dan paket rekomendasinya di chat pada 2026-11-03. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** EMP-012
**Tanggal:** 2026-11-03
**Terkait:** EMP-005/EMP-006 (fakta kepegawaian), D-10 TRAIN-001 (pola berkas terenkripsi), AUTH-011, ENG-LIST-001, KEL-IMPL-005 (Kartu Siswa Keluarga SQ, satu keluarga desain)
**Rujukan desain:** kanvas mockup `https://claude.ai/artifact/DW9D9mys8Q6bV4XMj7Rg7i` (privat milik owner), kartu lama Canva (`Id Card.pdf`, 50 × 85 mm).

## 1. Tujuan

Kartu identitas pegawai selama ini dibuat manual di Canva, satu per satu. Kartu lama tidak memuat NIP, unit, masa berlaku, atau nomor kartu, dan QR-nya mengarah ke layanan pemendek tautan pihak ketiga yang tidak dapat membuktikan keaslian maupun status pegawai. EMP-012 memindahkan kartu ke HCIS:

- HC mengunggah **pas foto** pegawai, **menerbitkan** kartu bernomor, **mencetak** ke ukuran kartu standar, dan **mengganti** kartu hilang/rusak dengan riwayat lengkap;
- pegawai melihat **kartu digitalnya** di HCIS dan dapat **melaporkan kartu hilang** sehingga kartu itu langsung tidak berlaku;
- siapa pun yang memindai QR membuka **halaman cek keaslian** tanpa login, yang membaca status kartu dan status kepegawaian **saat itu juga**, tanpa menampilkan data pribadi berlebih.

## 2. Batas

Termasuk (Paket 1): pas foto per pegawai, penerbitan kartu, terbit ulang (hilang/rusak/data berubah/habis masa berlaku), pencabutan, laporan hilang oleh pegawai, pengaturan penanda tangan dan masa berlaku, halaman cetak CR80, kartu digital, halaman cek keaslian publik, riwayat dan audit.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Pegawai mengunggah foto sendiri | Keputusan owner: HC yang mengunggah di Paket 1. Unggah mandiri + persetujuan HC menjadi kandidat paket berikut. |
| Foto potong-latar di atas foto gedung (gaya kartu lama, Opsi A) | Owner memilih gaya B (pas foto berlatar polos). |
| Kartu sebagai akses pintu, absensi, atau pembayaran | QR hanya untuk cek keaslian. Presensi tetap memakai ATT-*. |
| Biaya penggantian kartu | Aturan belum ada; Paket 1 tidak mencatat biaya (D-09). |
| Kartu siswa | Milik Keluarga SQ (KEL-IMPL-005); hanya identitas visualnya yang disamakan. |
| Pencetakan langsung ke printer kartu dari server | HC mencetak dari halaman cetak di peramban (printer kartu atau simpan sebagai PDF). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Bentuk:** satu desain untuk kartu cetak dan kartu digital. Ukuran CR80 tegak **54 × 85,6 mm**. Gaya B: latar putih, pita atas toska `#1DA3A4`, pas foto 3:4 di tengah, chip kuning "PEGAWAI", strip bawah kuning `#F2C129`, huruf Inter, logo putih yayasan. Belakang: logo, "Kartu Identitas Pegawai", aturan pemakaian, catatan pengembalian dengan nomor yayasan, nomor kartu dan cetakan, tanda tangan, pita bawah `#117A7B` dengan situs web dan alamat. | ACCEPTED (owner) |
| D-02 | **Isi kartu:** nama lengkap, jabatan, unit, NIP, masa berlaku, QR cek, nomor kartu, cetakan ke-n, tanggal terbit, penanda tangan. **Tidak pernah**: NIK, alamat pegawai, tanggal lahir, nomor kontak pegawai, golongan/gaji. | ACCEPTED (owner) |
| D-03 | **Foto:** diunggah HC. JPEG atau PNG, maks 2 MB, isi diperiksa dari tanda tangan berkas, dienkripsi AES-GCM dengan kunci yang sama dengan bukti cuti/sertifikat pelatihan (pola D-10 TRAIN-001), disimpan di database. Layar memotong ke 3:4 dan mengecilkan ke 600 × 800 piksel sebelum unggah. Satu foto aktif per pegawai; mengganti foto membuat baris baru dan yang lama tetap tersimpan sebagai jejak. Kartu yang sudah terbit memakai foto yang tercatat saat terbit. | ACCEPTED (owner) |
| D-04 | **Masa berlaku** 24 bulan sejak terbit, berakhir di hari terakhir bulan tersebut (contoh: terbit 3 Nov 2026 → berlaku s.d. 30 Nov 2028). Nilainya dapat diubah HC di pengaturan (12–60 bulan) dan hanya berlaku untuk kartu yang terbit sesudahnya. | ACCEPTED (owner: 2 tahun); cara hitung `DRAFT` |
| D-05 | **Penanda tangan:** jabatan default "Ketua Yayasan". Nama dan gambar tanda tangan (PNG transparan, maks 512 KB) diisi HC di pengaturan sekali. Selama nama belum diisi, kartu tidak dapat diterbitkan (409 `EMPLOYEE_CARD_SIGNER_MISSING`). Kartu menyimpan nama dan jabatan penanda tangan saat terbit; gambar tanda tangan dibaca dari pengaturan saat dicetak. | ACCEPTED (owner: Ketua Yayasan); mekanisme `DRAFT` |
| D-06 | **Nomor kartu** `KP-YYMM-NNNN`: `YYMM` bulan terbit (WIB), `NNNN` nomor urut global 4 digit (lebih bila perlu) dari sequence database, tidak pernah didaur ulang. **Cetakan ke-n** dihitung per pegawai. Kartu siswa memakai pola sejajar `KS-YYMM-NNNN`. | DRAFT |
| D-07 | **Kode cek** acak 10 karakter Crockford base32 (50 bit) dari CSPRNG, unik, tidak diturunkan dari NIP atau ID. URL QR `https://hcis.sabilulquran.or.id/cek/<kode>`: origin halaman HCIS yang menampilkan atau mencetak kartu (production: `hcis.sabilulquran.or.id`). Kode ditampilkan berkelompok lima (`7Q2M9-XPA4K`). Kode tidak pernah berubah untuk satu kartu; kartu baru selalu kode baru. | DRAFT |
| D-08 | **Sah** bila, saat dicek: status kartu `ACTIVE`, tanggal hari ini (WIB) ≤ `valid_until`, dan pegawai berstatus aktif. Selain itu **tidak berlaku** dengan alasan: `REPLACED` (sudah diganti), `REPORTED_LOST` (dilaporkan hilang), `REVOKED` (dicabut), `EXPIRED` (lewat masa berlaku), `EMPLOYEE_INACTIVE` (bukan pegawai aktif). | ACCEPTED (owner: status dicek langsung) |
| D-09 | **Penggantian** kartu hilang atau rusak tidak dicatat biayanya. HC menerbitkan ulang dengan alasan `LOST`, `DAMAGED`, `DATA_CHANGED`, atau `EXPIRED`; kartu aktif sebelumnya menjadi `REPLACED` dalam transaksi yang sama. | DRAFT (owner belum menetapkan biaya; default gratis) |
| D-10 | **Laporan hilang oleh pegawai** langsung membuat kartunya `REPORTED_LOST` (tidak berlaku), mencatat audit, dan tampil di layar HC sebagai "perlu terbit ulang". Pegawai tidak dapat membatalkan laporan; HC menerbitkan ulang. | DRAFT |
| D-11 | **Halaman cek publik:** kartu sah menampilkan foto, nama, jabatan, unit (seperti tercetak), nomor kartu dan cetakan, masa berlaku, waktu cek. Kartu tidak berlaku **tidak** menampilkan nama maupun foto, hanya status, alasan, nomor kartu, tanggal tidak berlaku, dan kontak yayasan. Kode tidak dikenal menjawab 404 dengan pesan umum. NIP tidak tampil di halaman cek. | ACCEPTED (owner: kartu tidak berlaku tanpa nama/foto) |
| D-12 | **Pencetak:** HC (`employee_cards.manage`). Halaman cetak berukuran halaman 54 × 85,6 mm, depan lalu belakang per kartu, untuk printer kartu dupleks atau "Simpan sebagai PDF". Setiap kali HC menekan Cetak, setiap kartu dalam batch mencatat `employee_card.printed` dan `print_count` naik. Halaman cetak hanya memuat kartu yang sah hari ini; kartu kedaluwarsa atau milik pegawai tidak aktif dilaporkan sebagai tidak ikut dicetak. | ACCEPTED (owner: HC mencetak) |
| D-13 | **Data kartu dibekukan saat terbit** (nama, NIP, jabatan, unit, foto, penanda tangan) supaya kartu digital, cetak ulang, dan halaman cek sama dengan kartu fisik. Bila data berubah, HC menerbitkan ulang dengan alasan `DATA_CHANGED`. Layar HC menandai kartu yang datanya berbeda dari data kepegawaian saat ini. Teks kosong dianggap tidak ada; nama di atas 200 karakter atau NIP di atas 60 karakter menjawab 409 `EMPLOYEE_CARD_DATA_INVALID` supaya HC memperbaiki data pegawai dulu. | DRAFT |
| D-14 | **Pegawai aktif** mengikuti master pegawai: `employees.status = 'active'`, `removed_at IS NULL`, dan `management_scope = 'MANAGED'` (EMP-005-L: staf di luar pengelolaan HCIS tidak ikut proses apa pun). Kartu hanya dapat diterbitkan untuk pegawai aktif yang punya foto aktif. | DRAFT |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| Pegawai (sesi `EMPLOYEE` yang terhubung ke pegawai) | Melihat kartu aktifnya (depan/belakang, QR besar), melaporkan kartu hilang. |
| Pemegang `employee_cards.manage` (HC Admin) | Mengunggah/mengganti foto, menerbitkan, menerbitkan ulang, mencabut, mencetak, mengatur penanda tangan dan masa berlaku, membaca riwayat dan audit. |
| Publik (tanpa login) | Membuka halaman cek dari QR. |

## 5. Alur dan state

### 5.1 State kartu

| Dari | Tindakan | Ke | Syarat |
| --- | --- | --- | --- |
| — | terbitkan | `ACTIVE` | `employee_cards.manage`; pegawai aktif, punya foto aktif, nama penanda tangan terisi, tidak ada kartu `ACTIVE` lain |
| `ACTIVE` | terbitkan ulang (kartu baru) | `REPLACED` | alasan `LOST`/`DAMAGED`/`DATA_CHANGED`/`EXPIRED`; kartu baru `ACTIVE` dalam transaksi sama |
| `REPORTED_LOST`, `REVOKED` | terbitkan ulang | (tetap) | kartu baru `ACTIVE`; kartu lama tetap pada statusnya |
| `ACTIVE` | laporkan hilang (pegawai) | `REPORTED_LOST` | pemilik kartu |
| `ACTIVE`, `REPORTED_LOST` | cabut | `REVOKED` | alasan wajib 5–300 karakter |

`EXPIRED` dan `EMPLOYEE_INACTIVE` tidak disimpan sebagai status; keduanya dihitung saat dibaca (D-08). Satu pegawai paling banyak satu kartu `ACTIVE` (unique index parsial). Transisi lain menjawab 409 `EMPLOYEE_CARD_INVALID_TRANSITION`. Terbit pertama padahal sudah ada kartu `ACTIVE` menjawab 409 `EMPLOYEE_CARD_ALREADY_ACTIVE`; tanpa foto 409 `EMPLOYEE_CARD_PHOTO_MISSING`; pegawai tidak aktif 409 `EMPLOYEE_CARD_EMPLOYEE_INACTIVE`.

### 5.2 Foto

HC memilih berkas, layar memotong 3:4 dan mengecilkan (D-03), lalu `PUT` mengirim base64. Server memeriksa ukuran dan tanda tangan berkas, mengenkripsi, menandai foto aktif sebelumnya `replaced_at`, dan menulis audit `employee_card.photo.uploaded`. Berkas tidak valid: 400 `INVALID_EMPLOYEE_CARD_IMAGE`; terlalu besar: 413 `EMPLOYEE_CARD_IMAGE_TOO_LARGE` (kode yang sama untuk gambar tanda tangan).

### 5.3 Cek keaslian

`GET /public/employee-cards/{code}` tanpa sesi. Kode dinormalisasi (huruf besar, `O`→`0`, `I`/`L`→`1`, tanda hubung dibuang) lalu dicari. Jawaban selalu `Cache-Control: no-store`. Foto kartu sah dibaca dari `GET /public/employee-cards/{code}/photo`, yang menjawab 404 bila kartu tidak sah. Setiap cek tidak ditulis ke audit (volume publik); pembatas laju per alamat klien (di dalam proses API, jendela tetap satu menit; alamat dibaca dari `CF-Connecting-IP` yang diisi Cloudflare, lalu dari `X-Forwarded-For` yang selalu ditulis ulang proxy edge Mi8 dengan alamat yang sama) menjawab 429 `RATE_LIMITED` di atas 30 permintaan per menit; data cek dan fotonya dihitung bersama. Jawaban kartu sah memuat `valid`, nomor, cetakan, masa berlaku, nama, jabatan, unit, dan `checkedAt`; jawaban tidak berlaku memuat `valid`, `reason`, nomor, cetakan, masa berlaku, `invalidSince`, dan `checkedAt`. ID internal, NIP, dan kode cek tidak pernah ada di jawaban publik.

## 6. Permission

| Permission | Pemegang | Membuka |
| --- | --- | --- |
| (sesi `EMPLOYEE` terhubung pegawai) | semua pegawai | `/me/employee-card*` |
| `employee_cards.manage` | `human_capital_admin` | `/admin/employee-cards/*` |
| (tanpa sesi) | publik | `/public/employee-cards/*` |

Ditambahkan oleh migration `0133_employee_card_permissions.sql`. Karena izin ditempelkan ke role yang sudah ada, rilisnya berdiri sendiri (OPS-MI8-REL-001 §4.5). Super Admin legacy tidak memperolehnya lewat kompatibilitas legacy.

## 7. Audit dan privasi

Tabel `employee_card_audit_events` mencatat `employee_card.photo.uploaded`, `employee_card.issued`, `employee_card.replaced`, `employee_card.reported_lost`, `employee_card.revoked`, `employee_card.printed`, `employee_card.settings.updated`, `employee_card.signature.uploaded`, dengan actor, pegawai, kartu, alasan, dan metadata (nomor kartu, cetakan, alasan terbit). Metadata **tidak** memuat isi foto, nama pegawai, atau NIP. Pengecualian: `employee_card.settings.updated` mencatat jabatan dan nama penanda tangan sebelum dan sesudah, karena itu pejabat yang namanya tercetak di setiap kartu, bukan data pribadi pegawai yang dikartukan.

Foto dan gambar tanda tangan hanya dikirim lewat endpoint terautentikasi `private, no-store` (dan foto kartu sah lewat endpoint cek publik). Log permintaan API menulis `/public/employee-cards/[code]` dan log server SPA Mi8 (`apps/web/deploy/mi8/spa_static_server.py`) menulis `/cek/[code]` sebagai pengganti kode cek (SEC-09). Server SPA production berjalan dari salinan bersama `/srv/hcis/shared/spa_static_server.py`, sehingga rilis EMP-012 menyalin versi ini ke sana (dengan cadangan berkas lama). Daftar admin hanya memuat pegawai yang dikelola HCIS (`management_scope = 'MANAGED'`, belum dihapus) yang aktif atau masih memegang kartu `ACTIVE`.

## 8. Penyimpanan

Migration `0132_employee_cards.sql`:

- `employee_card_photos` — `id`, `employee_id`, `mime_type`, `byte_size`, `sha256`, `encrypted_content`, `uploaded_by_account_id`, `created_at`, `replaced_at`. Satu baris aktif (`replaced_at IS NULL`) per pegawai.
- `employee_cards` — `id`, `employee_id`, `card_number` (unik), `edition`, `verify_code` (unik), `status`, `issue_reason` (`NEW`/`LOST`/`DAMAGED`/`DATA_CHANGED`/`EXPIRED`), `issued_at`, `valid_until`, `photo_id`, data beku (`full_name`, `employee_number`, `position_title`, `unit_name`, `signer_name`, `signer_title`), `print_count`, `last_printed_at`, `ended_at`, `end_reason`, `ended_by_account_id`, `issued_by_account_id`. Unik `(employee_id, edition)`; satu `ACTIVE` per pegawai.
- `employee_card_settings` — satu baris: `signer_title`, `signer_name`, `validity_months`, gambar tanda tangan terenkripsi, `updated_by_account_id`, `updated_at`.
- `employee_card_audit_events` — `id`, `event_type`, `employee_id`, `card_id` (tanpa FK), `actor_account_id`, `reason`, `metadata`, `occurred_at`.
- sequence `employee_card_number_seq`.

**Rollback/recovery:** migration hanya menambah tabel dan sequence; tidak mengubah data yang ada. Turun: `DROP TABLE employee_card_audit_events, employee_cards, employee_card_photos, employee_card_settings; DROP SEQUENCE employee_card_number_seq;` lalu hapus dua baris `schema_migrations`. Izin: `DELETE FROM role_permissions WHERE permission_key = 'employee_cards.manage'; DELETE FROM permissions WHERE permission_key = 'employee_cards.manage';`. Rollback aplikasi ke rilis sebelumnya aman tanpa menurunkan database karena build lama tidak membaca tabel ini.

## 9. API

Kontrak: `docs/api/employee-cards.openapi.yaml`.

| Method | Path | Akses | Daftar |
| --- | --- | --- | --- |
| GET | `/me/employee-card` | pegawai | satu |
| GET | `/me/employee-card/photo` | pegawai | satu (gambar) |
| POST | `/me/employee-card/report-lost` | pegawai | — |
| GET | `/admin/employee-cards` | `employee_cards.manage` | berhalaman (`page`/`pageSize` 25, maks 100, `total`); `q` (nama/NIP, 2–100), `filter` `NO_PHOTO`/`NO_CARD`/`ACTIVE`/`NEEDS_REISSUE` |
| GET | `/admin/employee-cards/employees/{employeeId}` | `employee_cards.manage` | satu, dengan riwayat kartu terbatas (§9.1) |
| GET, PUT | `/admin/employee-cards/employees/{employeeId}/photo` | `employee_cards.manage` | satu |
| POST | `/admin/employee-cards/employees/{employeeId}/cards` | `employee_cards.manage` | — |
| POST | `/admin/employee-cards/cards/{cardId}/revoke` | `employee_cards.manage` | — |
| GET | `/admin/employee-cards/cards/{cardId}/photo` | `employee_cards.manage` | satu (gambar) |
| GET | `/admin/employee-cards/print` | `employee_cards.manage` | terbatas: `cardIds` 1–50 |
| POST | `/admin/employee-cards/print` | `employee_cards.manage` | — (mencatat cetak) |
| GET, PUT | `/admin/employee-cards/settings` | `employee_cards.manage` | satu |
| GET, PUT | `/admin/employee-cards/settings/signature` | `employee_cards.manage` | satu (gambar) |
| GET | `/me/employee-card/signature` | pegawai | satu (gambar, untuk sisi belakang kartu digital) |
| GET | `/admin/employee-cards/audit-events` | `employee_cards.manage` | berhalaman |
| GET | `/public/employee-cards/{code}` | publik | satu |
| GET | `/public/employee-cards/{code}/photo` | publik | satu (gambar) |

### 9.1 Pengecualian ENG-LIST-001

- Riwayat kartu per pegawai di `/admin/employee-cards/employees/{employeeId}` dikembalikan utuh tanpa `LIMIT`: satu pegawai hanya bertambah satu kartu per penerbitan (praktis di bawah 20 seumur kerja), sehingga daftarnya terbatas oleh sifat datanya.
- Batch cetak dibatasi 1–50 kartu per permintaan; layar menolak pilihan di atas 50 dengan pesan, bukan memotong diam-diam.

Semua jawaban `Cache-Control: no-store`. Tanpa sesi di `/me/*` dan `/admin/*` 401 `UNAUTHENTICATED`; tanpa `employee_cards.manage` 403 `EMPLOYEE_CARD_FORBIDDEN`, dijawab sebelum validasi input; sesi pegawai tanpa pegawai terhubung 404 `EMPLOYEE_CARD_NOT_FOUND`.

## 10. Layar

- **Pegawai `/app/employee-card` ("Kartu Pegawai")**, di navigasi "Saya" dan katalog Semua Layanan: kartu depan, tombol "Lihat belakang", "Perbesar QR", status kartu, dan "Laporkan kartu hilang" dengan konfirmasi. Keadaan memuat, gagal (coba lagi), belum punya kartu, kartu tidak berlaku, dan tampilan ponsel.
- **Admin `/admin/employee-cards` ("Kartu Pegawai")**, di menu Administrasi grup Pegawai (hanya bagi pemegang `employee_cards.manage`) dan kartu di katalog layanan admin: daftar pegawai (pencarian, filter status kartu, pagination, pilih banyak untuk cetak), panel pegawai (foto dengan unggah/ganti dan pemotongan 3:4, kartu aktif, terbitkan/terbitkan ulang/cabut, riwayat kartu, tanda "data berubah"), tab Pengaturan (penanda tangan, gambar tanda tangan, masa berlaku), tab Riwayat (audit).
- **Cetak `/admin/employee-cards/print?cardIds=…`**: satu halaman 54 × 85,6 mm per sisi, depan lalu belakang, dengan tombol Cetak yang mencatat `printed`.
- **Publik `/cek/{code}`** tanpa login: status sah/tidak berlaku dengan ikon dan teks (tidak hanya warna), D-11.

## 11. Acceptance criteria

- EMP-012-A: tanpa `employee_cards.manage` semua rute admin menjawab 403 sebelum validasi; Super Admin legacy tidak memperolehnya.
- EMP-012-B: kartu tidak dapat diterbitkan tanpa foto aktif, untuk pegawai tidak aktif, tanpa nama penanda tangan, atau saat sudah ada kartu `ACTIVE` (kecuali terbit ulang).
- EMP-012-C: terbit ulang membuat kartu lama `REPLACED` dan kartu baru `ACTIVE` dengan cetakan +1, nomor dan kode baru, dalam satu transaksi; tidak pernah ada dua kartu `ACTIVE` untuk satu pegawai.
- EMP-012-D: halaman cek kartu sah menampilkan nama, jabatan, unit, foto, nomor, masa berlaku; kartu tidak berlaku (diganti, hilang, dicabut, kedaluwarsa, pegawai tidak aktif) tidak menampilkan nama maupun foto, dan foto publiknya 404.
- EMP-012-E: jawaban publik tidak memuat NIK, NIP, alamat, tanggal lahir, kontak, atau ID internal pegawai.
- EMP-012-F: foto diperiksa tanda tangan berkasnya, maks 2 MB, tersimpan terenkripsi; mengganti foto tidak mengubah foto kartu yang sudah terbit.
- EMP-012-G: setiap terbit, terbit ulang, laporan hilang, cabut, cetak, unggah foto, dan ubah pengaturan menulis audit event.
- EMP-012-H: pegawai hanya melihat dan melaporkan kartunya sendiri.

## 12. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Asumsi | Default yang dipakai |
| --- | --- | --- |
| D-04 | Cara hitung masa berlaku | 24 bulan, berakhir di akhir bulan |
| D-05 | Gambar tanda tangan | diunggah HC sekali di pengaturan |
| D-06 | Format nomor kartu | `KP-YYMM-NNNN` |
| D-09 | Biaya ganti kartu | gratis, tidak dicatat |
| D-10 | Laporan hilang oleh pegawai | langsung tidak berlaku, HC terbit ulang |
| D-13 | Data kartu dibekukan saat terbit | terbit ulang bila data berubah |
| D-14 | Definisi pegawai aktif | `status = 'active'`, belum dihapus, dikelola HCIS |
