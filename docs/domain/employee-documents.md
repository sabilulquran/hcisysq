# Arsip Dokumen Pegawai

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Keputusan aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** EMP-011 (arsip berkas dokumen pegawai dengan masa berlaku); juga menetapkan **batas penyimpanan berkas dokumen pegawai** yang ditunggu EMP-010.
**Tanggal:** 2026-11-11
**Terkait:** EMP-003, EMP-007, EMP-010, EMP-012, TRAIN-001 D-10, AUTH-011, ENG-LIST-001, ADR-0002
**Roadmap:** `docs/product/hcis-capability-map.md` §5

## 1. Tujuan

HCIS lama (Laravel) menyimpan pindaian KTP, KK, ijazah, dan sertifikat pegawai beserta tanggal kedaluwarsanya. HCIS sekarang hanya mencatat metadata (EMP-007, EMP-008, EMP-010) dan menunda unggah berkas sampai ada "batas penyimpanan dokumen pegawai" yang diterima. Spesifikasi ini menetapkan batas itu dan memakainya untuk:

1. **arsip dokumen pribadi pegawai** (EMP-011): HC mengunggah, pegawai dapat mengusulkan unggahan sendiri, HC memverifikasi;
2. **berkas Perjanjian Kerja dan Surat Keputusan** (EMP-010): pindaian dokumen yang sudah tercatat di register.

Yang dituju: HC tidak lagi mencari pindaian di WhatsApp atau map; pegawai melihat dan mengunduh dokumennya sendiri; dokumen yang segera kedaluwarsa muncul di daftar kerja HC; setiap pembacaan dan penulisan berkas tercatat di audit.

## 2. Batas

Termasuk (Paket 1):

- katalog jenis dokumen pribadi (§3 D-04);
- unggah oleh HC (langsung terverifikasi) dan usulan unggah oleh pegawai (menunggu verifikasi HC);
- ganti dokumen dengan versi baru, hapus berkas yang salah unggah, ubah metadata;
- daftar kerja HC: dokumen yang akan/sudah kedaluwarsa dan usulan yang menunggu verifikasi;
- unduh berkas oleh pemilik dan oleh HC yang berwenang, selalu teraudit;
- lampiran berkas untuk dokumen register EMP-010.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Object storage di luar database | Batas Paket 1 adalah database (D-01). Port `EmployeeFileStore` membuat perpindahan ke object storage menjadi pergantian adapter (ADR-0002). |
| Pemindaian antivirus | Tidak ada mesin AV di Mi8VPS. Paket 1 memeriksa tanda tangan berkas dan menolak PDF dengan konten aktif yang terlihat (D-07); berkas selalu dikirim sebagai unduhan. |
| Notifikasi otomatis ke pegawai menjelang kedaluwarsa | Butuh penjadwal NOTIF-003. Paket 1: daftar kerja HC dan penanda di layar pegawai. `TBD`. |
| Penghapusan otomatis menurut masa retensi | Masa retensi `DRAFT` (D-12); penghapusannya manual oleh HC sampai owner menetapkan. |
| Atasan membaca dokumen bawahan | Tidak pernah secara bawaan (D-09). |
| Pegawai membaca berkas PK/SK miliknya | Register EMP-010 belum punya layar pegawai; menyusul bersama layar itu. `TBD`. |
| Menautkan sertifikat ke catatan kualifikasi EMP-007 | Paket 1 menyimpan berkasnya; tautan ke catatan EMP-007 menyusul. `TBD`. |
| Dokumen yang diterbitkan HCIS (DOC-001/DOC-002) | Dirender HCIS dari data, bukan berkas unggahan (`hr-documents.md` D-01). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Batas penyimpanan berkas dokumen pegawai:** semua berkas dokumen pegawai (arsip EMP-011 dan lampiran EMP-010) disimpan di satu tabel `employee_document_files` di database HCIS, terenkripsi AES-256-GCM dengan `AUTH_ENCRYPTION_KEY`, pola yang sama dengan bukti cuti, sertifikat pelatihan (TRAIN-001 D-10), dan pas foto Kartu Pegawai (EMP-012 D-03). Kode modul hanya mengakses berkas lewat port `EmployeeFileStore` (simpan, baca, tandai diganti, hapus isi); adapter Postgres adalah satu-satunya implementasi. Tidak ada penyimpanan baru di Mi8VPS. | ACCEPTED (arahan owner 2026-11-11: pakai pola berkas terenkripsi yang ada, disimpan di database) |
| D-02 | **Berkas yang diterima:** PDF, JPEG, atau PNG, **maksimal 4 MB** per berkas. Isi diperiksa dari tanda tangan berkas (`%PDF-`, `FF D8 FF`, tanda tangan PNG), bukan dari nama atau tipe yang dikirim peramban. Tipe yang tidak cocok dengan isi ditolak 400 `EMPLOYEE_DOCUMENT_FILE_INVALID`; terlalu besar 413 `EMPLOYEE_DOCUMENT_FILE_TOO_LARGE`. Lampiran EMP-010 memakai batas yang sama. | DRAFT (2 MB pola lama terlalu kecil untuk pindaian ijazah multi-halaman) |
| D-03 | **Nama berkas asli tidak disimpan.** Nama berkas dari ponsel sering memuat nama atau NIK. Unduhan diberi nama dari jenis dan tanggal, misalnya `KTP-2026-11-11.pdf`. | ACCEPTED |
| D-04 | **Katalog jenis** (kode tetap): `KTP`, `KK`, `NPWP`, `BPJS_KESEHATAN`, `BPJS_KETENAGAKERJAAN`, `IJAZAH`, `TRANSKRIP`, `SERTIFIKAT`, `SIM`, `PASPOR`, `SKCK`, `SURAT_SEHAT`, `LAINNYA`. `SIM`, `PASPOR`, `SKCK`, dan `SURAT_SEHAT` **wajib** tanggal berakhir; `SERTIFIKAT` dan `LAINNYA` boleh; jenis lain tidak meminta tanggal berakhir tetapi menerimanya. `LAINNYA` wajib judul. | DRAFT |
| D-05 | **Nomor dokumen** (NIK, nomor KK, NPWP, dst.) boleh dicatat. Nomor disimpan terenkripsi (AES-GCM, kunci yang sama); API **hanya** mengembalikan empat karakter terakhir (`••••1234`). Nomor lengkap dibaca dari berkasnya, yang pembacaannya diaudit. Nomor tidak pernah masuk audit atau log. | DRAFT |
| D-06 | **Pegawai dapat mengusulkan unggahan sendiri.** Bentuknya sama dengan usulan EMP-003 — pegawai mengusulkan, satu petugas HC memutuskan, tanpa rantai approval — tetapi disimpan sebagai dokumen berstatus `PENDING_REVIEW`, bukan sebagai baris `employee_data_change_requests`, karena usulan EMP-003 membawa nilai field, bukan berkas. Usulan muncul di daftar kerja **Menunggu verifikasi**. Paling banyak **5** usulan terbuka per pegawai (409 `EMPLOYEE_DOCUMENT_PENDING_LIMIT`) dan **10** unggahan pegawai per 24 jam, termasuk yang sudah ditarik atau ditolak (429 `EMPLOYEE_DOCUMENT_RATE_LIMITED`), supaya unggah-tarik berulang tidak membebani database di Mi8VPS. Kedua batas diperiksa sebelum berkas didekode dan sekali lagi di bawah kunci baris pegawai. Hanya pegawai berstatus aktif yang dapat mengusulkan. | DRAFT |
| D-07 | **Pemeriksaan isi:** selain tanda tangan berkas, PDF yang memuat penanda konten aktif yang terlihat (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, `/AA`, `/SubmitForm`, `/ImportData`; nama ber-escape `#xx` didekode dulu, seperti yang dilakukan pembaca PDF) ditolak 400 `EMPLOYEE_DOCUMENT_FILE_ACTIVE_CONTENT` (padanan aturan `NoExecutableFile` di HCIS lama). `/OpenAction` sendiri tidak ditolak karena pemindai memakainya untuk membuka halaman pertama. Pemeriksaan ini upaya terbaik: penanda di dalam object stream yang dimampatkan tidak terlihat. Karena itu berkas **selalu** dikirim sebagai unduhan (`Content-Disposition: attachment`) dengan `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, dan `Cache-Control: private, no-store`; tidak pernah ditampilkan inline di origin HCIS. | DRAFT |
| D-08 | **Yang membaca:** (a) pegawai pemilik, untuk dokumennya yang `PENDING_REVIEW` atau `VERIFIED`, tanpa permission; (b) pemegang `employee_documents.read`; (c) untuk lampiran EMP-010, pemegang `employment.read`. Dokumen pegawai lain dijawab **404**, sama dengan dokumen yang tidak ada. | ACCEPTED (arahan owner 2026-11-11) |
| D-09 | **Atasan tidak pernah membaca secara bawaan.** Tidak ada role bercakupan unit yang membawa `employee_documents.*`, dan `employees.read.all` atau `employees.read.unit` tidak membuka arsip ini. Super Admin tidak memperolehnya lewat kompatibilitas legacy. | ACCEPTED (arahan owner 2026-11-11) |
| D-10 | **Yang menulis:** pemegang `employee_documents.manage` mengunggah, memverifikasi, menolak, mengganti, menghapus berkas, dan mengubah metadata. Kedua izin dibawa `human_capital_admin` (migrasi 0143). Pegawai hanya mengusulkan dan menarik usulannya sendiri. Pegawai yang ditandai di luar pengelolaan HCIS (EMP-005 S2B) hanya dapat dibaca: setiap penulisan dijawab 409 `EMPLOYEE_OUTSIDE_HCIS_READ_ONLY`. | DRAFT |
| D-11 | **Audit setiap pembacaan dan penulisan.** Setiap unduhan berkas (pemilik maupun HC), setiap pembacaan daftar dokumen seorang pegawai oleh HC, setiap pembacaan daftar kerja, dan setiap penulisan mencatat event di `employee_document_audit_events`. Pegawai yang membaca daftar metadata miliknya sendiri tidak diaudit (bukan pengungkapan ke orang lain); unduhan berkasnya tetap diaudit. Metadata audit **tidak pernah** memuat isi berkas, nomor dokumen, nama berkas, nama pegawai, atau teks alasan — hanya jenis, tipe isi, ukuran, status, nama field yang berubah, dan panjang alasan. | ACCEPTED |
| D-12 | **Retensi:** berkas disimpan selama data pegawai ada dan **5 tahun** sesudah hubungan kerja berakhir; sesudah itu HC menghapus isinya. Berkas yang diganti tetap tersimpan sebagai jejak (pola TRAIN-001 D-10) dengan masa yang sama. Usulan yang **ditolak** atau **ditarik** langsung dihapus isinya: tidak ada tujuan menyimpan pindaian yang tidak dipakai. Penghapusan otomatis `TBD`. **Batas yang diketahui:** "dihapus" berarti isi terenkripsi dan hash-nya dikosongkan di baris aktif. Versi baris lama tetap ada di berkas tabel sampai autovacuum, dan di backup harian OPS-MI8-BAK-001 (14 set beserta salinan terenkripsi di luar host) serta dump pra-rilis sampai rotasinya; isinya tetap terenkripsi dengan `AUTH_ENCRYPTION_KEY`. Jadi isi yang dihapus baru benar-benar hilang setelah set backup terakhir yang memuatnya dirotasi. | DRAFT |
| D-13 | **Hapus berkas** oleh HC (misalnya salah unggah ke pegawai lain): alasan wajib (5–300 karakter), isi berkas dihapus permanen (`ciphertext` dikosongkan, `purged_at` diisi), baris metadata dan audit tetap ada dengan status `REMOVED`. Tidak dapat dibatalkan. | DRAFT |
| D-14 | **Ganti dokumen:** HC mengunggah dokumen baru dengan `replacesDocumentId` (jenis sama, pegawai sama, status `VERIFIED`); yang lama menjadi `REPLACED` dalam transaksi yang sama. Usulan pegawai dapat menyebut dokumen yang ingin diganti; penggantian terjadi saat HC memverifikasi. | DRAFT |
| D-15 | **Daftar kerja kedaluwarsa** memuat dokumen `VERIFIED` milik pegawai aktif yang dikelola HCIS dengan tanggal berakhir dalam 30/60/90/180 hari ke depan (bawaan 60), **termasuk yang sudah lewat** dan belum diganti, urut tanggal berakhir. Dokumen tidak kedaluwarsa dengan sendirinya: statusnya tetap `VERIFIED` sampai diganti; "kedaluwarsa" dihitung saat dibaca (WIB). | DRAFT (pola EMP-007 §7.5) |
| D-16 | **Lampiran EMP-010:** satu berkas aktif per dokumen register. Melampirkan butuh `employment.manage`. Mengganti berkas dokumen yang **sudah terkunci** (sudah ditautkan ke tindakan) butuh juga `employment.correct` dan alasan (10–500 karakter), sejalan dengan EMP-010 D-09; berkas lama tetap tersimpan sebagai jejak. Membaca butuh `employment.read`. Event masuk `employment_audit_events` (`employment.document.file_attached`, `employment.document.file_replaced`, `employment.document.file_read`). Penggantian berkas dokumen terkunci juga dicatat sebagai koreksi EMP-010 (`employment_decision_document_corrections`) beserta alasannya dan id berkas lama, sehingga muncul di Riwayat koreksi. Berkas PK/SK lama tidak dapat dihapus isinya di Paket 1 (`TBD`). Mengikuti mode rollout register: tidak tersedia saat `OFF`. | DRAFT |

## 4. Actor

| Actor | Yang dilakukan |
| --- | --- |
| Pegawai (sesi `EMPLOYEE` terhubung ke data pegawai) | Melihat dokumennya, mengunduh berkasnya, mengusulkan unggahan, menarik usulan yang belum diputuskan. |
| HC (`employee_documents.read`) | Membaca arsip seorang pegawai, mengunduh berkas, membaca daftar kerja. |
| HC (`employee_documents.manage`) | Mengunggah, memverifikasi/menolak usulan, mengganti, menghapus berkas, mengubah metadata. |
| HC (`employment.read` / `employment.manage` / `employment.correct`) | Membaca, melampirkan, dan mengganti berkas dokumen register EMP-010. |

## 5. Alur dan state

### 5.1 State dokumen

```text
            unggah HC ─────────────────────────────┐
                                                   v
usulan pegawai → PENDING_REVIEW ──verifikasi──> VERIFIED ──ganti──> REPLACED
                   │        │                      │                  │
                   │ tolak  │ tarik (pegawai)      │ hapus            │ hapus
                   v        v                      v                  v
               REJECTED  WITHDRAWN              REMOVED            REMOVED
```

| Transisi | Actor | Prasyarat | Efek | Audit |
| --- | --- | --- | --- | --- |
| unggah HC | `employee_documents.manage` | pegawai ada, dikelola HCIS; aturan D-02/D-04/D-07 | dokumen `VERIFIED`, `source = HC` | `employee_document.uploaded` (+ `employee_document.replaced` bila mengganti) |
| usulan | pegawai | < 5 usulan terbuka; dikelola HCIS | dokumen `PENDING_REVIEW`, `source = EMPLOYEE` | `employee_document.uploaded` |
| verifikasi | `employee_documents.manage` | `PENDING_REVIEW` | `VERIFIED`; dokumen yang disebut diganti menjadi `REPLACED` bila masih `VERIFIED` | `employee_document.verified` (+ `replaced`) |
| tolak | `employee_documents.manage` | `PENDING_REVIEW`; alasan 5–300 karakter | `REJECTED`, isi berkas dihapus (D-12) | `employee_document.rejected` |
| tarik | pegawai pemilik | `PENDING_REVIEW` | `WITHDRAWN`, isi berkas dihapus | `employee_document.withdrawn` |
| ubah metadata | `employee_documents.manage` | `PENDING_REVIEW` atau `VERIFIED` | judul, penerbit, tanggal, nomor, catatan | `employee_document.updated` (nama field saja) |
| hapus | `employee_documents.manage` | `VERIFIED` atau `REPLACED`; alasan 5–300 | `REMOVED`, isi berkas dihapus (D-13) | `employee_document.removed` |

Transisi lain dijawab 409 `EMPLOYEE_DOCUMENT_INVALID_TRANSITION`. Semua transisi berjalan dalam satu transaksi dengan `SELECT … FOR UPDATE` pada baris dokumen, dan jawaban dikirim setelah `COMMIT`.

### 5.2 Validasi metadata

- `documentType` dari katalog D-04; `title` 1–200 karakter (wajib untuk `LAINNYA`); `issuer` ≤ 200; `notes` ≤ 500; `documentNumber` 1–60 karakter huruf, angka, spasi, titik, garis miring, atau tanda hubung.
- `issuedOn` dan `expiresOn` tanggal ISO; `expiresOn ≥ issuedOn` bila keduanya ada; `issuedOn` tidak boleh di masa depan (WIB).
- Pelanggaran: 400 `EMPLOYEE_DOCUMENT_INVALID` dengan `field`.

### 5.3 Unduh

`GET …/file` mengembalikan isi berkas yang didekripsi dengan header D-07. Isi yang sudah dihapus (`REJECTED`, `WITHDRAWN`, `REMOVED`) dijawab 410 `EMPLOYEE_DOCUMENT_FILE_PURGED` untuk HC; pegawai hanya melihat dokumen `PENDING_REVIEW`/`VERIFIED` sehingga mendapat 404. Integritas diperiksa dengan SHA-256 sesudah dekripsi; gagal berarti 500 tanpa isi.

## 6. Permission

| Permission | Pemegang | Membuka |
| --- | --- | --- |
| `employee_documents.read` | `human_capital_admin` | arsip per pegawai, unduh berkas, daftar kerja |
| `employee_documents.manage` | `human_capital_admin` | unggah, verifikasi, tolak, ganti, hapus, ubah metadata |

Melihat, mengunduh, mengusulkan, dan menarik dokumen sendiri tidak membutuhkan permission. Kedua kunci berada di luar `ADMIN_PERMISSIONS`, sehingga Super Admin tidak memperolehnya lewat kompatibilitas legacy, dan di luar `UNIT_SCOPED_PERMISSIONS`, sehingga penugasan bercakupan unit tidak pernah membukanya. **Batas yang diketahui:** role yang mengikuti kursi (AUTH-015) berlaku seluruh organisasi; menautkan role yang membawa `employee_documents.*` ke kursi seorang atasan akan membuka arsip. Itu keputusan Super Admin yang harus dihindari, bukan jalur bawaan. Migrasi 0143 menambahkan izin ke role yang sudah ada; lihat OPS-MI8-REL-001 §4.5 untuk jendela antara `migrate` dan `cutover`.

## 7. Audit dan privasi

Tabel `employee_document_audit_events`: `event_type`, `employee_id`, `document_id`, `actor_account_id`, `metadata`, `occurred_at` (`clock_timestamp()`).

| Event | Kapan | Metadata |
| --- | --- | --- |
| `employee_document.uploaded` | unggah HC atau usulan pegawai | `documentType`, `source`, `contentType`, `byteSize`, `hasExpiry`, `hasNumber` |
| `employee_document.verified` | HC memverifikasi | `documentType` |
| `employee_document.rejected` | HC menolak | `documentType`, `reasonLength` |
| `employee_document.withdrawn` | pegawai menarik | `documentType` |
| `employee_document.replaced` | dokumen lama diganti | `documentType`, `replacedBy` (id dokumen) |
| `employee_document.removed` | HC menghapus berkas | `documentType`, `previousStatus`, `reasonLength` |
| `employee_document.updated` | HC mengubah metadata | `documentType`, `changedFields` |
| `employee_document.file_read` | setiap unduhan | `documentType`, `via` (`SELF`/`HC`) |
| `employee_document.list_read` | HC membaca arsip seorang pegawai | `count` |
| `employee_document.worklist_read` | HC membaca daftar kerja | `view` (`EXPIRING`/`PENDING`), `withinDays`, `total` |

Log aplikasi tidak memuat isi permintaan; URL hanya memuat UUID. Nomor dokumen, isi berkas, dan alasan tidak pernah masuk log atau audit (D-05, D-11). Teks alasan penolakan disimpan di baris dokumen supaya pegawai membacanya.

## 8. Penyimpanan

- `employee_documents` — `id`, `employee_id`, `document_type`, `title`, `issuer`, `issued_on`, `expires_on`, nomor terenkripsi (`number_ciphertext`, `number_iv`, `number_auth_tag`) dan `number_last4`, `status`, `source`, `replaces_document_id`, `submitted_by_account_id`, `decided_by_account_id`, `decided_at`, `decision_reason`, `ended_by_account_id`, `ended_at`, `end_reason`, `notes`, `created_at`, `updated_at`.
- `employee_document_files` — batas penyimpanan D-01: `id`, `purpose` (`EMPLOYEE_DOCUMENT`/`DECISION_DOCUMENT`), `employee_document_id` atau `decision_document_id` (tepat satu, sesuai `purpose`), `content_type`, `byte_size` (≤ 4 MB), `sha256`, `ciphertext`, `iv`, `auth_tag`, `uploaded_by_account_id`, `created_at`, `replaced_at`, `purged_at`. Satu berkas per dokumen arsip; satu berkas aktif (`replaced_at IS NULL`) per dokumen register. `purged_at` terisi tepat ketika isi terenkripsi kosong.
- `employee_document_audit_events` — §7.

Perkiraan kapasitas: ±400 pegawai × 6 dokumen × rata-rata 1 MB ≈ 2,4 GB isi, ±3,2 GB setelah base64. Ruang bebas `/data` dan ukuran dump harian OPS-MI8-BAK-001 harus dipantau; bila arsip melewati 5 GB, pindahkan adapter ke object storage (ADR-0002) sebelum menambah jenis dokumen.

**Rollback/recovery:** migrasi 0142 hanya menambah tabel, indeks, dan constraint; migrasi 0143 hanya menambah dua permission dan memberikannya ke `human_capital_admin`. Tidak ada data lama yang diubah. Turun (setelah build lama berjalan kembali):

```sql
DELETE FROM role_permissions WHERE permission_key IN ('employee_documents.read', 'employee_documents.manage');
DELETE FROM permissions WHERE permission_key IN ('employee_documents.read', 'employee_documents.manage');
DROP TABLE employee_document_audit_events, employee_document_files, employee_documents;
DELETE FROM schema_migrations WHERE name IN ('0142_employee_documents.sql', '0143_employee_document_permissions.sql');
```

Rollback aplikasi ke rilis sebelumnya aman tanpa menurunkan database karena build lama tidak membaca tabel ini. Menurunkan database menghapus semua berkas yang sudah diunggah; lakukan hanya bila belum ada unggahan nyata, atau setelah `pg_dump` tabel-tabel itu.

## 9. API

Kontrak: `docs/api/employee-documents.openapi.yaml` dan, untuk lampiran EMP-010, `docs/api/employment.openapi.yaml`. Semua jawaban JSON `Cache-Control: no-store`; berkas mengikuti D-07. Permission diperiksa sebelum validasi input.

| Metode | Path | Akses | Bentuk |
| --- | --- | --- | --- |
| GET | `/me/employee-documents` | pegawai | halaman (`page`/`pageSize`, `total`) |
| POST | `/me/employee-documents` | pegawai | satu (usulan) |
| GET | `/me/employee-documents/{documentId}/file` | pegawai | berkas |
| POST | `/me/employee-documents/{documentId}/withdraw` | pegawai | satu |
| GET | `/admin/employee-documents/employees/{employeeId}` | `employee_documents.read` | halaman; `includeHistory=true` menyertakan `REPLACED`/`REJECTED`/`WITHDRAWN`/`REMOVED` |
| POST | `/admin/employee-documents/employees/{employeeId}` | `employee_documents.manage` | satu |
| GET | `/admin/employee-documents/expiring` | `employee_documents.read` | halaman; `withinDays` 30/60/90/180 |
| GET | `/admin/employee-documents/pending` | `employee_documents.read` | halaman |
| GET | `/admin/employee-documents/{documentId}/file` | `employee_documents.read` | berkas |
| PATCH | `/admin/employee-documents/{documentId}` | `employee_documents.manage` | satu |
| POST | `/admin/employee-documents/{documentId}/verify` | `employee_documents.manage` | satu |
| POST | `/admin/employee-documents/{documentId}/reject` | `employee_documents.manage` | satu |
| POST | `/admin/employee-documents/{documentId}/remove` | `employee_documents.manage` | satu |
| GET | `/admin/decision-documents/{documentId}/file` | `employment.read` | berkas |
| PUT | `/admin/decision-documents/{documentId}/file` | `employment.manage` (+ `employment.correct` saat mengganti berkas dokumen terkunci) | satu |

Unggahan dikirim sebagai JSON `{ contentType, contentBase64, … }` (pola TRAIN-001/EMP-012), batas body 6 MB. `GET /admin/decision-documents/{documentId}` menambahkan `file` (`contentType`, `byteSize`, `uploadedAt`, atau `null`).

Semua daftar memakai pagination server-side ENG-LIST-001 (`page`, `pageSize` bawaan 25 maks 100, `total`); filter (pegawai, status, rentang tanggal, status pegawai) dijalankan sebelum `LIMIT`.

## 10. Layar

| Layar | Isi |
| --- | --- |
| Detail pegawai → tab **Dokumen** (HC, `employee_documents.read`) | Daftar dokumen dengan jenis, judul, nomor tersamar, tanggal, status kedaluwarsa, sumber; unduh; untuk `manage`: unggah, ganti, verifikasi/tolak usulan, ubah, hapus berkas; tombol "Tampilkan riwayat". |
| **Kepegawaian → Dokumen Pegawai** (`/admin/employee-documents`, `employee_documents.read`) | Dua tampilan: **Akan berakhir** (30/60/90/180 hari, termasuk yang lewat) dan **Menunggu verifikasi**; tautan ke tab Dokumen pegawai. |
| **Data Saya → Dokumen Pribadi** (pegawai) | Dokumen sendiri dengan status dan sisa masa berlaku; unduh; formulir usulan unggah; tarik usulan; alasan penolakan. |
| **Perjanjian Kerja & SK** → detail dokumen | Lampirkan/ganti berkas, unduh berkas. |

Setiap layar menampilkan state memuat, kosong, galat, dan terlarang (403), dan dapat dipakai pada lebar ponsel.

## 11. Acceptance criteria

| # | Kriteria | Bukti |
| --- | --- | --- |
| EMP-011-A | Setiap rute admin menjawab 403 tanpa permission yang tepat, sebelum memvalidasi input; `employees.read.all`, `employees.manage`, dan Super Admin legacy tidak membuka arsip. | `employee-documents.test.ts` |
| EMP-011-B | Pegawai hanya membaca dokumen sendiri; dokumen pegawai lain dijawab 404, termasuk unduhan dan penarikan. | `employee-documents.postgres.test.ts` |
| EMP-011-C | Berkas yang isinya tidak cocok dengan tipe, terlalu besar, atau PDF dengan konten aktif ditolak. | `employee-documents-domain.test.ts`, postgres test |
| EMP-011-D | Setiap unggahan, keputusan, unduhan, dan pembacaan arsip oleh HC menulis audit; metadata audit tidak memuat nomor, nama berkas, atau alasan. | postgres test |
| EMP-011-E | Penolakan, penarikan, dan penghapusan mengosongkan isi berkas; unduhan sesudahnya 410/404. | postgres test |
| EMP-011-F | Daftar kerja memuat dokumen yang segera/sudah kedaluwarsa milik pegawai aktif dan usulan yang menunggu, dengan pagination. | postgres test |
| EMP-011-G | Lampiran EMP-010: melampirkan butuh `employment.manage`, mengganti berkas dokumen terkunci butuh `employment.correct` dan alasan, membaca butuh `employment.read` dan diaudit. | postgres test |
| EMP-011-H | Batas 5 usulan terbuka dan 10 unggahan per 24 jam; pegawai di luar pengelolaan HCIS tidak dapat ditulis. | postgres test |

## 12. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Asumsi | Default yang dipakai |
| --- | --- | --- |
| D-02 | Batas ukuran berkas | 4 MB, PDF/JPEG/PNG |
| D-04 | Katalog jenis dan jenis yang wajib tanggal berakhir | 13 jenis; SIM, paspor, SKCK, surat sehat wajib |
| D-05 | Menyimpan nomor dokumen | boleh, terenkripsi, tampil 4 karakter terakhir |
| D-06 | Batas usulan terbuka dan unggahan harian per pegawai | 5 terbuka, 10 per 24 jam |
| D-10 | Pemegang izin | hanya HC Admin |
| D-12 | Masa retensi | 5 tahun setelah hubungan kerja berakhir; usulan ditolak/ditarik dihapus segera |
| D-15 | Rentang daftar kerja | 30/60/90/180 hari, bawaan 60 |
| D-16 | Mengganti berkas PK/SK terkunci | butuh `employment.correct` dan alasan |
