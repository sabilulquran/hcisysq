# Kepanitiaan

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** ORG-012
**Tanggal:** 2026-11-03
**Terkait:** ORG-004 (struktur organisasi dan kewenangan), EMP-005 D-06 (penempatan `ADDITIONAL`), DOC-001 (register surat terbit dan penomoran), CAL-001 (undangan rapat), NOTIF-004 (notifikasi in-app), PERF-001 (penilaian kinerja), AUTH-011, ENG-LIST-001
**Rujukan:** `docs/product/feature-parity.yaml` (ORG-012), `docs/product/legacy-parity-audit-2026-11-02.md`

## 1. Tujuan

Sekolah dan pondok di YSQ menjalankan banyak **kepanitiaan** yang berumur pendek dan lintas unit: PPDB/SPMB, ujian, wisuda, kegiatan Ramadhan, dan acara lain. HCIS legacy (Laravel `hcysq/hcis-ysq`: `Committee`, `CommitteeMember`, `CommitteeService`, rute `committees/*`) mencatatnya. Paket 1 membawa pencatatan itu ke HCIS:

- HC mencatat kepanitiaan: nama kegiatan, jenis, periode, penyelenggara, dan **susunan panitia** (ketua, wakil, sekretaris, bendahara, koordinator seksi, anggota) dari pegawai aktif;
- penetapan kepanitiaan disertai **SK panitia bernomor** dari register surat DOC-001, atau mencatat nomor SK yang terbit di luar HCIS;
- perubahan susunan setelah penetapan dan seluruh tindakan HC tercatat sebagai **riwayat**;
- pegawai melihat **Kepanitiaan Saya** dan mencetak SK kepanitiaannya;
- anggota panitia dapat **mengundang seluruh panitia ke rapat** CAL-001 dengan satu pilihan;
- HC melihat **rekap keikutsertaan per pegawai** per tahun, sebagai bahan penilaian kinerja PERF-001.

## 2. Batas

**Kepanitiaan bukan struktur organisasi.** Ia tidak menulis ke tabel `organization_*`, tidak membuat unit atau jabatan, tidak membuat penempatan (`employment_placements`), dan **tidak memberi kewenangan approval** apa pun: ketua panitia tidak menjadi atasan anggota untuk cuti, lembur, atau persetujuan lain. Resolver kewenangan ORG-004 dan approval engine tidak membaca tabel kepanitiaan. Ini sengaja berbeda dari legacy, yang membuat "unit virtual" bertipe `committee` (catatan perencanaan ORG-012); membawa kepanitiaan ke struktur kewenangan membutuhkan ADR tersendiri.

Bedanya dengan **tugas tambahan** (penempatan `ADDITIONAL`, EMP-005 D-06): tugas tambahan adalah jabatan berulang yang melekat pada struktur (misalnya Pj. Media) dan dapat memengaruhi payroll; kepanitiaan adalah penugasan sementara untuk satu kegiatan dan tidak memengaruhi apa pun di luar modul ini.

Tidak termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Honor panitia | Payroll. Tidak ada nominal di modul ini (D-14). |
| Usulan kepanitiaan oleh unit dan persetujuannya di HCIS | Legacy punya alur usul → setujui. Paket 1 mencatat kepanitiaan yang sudah diputuskan (D-02); alur usulan lewat approval engine adalah kandidat Paket 2. |
| Anggaran, tugas/to-do panitia, notulen, laporan kegiatan | Manajemen proyek, di luar lingkup HCIS. |
| Anggota dari luar pegawai (siswa, wali, relawan) | Hanya Employee yang dapat menjadi anggota (D-06). |
| Penilaian kinerja otomatis dari keikutsertaan | Rekap disediakan untuk dibaca HC dan penilai (D-13); PERF-001 tidak menghitung skor darinya. |
| Unit virtual dan kode surat per kepanitiaan (legacy) | Lihat Batas di atas; SK memakai register DOC-001 (D-08). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Jenis kepanitiaan** dari daftar tetap: `ADMISSION` (PPDB/SPMB), `EXAM` (Ujian), `GRADUATION` (Wisuda), `RAMADAN` (Kegiatan Ramadhan), `EVENT` (Acara/kegiatan lain), `OTHER` (Lainnya). Dijaga CHECK database dan validasi API. | DRAFT |
| D-02 | **Hanya HC yang mencatat** kepanitiaan di Paket 1 (izin `committees.manage`). Keputusan membentuk panitia tetap diambil pejabat di luar HCIS; HCIS mencatat dan menerbitkan SK-nya. | DRAFT |
| D-03 | **State:** `DRAFT` → `ACTIVE` (ditetapkan) → `COMPLETED` (selesai); `DRAFT` atau `ACTIVE` → `CANCELLED` (batal). Tidak ada penghapusan permanen. Draf tidak terlihat oleh pegawai. | DRAFT |
| D-04 | **Periode:** tanggal mulai dan selesai (tanggal kalender WIB), selesai ≥ mulai, paling lama **366 hari**. Kepanitiaan yang periodenya sudah lewat **boleh** dicatat (untuk memasukkan riwayat), asal SK-nya dicatat sebagai SK di luar HCIS atau diterbitkan sekarang. | DRAFT |
| D-05 | **Peran panitia:** `CHAIR` (Ketua), `VICE_CHAIR` (Wakil Ketua), `SECRETARY` (Sekretaris), `TREASURER` (Bendahara), `SECTION_COORDINATOR` (Koordinator Seksi), `MEMBER` (Anggota). Seksi adalah teks bebas 2–100 karakter (misalnya "Seksi Acara"), **wajib** untuk Koordinator Seksi dan opsional untuk peran lain. Tepat **satu Ketua aktif** per kepanitiaan; peran lain boleh lebih dari satu (misalnya Sekretaris 1 dan 2). Satu pegawai hanya memegang satu peran aktif dalam satu kepanitiaan. | DRAFT |
| D-06 | **Anggota** adalah Employee berstatus aktif saat ditambahkan. Pegawai yang kemudian keluar tetap tercatat di riwayat. Satu kepanitiaan paling banyak **300 anggota aktif**. | DRAFT |
| D-07 | **Syarat penetapan** (`DRAFT` → `ACTIVE`): ada tepat satu Ketua, paling sedikit **dua anggota aktif**, dan semua anggota masih pegawai aktif. | DRAFT |
| D-08 | **SK panitia** ditetapkan dengan salah satu cara: (a) **terbit di HCIS** — satu baris di register surat DOC-001 (`hr_issued_documents`, jenis `COMMITTEE`, kode nomor `SKP`), nomor `<urut>/SKP/YSQ/<bulan-romawi>/<tahun>` dialokasikan saat penetapan, tidak pernah didaur ulang (DOC-001 D-02/D-03), pemilik baris register adalah Ketua; atau (b) **SK di luar HCIS** — HC mencatat nomor (3–100 karakter) dan tanggal SK yang sudah ditandatangani di atas kertas; HCIS tidak mengalokasikan nomor. | DRAFT |
| D-09 | **Penandatangan SK terbit di HCIS: Ketua Yayasan atau Direktur. Kepala Human Capital Management menjadi tembusan**, bukan penandatangan atau cadangan. Keputusan owner 2026-11-03: "Ketua Yayasan / Direktur. HCM tembusan aja". Ini pengecualian dari DOC-001 D-05 khusus SK panitia. Mekanisme (DRAFT): (1) **HC memilih** penandatangan saat menetapkan, bawaannya **Ketua Yayasan**. Tidak ada cadangan otomatis, sehingga SK tidak pernah diam-diam ditandatangani pejabat lain. (2) Pemegang jabatan dibaca dari struktur ORG-004 yang terbit dan berlaku hari ini. **Ketua Yayasan** adalah jabatan berjudul "Ketua Yayasan", atau "Ketua" di unit "Dewan Pengurus"/"Pengurus Yayasan", yang dipegang akun Organ Yayasan (`FOUNDATION_BOARD`, aktif, ORG-013) atau pegawai aktif. **Direktur** memakai pencarian DOC-001 (struktur, lalu field jabatan lama). (3) Akun Organ Yayasan tidak punya nama di HCIS, jadi HC **mengetik nama Ketua Yayasan** sebagaimana tertulis di SK (2–120 karakter). Formulir mengisikan usulan hanya dari nama yang diketik HC pada SK panitia terakhir yang ditandatangani **akun yang sama**. Akun pemegang dicatat di audit `committee.activated`, yang hanya dibaca HC. Pemegang baru mulai dengan kolom kosong, sehingga nama pendahulunya tidak pernah diusulkan. Pemegang yang berstatus pegawai selalu memakai namanya sendiri. (4) Penandatangan tidak pernah Ketua panitia itu sendiri. Pemeriksaan ini membandingkan pegawai, sehingga bila orang di balik akun Organ juga pegawai yang menjadi Ketua panitia, HCIS tidak dapat mengenalinya. Invarian ORG-013-1 butir 4 (anggota organ yang juga pegawai tidak memegang akun Organ aktif) yang mencegah keadaan itu. Jabatan yang kosong atau dipegang Ketua panitia ditolak 409 `DOCUMENT_SIGNER_UNAVAILABLE`. Nama yang kosong ditolak 400 `INVALID_COMMITTEE`. Dalam kedua kasus nomor tidak terpakai dan kepanitiaan tetap `DRAFT`. (5) **Tembusan** "Kepala Human Capital Management" disimpan di snapshot SK (`carbonCopies`) dan tercetak di bagian Tembusan. (6) **SK yang sudah terbit tidak berubah.** Penandatangan dan isi SK adalah snapshot saat terbit (DOC-001 D-15). SK yang terbit sebelum aturan ini tetap tercetak dengan penandatangan aslinya (Kepala HCM atau Direktur) dan tanpa Tembusan. | ACCEPTED (owner 2026-11-03); mekanisme `DRAFT` |
| D-10 | **Perubahan setelah penetapan:** HC boleh menambah anggota, mengubah peran/seksi, dan mengakhiri tugas anggota; mengubah keterangan, penyelenggara, dan **tanggal selesai** (memperpanjang atau memperpendek, tidak sebelum tanggal mulai). Nama, jenis, dan tanggal mulai terkunci karena tertulis di SK. SK **tidak** diterbitkan ulang; perubahan tercatat di riwayat dan tampil di daftar anggota. | DRAFT |
| D-11 | **Mengakhiri tugas anggota:** di `DRAFT` anggota dihapus dari draf (tidak ada riwayat keanggotaan karena belum ditetapkan, tetapi audit event tetap ditulis); di `ACTIVE` keanggotaan diberi tanggal akhir (hari ini WIB, tidak sebelum tanggal bergabung) dan alasan opsional, lalu tetap tampil sebagai riwayat. Ketua hanya dapat diakhiri setelah peran Ketua dipindahkan ke anggota lain. Tanggal bergabung anggota yang ditambahkan setelah penetapan = hari ini, dibatasi ke dalam periode kepanitiaan (tidak sebelum tanggal mulai, tidak sesudah tanggal selesai), sehingga anggota yang ditambahkan belakangan pada kepanitiaan lampau tetap terhitung di tahunnya. | DRAFT |
| D-12 | **Selesai dan batal:** `ACTIVE` → `COMPLETED` kapan saja oleh HC; keanggotaan yang masih terbuka ditutup pada minimum(hari ini, tanggal selesai). `CANCELLED` membutuhkan alasan 10–500 karakter; bila SK terbit di HCIS, SK itu ikut **dicabut** (`REVOKED`) dengan alasan yang sama dan nomornya tetap terpakai. Saat selesai atau batal, keanggotaan yang masih terbuka diberi tanggal akhir, termasuk anggota draf yang dibatalkan (tampil di riwayat anggota admin; pegawai tidak pernah melihat draf). Kepanitiaan batal yang pernah ditetapkan tetap terlihat oleh anggotanya dengan label "Dibatalkan" dan **tidak** dihitung di rekap. Pembatalan SK hanya lewat pembatalan kepanitiaan, bukan tombol Batalkan di register DOC (sama seperti surat tugas TRIP-001). | DRAFT |
| D-13 | **Rekap keikutsertaan** per pegawai per tahun takwim: jumlah kepanitiaan `ACTIVE`/`COMPLETED` yang periode keanggotaannya beririsan dengan tahun itu, jumlah sebagai Ketua, jumlah sebagai pengurus inti (Ketua, Wakil, Sekretaris, Bendahara), dan jumlah yang sedang berjalan. Rekap dibaca HC (`committees.read`); Peran yang dihitung adalah peran terakhir pada keanggotaan itu: Ketua yang perannya dipindahkan di tengah jalan terhitung sebagai Anggota. PERF-001 dapat merujuknya, tetapi tidak menghitung skor darinya di Paket 1. | DRAFT |
| D-14 | **Tidak ada data gaji atau honor** di kepanitiaan, SK, rekap, maupun audit. | ACCEPTED |
| D-15 | **Pegawai** melihat kepanitiaan yang pernah ia ikuti (bukan draf). Di detailnya ia melihat susunan panitia lengkap (nama, unit, peran, seksi, tanggal bergabung/berakhir) dan SK. Alasan berakhirnya tugas anggota hanya untuk HC. Bukan anggota mendapat 404 seperti kepanitiaan yang tidak ada. Tidak ada email, telepon, atau NIP anggota lain. | DRAFT |
| D-16 | **Undang panitia ke rapat (CAL-001):** pada formulir rapat, pegawai yang menjadi anggota aktif kepanitiaan `ACTIVE` dapat memilih kepanitiaan itu dan seluruh anggota aktif lainnya masuk ke daftar peserta sekaligus. Ini hanya pengisian daftar peserta; semua aturan CAL-001 (cek bentrok, batas 200 peserta, notifikasi) tetap berlaku; formulir memperingatkan bila daftar peserta melewati 200 dan rapat tidak menyimpan tautan ke kepanitiaan. | DRAFT |
| D-17 | **Notifikasi in-app** (NOTIF-004, kategori `system`): saat kepanitiaan ditetapkan → semua anggota aktif; anggota ditambahkan atau perannya berubah setelah penetapan → anggota itu; tugas diakhiri → anggota itu; kepanitiaan dibatalkan setelah penetapan → semua anggota yang masih aktif. Tidak ada WhatsApp di Paket 1. | DRAFT |
| D-18 | **Izin:** `committees.read` (membaca daftar, detail, riwayat, rekap) dan `committees.manage` (semua tindakan tulis dan pencarian pegawai), keduanya untuk `human_capital_admin`. Super Admin tidak memperolehnya lewat kompatibilitas legacy. Pegawai tidak membutuhkan izin untuk Kepanitiaan Saya. | DRAFT |
| D-19 | Penulisan membawa `version` yang dibaca (optimistic concurrency); versi berbeda dijawab 409 `COMMITTEE_STALE`. | DRAFT |

## 4. Actor

| Actor | Kemampuan |
| --- | --- |
| Pemegang `committees.manage` (HC Admin) | Mencatat, mengubah, menetapkan (menerbitkan atau mencatat SK), menyelesaikan, membatalkan kepanitiaan; mengelola anggota; mencari pegawai. |
| Pemegang `committees.read` (HC Admin) | Membaca daftar, detail, riwayat, dan rekap keikutsertaan. |
| Pegawai (sesi `EMPLOYEE` dengan Employee aktif) | Melihat Kepanitiaan Saya dan detailnya, mencetak SK, mengundang panitia ke rapat. |

Akun tanpa Employee aktif mendapat 403 `EMPLOYEE_NOT_ACTIVE` di ruang pegawai. Pengurus Yayasan dan Super Admin legacy tidak memakai layar ini.

## 5. Alur dan state

### 5.1 State kepanitiaan

| Dari | Tindakan | Ke | Syarat dan efek |
| --- | --- | --- | --- |
| — | Catat | `DRAFT` | Input §5.2. |
| `DRAFT` | Ubah | `DRAFT` | Semua field §5.2; tanggal bergabung anggota draf mengikuti tanggal mulai baru. |
| `DRAFT` | Tetapkan | `ACTIVE` | D-07; SK menurut D-08/D-09 dalam transaksi yang sama; notifikasi D-17. |
| `ACTIVE` | Ubah | `ACTIVE` | Hanya field D-10. |
| `ACTIVE` | Selesaikan | `COMPLETED` | Keanggotaan terbuka ditutup (D-12). |
| `DRAFT`/`ACTIVE` | Batalkan | `CANCELLED` | Alasan wajib; SK HCIS dicabut (D-12). |
| `COMPLETED`/`CANCELLED` | — | — | Final; semua tulis ditolak 409 `COMMITTEE_CLOSED`. |

### 5.2 Mencatat dan mengubah

Input: `name` (3–200), `category` (D-01), `description?` (≤ 2.000), `organizer?` (penyelenggara, teks 2–200, misalnya "SMP Sabilul Qur'an"), `startOn`, `endOn` (D-04); ubah membawa `version` (D-19).

### 5.3 Anggota

Tambah: `employeeId`, `role`, `section?` (D-05/D-06). Ubah: `role`, `section?`. Akhiri: `reason?` (≤ 300). Memindahkan Ketua dilakukan dengan mengubah peran anggota lain menjadi `CHAIR`: dalam satu transaksi Ketua lama otomatis menjadi `MEMBER` (tercatat di riwayat), sehingga D-05 tidak pernah dilanggar. Semua tindakan anggota menaikkan `version` kepanitiaan.

### 5.4 Penetapan

Input: `decree.mode` = `ISSUE` (terbit di HCIS) dengan `decree.signer` = `FOUNDATION_CHAIR` (Ketua Yayasan, bawaan) atau `DIRECTOR`, serta `decree.signerName` bila HCIS tidak mengetahui nama pemegangnya (D-09); atau `EXTERNAL` dengan `decree.number` dan `decree.date`. Keduanya membawa `version`. Untuk `ISSUE`, snapshot isi SK berisi nama, jenis, periode, penyelenggara, susunan panitia (nama, unit, peran, seksi) saat penetapan, dan tembusan. Snapshot tidak pernah memuat NIK, alamat, gaji, atau kontak (DOC-001 D-15). Penandatangan (jabatan dan nama) disimpan di baris register. Tanpa penandatangan sah: 409 `DOCUMENT_SIGNER_UNAVAILABLE`, dan nomor tidak terpakai karena transaksi dibatalkan. Detail admin kepanitiaan `DRAFT` membawa `decreeSignerOptions`: kedua jabatan, apakah dapat dipilih, nama pemegang atau usulan nama, dan apakah nama wajib diketik.

### 5.5 Kegagalan

| Kondisi | Respons |
| --- | --- |
| Tanpa izin | 403 `COMMITTEE_FORBIDDEN` |
| Kepanitiaan tidak ada (admin) atau bukan anggotanya (pegawai) | 404 `COMMITTEE_NOT_FOUND` |
| Input tidak valid | 400 `INVALID_COMMITTEE` / `INVALID_COMMITTEE_MEMBER` / `INVALID_COMMITTEE_FILTER` |
| Versi berbeda | 409 `COMMITTEE_STALE` |
| Status tidak mengizinkan tindakan | 409 `COMMITTEE_STATE` (atau `COMMITTEE_CLOSED` untuk status final) |
| Field terkunci setelah penetapan diubah | 409 `COMMITTEE_FIELD_LOCKED` |
| Pegawai tidak aktif / sudah anggota / batas anggota | 409 `COMMITTEE_EMPLOYEE_NOT_ACTIVE` / `COMMITTEE_DUPLICATE_MEMBER` / `COMMITTEE_MEMBER_LIMIT` |
| Kepanitiaan yang sudah ditetapkan akan kehilangan Ketua (peran Ketua diubah atau tugasnya diakhiri) | 409 `COMMITTEE_CHAIR_REQUIRED` |
| Syarat penetapan tidak terpenuhi | 409 `COMMITTEE_NOT_READY` dengan daftar alasan |
| Jabatan penandatangan yang dipilih kosong atau dipegang Ketua panitia | 409 `DOCUMENT_SIGNER_UNAVAILABLE` |
| Nama Ketua Yayasan (pemegang akun Organ) tidak diisi | 400 `INVALID_COMMITTEE` |

## 6. Permission

Migration `0135_committee_permissions.sql`, berscope organisasi.

| Permission | Pemegang | Catatan |
| --- | --- | --- |
| `committees.read` | HC Admin (`human_capital_admin`) | daftar, detail, riwayat, rekap |
| `committees.manage` | HC Admin (`human_capital_admin`) | semua tindakan tulis, pencarian pegawai |

`committees.manage` tanpa `committees.read` tidak membuka layar admin; keduanya selalu diberikan bersama. Kepanitiaan Saya hanya membutuhkan sesi `EMPLOYEE` dengan Employee aktif; aksesnya adalah keanggotaan, bukan permission.

## 7. Audit dan privasi

Tabel `committee_audit_events` (append-only): `committee.created`, `committee.updated` (metadata: field yang berubah, nilai lama/baru), `committee.member.added`, `committee.member.updated` (peran/seksi lama/baru), `committee.member.removed` (draf) / `committee.member.ended` (setelah penetapan), `committee.activated` (cara SK, nomor, serta jabatan, nama, dan id akun Organ pemegang jabatan penandatangan untuk SK terbit di HCIS), `committee.completed`, `committee.cancelled` (alasan), `committee.decree.revoked`. Penerbitan dan pencabutan SK HCIS juga menulis `doc.issued`/`doc.revoked` di log register DOC-001 dengan `source: "ORG-012"`; `doc.issued` membawa jabatan dan nama penandatangan. Metadata hanya berisi nama kegiatan, id dan nama pegawai, peran, seksi, tanggal, nomor SK, serta jabatan dan nama penandatangan — tidak ada gaji, NIK, atau kontak.

## 8. Penyimpanan

```text
committees                id, name, category, description, organizer, start_on, end_on, status, version,
                          decree_mode (ISSUED|EXTERNAL), issued_document_id -> hr_issued_documents,
                          external_decree_number, external_decree_date, activated_at, completed_at,
                          cancelled_at, cancel_reason, created_by/updated_by_account_id, timestamps
committee_members         id, committee_id, employee_id, role, section, joined_on, left_on, end_reason,
                          added_by_account_id, timestamps
committee_audit_events    id, event_type, committee_id, employee_id, actor_account_id, reason, metadata, occurred_at
```

- `committee_members`: unik parsial `(committee_id, employee_id) WHERE left_on IS NULL` dan `(committee_id) WHERE role = 'CHAIR' AND left_on IS NULL`; indeks `(employee_id, joined_on)` untuk Kepanitiaan Saya dan rekap.
- `hr_issued_documents.document_kind` CHECK diperluas dengan `COMMITTEE`. Daftar register DOC dan surat milik pegawai tetap memfilter jenisnya sendiri, dan rute Batalkan register DOC menolak jenis `COMMITTEE` seperti `ASSIGNMENT`.
- Migration `0134_committees.sql` (aditif) dan `0135_committee_permissions.sql`. Rollback ditulis di kepala masing-masing file; data kepanitiaan dapat dihapus tanpa memengaruhi modul lain karena tidak ada modul lain yang membacanya, kecuali baris register `COMMITTEE` yang dipertahankan (nomor tidak didaur ulang).

## 9. API

Kontrak lengkap: `docs/api/committees.openapi.yaml`.

| Metode | Path | Izin |
| --- | --- | --- |
| GET | `/admin/committees?status=&category=&year=&q=&page=&pageSize=` | `committees.read` |
| POST | `/admin/committees` | `committees.manage` |
| GET | `/admin/committees/{id}` (detail, anggota, SK, pilihan penandatangan untuk draf) | `committees.read` |
| GET | `/admin/committees/{id}/history?page=&pageSize=` | `committees.read` |
| PATCH | `/admin/committees/{id}` | `committees.manage` |
| POST | `/admin/committees/{id}/members` | `committees.manage` |
| PATCH | `/admin/committees/{id}/members/{memberId}` | `committees.manage` |
| POST | `/admin/committees/{id}/members/{memberId}/end` | `committees.manage` |
| POST | `/admin/committees/{id}/activate` | `committees.manage` |
| POST | `/admin/committees/{id}/complete` | `committees.manage` |
| POST | `/admin/committees/{id}/cancel` | `committees.manage` |
| GET | `/admin/committees/employee-options?q=` | `committees.manage` |
| GET | `/admin/committees/participation?year=&q=&page=&pageSize=` | `committees.read` |
| GET | `/admin/committees/participation/{employeeId}?year=&page=&pageSize=` | `committees.read` |
| GET | `/me/committees?scope=current|history&page=&pageSize=` | sesi pegawai |
| GET | `/me/committees/{id}` | anggota |
| GET | `/me/committees/meeting-groups` | sesi pegawai (D-16) |

Daftar mengikuti ENG-LIST-001 §3.1 (bawaan 25, maks 100, filter sebelum `LIMIT`, `total` dengan filter yang sama). Susunan panitia di detail adalah daftar terbatas (D-06, maks 300 aktif ditambah riwayatnya) dan dikembalikan utuh; riwayat audit punya rute berhalaman sendiri, terbaru dulu. Pencarian pegawai: typeahead minimal 2 huruf, maks 20 hasil, nama + nomor pegawai + unit. `meeting-groups` paling banyak 20 kepanitiaan aktif milik pegawai itu, masing-masing dengan anggota aktif selain dirinya dalam bentuk opsi peserta CAL-001.

## 10. Layar

- **Admin → Kepanitiaan** (`/admin/committees`): tab status, filter jenis dan tahun, pencarian nama, daftar berhalaman selebar halaman; detail satu kepanitiaan terbuka sebagai pop-up (`?panitia=<id>`, formulir Catat kepanitiaan `?panitia=baru`; aturan SQ Core "Detail views open as a pop-up") berisi data kegiatan, susunan panitia (tambah lewat typeahead pegawai, ubah peran/seksi, akhiri tugas), SK (nomor, penandatangan, tombol Cetak SK), tombol Tetapkan/Selesaikan/Batalkan, dan riwayat. Formulir Tetapkan memuat pilihan penandatangan (Ketua Yayasan terpilih bila tersedia, atau Direktur) dan kolom nama Ketua Yayasan bila diperlukan (D-09). Jabatan yang tidak dapat dipilih tampil nonaktif beserta alasannya. Bila tidak ada satu pun yang dapat dipilih, tombol Tetapkan untuk SK HCIS nonaktif dan cara SK di luar HCIS tetap tersedia. Cetakan SK memuat bagian Tembusan. Tab **Rekap keikutsertaan**: per tahun, pencarian nama, daftar berhalaman, rincian kepanitiaan per pegawai dalam pop-up (`?rekap=<employeeId>`).
- **Pegawai → Kepanitiaan Saya** (`/app/committees`): tab Berjalan dan Riwayat; detail dengan susunan panitia dan Cetak SK.
- **Kalender → Buat undangan rapat**: pilihan "Undang panitia" bila pegawai sedang menjadi anggota kepanitiaan aktif (D-16).
- Semua layar punya keadaan memuat, kosong, galat, dan terlarang (403), serta tata letak satu kolom di layar ponsel.

## 11. Acceptance criteria

- ORG-012-A: tanpa `committees.read`, semua rute admin baca menjawab 403; tanpa `committees.manage`, semua rute admin tulis menjawab 403; Super Admin legacy tidak membukanya.
- ORG-012-B: penetapan tanpa Ketua, dengan kurang dari dua anggota, atau dengan anggota tidak aktif ditolak 409 `COMMITTEE_NOT_READY` dan tidak memakan nomor SK.
- ORG-012-C: penetapan `ISSUE` menulis satu baris register `COMMITTEE` bernomor `…/SKP/YSQ/…`; dua penetapan berurutan mendapat nomor berbeda; penetapan `EXTERNAL` tidak menulis ke register.
- ORG-012-D: pembatalan kepanitiaan yang SK-nya terbit di HCIS mencabut SK itu (`REVOKED`) dengan alasan yang sama; rute Batalkan register DOC menolak SK panitia.
- ORG-012-E: hanya satu Ketua aktif; memindahkan Ketua menurunkan Ketua lama menjadi Anggota dalam transaksi yang sama.
- ORG-012-F: pegawai hanya melihat kepanitiaan non-draf yang ia ikuti; selain itu 404.
- ORG-012-G: modul tidak menulis ke tabel `organization_*`, `employment_*`, atau kewenangan approval (diuji).
- ORG-012-H: setiap tindakan tulis menulis audit event menurut §7: satu per tindakan, ditambah satu untuk Ketua yang diturunkan saat pemindahan Ketua dan satu `committee.decree.revoked` saat pembatalan mencabut SK HCIS.
- ORG-012-I: rekap menghitung hanya kepanitiaan `ACTIVE`/`COMPLETED` yang beririsan dengan tahun yang diminta.
- ORG-012-J: `meeting-groups` hanya memuat kepanitiaan `ACTIVE` tempat pemanggil menjadi anggota aktif, tanpa dirinya sendiri.
- ORG-012-K: versi lama ditolak 409 `COMMITTEE_STALE`.
- ORG-012-L (D-09): SK terbit di HCIS ditandatangani Ketua Yayasan (bawaan) atau Direktur sesuai pilihan HC, tidak pernah Kepala HCM dan tidak pernah Ketua panitia. Kepala HCM tercantum di Tembusan. Ketua Yayasan yang dipegang akun Organ wajib disertai nama dari HC. Jabatan yang kosong tidak memakan nomor. SK yang terbit sebelumnya tetap dengan penandatangan dan isi aslinya (diuji).

## 12. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

1. Hanya HC yang mencatat kepanitiaan; unit belum dapat mengusulkan lewat HCIS (D-02).
2. Daftar jenis kepanitiaan (D-01) dan peran panitia (D-05).
3. **Diputuskan owner 2026-11-03 (D-09):** SK panitia ditandatangani Ketua Yayasan atau Direktur, dengan Kepala HCM sebagai tembusan. Register DOC-001 dengan kode `SKP` tetap dipakai. SK yang ditandatangani Kepala Sekolah tetap dicatat sebagai SK di luar HCIS (D-08 cara b). Mekanisme yang masih DRAFT: HC memilih penandatangan dengan Ketua Yayasan sebagai bawaan, tanpa cadangan otomatis, dan HC mengetik nama Ketua Yayasan karena akun Organ tidak punya nama di HCIS.
4. Syarat penetapan: satu Ketua dan minimal dua anggota (D-07).
5. Perubahan susunan setelah penetapan tidak menerbitkan SK baru (D-10).
6. Anggota melihat susunan panitia lengkap (D-15).
7. Rekap per tahun takwim, bukan tahun ajaran (D-13).
