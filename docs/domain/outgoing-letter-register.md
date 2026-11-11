# Buku Nomor Surat Keluar Yayasan (penomoran surat keluar)

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis memakai default paling masuk akal dan ditandai `DRAFT`.
**Spesifikasi:** DOC-003
**Tanggal:** 2026-11-11
**Terkait:** DOC-001, DOC-002, TRIP-001, ORG-012, AUTH-011, ENG-LIST-001
**Bukti legacy:** `docs/product/feature-parity.yaml` DOC-003 (`LetterNumber`, `LetterType`, `LetterNumberAccessGrant`, `letter-numbers/*` pada Laravel hcis-ysq; repository legacy tidak lagi dapat diakses pada 2026-11-11, jadi bukti yang dipakai adalah catatan audit 2026-11-02).

## 1. Tujuan

Unit-unit Yayasan Sabilul Qur'an membuat surat keluar di luar HCIS (undangan, pemberitahuan, permohonan, edaran, keputusan unit). Nomornya hari ini diambil dari buku agenda manual per unit, sehingga nomor ganda, lompatan nomor, dan nomor yang hilang tidak terdeteksi. Legacy HCIS punya buku nomor surat umum; HCIS baru hanya menomori surat yang ia terbitkan sendiri (register DOC-001).

Yang dituju:

- satu buku nomor surat keluar untuk seluruh yayasan, dengan penerbit (yayasan, unit, panitia) dan jenis surat;
- nomor diambil sendiri oleh pegawai yang diberi akses, **tanpa celah dan tanpa ganda** walau diambil bersamaan;
- nomor yang batal tetap tercatat dan terlihat, tidak pernah dipakai ulang;
- HC dapat mencari, menelusuri, dan mengekspor buku ini, termasuk surat yang diterbitkan HCIS sendiri.

**Keputusan lokasi.** Buku nomor surat masuk HCIS, bukan aplikasi SQ Core lain (DRAFT, D-01): pemberi akses adalah pegawai, scope penerbit adalah unit organisasi dan panitia yang hanya ada di HCIS, dan register DOC-001 sudah ada di sini. Bila kelak ada aplikasi persuratan tersendiri, register ini menjadi sumbernya.

## 2. Batas

Termasuk (Paket 1): katalog jenis surat, katalog penerbit, hak ambil nomor per penerbit, ambil nomor, ubah perihal/tujuan, batalkan nomor, register gabungan (buku + surat terbitan HCIS) dengan pencarian dan halaman, ekspor CSV, nomor awal per penerbit/jenis/periode untuk peralihan dari buku manual, audit.

Tidak termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Isi surat, templat, unggah berkas surat | Paket 1 hanya mencatat nomor. Berkas butuh object storage dan pemindaian (sama dengan DOC-001 §2). |
| Persetujuan sebelum nomor diambil | Legacy tidak punya; hak ambil nomor sudah merupakan keputusan HC (D-07). |
| Impor CSV buku legacy | Repository legacy tidak dapat diakses; peralihan memakai **nomor awal** (§5.5). |
| Surat masuk (agenda surat masuk) | Fitur terpisah; tidak ada bukti legacy. |
| Tanda tangan elektronik | Di luar HCIS. |
| Penomoran ulang surat terbitan HCIS | Dilarang (D-10). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Buku nomor surat keluar umum berada di HCIS, modul `documents`. | DRAFT |
| D-02 | Format nomor mengikuti legacy: `<JENIS>.<urut>/<PENERBIT>/<bulan romawi>/<tahun>`, urut minimal 3 digit (`UND.007/SDIT/XI/2026`). | DRAFT |
| D-03 | Urutan dihitung **per penerbit, per jenis, per periode**. Legacy menghitung per jenis per tahun lintas penerbit; HCIS memisahkan per penerbit karena setiap unit memegang buku agendanya sendiri dan celah per unit harus dapat diperiksa. | DRAFT |
| D-04 | Periode reset diatur per jenis: `YEARLY` (bawaan, reset 1 Januari) atau `MONTHLY` (reset tanggal 1). Tanggal, bulan, dan tahun diturunkan dari zona **Asia/Jakarta**. Periode reset jenis yang **sudah punya nomor tidak dapat diubah** (`409 LETTER_TYPE_IN_USE`), karena format nomor hanya memuat bulan dan tahun sehingga penghitung periode baru akan mengulang nomor lama; perlu periode lain berarti jenis baru. Bila tetap terjadi tabrakan dengan nomor lama, pengambilan ditolak `409 LETTER_NUMBER_CONFLICT` dan HC menaikkan nomor awal (§5.5). | DRAFT |
| D-05 | Alokasi tanpa celah: penghitung dinaikkan dan baris register disisipkan dalam **satu transaksi**. Bila penyisipan gagal, transaksi dibatalkan dan nomor kembali; dua pengambilan bersamaan saling menunggu pada kunci baris penghitung. | ACCEPTED |
| D-06 | Tanggal surat = tanggal pengambilan nomor (Jakarta). Tidak ada nomor mundur tanggal di Paket 1, supaya urutan dan tanggal di buku selalu searah. | DRAFT |
| D-07 | Hanya pegawai aktif yang punya **hak ambil nomor** (grant) untuk sebuah penerbit yang dapat mengambil nomor atas nama penerbit itu. Grant diberikan HC dengan alasan, dapat dicabut, dan tercatat. | ACCEPTED (bukti legacy) |
| D-08 | Nomor tidak pernah dihapus atau dipakai ulang. Nomor yang tidak jadi dipakai **dibatalkan** dengan alasan dan tetap tampil berstatus Dibatalkan. | ACCEPTED (sama dengan DOC-001 D-03) |
| D-09 | Pembatalan oleh pengambil nomor sendiri (selama nomornya miliknya) atau oleh pemegang `documents.manage`. | DRAFT |
| D-10 | Surat yang diterbitkan HCIS (surat keterangan, SP, surat tugas, SK panitia) **tetap memakai penghitung DOC-001** dan formatnya sendiri; nomor lamanya tidak diubah. Register gabungan menampilkan keduanya. Format DOC-001 diawali angka dan format DOC-003 diawali kode jenis berhuruf, jadi kedua ruang nomor tidak dapat bertabrakan. | DRAFT |
| D-11 | Izin memakai kosakata DOC yang sudah ada: `documents.read` membaca register gabungan dan mengekspornya; `documents.manage` mengatur jenis, penerbit, hak ambil nomor, nomor awal, dan membatalkan nomor siapa pun. Tidak ada kunci izin baru, sehingga tidak ada jendela izin saat rilis (`mi8vps-hcis-release.md` §4.5). | DRAFT |
| D-12 | Baris surat terbitan HCIS di register gabungan hanya membawa fakta register: nomor, jenis, status, tanggal, serta waktu dan alasan pembatalan — sama dengan DOC-002 D-18. Tidak ada nama pegawai, penanda tangan, tujuan, maupun isi surat. | ACCEPTED (turunan D-18) |
| D-13 | Pemegang grant melihat buku penerbit yang grant-nya ia pegang, ditambah nomor yang pernah ia ambil sendiri walau grant-nya sudah dicabut. | DRAFT |
| D-14 | Penerbit jenis panitia (`COMMITTEE`) hanya dapat menerbitkan nomor selama panitia ORG-012-nya berstatus `ACTIVE`. | DRAFT (bukti legacy: "an active committee could also issue numbered letters") |
| D-15 | Kode jenis dan kode penerbit tidak dapat diubah setelah dibuat; label dapat diubah. Jenis dan penerbit dinonaktifkan, tidak dihapus. | ACCEPTED |
| D-16 | Katalog awal (dapat diubah HC): penerbit `YSQ` (Yayasan Sabilul Qur'an); jenis `UND` Undangan, `PEM` Pemberitahuan, `PMH` Permohonan, `EDR` Edaran, `SK` Surat Keputusan, `KET` Keterangan, `REK` Rekomendasi, `LAIN` Lainnya — semuanya reset tahunan. | DRAFT |
| D-17 | Nomor awal (§5.5) hanya dapat **menaikkan** penghitung, tidak pernah menurunkan, supaya tidak ada nomor yang terpakai dua kali. | ACCEPTED |

## 4. Objek

```text
LetterType (jenis surat)        code, label, reset_period, active
LetterIssuer (penerbit)         code, name, kind ORGANIZATION|UNIT|COMMITTEE|OTHER, unit/committee, active
LetterNumberGrant (hak ambil)   employee x issuer, reason, granted/revoked
LetterNumber (nomor surat)      issuer, type, period, sequence, number, date, subject, recipient, status
LetterCounter                   issuer x type x period -> last_sequence
```

### 4.1 Status nomor

```text
ALLOCATED -> VOIDED
```

`ALLOCATED` berarti nomor sudah diambil. `VOIDED` menyimpan waktu, pelaku, dan alasan; nomornya tetap terpakai.

## 5. Alur

### 5.1 Ambil nomor (pegawai dengan grant)

| Unsur | Isi |
| --- | --- |
| Aktor | Pegawai aktif dengan akun aktif yang memegang grant aktif untuk penerbit itu. |
| Prasyarat | Penerbit aktif (dan panitianya `ACTIVE` bila penerbit panitia, D-14); jenis aktif. |
| Input | `issuerId`, `typeCode`, `subject` (perihal, 3–300 karakter), `recipient` (tujuan, 2–300), `notes` (opsional, ≤1000). |
| Transisi | — → `ALLOCATED`; penghitung naik satu dalam transaksi yang sama (D-05). |
| Izin | Grant, bukan permission. Tanpa grant: `403 LETTER_GRANT_REQUIRED`. |
| Audit | `letter.allocated` (id, nomor, penerbit, jenis, aktor). |
| Gagal | Penerbit/jenis nonaktif atau panitia tidak aktif → `409 LETTER_ISSUER_INACTIVE` / `409 LETTER_TYPE_INACTIVE`; input tidak valid → `400 INVALID_LETTER_REQUEST`; tidak ada nomor yang terpakai. |

### 5.2 Ubah perihal/tujuan

Pengambil nomor (selama `ALLOCATED`) atau pemegang `documents.manage` dapat mengubah `subject`, `recipient`, `notes` dengan `version` (optimistic concurrency, `409 LETTER_VERSION_CONFLICT`). Nomor, penerbit, jenis, dan tanggal tidak dapat diubah. Audit `letter.updated` memuat nama kolom yang berubah, bukan isinya.

### 5.3 Batalkan nomor

Pengambil nomor sendiri atau pemegang `documents.manage` (D-09). Alasan 10–500 karakter. `ALLOCATED → VOIDED`; nomor tidak kembali ke penghitung (D-08). Audit `letter.voided` dengan alasan. Nomor yang sudah batal → `409 LETTER_NOT_VOIDABLE`.

### 5.4 Register gabungan dan ekspor

`GET /admin/letters/register` (`documents.read`), ENG-LIST-001 §3.1: `page`, `pageSize` (25, maks 100), `total`; filter `source` (`ALL` bawaan, `BOOK`, `HCIS`), `issuerCode`, `typeCode`, `status` (`ACTIVE` = terpakai, `VOIDED` = batal), `year`, `q` (2–100 karakter: nomor, perihal, tujuan). Semua filter berjalan di SQL sebelum `LIMIT`; urutan stabil: tanggal terbaru, lalu waktu pengambilan/penerbitan terbaru, lalu id. Baris surat terbitan HCIS (D-10, D-12) ber-`source = HCIS`, penerbit "HCIS", perihal = nama jenis surat, tanpa nama pegawai dan tanpa tujuan; filter `issuerCode`/`typeCode` hanya berlaku untuk baris buku dan menyembunyikan baris HCIS (sehingga `source=HCIS` dengan filter itu menghasilkan daftar kosong).

`GET /admin/letters/register/export` memakai filter yang sama tanpa halaman dan menghasilkan CSV lengkap (ENG-LIST-001-H). Bila hasil melebihi 20.000 baris, ekspor ditolak `422 LETTER_EXPORT_TOO_LARGE` dengan pesan "persempit filter". Sel teks dinetralkan dari formula (SEC-13). Audit `letter.register.exported` dengan filter dan jumlah baris.

Pemegang grant membaca bukunya lewat `GET /letters/me/numbers` (D-13), juga berhalaman dengan filter `issuerId`, `status`, `q`.

### 5.5 Pengaturan (HC)

- Jenis surat: tambah (`code` `^[A-Z][A-Z0-9-]{0,9}$`, `label`, `resetPeriod`), ubah label/aktif, dan ubah periode reset **selama jenis itu belum punya nomor** (D-04).
- Penerbit: tambah (`code` `^[A-Z0-9][A-Z0-9-]{0,15}$`, `name`, `kind`, `organizationalUnitId` untuk `UNIT`, `committeeId` untuk `COMMITTEE`), ubah nama/aktif.
- Hak ambil nomor: beri ke pegawai aktif (pencarian typeahead) dengan alasan 5–500 karakter; cabut dengan alasan. Satu grant aktif per pegawai per penerbit (`409 LETTER_GRANT_EXISTS`).
- Nomor awal: untuk penerbit + jenis + periode, set "nomor terakhir yang sudah terpakai di buku manual". Hanya boleh lebih besar dari penghitung sekarang (D-17, `409 LETTER_COUNTER_NOT_RAISED`). Nomor berikutnya = nilai itu + 1. Audit `letter.counter.raised` dengan nilai lama dan baru.

Panjang teks dihitung dalam karakter, sama dengan constraint basis data. Permintaan ubah tanpa isi ditolak `400`.

Audit pengaturan: `letter.type.created`, `letter.type.updated`, `letter.issuer.created`, `letter.issuer.updated`, `letter.grant.created`, `letter.grant.revoked`, `letter.counter.raised`.

## 6. Izin

| Akses | Siapa |
| --- | --- |
| Ambil nomor, lihat buku penerbitnya, ubah/batalkan nomor sendiri | Pegawai aktif dengan grant aktif (D-07, D-13) |
| Baca register gabungan, ekspor | `documents.read` (`human_capital_admin`, `document_corrector`) |
| Pengaturan, grant, nomor awal, ubah/batalkan nomor siapa pun | `documents.manage` (`human_capital_admin`) |

Super Admin tidak menerima `documents.*` lewat kompatibilitas legacy (DOC-001 §6). Frontend hanya menyembunyikan tombol; setiap keputusan otorisasi ada di API.

## 7. Penyimpanan

```text
letter_types              code PK, label, reset_period, active, sort_order
letter_issuers            id, code UNIQUE, name, kind, organizational_unit_id, committee_id, active
letter_number_grants      id, employee_id, issuer_id, reason, granted_*, revoked_*  (unik aktif per pegawai+penerbit)
letter_number_counters    (issuer_id, type_code, period_key) PK, last_sequence
letter_numbers            id, issuer_id, type_code, period_key, sequence, letter_number UNIQUE, letter_date, subject,
                          recipient, notes, status, requested_by_employee_id/account_id, voided_*, version
letter_audit_events       id, event_type, letter_number_id, issuer_id, actor_account_id, reason, metadata, occurred_at
```

`letter_numbers` unik pada `(issuer_id, type_code, period_key, sequence)` dan pada `letter_number`. Tidak ada endpoint hapus. Rollback migrasi ditulis sebagai `-- Down:` di berkas migrasi.

## 8. Layar

- **Pegawai → Layanan → Nomor Surat** (`/app/letters`): tampil bagi semua pegawai; tanpa grant menampilkan keadaan kosong "Anda belum diberi akses mengambil nomor surat. Hubungi Human Capital." Dengan grant: formulir ambil nomor (penerbit, jenis, perihal, tujuan, catatan), hasilnya ditampilkan besar dan dapat disalin; daftar buku berhalaman dengan pencarian; ubah dan batalkan untuk nomor sendiri.
- **Admin → Pegawai → Buku Nomor Surat** (`/admin/letters`, `documents.read`): tab **Register** (filter, pencarian, halaman, ekspor CSV, batalkan bila `documents.manage`), tab **Jenis & Penerbit**, tab **Hak Ambil Nomor**, dan formulir **Nomor awal**. Tab pengaturan hanya bisa diubah pemegang `documents.manage`.

Setiap layar punya keadaan memuat, kosong, galat, terlarang, dan tampilan ponsel.

## 9. Acceptance criteria

- DOC-003-A: pegawai tanpa grant ditolak `403 LETTER_GRANT_REQUIRED` dan tidak ada nomor yang terpakai.
- DOC-003-B: pegawai dengan grant memperoleh nomor berformat D-02; pengambilan kedua untuk penerbit/jenis/periode yang sama mendapat urut berikutnya; penerbit lain mulai dari 1 (D-03).
- DOC-003-C: dua pengambilan bersamaan pada koneksi terpisah menghasilkan dua nomor berurutan tanpa celah dan tanpa ganda (D-05).
- DOC-003-D: pengambilan yang gagal validasi tidak memakan nomor.
- DOC-003-E: jenis `MONTHLY` memakai periode `YYYY-MM` dan mulai dari 1 tiap bulan; jenis `YEARLY` memakai `YYYY`.
- DOC-003-F: nomor yang dibatalkan tetap ada di register berstatus `VOIDED` dengan alasan, dan nomor berikutnya tidak memakai ulang urutannya.
- DOC-003-G: pegawai tidak dapat mengubah atau membatalkan nomor milik orang lain; pemegang `documents.manage` dapat.
- DOC-003-H: register gabungan memuat surat terbitan HCIS tanpa nama pegawai, berhalaman dengan `total` yang memakai filter yang sama; halaman di luar jangkauan mengembalikan daftar kosong dengan `total` sebenarnya.
- DOC-003-I: ekspor CSV memuat seluruh baris sesuai filter dan menetralkan sel berawalan `=`.
- DOC-003-J: nomor awal hanya dapat menaikkan penghitung; nomor berikutnya melanjutkan dari nilai itu.
- DOC-003-K: penerbit panitia yang panitianya tidak `ACTIVE` menolak pengambilan nomor.
- DOC-003-L: setiap pengambilan, perubahan, pembatalan, pengaturan, grant, nomor awal, dan ekspor menulis satu audit event.
- DOC-003-M: mencabut grant menghentikan pengambilan nomor berikutnya, tetapi pegawai tetap melihat nomor yang pernah ia ambil.

## 10. Pertanyaan untuk owner (sudah dijawab dengan DRAFT)

1. Urutan per penerbit (D-03) atau satu urutan per jenis lintas penerbit seperti legacy?
2. Daftar jenis dan kodenya (D-16), dan apakah ada jenis yang reset bulanan.
3. Apakah nomor boleh diambil dengan tanggal mundur (D-06)?
4. Siapa saja yang diberi hak ambil nomor per unit (diisi HC lewat layar, bukan keputusan kode).
