# Pusat Bantuan

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** HELP-001
**Tanggal:** 2026-11-03
**Terkait:** NOTIF-002 (pola konten teks biasa), AUTH-011, ENG-LIST-001, SEC-001
**Rujukan:** `docs/product/feature-parity.yaml` (HELP-001), `docs/product/legacy-parity-audit-2026-11-02.md`

## 1. Tujuan

HCIS akan dibuka untuk seluruh pegawai. Mereka butuh satu tempat yang jelas untuk membaca cara memakai tiap layanan dan tahu ke mana bertanya. HCIS legacy (Laravel `hcysq/hcis-ysq`) punya `HelpController` dengan halaman FAQ, panduan, dan formulir kontak (`sendSupport`). Paket 1 membawa fungsi bacanya:

- pegawai membaca **FAQ berkategori** dan **panduan singkat per layanan**, serta **mencari** di keduanya;
- pegawai melihat **kontak Human Capital** (HC) yang resmi;
- HC mengelola isi dari layar admin; setiap perubahan tersimpan sebagai **revisi** dan **audit event**;
- isi awal (FAQ dan panduan untuk layanan yang sudah berjalan di production) dimuat oleh migration sebagai **draf** yang ditinjau HC sebelum terbit.

## 2. Batas

Termasuk (Paket 1): artikel FAQ dan panduan pada daftar topik tetap, status draf/terbit/arsip, revisi isi, daftar kontak HC, pencarian kata, layar pegawai dan layar admin.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Formulir kontak / tiket / chat | Catatan perencanaan HELP-001: formulir kontak tidak boleh menjadi chat umum (di luar lingkup HCIS). Paket 1 hanya menampilkan kontak resmi (D-10). |
| Topik buatan HC | Daftar topik tetap mengikuti layanan yang ada (D-01). Menambah topik adalah perubahan kode kecil. |
| Gambar, lampiran, video, format kaya (HTML/Markdown) | Teks biasa menutup risiko XSS dan data pribadi dalam lampiran (D-05). |
| Penilaian "artikel ini membantu?" dan statistik baca | Belum dibutuhkan sebelum peluncuran. |
| Bantuan untuk ruang admin / Hub / aplikasi lain | Paket 1 ditujukan kepada pegawai di ruang kerja HCIS. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Artikel punya **jenis** `FAQ` atau `GUIDE` (panduan) dan **satu topik** dari daftar tetap: `GENERAL` (Umum & akun), `ATTENDANCE` (Kehadiran), `OVERTIME` (Lembur), `LEAVE` (Cuti & izin), `PAYSLIP` (Slip gaji), `TRIPS` (Perjalanan dinas), `CALENDAR` (Kalender & rapat), `TRAINING` (Pelatihan), `LOANS` (Pinjaman), `ASSETS` (Asset Saya), `DOCUMENTS` (Dokumen), `PERFORMANCE` (Kinerja), `APPROVALS` (Persetujuan). Dijaga CHECK database dan validasi API. | DRAFT |
| D-02 | Status artikel `DRAFT` → `PUBLISHED` → `ARCHIVED`, dan `ARCHIVED` → `DRAFT` (pulihkan). Pegawai hanya melihat `PUBLISHED`. **"Hapus" di layar admin berarti arsip**: artikel tidak pernah dihapus permanen supaya revisi dan audit tetap utuh. Menerbitkan ulang artikel arsip harus lewat pulihkan dulu. | DRAFT |
| D-03 | **Isi awal dimuat sebagai `DRAFT`** dengan asal `SEED`, sehingga tidak ada teks yang belum ditinjau HC sampai ke pegawai. HC meninjau, mengubah bila perlu, lalu menerbitkan per artikel. Layar admin menandainya "Draf awal — perlu ditinjau" selama artikel itu belum pernah diedit maupun diterbitkan. | DRAFT |
| D-04 | Mengedit artikel `PUBLISHED` **langsung berlaku** (tidak ada salinan draf terpisah); artikel `ARCHIVED` tidak dapat diedit sebelum dipulihkan. Setiap simpan menaikkan `version` dan menulis **revisi** berisi isi lengkap. Edit dan terbit membawa `version` yang dibaca; bila berbeda, API menjawab 409 `HELP_ARTICLE_STALE` supaya dua admin tidak saling menimpa. | DRAFT |
| D-05 | Judul 5–200 karakter, isi 20–8.000 karakter, **teks biasa** dengan paragraf dipisah baris kosong; tidak pernah HTML atau skrip, dan layar menampilkannya sebagai teks. Catatan perubahan opsional ≤ 300 karakter. HC dilarang menulis data pribadi, gaji, atau nomor identitas di dalam artikel (diingatkan di layar admin). | ACCEPTED |
| D-06 | **Pencarian:** `q` 2–100 karakter dipecah menjadi paling banyak 8 kata; setiap kata harus muncul di judul atau isi (tidak peka huruf besar/kecil, `%`/`_` diperlakukan harfiah). Urutan hasil: kecocokan judul lebih banyak dulu, lalu urutan topik (D-01), lalu `sortOrder`, lalu judul. Filter `topic` dan `kind` boleh digabung dengan `q`. | ACCEPTED |
| D-07 | **Pembaca:** setiap sesi `EMPLOYEE` tanpa izin tambahan, termasuk akun yang belum terhubung ke pegawai aktif (bantuan login dan akun justru dibutuhkan mereka). Super Admin legacy dan Pengurus Yayasan tidak memakai ruang pegawai. | DRAFT |
| D-08 | **Pengelola:** izin baru `help.manage` (membaca semua status, membuat, mengedit, menerbitkan, mengarsipkan, memulihkan, mengelola kontak, membaca riwayat) diberikan ke `human_capital_admin`. Draf tidak rahasia, jadi tidak ada izin baca admin terpisah. Super Admin tidak memperolehnya lewat kompatibilitas legacy. | DRAFT |
| D-09 | **Kontak HC:** daftar terstruktur — label (misalnya "Layanan HC"), kanal `WHATSAPP`, `PHONE`, `EMAIL`, atau `OFFICE`, nilai (nomor/alamat/lokasi), catatan opsional (misalnya jam layanan), urutan, aktif/nonaktif. Paling banyak **20 kontak** (daftar terbatas, ENG-LIST-001 §4). Migration tidak mengisi kontak karena repo tidak memuat kontak resmi; sampai HC mengisinya, layar pegawai menampilkan keadaan kosong. HC diminta memakai kontak kelembagaan, bukan nomor pribadi. Kontak dapat dihapus; isinya tetap tercatat di audit event. | DRAFT |
| D-10 | **Tidak ada formulir kontak** di Paket 1 (legacy `sendSupport` tidak dibawa). Pegawai menghubungi HC lewat kanal resmi D-09. Formulir/tiket menjadi kandidat paket berikut bila HC membutuhkannya. | DRAFT |
| D-11 | Setiap panduan dan FAQ boleh mengarah ke layanannya: layar pegawai menampilkan tombol "Buka layanan" berdasarkan topik (pemetaan topik → halaman ada di web, bukan di data). | ACCEPTED |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| Pegawai (sesi `EMPLOYEE`) | Membaca dan mencari artikel terbit, melihat kontak aktif. |
| Pemegang `help.manage` (HC Admin) | Semua di atas ditambah mengelola artikel, kontak, dan membaca revisi serta riwayat. |

## 5. Alur dan state

### 5.1 State artikel

| Dari | Tindakan | Ke | Syarat |
| --- | --- | --- | --- |
| — | buat | `DRAFT` | `help.manage`; input valid (D-01, D-05) |
| `DRAFT`, `PUBLISHED` | edit | (tetap) | `version` cocok (D-04) |
| `DRAFT` | terbitkan | `PUBLISHED` | `version` cocok |
| `DRAFT`, `PUBLISHED` | arsipkan ("hapus") | `ARCHIVED` | alasan opsional ≤ 300 |
| `ARCHIVED` | pulihkan | `DRAFT` | — (`published_at` tetap menyimpan waktu terbit terakhir) |

Transisi lain menjawab 409 (`HELP_ARTICLE_NOT_PUBLISHABLE`, `HELP_ARTICLE_ARCHIVED`, `HELP_ARTICLE_NOT_ARCHIVED`, `HELP_ARTICLE_ALREADY_ARCHIVED`). Artikel yang tidak ada menjawab 404 `HELP_ARTICLE_NOT_FOUND`; bagi pegawai, artikel yang tidak terbit juga 404.

### 5.2 Membuat dan mengedit

Input: `kind`, `topic`, `title`, `body`, `sortOrder` (0–9999, default 100), dan untuk edit `version` serta `changeNote` opsional. Simpan dalam satu transaksi: baris artikel, revisi (`version`, isi lengkap, actor, catatan), dan audit event. Input tidak valid, termasuk teks yang memuat karakter NUL, menjawab 400 `INVALID_HELP_ARTICLE`.

### 5.3 Kontak

Buat, ubah (termasuk aktif/nonaktif dan urutan), hapus. Kontak ke-21 menjawab 409 `HELP_CONTACT_LIMIT`. Nilai divalidasi per kanal: `WHATSAPP`/`PHONE` 6–20 karakter angka dengan `+`, spasi, atau `-`; `EMAIL` alamat email; `OFFICE` 2–200 karakter teks. Tidak ditemukan: 404 `HELP_CONTACT_NOT_FOUND`. Layar pegawai membentuk tautan `wa.me`, `tel:`, atau `mailto:` dari nilainya.

### 5.4 Membaca dan mencari

Pegawai: ringkasan topik (jumlah FAQ dan panduan terbit per topik) dengan kontak aktif, daftar artikel terbit berhalaman dengan filter dan pencarian (D-06), dan satu artikel terbit. Admin: daftar semua status dengan filter `status` dan jumlah per status, satu artikel, riwayat revisinya, dan riwayat audit seluruh Pusat Bantuan.

## 6. Permission

| Permission | Pemegang | Membuka |
| --- | --- | --- |
| (tanpa izin, sesi `EMPLOYEE`) | semua pegawai | `/help/*` |
| `help.manage` | `human_capital_admin` | `/admin/help/*` |

Ditambahkan oleh migration `0131_help_center_permissions.sql`. Karena izin ditempelkan ke role yang sudah ada, rilisnya berdiri sendiri (OPS-MI8-REL-001 §4.5).

## 7. Audit dan privasi

Tabel `help_audit_events` mencatat `help.article.created`, `help.article.edited`, `help.article.published`, `help.article.archived`, `help.article.restored`, `help.contact.created`, `help.contact.updated`, `help.contact.deleted`, dengan actor, waktu, alasan bila ada, dan metadata. Metadata artikel memuat topik, jenis, versi, dan judul — **tidak** memuat isi (isi lengkap ada di `help_article_revisions`). Metadata kontak memuat label, kanal, dan nilai sebelum/sesudah, karena kontak adalah data kelembagaan. Isi awal migration tercatat sebagai revisi versi 1 tanpa actor dan audit event `help.article.created` dengan `origin = SEED`.

## 8. Penyimpanan

Migration `0130_help_center.sql`:

- `help_articles` — `id`, `kind`, `topic`, `title`, `body`, `status`, `sort_order`, `version`, `origin` (`SEED`/`HC`), `created_by_account_id` (null untuk isi awal), `updated_by_account_id`, `published_at`, `archived_at`, `created_at`, `updated_at`.
- `help_article_revisions` — `article_id`, `version` (unik per artikel), `kind`, `topic`, `title`, `body`, `status` saat simpan, `change_note`, `actor_account_id`, `created_at`.
- `help_contacts` — `id`, `label`, `channel`, `value`, `note`, `sort_order`, `active`, `created_at`, `updated_at`.
- `help_audit_events` — `id`, `event_type`, `article_id` (tanpa FK supaya riwayat tetap utuh), `contact_id` (tanpa FK, kontak boleh dihapus), `actor_account_id`, `reason`, `metadata`, `occurred_at`.

Isi awal dimasukkan di migration yang sama (D-03), dihasilkan dari `docs/domain/help-center-seed.json`: 13 panduan (satu per topik) dan 70 FAQ, ditulis dari spesifikasi dan layar setiap layanan yang sudah berjalan di production pada 2026-11-03. Berkas JSON itu hanya **potret isi awal**; setelah migration berjalan, isi resmi adalah data di database yang diubah HC lewat layar admin, dan mengubah JSON tidak mengubah apa pun.

**Rollback/recovery:** migration hanya menambah tabel dan baris baru; tidak mengubah data yang ada. Turun: `DROP TABLE help_audit_events, help_article_revisions, help_contacts, help_articles;` lalu hapus dua baris `schema_migrations`. Izin: `DELETE FROM role_permissions WHERE permission_key = 'help.manage'; DELETE FROM permissions WHERE permission_key = 'help.manage';`. Rollback aplikasi ke rilis sebelumnya aman tanpa menurunkan database, karena build lama tidak membaca tabel ini (build lama hanya tidak mengenal `help.manage` saat mendelegasikan role `human_capital_admin`, OPS-MI8-REL-001 §4.5).

### 8.1 Koreksi isi awal setelah celah layanan ditutup (2026-11-03)

Tujuh artikel isi awal menjelaskan celah yang sejak 2026-11-03 ditutup: pilihan WhatsApp rapat yang tampil padahal belum aktif (CAL-001 K-16), surat terbit yang tidak bisa dicetak (DOC-001 D-20), dan cuti yang tidak bisa dibatalkan serta penyetuju cuti yang tidak diberi notifikasi (LEAVE-010). Migration `0137_help_center_gap_articles.sql` menyesuaikan artikel itu tanpa pernah menimpa suntingan HC:

- artikel isi awal yang masih draf dan belum disentuh (`origin = SEED`, `version = 1`, belum pernah terbit, isi persis sama dengan 0130) dikoreksi di tempat sebagai isi awal: artikel dan revisi 1 mendapat teks baru, tetap versi 1 sehingga tetap terhitung "draf awal perlu ditinjau" (D-03), dan audit mencatat `help.article.seed_corrected` dengan catatan perubahan;
- artikel isi awal yang diterbitkan HC tanpa pernah disimpan HC (tidak ada revisi ber-actor) dan isinya masih teks 0130 disunting seperti simpan biasa (D-04): versi naik, revisi lengkap dengan catatan perubahan, audit `help.article.edited` tanpa actor;
- artikel yang sudah diubah atau diarsipkan HC dibiarkan; HC menyesuaikannya di layar admin.

Artikel yang disentuh: FAQ rapat lewat WhatsApp, FAQ salinan surat terbit, panduan Dokumen Kepegawaian, FAQ pembatalan cuti, panduan Cuti & Izin, FAQ notifikasi untuk penyetuju, dan FAQ isi halaman Notifikasi. `help-center-seed.json` tetap potret isi 0130.

### 8.2 Topik Reimbursement (2026-11-13)

REIMB-001 menambah topik `REIMBURSEMENT` ("Reimbursement", tautan `/app/reimbursements`) di antara Pinjaman dan Asset Saya. Migration `0150_help_center_reimbursement_articles.sql`:

- memperluas `CHECK` topik `help_articles` (daftar `HELP_TOPICS` di API dan web berubah bersamaan);
- menambah empat isi awal `DRAFT`/`SEED` (satu panduan, tiga FAQ: kategori dan batas, kapan dibayar, mengubah atau membatalkan) dengan revisi 1 tanpa actor dan audit `help.article.created`, sehingga tidak ada yang tampil ke pegawai sebelum HC menerbitkannya (D-03);
- mengoreksi panduan Perjalanan Dinas dan FAQ "Apakah biaya perjalanan … bisa diajukan di HCIS?" yang menyatakan biaya belum diurus, dengan aturan 8.1 yang sama (draf awal dikoreksi di tempat, terbitan isi awal yang belum pernah disimpan HC disunting dengan versi naik, suntingan HC dibiarkan).

**Rollback/recovery:** hapus baris `help_audit_events`, `help_article_revisions`, dan `help_articles` bertopik `REIMBURSEMENT`, lalu pulihkan `CHECK` topik 0130. Teks TRIPS dikembalikan HC di layar admin bila perlu. Build lama tidak mengenal topik itu dan hanya tidak menampilkannya.

## 9. API

Kontrak: `docs/api/help-center.openapi.yaml`.

| Method | Path | Akses | Daftar |
| --- | --- | --- | --- |
| GET | `/help/overview` | pegawai | terbatas (13 topik, ≤ 20 kontak) |
| GET | `/help/articles` | pegawai | berhalaman (`page`/`pageSize` 25, maks 100, `total`) |
| GET | `/help/articles/{id}` | pegawai | satu |
| GET, POST | `/admin/help/articles` | `help.manage` | berhalaman |
| GET, PUT | `/admin/help/articles/{id}` | `help.manage` | satu |
| POST | `/admin/help/articles/{id}/publish`, `/archive`, `/restore` | `help.manage` | — |
| GET | `/admin/help/articles/{id}/revisions` | `help.manage` | berhalaman |
| GET, POST | `/admin/help/contacts` | `help.manage` | terbatas (≤ 20) |
| PUT, DELETE | `/admin/help/contacts/{id}` | `help.manage` | — |
| GET | `/admin/help/audit-events` | `help.manage` | berhalaman |

Semua jawaban `Cache-Control: no-store`. Tanpa sesi 401 `UNAUTHENTICATED`; sesi bukan pegawai di `/help/*` 403 `FORBIDDEN`; tanpa `help.manage` di `/admin/help/*` 403 `HELP_FORBIDDEN`, dijawab sebelum validasi input.

## 10. Layar

- **Pegawai `/app/help` ("Bantuan")**, di navigasi "Saya" dan katalog Semua Layanan: kotak pencarian, pilihan topik, panduan topik terpilih, FAQ sebagai daftar buka-tutup, tombol "Buka layanan", dan kartu "Hubungi HC". Keadaan memuat, gagal (dengan coba lagi), kosong (belum ada artikel terbit / pencarian tanpa hasil / kontak belum diisi) dan tampilan ponsel satu kolom.
- **Admin `/admin/help` ("Pusat Bantuan")**, kartu di katalog layanan admin: tab Artikel (filter status/topik/jenis, pencarian, jumlah per status, pagination), formulir buat/edit (pop-up `?artikel=baru|<id>`), terbitkan, arsipkan, pulihkan, riwayat revisi per artikel (pop-up `?revisi=<id>`); tab Kontak; tab Riwayat (audit). Tanpa `help.manage` rute ditolak oleh guard admin.

## 11. Acceptance criteria

- HELP-001-A: pegawai hanya melihat artikel `PUBLISHED`; draf dan arsip menjawab 404 dan tidak muncul di daftar maupun hitungan topik.
- HELP-001-B: tanpa `help.manage` semua rute admin menjawab 403 sebelum validasi; Super Admin legacy tidak memperoleh `help.manage`.
- HELP-001-C: membuat, mengedit, menerbitkan, mengarsipkan, dan memulihkan menulis audit event; membuat dan mengedit menulis revisi dengan versi naik satu.
- HELP-001-D: edit atau terbit dengan `version` lama menjawab 409 `HELP_ARTICLE_STALE` dan tidak mengubah apa pun.
- HELP-001-E: pencarian mencocokkan setiap kata pada judul atau isi, memperlakukan `%` dan `_` secara harfiah, dan berhalaman dengan `total`.
- HELP-001-F: isi awal tersedia setelah migration sebagai `DRAFT` asal `SEED` dengan revisi versi 1, dan dapat diedit, diterbitkan, atau diarsipkan HC.
- HELP-001-G: kontak ke-21 ditolak; menghapus kontak mencatat isinya di audit event.
- HELP-001-H: transisi yang tidak sah (terbit dari arsip, edit arsip, arsip dua kali, pulihkan yang tidak diarsip) menjawab 409.

## 12. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Asumsi | Default yang dipakai |
| --- | --- | --- |
| D-01 | Daftar topik tetap | 13 topik sesuai layanan yang sudah berjalan |
| D-02 | Arti "hapus" | arsip, bisa dipulihkan; tidak ada hapus permanen |
| D-03 | Isi awal | draf, wajib ditinjau dan diterbitkan HC per artikel |
| D-04 | Edit artikel terbit | langsung berlaku, revisi tersimpan |
| D-07 | Siapa yang membaca | semua sesi pegawai |
| D-08 | Siapa yang mengelola | `human_capital_admin` lewat `help.manage` |
| D-09 | Kontak HC | maksimal 20, kosong sampai HC mengisi |
| D-10 | Formulir kontak | tidak ada di Paket 1 |

Isi awal juga mengulang aturan yang di spesifikasi layanannya masih `DRAFT` (ditulis dengan kata "saat ini"): batas dan tenor pinjaman (LOAN-001), batas 30 hari dan alur persetujuan perjalanan dinas (TRIP-001), syarat 80% kehadiran pelatihan (TRAIN-001), bobot dan batas predikat kinerja (PERF-001), batas tiga permintaan surat dan masa berlaku SP (DOC-001/DOC-002), serta aturan ubah/batal rapat (CAL-001). Bila salah satu aturan itu berubah, artikel terkait perlu diedit HC.
