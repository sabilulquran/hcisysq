# Dokumen Kepegawaian — Surat Keterangan dan Surat Peringatan

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Keputusan aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** DOC-001 (surat keterangan), DOC-002 (surat peringatan)
**Tanggal:** 2026-10-27
**Terkait:** EMP-005, EMP-006, EMP-010, NOTIF-004, APR-001, PAYSLIP-005, ORG-004, AUTH-011
**Roadmap:** `docs/product/roadmap.md` §G, `docs/product/hcis-capability-map.md` §5

## 1. Tujuan

Human Capital YSQ rutin mengeluarkan dua jenis dokumen yang hari ini dibuat manual di luar sistem:

1. **Surat keterangan** atas permintaan pegawai (keterangan kerja, keterangan penghasilan, paklaring) — DOC-001;
2. **Surat peringatan** atas keputusan organisasi — DOC-002.

Yang dituju:

- pegawai meminta surat dari HCIS dan melihat statusnya, tanpa pesan WhatsApp ke HC;
- setiap surat yang terbit punya **nomor yang unik dan tidak dapat didaur ulang**, pejabat penandatangan yang sah, dan jejak audit;
- surat peringatan punya **masa berlaku** yang jelas dan tanda terima pegawai;
- isi surat diturunkan dari fakta kepegawaian yang sudah ada (EMP-005/EMP-006), bukan diketik ulang.

## 2. Batas dokumen

Termasuk (Paket 1):

- jenis surat keterangan kerja dan paklaring;
- alur permintaan → keputusan HC → penerbitan → unduh/cetak;
- register nomor surat;
- surat peringatan SP-1/SP-2/SP-3 dengan masa berlaku dan tanda terima;
- notifikasi in-app melalui NOTIF-004.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Perjanjian Kerja dan Surat Keputusan | Milik EMP-010; register dokumen dasar tindakan kepegawaian, bukan surat layanan. DOC-001/DOC-002 tidak menulis ke register EMP-010. |
| Ijazah, sertifikat, dokumen kualifikasi pegawai | Milik EMP-007/EMP-008. |
| Surat keterangan penghasilan | Butuh angka payroll otoritatif. **Ditunda ke Paket 2**, setelah PAY-003 punya hasil payroll final. Jenisnya sudah disediakan di katalog tetapi tidak aktif. |
| Unggah berkas dari pegawai | Paket 1 tidak menerima attachment. Object storage dan pemindaian berkas adalah keputusan terpisah. |
| Tanda tangan elektronik bersertifikat | Paket 1 memakai blok penandatangan tercetak, sama seperti PAYSLIP-005. |
| Akses mandiri pegawai non-aktif | Endpoint self HCIS mensyaratkan pegawai dan akun yang aktif. Paklaring karena itu diterbitkan HC dan diserahkan di luar sistem pada Paket 1; ini batas yang diketahui, bukan cacat. |
| Pengiriman email/WhatsApp | NOTIF-001 adapter eksternal, terpisah. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Surat terbit sebagai **dokumen yang dirender HCIS** dari data kepegawaian, bukan berkas yang diunggah HC. | ACCEPTED |
| D-02 | Nomor surat dialokasikan **hanya pada saat penerbitan**, bukan saat permintaan dibuat, supaya permintaan yang ditolak tidak memakan nomor. | ACCEPTED |
| D-03 | Nomor surat **tidak dapat didaur ulang**. Surat yang dibatalkan setelah terbit tetap memegang nomornya dan berstatus `REVOKED`. | ACCEPTED |
| D-04 | Format nomor: `<urut>/<kode-jenis>/YSQ/<bulan-romawi>/<tahun>`, urut per jenis per tahun takwim. | DRAFT |
| D-05 | Penandatangan surat keterangan: **Kepala Human Capital Management**, fallback **Direktur**, tanpa self-sign — sama persis dengan resolver PAYSLIP-005. | ACCEPTED |
| D-06 | Surat keterangan kerja boleh diminta pegawai **aktif**; paklaring hanya untuk pegawai yang hubungan kerjanya sudah berakhir. | DRAFT |
| D-07 | Permintaan surat keterangan memakai **keputusan satu langkah oleh HC**, bukan rantai approval APR-001. Alasan: surat keterangan tidak mengubah hak atau uang. | DRAFT |
| D-08 | Pegawai boleh punya **maksimal 3 permintaan terbuka** sekaligus, untuk mencegah spam. | DRAFT |
| D-09 | Surat peringatan **tidak** dapat diminta pegawai. Hanya HC yang menerbitkan, dan selalu dengan alasan tertulis. | ACCEPTED |
| D-10 | Tingkat surat peringatan: `SP1`, `SP2`, `SP3`. Masa berlaku bawaan **6 bulan** sejak tanggal berlaku. | DRAFT |
| D-11 | Sistem **tidak** memaksa urutan SP1 → SP2 → SP3, tetapi memperingatkan bila ada SP aktif tingkat lebih tinggi atau bila tingkat melompat. Keputusan tetap pada HC. | DRAFT |
| D-12 | Pegawai **wajib** melihat SP-nya dan dapat menekan "Saya telah membaca". Tanda terima dicatat dengan waktu; ketiadaan tanda terima tidak membatalkan SP. | DRAFT |
| D-13 | Surat peringatan hanya terlihat oleh pegawai ybs dan pemegang `documents.discipline.manage`. **Atasan tidak otomatis melihat**nya di Paket 1. Sejak migrasi 0102 izin itu dibawa `human_capital_admin`, karena di YSQ administrator HC-lah yang menerbitkan surat peringatan; tidak ada role bercakupan unit yang membawanya. | DRAFT (revisi 2026-10-27) |
| D-14 | Pembatalan SP yang sudah terbit butuh permission terpisah `documents.correct` dan alasan; nilai lama tetap tersimpan. | ACCEPTED |
| D-15 | Isi surat tidak boleh memuat gaji, NIK lengkap, nomor rekening, data medis, atau alamat rumah. Nomor identitas ditampilkan tersamar bila diperlukan. | ACCEPTED |
| D-16 | `documents.correct` dibawa role tersendiri `document_corrector`, bukan bundel mana pun. Konsekuensi yang **disengaja**: pemegangnya dapat membatalkan surat peringatan yang tidak dapat ia baca isinya, karena pembatalan adalah tindakan atas register (nomor dan status), bukan atas isi surat. Alasan pembatalan wajib dan tercatat di audit. | ACCEPTED (2026-10-27) |
| D-18 | Register surat terbit memuat surat peringatan untuk pemegang `documents.read`, tetapi **hanya fakta register**: nomor, tingkat (sudah tersirat di nomor), status, tanggal terbit, serta waktu dan alasan pembatalan. Identitas pegawai, perihal, uraian, dan snapshot isi SP **tidak** ikut, sehingga D-13 tetap berlaku: pemegang `document_corrector` mengenali SP dari nomornya saja. Pemegang `documents.discipline.manage` tetap melihat identitas dan perihal di daftar surat peringatan. | DRAFT (2026-11-02) |
| D-19 | SP yang sudah ditandai dibaca, atau yang masa berlakunya sudah lewat, **tetap dapat dibatalkan**. Tanda terima dan kedaluwarsa bukan status tersimpan register (§5.2), jadi keduanya tidak mengunci pembatalan; yang mengunci hanya status `REVOKED`. | DRAFT (2026-11-02) |
| D-17 | Setiap migrasi yang menambahkan izin ke sebuah role harus dijalankan **setelah** build yang mengenal kunci izin itu berjalan. `canDelegateRole` menolak role yang membawa izin di luar allowlist-nya, sehingga build lama akan menolak pemberian/pencabutan role tersebut selama jendela antara migrasi dan restart. | ACCEPTED (2026-10-27) |

## 4. Objek

```text
DocumentRequest (DOC-001)
  -> keputusan HC
  -> IssuedDocument (nomor, penandatangan, snapshot isi)

DisciplinaryLetter (DOC-002)
  -> IssuedDocument (nomor, penandatangan, snapshot isi)
  -> acknowledgement pegawai
```

`IssuedDocument` adalah satu register bersama untuk kedua jenis, dibedakan `document_kind`. Sejak TRIP-001 register ini juga memuat surat tugas (`ASSIGNMENT`, kode nomor `ST`); surat tugas hanya dicabut lewat pembatalan perjalanan, bukan lewat tombol Batalkan register (`docs/domain/business-travel.md` D-14).

### 4.1 Snapshot isi

Saat diterbitkan, surat menyimpan **snapshot** fakta yang dipakainya (nama, jabatan, unit, tanggal mulai kerja, status kepegawaian). Perubahan data pegawai sesudahnya tidak mengubah surat yang sudah terbit. Ini mengikuti pola snapshot-on-submit `docs/domain/workflows/approval-engine.md`.

### 4.2 Jenis surat keterangan (katalog)

| Kode | Nama | Untuk | Paket |
| --- | --- | --- | --- |
| `KETERANGAN_KERJA` | Surat Keterangan Kerja | Pegawai aktif | 1 |
| `PAKLARING` | Surat Keterangan Pengalaman Kerja | Hubungan kerja berakhir | 1 |
| `KETERANGAN_PENGHASILAN` | Surat Keterangan Penghasilan | Pegawai aktif | 2 (tidak aktif) |

Katalog disimpan sebagai data, bukan `enum` kode, supaya jenis baru tidak memerlukan rilis.

## 5. Status

### 5.1 Permintaan surat keterangan

```text
SUBMITTED -> APPROVED -> ISSUED
          -> REJECTED
SUBMITTED -> CANCELLED   (oleh pegawai, selama masih SUBMITTED)
```

`APPROVED` dan `ISSUED` dipisah supaya penerbitan yang gagal (misalnya tidak ada penandatangan eligible) tidak menghilangkan keputusan HC. HC dapat mencoba menerbitkan ulang; nomor baru dialokasikan hanya ketika penerbitan berhasil.

### 5.2 Surat peringatan

```text
ISSUED -> ACKNOWLEDGED      (pegawai menekan tanda terima)
ISSUED -> REVOKED           (documents.correct)
ISSUED/ACKNOWLEDGED -> EXPIRED  (turunan tanggal, bukan state tersimpan)
```

`EXPIRED` **dihitung dari tanggal**, tidak disimpan sebagai kolom status, supaya tidak ada job yang wajib berjalan agar data benar.

## 6. Permission

| Permission | Arti |
| --- | --- |
| `documents.read` | Melihat register surat dan permintaan seluruh pegawai |
| `documents.manage` | Memutuskan permintaan surat keterangan dan menerbitkannya |
| `documents.discipline.manage` | Menerbitkan dan membaca surat peringatan |
| `documents.correct` | Membatalkan surat yang sudah terbit |

Bundel (migrasi 0094 dan 0102):

| Izin | Pembawa |
| --- | --- |
| `documents.read` | `human_capital_admin`, `document_corrector` |
| `documents.manage` | `human_capital_admin` |
| `documents.discipline.manage` | `human_capital_admin` (D-13 revisi) |
| `documents.correct` | `document_corrector` saja (D-16) |

Super Admin **tidak** menerima `documents.*` melalui kompatibilitas legacy. Role `document_corrector` hanya diberikan oleh Super Admin, dengan scope organisasi dan alasan penugasan.

Pegawai mengakses surat miliknya sendiri melalui endpoint self, bukan permission.

## 7. Audit

Setiap transisi menghasilkan audit event: `doc.request.submitted`, `doc.request.approved`, `doc.request.rejected`, `doc.request.cancelled`, `doc.issued`, `doc.revoked`, `doc.discipline.issued`, `doc.discipline.acknowledged`, `doc.discipline.revoked`.

Audit event memuat id surat, jenis, aktor, dan alasan bila ada. Audit **tidak** memuat isi naratif surat peringatan.

## 8. Notifikasi

Melalui `notifyEmployee` (NOTIF-004), kategori `system`:

- permintaan diputuskan (disetujui/ditolak) → pegawai;
- surat terbit dan siap diunduh → pegawai;
- surat peringatan terbit → pegawai, dengan judul netral dan tanpa isi naratif pada pratinjau;
- permintaan baru masuk → tidak ada notifikasi massal ke HC di Paket 1; HC melihat antrean di layarnya.

## 9. Penyimpanan

```text
hr_document_types          katalog jenis surat keterangan
hr_document_requests       permintaan pegawai
hr_issued_documents        register surat terbit (kedua jenis)
hr_document_numbers        alokasi nomor per jenis per tahun
hr_disciplinary_letters    detail surat peringatan
```

Aturan:

- `hr_issued_documents` unik pada `(number_code, number_year, number_sequence)` dan pada `document_number`;
- alokasi nomor menaikkan baris penghitung dengan `ON CONFLICT DO UPDATE` di dalam transaksi penerbitan; kunci baris eksklusifnya membuat penerbitan kedua menunggu, sehingga dua penerbitan bersamaan tidak memperoleh nomor yang sama;
- tanggal, bulan romawi, dan tahun nomor surat diturunkan dari zona **Asia/Jakarta**, bukan UTC, supaya surat yang terbit dini hari tidak memakai urutan tahun atau bulan sebelumnya;
- snapshot isi disimpan sebagai `jsonb` yang sudah tersaring (§D-15);
- tidak ada endpoint hapus.

Rencana rollback migrasi ditulis sebagai komentar `-- Down:` di berkas migrasi, mengikuti pola 0058.

## 10. Acceptance criteria

DOC-001:

- DOC-001-A: pegawai aktif dapat mengajukan surat keterangan kerja dan melihat statusnya; pegawai lain tidak dapat melihat permintaan itu.
- DOC-001-B: permintaan ke-4 yang masih terbuka ditolak (D-08).
- DOC-001-C: permintaan yang ditolak **tidak** memakan nomor surat.
- DOC-001-D: dua penerbitan bersamaan menghasilkan dua nomor berbeda, tanpa lompatan yang tidak tercatat.
- DOC-001-E: surat yang terbit menyimpan snapshot; mengubah jabatan pegawai sesudahnya tidak mengubah isi surat.
- DOC-001-F: penandatangan diselesaikan dengan aturan PAYSLIP-005; bila tidak ada kandidat eligible, penerbitan gagal dengan pesan jelas dan permintaan tetap `APPROVED`.
- DOC-001-G: paklaring ditolak untuk pegawai yang masih aktif (D-06).
- DOC-001-H: isi surat tidak memuat gaji, rekening, atau alamat rumah.
- DOC-001-I: jenis `KETERANGAN_PENGHASILAN` tidak dapat diajukan di Paket 1.

DOC-002:

- DOC-002-A: hanya pemegang `documents.discipline.manage` yang dapat menerbitkan dan membaca surat peringatan orang lain.
- DOC-002-B: pegawai melihat surat peringatan miliknya dan dapat menandainya telah dibaca; tanda terima tercatat dengan waktu.
- DOC-002-C: pegawai tidak dapat menandai tanda terima milik orang lain.
- DOC-002-D: SP dianggap berlaku hanya bila statusnya `ISSUED`, tanggal berlakunya sudah lewat, dan belum melewati tanggal berakhir — seluruhnya diturunkan saat dibaca, tanpa job terjadwal. SP yang dibatalkan tidak pernah tampil berlaku.
- DOC-002-E: menerbitkan SP1 saat ada SP2 aktif menghasilkan peringatan, bukan penolakan (D-11).
- DOC-002-F: pembatalan membutuhkan `documents.correct` dan alasan; nomor tetap terpakai. Alur layarnya di §12.
- DOC-002-G: pratinjau notifikasi tidak memuat isi naratif.
- DOC-002-H: atasan tanpa `documents.discipline.manage` tidak melihat SP bawahannya (D-13).
- DOC-002-I: `human_capital_admin` dapat menerbitkan dan membaca surat peringatan; `documents.correct` hanya dibawa `document_corrector` (D-16).
- DOC-001-J: dua pengajuan bersamaan dari satu pegawai tidak dapat menembus batas D-08.

## 11. Pertanyaan terbuka

Semua dijawab dengan default `DRAFT` di §3 supaya implementasi tidak berhenti. Yang perlu dikonfirmasi pemilik produk kemudian:

1. format nomor surat yang berlaku di YSQ (D-04);
2. masa berlaku surat peringatan (D-10);
3. apakah atasan langsung berhak melihat SP bawahannya (D-13);
4. apakah surat keterangan perlu persetujuan di atas HC untuk kasus tertentu (D-07);
5. siapa yang memegang role `document_corrector` di YSQ (D-16); sampai Super Admin memberikannya, pembatalan surat tidak tersedia bagi siapa pun dan tombolnya tidak ditampilkan;
6. apakah pemegang `document_corrector` perlu melihat nama pegawai pada SP di register (D-18), dan apakah pegawai perlu diberi notifikasi saat SP-nya dibatalkan (saat ini tidak; statusnya berubah di layar dokumen pegawai).

Follow-up yang diketahui, di luar paket ini: resolver penandatangan (`modules/documents/signer-authority.ts`, warisan PAYSLIP-005) masih memakai `current_date` basis data, sehingga masa jabatan penanda tangan berganti pada 00:00 UTC (07:00 WIB), bukan tengah malam Jakarta. Perbaikannya menyentuh slip gaji juga, jadi menjadi perubahan tersendiri.

## 12. Alur layar pembatalan surat (DOC-002-F)

Ditambahkan 2026-11-02. Sebelumnya aturan pembatalan hanya ada di API, sedangkan register di layar hanya memuat surat keterangan, sehingga pemegang `document_corrector` (yang tidak membawa `documents.discipline.manage`) tidak dapat menemukan SP yang hendak dibatalkan.

| Unsur | Isi |
| --- | --- |
| Aktor | Pemegang `documents.correct` (role `document_corrector`, D-16). |
| Prasyarat | Surat ada di register dengan status `ISSUED` (termasuk SP yang sudah dibaca atau kedaluwarsa, D-19). |
| Layar | `/admin/documents` (menu **Pegawai → Dokumen Kepegawaian**), bagian **Register surat terbit**, dengan tab **Surat keterangan** dan **Surat peringatan** serta filter status (semua, terbit, dibatalkan). `documents.read` membuka shell admin, karena `document_corrector` tidak membawa izin admin lain; tanpa itu shell memantulkan satu-satunya role yang boleh membatalkan. |
| Input | Alasan pembatalan, 10–500 karakter setelah dipangkas, wajib. |
| Transisi | `ISSUED -> REVOKED`; `revoked_at`, `revoked_by_account_id`, dan `revoke_reason` disimpan; nomor tetap terpakai (D-03) dan isi surat tidak diubah (D-14). |
| Permission | API memeriksa `documents.correct` di setiap panggilan. Layar hanya menyembunyikan tombol **Batalkan** dari akun tanpa izin itu; tidak ada keputusan otorisasi lain di frontend. |
| Audit | `doc.discipline.revoked` untuk SP, `doc.revoked` untuk surat keterangan; memuat id surat, pegawai, aktor, alasan, serta `documentCode` dan `documentNumber` di metadata. Isi naratif SP tidak pernah masuk audit (§7). |
| Kegagalan | Tanpa izin → `403 DOCUMENT_FORBIDDEN`; alasan kurang dari 10 karakter → `400 INVALID_DOCUMENT_REVOKE` dan dialog tetap terbuka dengan pesannya; surat sudah dibatalkan atau tidak ada → `409 DOCUMENT_NOT_REVOCABLE`, register dimuat ulang. |

Register (`GET /admin/documents/register`) mengikuti ENG-LIST-001 §3.1: `kind` (`CERTIFICATE` bawaan, atau `DISCIPLINARY`), `status` (`ISSUED`/`REVOKED`, opsional), `page`, `pageSize` (bawaan 25, maksimum 100); filter berjalan di SQL sebelum `LIMIT` dan `total` memakai filter yang sama. Baris SP tidak membawa identitas pegawai, signer, maupun snapshot isi (D-18). Tab, filter status, halaman, dan ukuran halaman disimpan di query string layar (`registerKind`, `registerStatus`, `registerPage`, `registerPageSize`).

Acceptance:

- DOC-002-F1: tombol **Batalkan** tampil hanya untuk pemegang `documents.correct` dan hanya pada surat berstatus terbit.
- DOC-002-F2: pemegang `documents.read` tanpa `documents.discipline.manage` melihat SP di register tanpa nama pegawai, perihal, maupun uraian.
- DOC-002-F3: dialog pembatalan tidak mengirim alasan kosong atau kurang dari 10 karakter; API tetap menolaknya dengan `400` bila dikirim langsung.
- DOC-002-F4: pembatalan menulis satu audit event berisi alasan, dan nomor surat yang dibatalkan tidak pernah dialokasikan ulang ke surat berikutnya.
- DOC-002-F5: surat yang dibatalkan tampil berstatus **Dibatalkan** beserta tanggal dan alasannya di register, dan sebagai **Dibatalkan** di daftar surat peringatan HC.
