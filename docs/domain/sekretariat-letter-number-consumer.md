# HCIS sebagai konsumen buku nomor Sekretariat (peralihan DOC-003)

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis memakai default paling masuk akal dan ditandai `DRAFT`.
**Spesifikasi:** DOC-004
**Tanggal:** 2026-11-17
**Terkait:** DOC-001, DOC-002, DOC-003, TRIP-001, ORG-012, AUTH-011, ENG-LIST-001
**Pasangan:** SQ Hub [SEK-IMPL-001](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/specs/SEK-IMPL-001-r1-buku-nomor-arsip-kotak-masuk.md) §14 langkah 8–9 (ACCEPTED 2026-11-13) dan [SEK-001](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/product/sekretariat-module-design.md) §5.5.

## 1. Tujuan

DOC-003 §1 mencatat keputusan owner 2026-11-12: seluruh penomoran surat yayasan terpusat di satu buku milik modul Sekretariat SQ Hub, dan buku DOC-003 di HCIS adalah masa antara. SEK-IMPL-001 §14 menuntut dua hal dari repository HCIS sebelum cutover dapat dijalankan: **skrip ekspor buku DOC-003** dan **spesifikasi sisi konsumen**. Dokumen ini adalah spesifikasi itu, dan skrip ekspornya adalah `documents:export-doc003`.

Yang dituju:

- buku DOC-003 berpindah sekali, satu arah, terverifikasi, tanpa pernah ada dua buku aktif;
- surat yang diterbitkan HCIS sendiri (DOC-001, DOC-002, SK panitia ORG-012, surat tugas TRIP-001) mengambil nomornya dari buku Sekretariat, **fail-closed** tanpa deret cadangan lokal;
- nomor yang sudah terbit tidak pernah berubah, tidak pernah dinomori ulang (DOC-003 D-10), dan tetap terbaca di HCIS.

## 2. Batas

Termasuk: skrip ekspor DOC-003, klien HTTP ke `/internal/sekretariat/v1/alokasi-nomor`, pemetaan empat titik terbit HCIS ke jenis dan penerbit buku Sekretariat, perilaku gagal, pensiun layar `/app/letters` dan `/admin/letters`, urutan cutover dan rollback.

Tidak termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Perubahan format nomor yang sudah terbit | Dilarang DOC-003 D-10; nomor lama dipertahankan apa adanya. |
| Arsip berkas dan kotak masuk surat | Milik Sekretariat R1 (SEK-IMPL-001 §1), bukan HCIS. |
| Impor balik dari Sekretariat ke HCIS | Migrasi satu arah (SEK-001 §5.5). |
| Penomoran surat di luar empat titik terbit §5 | Tidak ada titik terbit lain di HCIS. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| C-01 | Ekspor DOC-003 adalah **satu berkas JSON** yang bentuknya persis `eksporDoc003Schema` milik Sekretariat (`apps/api/src/modules/sekretariat/migrasi.ts`). HCIS tidak menulis ke database Sekretariat dan tidak memanggil API impor; operator memindahkan berkasnya. | ACCEPTED |
| C-02 | Ekspor **read-only** dan dapat dijalankan berkali-kali. Impor sisi Sekretariat idempoten per `sourceId`, sehingga ekspor ulang tidak menduplikasi baris. | ACCEPTED |
| C-03 | `sourceId` = `letter_numbers.id` (UUID HCIS). Itu kunci idempotensi migrasi dan satu-satunya jejak balik ke baris asalnya. | ACCEPTED |
| C-04 | Identitas pengambil nomor diekspor sebagai `hcis:employee:<uuid pegawai>`, bukan nama, NIP, atau e-mail. Buku Sekretariat menyimpan rujukan, bukan data pribadi (sejalan DOC-003 D-12). | ACCEPTED |
| C-05 | Jenis dan penerbit lama ikut diekspor dan mendarat **nonaktif** di katalog Sekretariat, supaya nomor lama tetap terbaca tanpa menambah pilihan baru bagi petugas. | ACCEPTED (SEK-IMPL-001 §14 langkah 8) |
| C-06 | Penghitung diekspor apa adanya per `period_key`; sisi Sekretariat melipat periode bulanan ke tahunnya dengan `GREATEST`, jadi penghitung tujuan tidak pernah turun. HCIS tidak melipatnya sendiri. | ACCEPTED |
| C-07 | Grant yang sudah dicabut **tidak** diekspor. Hak akses di buku baru diberikan ulang lewat Sekretariat; hanya grant aktif yang dibawa sebagai titik awal. | DRAFT |
| C-08 | Setelah cutover, keempat titik terbit HCIS memanggil `/internal/sekretariat/v1/alokasi-nomor` dengan `rujukan_modul` + `rujukan_id` yang stabil, sehingga percobaan ulang mengembalikan nomor yang sama (SEK-IMPL-001 D-3). | ACCEPTED |
| C-09 | **Fail-closed.** Bila buku Sekretariat tidak menjawab atau menolak, penerbitan surat HCIS gagal dengan `503 LETTER_BOOK_UNAVAILABLE` dan tidak ada dokumen yang terbit. Tidak ada deret cadangan lokal, tidak ada nomor sementara. | ACCEPTED (SEK-001 §5.5) |
| C-10 | `hr_document_number_counters` **tidak dihapus** pada rilis konsumen. Ia berhenti dipakai dan tinggal sebagai catatan; penghapusannya butuh migration tersendiri setelah masa pantau 7 hari. | DRAFT |
| C-11 | Pemetaan titik terbit ke pasangan (penerbit, jenis) disimpan sebagai konfigurasi, bukan tabel baru, karena isinya empat baris dan hanya berubah lewat Keputusan Pengurus (pedoman Pasal 13 ayat 7). | DRAFT |
| C-12 | Sejak tanggal cutover, buku DOC-003 di HCIS menjadi **baca-saja**: pengambilan nomor baru lewat `/app/letters` ditolak `409 LETTER_BOOK_MOVED`, register lama tetap dapat dibaca dan diekspor sampai layarnya pensiun. | ACCEPTED (SEK-IMPL-001 §14) |

## 4. Ekspor DOC-003

**Perintah.** `npm --workspace @hcis/api run documents:export-doc003 -- --out <berkas.json>`

Hanya membaca. Tanpa `--out` ringkasannya dicetak dan berkasnya tidak ditulis (mode pratinjau), sehingga operator dapat memeriksa jumlah baris sebelum mengambil datanya.

**Isi berkas** (bentuk `eksporDoc003Schema`):

| Kunci | Sumber | Catatan |
| --- | --- | --- |
| `types[]` | `letter_types` | `code`, `label`. Semua jenis, aktif maupun tidak. |
| `issuers[]` | `letter_issuers` | `code`, `name`, `kind`. Semua penerbit. |
| `grants[]` | `letter_number_grants` dan `employees` | hanya `revoked_at IS NULL`; `personId` = `hcis:employee:<uuid>` (C-04). |
| `counters[]` | `letter_number_counters` | `issuerCode`, `typeCode`, `periodKey`, `lastSequence`. |
| `numbers[]` | `letter_numbers` | seluruh baris, termasuk `VOIDED`; `sourceId` = id baris (C-03). |

**Pemeriksaan sebelum menulis berkas.** Skrip gagal dengan pesan jelas dan tidak menulis apa pun bila: ada kode penerbit sepanjang satu karakter (katalog Sekretariat menuntut minimal dua), ada `subject` atau `recipient` melebihi 300 karakter, ada nomor yang penerbit atau jenisnya tidak ikut terekspor, atau ada penghitung yang lebih kecil dari urut tertinggi nomor pada kombinasi yang sama. Pemeriksaan terakhir itu menangkap buku yang sudah tidak konsisten sebelum data pindah, bukan sesudahnya.

**Keluaran ringkasan** (dicetak, tanpa data pribadi): jumlah jenis, penerbit, grant aktif, penghitung, nomor `ALLOCATED`, nomor `VOIDED`, dan urut tertinggi per penerbit, jenis, dan tahun. Angka-angka ini yang dicocokkan dengan hasil impor SEK-IMPL-001 §14 langkah 8.

## 5. Titik terbit HCIS dan pemetaannya

Empat tempat memanggil `issueDocument` hari ini:

| # | Titik terbit | Berkas | Jenis pedoman (`DRAFT`) |
| --- | --- | --- | --- |
| 1 | Surat keterangan pegawai (DOC-001) | `apps/api/src/modules/documents/routes.ts` | `12` Surat Keterangan |
| 2 | Surat peringatan (DOC-002) | `apps/api/src/modules/documents/routes.ts` | `13` Surat Peringatan |
| 3 | SK panitia (ORG-012) | `apps/api/src/modules/committees/routes.ts` | `02` Surat Keputusan |
| 4 | Surat tugas (TRIP-001) | `apps/api/src/modules/trips/routes.ts` | `04` Surat Tugas |

Penerbitnya `HCM.YSQ` untuk nomor 1, 2, dan 4; `DIR.YSQ` untuk SK panitia. Keempat pemetaan ditandai `DRAFT`: kode jenis diambil dari katalog Pedoman Tata Naskah Dinas YSQ v0.11 Pasal 8 yang sudah ter-seed di `sekretariat_jenis`, dan dikonfirmasi ke Sekretariat sebelum rilis konsumen.

`rujukan_modul` = `hcis`; `rujukan_id` = id dokumen HCIS yang akan terbit (`hr_documents.id`). Id itu dibuat sebelum panggilan alokasi, sehingga percobaan ulang setelah jaringan putus mengembalikan nomor yang sama, bukan nomor kedua.

## 6. Klien dan identitas layanan

- Client Keycloak `hcis-sekretariat` (realm `sq-staff`, client credentials, service account) dengan satu audience mapper ke `MACHINE_TOKEN_AUDIENCE` SQ Hub. Dibuat `reconcile-sekretariat-clients.sh` di repository SQ-Hub.
- Env HCIS baru: `SEKRETARIAT_BASE_URL`, `SEKRETARIAT_CLIENT_ID`, `SEKRETARIAT_CLIENT_SECRET`. Kosong berarti konsumen mati dan titik terbit memakai perilaku lama — itulah keadaan sebelum cutover.
- Rute `/internal/*` tidak pernah terbuka dari edge; panggilan berjalan di loopback Mi8 (SEK-IMPL-001 §14 langkah 7 sudah menutupnya dengan 404 dari edge).
- Token di-cache sampai 60 detik sebelum kedaluwarsa, diperbarui sekali, dan tidak pernah ditulis ke log.

## 7. Perilaku gagal

| Keadaan | Jawaban HCIS | Catatan |
| --- | --- | --- |
| Buku tidak menjawab, timeout 5 detik | `503 LETTER_BOOK_UNAVAILABLE` | C-09; tidak ada dokumen terbit, tidak ada nomor terpakai. |
| Token ditolak (401/403) | `503 LETTER_BOOK_UNAVAILABLE` | Dibedakan di log sebagai masalah identitas, bukan di pesan pengguna. |
| Penerbit atau jenis tidak dikenal (404) | `500 LETTER_MAPPING_INVALID` | Salah konfigurasi §5, bukan salah pengguna. |
| Panggilan ulang rujukan yang sama | nomor yang sama | SEK-IMPL-001 D-3. |

Setiap kegagalan menulis satu audit event `letter_number.remote_failed` dengan kode dan rujukan, tanpa isi surat.

## 8. Pensiun layar HCIS

Setelah langkah 9 SEK-IMPL-001: `/app/letters` dan `/admin/letters` dihapus beserta rutenya di `letter-routes.ts`, dan barisnya dicabut dari `AUTH-011-admin-route-permissions.json`. Izin `documents.read` dan `documents.manage` tetap ada untuk DOC-001 dan DOC-002, sehingga tidak ada jendela izin saat rilis (DOC-003 D-11). Tautan di peluncur mengarah ke `sekretariat.sabilulquran.or.id`.

Tabel `letter_*` tidak di-drop pada rilis ini (sejalan C-10): datanya sudah pindah, tetapi penghapusan tabel adalah migration tersendiri setelah masa pantau.

## 9. Urutan cutover

Berjalan bersama SEK-IMPL-001 §14 langkah 8–9, mengikuti gate rilis owner 2026-10-27 (dry-run dulu, backup sebelum migration, rollback bila verifikasi gagal, tidak pada jam 19 UTC).

1. Ekspor pratinjau di Mi8 (`documents:export-doc003` tanpa `--out`); catat angkanya.
2. Backup database HCIS dan SQ Hub.
3. Ekspor ke berkas, pindahkan ke Hub, `sekretariat:admin impor-doc003 --dry-run`.
4. Impor sungguhan; verifikasi otomatis sisi Sekretariat harus lulus (jumlah baris, penghitung tidak kurang).
5. Bandingkan ringkasan langkah 1 dengan hasil impor; bila berbeda, berhenti — buku HCIS belum dimatikan.
6. Buku DOC-003 HCIS menjadi baca-saja (C-12).
7. `SEKRETARIAT_ALLOWED_MACHINE_CLIENTS=hcis-sekretariat` di SQ Hub; rilis HCIS sisi konsumen dengan env §6 terisi.
8. Uji satu surat keterangan nyata end-to-end; nomornya muncul di register Sekretariat.
9. Pantau 7 hari, lalu layar HCIS pensiun (§8).

**Rollback.** Sebelum langkah 6 cukup mengosongkan `SEKRETARIAT_ALLOWED_MACHINE_CLIENTS` dan membatalkan rilis konsumen; impor idempoten sehingga baris yang telanjur masuk tidak menjadi ganda. Setelah langkah 6, rollback berarti mengembalikan buku HCIS ke tulis dan mematikan konsumen — nomor yang sudah terbit di Sekretariat tetap sah dan tidak ditarik kembali.

## 10. Uji

- **Unit:** pemetaan §5; pembentukan `rujukan_id`; cache token (perbarui sekali, tidak dua kali); pemetaan kode galat §7.
- **Ekspor (PostgreSQL uji):** buku berisi menghasilkan JSON yang lolos `eksporDoc003Schema`; grant tercabut tidak ikut; nomor `VOIDED` ikut dengan alasannya; penghitung lebih kecil dari urut tertinggi membuat skrip gagal tanpa menulis berkas; dijalankan dua kali menghasilkan berkas yang sama.
- **Konsumen (API uji):** buku tidak tersedia menghasilkan `503` dan tidak ada dokumen terbit; panggilan ulang rujukan sama mengembalikan nomor sama dengan dokumen tetap satu; env kosong berarti perilaku lama.

## 11. Kriteria penerimaan

1. Ekspor menghasilkan berkas yang diterima `sekretariat:admin impor-doc003` tanpa penyesuaian tangan.
2. Jumlah baris dan urut tertinggi per penerbit, jenis, dan tahun sama di kedua sisi.
3. Nomor yang sudah terbit di HCIS tampil utuh di register Sekretariat, termasuk yang dibatalkan.
4. Setelah cutover, surat keterangan baru memperoleh nomor dari buku Sekretariat, dan HCIS tidak pernah menerbitkan nomor sendiri.
5. Buku tidak tersedia berarti tidak ada surat terbit, bukan nomor cadangan.
6. Tidak ada data pribadi pada berkas ekspor selain rujukan `hcis:employee:<uuid>`.
