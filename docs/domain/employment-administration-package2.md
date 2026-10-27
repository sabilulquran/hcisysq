# Administrasi Kepegawaian — Paket 2: Pendidikan, Keahlian, Keluarga, Alamat & Kontak

**Status:** ACCEPTED (Paket 2) — spesifikasi ini mengizinkan implementasi. Keputusan aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal; owner dapat mengubahnya kapan saja tanpa membongkar model data.
**Spesifikasi:** EMP-007 (pendidikan & kualifikasi), EMP-008 (keahlian & kompetensi), EMP-009 (keluarga & tanggungan), EMP-003 (perubahan data pegawai, untuk alamat/kontak)
**Tanggal:** 2026-10-27
**Terkait:** EMP-001, EMP-004, EMP-005, EMP-006, EMP-010, DOC-001/DOC-002, AUTH-011, NOTIF-004, PAY-003, TRAIN-001, PERF-001
**Induk:** `docs/domain/employment-administration.md` (ACCEPTED PRODUCT DIRECTION, 2026-09-22)
**Roadmap:** `docs/product/roadmap.md` §B, `docs/product/hcis-capability-map.md` §5
**Paket 1:** `docs/domain/employment-administration-package1.md` (EMP-005/EMP-006/EMP-010)

## 1. Tujuan

Paket 1 menjawab *apa hubungan kerja pegawai dan di mana ia ditempatkan*. Paket 2 menjawab *siapa pegawainya*: pendidikan yang ia selesaikan, keahlian dan sertifikat yang ia pegang, keluarga yang menjadi tanggungannya, serta alamat dan kontak yang dipakai HC untuk menghubunginya.

Hari ini semuanya hidup di satu kolom teks pada master pegawai (`employees.education`) atau di lembar kerja di luar sistem. Akibatnya:

- tidak ada riwayat: pegawai yang menyelesaikan S2 menimpa S1-nya;
- tidak ada tanggal berlaku: sertifikat yang kedaluwarsa tetap terlihat sah;
- tidak ada pembeda antara yang **dilaporkan pegawai** dan yang **sudah diverifikasi HC**;
- perubahan alamat datang lewat pesan WhatsApp dan diketik ulang oleh HC tanpa jejak.

Paket 2 memperbaiki keempatnya dengan pola yang sama seperti bagian HCIS lain: catatan yang berdiri sendiri, tanggal yang jelas, status verifikasi, dan audit — bukan kolom yang ditimpa.

## 2. Batas paket

Termasuk:

| Lingkup | Spesifikasi |
| --- | --- |
| Riwayat pendidikan formal dan gelar | EMP-007 |
| Keahlian, kompetensi, dan sertifikat beserta masa berlakunya | EMP-008 |
| Keluarga, tanggungan, dan kontak darurat | EMP-009 |
| Alamat dan kontak sebagai data ber-riwayat | EMP-003 |
| Alur usulan perubahan data oleh pegawai dan keputusan HC | EMP-003 |

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Unggah berkas (ijazah, sertifikat, kartu keluarga) | Butuh object storage dan pemindaian berkas; keputusan terpisah, sama seperti EMP-010 Paket 1. Paket 2 menyimpan **metadata dan lokasi arsip**, bukan berkasnya. |
| Perhitungan tunjangan keluarga | Milik PAY-003. Paket 2 hanya menyediakan fakta tanggungan; PAY-003 memutuskan apakah dan bagaimana memakainya. |
| Matriks kompetensi jabatan, penilaian, rencana pengembangan | Milik PERF-001 dan TRAIN-001. Paket 2 mencatat kompetensi yang **dimiliki pegawai**, bukan yang **dituntut jabatan**. |
| Verifikasi otomatis ke Dikti/lembaga sertifikasi | Tidak ada integrasi yang disepakati. Verifikasi dilakukan manusia. |
| Data kesehatan, agama pasangan, penghasilan pasangan | Tidak ada tujuan HR yang terdokumentasi di YSQ. Jangan dikumpulkan (§8). |

## 3. Prinsip

1. **Catatan, bukan kolom.** Setiap pendidikan, keahlian, anggota keluarga, dan alamat adalah baris tersendiri dengan tanggalnya. `employees.education` tetap ada sebagai ringkasan proyeksi (§5.6), tidak lagi sebagai satu-satunya fakta.
2. **Yang dilaporkan berbeda dari yang diverifikasi.** Setiap catatan membawa `verification_status`. Laporan dan keputusan HC yang bergantung pada kualifikasi hanya boleh memakai catatan `DIVERIFIKASI`.
3. **Pegawai mengusulkan, HC memutuskan.** Pegawai tidak menulis langsung ke master. Ia mengajukan usulan (EMP-003); HC menerima atau menolak dengan alasan; perubahan baru berlaku setelah diterima.
4. **Privacy-by-purpose.** Setiap atribut yang dikumpulkan punya tujuan HR yang tertulis di §8. Nomor identitas disimpan hanya bila tujuannya tertulis, tidak pernah masuk log maupun payload audit.
5. **Tidak memberi kewenangan.** Pendidikan dan kompetensi tidak pernah menghasilkan role, izin, atau kewenangan approval. Itu tetap milik AUTH-011 dan ORG-004.
6. **Riwayat tidak dihapus.** Koreksi menyimpan nilai sebelumnya; penghapusan hanya untuk data yang memang salah dicatat (`VOIDED` dengan alasan), bukan untuk menyembunyikan masa lalu.

## 4. Model data

### 4.1 EMP-007 — Pendidikan dan kualifikasi

Satu baris per jenjang/program yang ditempuh pegawai.

| Atribut | Catatan |
| --- | --- |
| `employee_id` | Pemilik catatan. |
| `level` | `SD`, `SMP`, `SMA_SEDERAJAT`, `D1`, `D2`, `D3`, `D4_S1`, `S2`, `S3`, `PONDOK`, `LAINNYA`. `PONDOK` ada karena relevan di YSQ dan tidak selalu setara jenjang formal. |
| `institution_name` | Nama lembaga apa adanya; tidak dinormalisasi ke tabel referensi pada paket ini (`DRAFT`: daftar lembaga bisa muncul kemudian tanpa mengubah baris). |
| `major` | Program/jurusan, opsional. |
| `started_year`, `completed_year` | Tahun, bukan tanggal: ijazah YSQ umumnya hanya menyebut tahun. Keduanya opsional; `completed_year` kosong berarti belum/tidak selesai. |
| `completion_status` | `SELESAI`, `BELUM_SELESAI`, `TIDAK_SELESAI`. |
| `degree_title` | Gelar yang diperoleh (contoh "S.Pd."), opsional. |
| `certificate_number` | Nomor ijazah, opsional. |
| `archive_reference` | Lokasi arsip fisik; tidak ada unggahan berkas pada paket ini. |
| `is_highest` | Diturunkan, bukan diisi: §5.6 menghitungnya dari `level` tertinggi yang `SELESAI` dan `DIVERIFIKASI`. |
| `verification_status`, `verified_by_account_id`, `verified_at` | §6. |
| `notes` | Opsional. |
| `voided_at`, `voided_reason` | Catatan yang salah dicatat. |

Aturan:

- satu pegawai boleh punya beberapa catatan pada jenjang yang sama (pindah kampus, dua S1);
- `completed_year` tidak boleh lebih kecil dari `started_year`;
- `completion_status = SELESAI` mewajibkan `completed_year`;
- tahun tidak boleh di masa depan lebih dari satu tahun berjalan (`DRAFT`: menampung ijazah yang baru akan terbit).

### 4.2 EMP-008 — Keahlian, kompetensi, dan sertifikat

Dua hal berbeda disimpan di satu tabel dengan `kind`, karena keduanya menjawab "apa yang bisa dilakukan pegawai ini" dan selalu ditampilkan berdampingan:

| Atribut | Catatan |
| --- | --- |
| `kind` | `KEAHLIAN` (tanpa lembaga penerbit) atau `SERTIFIKAT` (dengan lembaga, nomor, masa berlaku). |
| `name` | Nama keahlian atau sertifikat. |
| `category` | `PENGAJARAN`, `KEAGAMAAN`, `ADMINISTRASI`, `TEKNOLOGI`, `BAHASA`, `KESEHATAN_KESELAMATAN`, `LAINNYA` (`DRAFT`: kategori awal dari kebutuhan YSQ; menambah kategori tidak mengubah data lama). |
| `proficiency` | `DASAR`, `MENENGAH`, `MAHIR`, atau kosong. Opsional karena YSQ belum punya kebijakan penilaian; PERF-001 kelak boleh memakainya. |
| `issuer` | Lembaga penerbit; wajib untuk `SERTIFIKAT`. |
| `certificate_number` | Wajib untuk `SERTIFIKAT` bila ada. |
| `issued_on`, `expires_on` | Tanggal terbit dan berakhir. `expires_on` kosong berarti tidak kedaluwarsa. |
| `archive_reference`, `notes` | Seperti EMP-007. |
| `verification_status`, `verified_by_account_id`, `verified_at` | §6. |
| `voided_at`, `voided_reason` | Seperti EMP-007. |

Aturan:

- `expires_on` tidak boleh sebelum `issued_on`;
- sertifikat yang `expires_on` sudah lewat ditandai **Kedaluwarsa** di layar dan dalam laporan; catatannya **tidak** dihapus dan tidak berubah statusnya sendiri;
- keahlian yang sama boleh dicatat ulang dengan tanggal berbeda (sertifikasi ulang); yang lama tetap ada.

### 4.3 EMP-009 — Keluarga, tanggungan, dan kontak darurat

| Atribut | Catatan |
| --- | --- |
| `relation` | `PASANGAN`, `ANAK`, `ORANG_TUA`, `SAUDARA`, `LAINNYA`. |
| `full_name` | Nama. |
| `birth_date` | Opsional; diperlukan untuk tanggungan (§8). |
| `gender` | Opsional, `L`/`P`. |
| `is_dependent` | Tanggungan untuk keperluan administratif (BPJS, tunjangan bila kelak diputuskan). |
| `dependent_order` | Urutan tanggungan (anak ke-1, ke-2); hanya untuk `is_dependent`. |
| `identity_number` | **Hanya** untuk tanggungan dan hanya bila tujuannya tertulis (§8). Disimpan terenkripsi di tingkat basis data bila kebijakan enkripsi kolom sudah ada; sampai itu ada, kolomnya **tidak diisi** dan layar tidak memintanya (`DRAFT`). |
| `is_emergency_contact`, `emergency_phone`, `emergency_priority` | Kontak darurat: siapa yang dihubungi lebih dulu. |
| `valid_from`, `valid_to` | Relasi berubah: pernikahan, kelahiran, perceraian, kematian. `valid_to` kosong berarti masih berlaku. |
| `notes`, `voided_at`, `voided_reason` | Seperti di atas. |

Aturan:

- paling banyak satu `PASANGAN` yang berlaku pada satu tanggal (`DRAFT`: YSQ mencatat satu pasangan per pegawai untuk keperluan administratif; model memakai exclusion constraint, bukan asumsi di kode);
- `is_dependent` mewajibkan `birth_date`;
- `is_emergency_contact` mewajibkan `emergency_phone`;
- `emergency_priority` unik per pegawai di antara kontak darurat yang berlaku;
- menghapus relasi yang berakhir dilakukan dengan mengisi `valid_to`, bukan menghapus baris.

### 4.4 EMP-003 — Alamat dan kontak sebagai data ber-riwayat

| Atribut | Catatan |
| --- | --- |
| `kind` | `DOMISILI` (tempat tinggal sekarang) atau `KTP` (alamat administratif). |
| `address_line`, `village`, `district`, `city`, `province`, `postal_code` | Alamat; hanya `address_line` dan `city` yang wajib. |
| `valid_from`, `valid_to` | Pindah rumah adalah fakta ber-tanggal. |
| `source` | `IMPOR` (dari EMP-004), `HC`, atau `USULAN_PEGAWAI`. |

Kontak (`phone`, `email`) tetap di master pegawai karena setiap konsumen membacanya di sana, tetapi setiap perubahannya kini melewati §7 dan tercatat di audit.

Aturan:

- satu alamat berlaku per `kind` pada satu tanggal (exclusion constraint);
- alamat tidak pernah dihapus; pindah rumah menutup yang lama dan membuka yang baru.

### 4.5 Usulan perubahan data (EMP-003)

| Atribut | Catatan |
| --- | --- |
| `employee_id`, `submitted_by_account_id` | Pengusul; selalu pegawai yang bersangkutan pada paket ini. |
| `target` | `ALAMAT`, `KONTAK`, `KELUARGA`, `PENDIDIKAN`, `KEAHLIAN`. |
| `payload` | Nilai yang diusulkan, divalidasi dengan aturan §4.1–4.4 saat diajukan **dan** saat diterima. |
| `state` | `DIAJUKAN` → `DITERIMA` / `DITOLAK` / `DIBATALKAN`. |
| `decided_by_account_id`, `decided_at`, `decision_note` | Keputusan HC; alasan wajib saat menolak. |

Alur: `DIAJUKAN --terima--> DITERIMA` (perubahan ditulis dalam transaksi yang sama), `--tolak--> DITOLAK`, `--batalkan oleh pengusul--> DIBATALKAN`. Tidak ada status lain; tidak ada approval berjenjang pada paket ini (`DRAFT`: satu petugas HC cukup, sama seperti D-07 pada Paket 1).

## 5. Perilaku

### 5.1 Siapa menulis apa

| Tindakan | Izin |
| --- | --- |
| Membaca catatan pegawai mana pun | `employees.read.all` (HC) |
| Mencatat, mengubah, membatalkan catatan | `employees.manage` (HC) |
| Memverifikasi catatan | `employees.manage` |
| Membaca catatan sendiri | sesi pegawai, tanpa izin tambahan |
| Mengajukan usulan atas data sendiri | sesi pegawai |
| Memutuskan usulan | `employees.manage` |

Tidak ada izin baru. Paket ini sengaja memakai `employees.manage` yang sudah dipegang `human_capital_admin`: menambah izin baru berarti menambah keputusan pemberian role yang belum diminta siapa pun.

### 5.2 Verifikasi

`DILAPORKAN` (default untuk apa pun yang datang dari pegawai atau impor) → `DIVERIFIKASI` (petugas HC melihat buktinya) → boleh kembali ke `DILAPORKAN` dengan alasan bila ternyata meragukan. Verifikasi mencatat siapa dan kapan.

### 5.3 Kedaluwarsa sertifikat

Layar dan laporan menandai sertifikat yang `expires_on`-nya lewat. Tidak ada status yang berubah sendiri dan tidak ada penghapusan otomatis: yang kedaluwarsa tetap fakta sejarah.

### 5.4 Pegawai yang di luar pengelolaan HCIS

Catatan paket ini mengikuti aturan yang sama seperti Paket 1: record yang ditandai di luar pengelolaan HCIS (S2B) hanya dapat dibaca.

### 5.5 Impor EMP-004

Impor master pegawai **tidak** menulis tabel paket ini. Kolom `employees.education` yang ada tetap diisi impor sampai HC selesai memindahkan riwayat pendidikan; setelah pegawai punya minimal satu catatan EMP-007, layar menampilkan catatan itu dan kolom lama hanya muncul sebagai "data lama dari impor" (`DRAFT`).

### 5.6 Proyeksi pendidikan tertinggi

Dihitung dari catatan `SELESAI` dan `DIVERIFIKASI` dengan `level` tertinggi menurut urutan §4.1. Dipakai untuk daftar pegawai dan laporan. Bila tidak ada catatan yang memenuhi, nilainya kosong — bukan tebakan dari kolom lama.

## 6. Status verifikasi dan audit

Setiap perubahan menulis satu peristiwa audit: `employee.education.recorded|updated|verified|voided`, `employee.skill.*`, `employee.family.*`, `employee.address.*`, `employee.data_change.submitted|accepted|rejected|cancelled`.

Payload audit berisi id, kode, tanggal, dan nama field yang berubah. **Tidak pernah** berisi nama anggota keluarga, nomor identitas, alamat, nomor telepon, atau isi catatan.

## 7. Layar

### 7.1 Detail pegawai — tab **Pendidikan & Keahlian**

Dua bagian pada satu tab: **Riwayat pendidikan** (jenjang, lembaga, jurusan, tahun, status, gelar, badge verifikasi) dan **Keahlian & sertifikat** (nama, kategori, penerbit, berlaku sampai, badge **Kedaluwarsa** bila lewat). Tombol **Catat pendidikan**, **Catat keahlian**, dan pada tiap baris **Ubah**, **Verifikasi**, **Batalkan catatan** (dengan alasan).

### 7.2 Detail pegawai — tab **Keluarga & Kontak**

**Keluarga dan tanggungan** (relasi, nama, tanggal lahir, penanda tanggungan, berlaku sejak/sampai), **Kontak darurat** (urutan, nama, hubungan, telepon), **Alamat** (domisili dan KTP, dengan riwayat yang dapat dibuka). Tombol sejajar dengan §7.1.

### 7.3 Pegawai — **Profil saya → Data saya**

Pegawai melihat data dirinya dan menekan **Ajukan perubahan** pada bagian yang boleh diusulkan. Form memperlihatkan nilai sekarang dan nilai usulan berdampingan, lalu status usulan: *Diajukan*, *Diterima*, atau *Ditolak* dengan alasannya.

### 7.4 HC — **Pegawai → Usulan perubahan data**

Daftar usulan yang menunggu keputusan: pegawai, bagian data, ringkasan "dari → menjadi", tanggal pengajuan. Tombol **Terima** dan **Tolak** (alasan wajib). Diurutkan dari yang paling lama menunggu.

### 7.5 Laporan — **Sertifikat akan berakhir**

Sertifikat yang berakhir dalam 30/60/90 hari beserta yang sudah lewat, agar HC dapat menjadwalkan sertifikasi ulang. Pola layarnya sama dengan **Kontrak akan berakhir** (Paket 1 §13.4).

Setiap layar memiliki keadaan loading, kosong, error, tidak berizin, dan tampilan ponsel.

## 8. Privasi: tujuan per atribut

| Atribut | Tujuan HR | Konsekuensi |
| --- | --- | --- |
| Pendidikan, gelar, nomor ijazah | Syarat jabatan, pelaporan yayasan dan dinas pendidikan | Disimpan; nomor ijazah tidak pernah di-log |
| Sertifikat dan masa berlakunya | Kepatuhan jabatan tertentu, perencanaan sertifikasi ulang | Disimpan |
| Nama dan tanggal lahir anggota keluarga | Pendaftaran BPJS tanggungan, cuti khusus terkait keluarga | Disimpan untuk tanggungan dan pasangan |
| Nomor identitas anggota keluarga | Pendaftaran BPJS | **Belum dikumpulkan** sampai ada enkripsi kolom; layar tidak memintanya |
| Kontak darurat | Kecelakaan kerja dan keadaan darurat | Disimpan |
| Alamat domisili | Korespondensi, tunjangan transport bila kelak diputuskan | Disimpan |
| Alamat KTP | Dokumen administratif yang mensyaratkannya | Disimpan bila diisi |
| Agama, kesehatan, penghasilan anggota keluarga | — | **Tidak dikumpulkan** |

Pegawai melihat seluruh datanya sendiri. HC melihat data pegawai dalam lingkup aksesnya. Tidak ada pegawai yang dapat melihat keluarga atau alamat pegawai lain.

## 9. Kode kesalahan

| Kode | HTTP | Kapan | Pesan |
| --- | --- | --- | --- |
| `EMPLOYEE_RECORD_INVALID` | 400 | Field wajib kosong atau tidak konsisten; respons menyebut `field` | Spesifik per field |
| `EMPLOYEE_RECORD_NOT_FOUND` | 404 | Catatan tidak ada | "Catatan tidak ditemukan." |
| `EMPLOYEE_RECORD_VOIDED` | 409 | Mengubah catatan yang sudah dibatalkan | "Catatan ini sudah dibatalkan." |
| `FAMILY_SPOUSE_OVERLAP` | 409 | Pasangan kedua pada periode yang sama | "Sudah ada pasangan yang tercatat pada periode tersebut." |
| `ADDRESS_PERIOD_OVERLAP` | 409 | Dua alamat jenis sama berlaku bersamaan | "Sudah ada alamat jenis ini pada periode tersebut." |
| `EMERGENCY_PRIORITY_TAKEN` | 409 | Urutan kontak darurat dipakai | "Urutan kontak darurat ini sudah dipakai." |
| `DATA_CHANGE_NOT_PENDING` | 409 | Memutuskan usulan yang sudah selesai | "Usulan ini sudah diputuskan." |
| `DATA_CHANGE_REASON_REQUIRED` | 400 | Menolak tanpa alasan | "Penolakan wajib disertai alasan." |
| `DATA_CHANGE_FORBIDDEN` | 403 | Mengusulkan atas data pegawai lain | "Anda hanya dapat mengajukan perubahan data Anda sendiri." |
| `EMPLOYEE_OUTSIDE_HCIS_READ_ONLY` | 409 | Record di luar pengelolaan HCIS | Sama seperti Paket 1 |

## 10. Migrasi dan rollback

Seluruhnya additive: lima tabel baru (`employee_education`, `employee_skills`, `employee_family_members`, `employee_addresses`, `employee_data_change_requests`) ditambah kolom audit. Tidak ada kolom lama yang dihapus, dan `employees.education` tetap apa adanya.

Rollback: revert PR; tabel baru ditinggalkan kosong atau dihapus dengan down script selama belum ada baris. Konsumen lama tidak pernah membaca tabel baru sampai layar §7 dirilis.

## 11. Urutan implementasi

| Langkah | Isi |
| --- | --- |
| **P2-1** | Migrasi lima tabel, aturan validasi murni (domain), tanpa route |
| **P2-2** | API dan layar EMP-007 + EMP-008 (termasuk laporan §7.5) |
| **P2-3** | API dan layar EMP-009 + alamat EMP-003 (§4.3, §4.4) |
| **P2-4** | Alur usulan perubahan data: pengajuan pegawai (§7.3) dan keputusan HC (§7.4) |

Setiap langkah satu pull request dengan tes, dokumentasi, dan catatan rollback sendiri. Langkah yang menyentuh privasi data keluarga (P2-3) meminta satu putaran review independen seperti AGENTS.md §8.

## 12. Acceptance criteria

EMP-007:

- EMP-007-A: riwayat pendidikan dicatat sebagai beberapa baris dengan jenjang, lembaga, tahun, status penyelesaian, dan gelar; menambah catatan baru tidak menimpa yang lama.
- EMP-007-B: pendidikan tertinggi diturunkan dari catatan `SELESAI` dan `DIVERIFIKASI`, bukan diisi manual.
- EMP-007-C: catatan dapat diverifikasi, dan status verifikasi terlihat di layar.

EMP-008:

- EMP-008-A: keahlian dan sertifikat dicatat beserta kategori, penerbit, dan masa berlaku.
- EMP-008-B: sertifikat yang masa berlakunya lewat ditandai kedaluwarsa tanpa diubah atau dihapus.
- EMP-008-C: ada daftar sertifikat yang akan berakhir dalam rentang yang dipilih.

EMP-009:

- EMP-009-A: anggota keluarga, tanggungan, dan kontak darurat dicatat dengan periode berlakunya.
- EMP-009-B: hanya satu pasangan dan satu urutan kontak darurat yang berlaku pada satu waktu, ditegakkan oleh basis data.
- EMP-009-C: atribut tanpa tujuan HR yang tertulis tidak dikumpulkan, dan audit tidak pernah memuat data pribadi anggota keluarga.

EMP-003:

- EMP-003-A: alamat disimpan dengan periode berlaku; pindah rumah menutup alamat lama dan membuka yang baru.
- EMP-003-B: pegawai mengajukan perubahan atas datanya sendiri dan melihat statusnya.
- EMP-003-C: HC menerima atau menolak usulan; penolakan wajib beralasan; penerimaan menulis perubahan dalam satu transaksi dan tercatat di audit.
- EMP-003-D: pegawai tidak dapat mengajukan perubahan atas data pegawai lain.

## 13. Keputusan DRAFT yang menunggu owner

| Hal | Default yang dipakai | Kalau owner memutuskan lain |
| --- | --- | --- |
| Nomor identitas anggota keluarga | Tidak dikumpulkan sampai ada enkripsi kolom | Kolomnya sudah ada; tinggal diaktifkan bersama kebijakan enkripsi |
| Satu pasangan per periode | Ditegakkan basis data | Constraint dilonggarkan, data lama tetap valid |
| Tingkat kemahiran keahlian | Opsional, tiga tingkat | Menjadi wajib, atau skala lain, tanpa mengubah baris lama |
| Approval usulan perubahan | Satu petugas HC | APR-001 dapat ditambahkan di atas state `DIAJUKAN` |
| Kategori keahlian | Tujuh kategori awal | Menambah kategori tidak mengubah data lama |
| Jenjang `PONDOK` | Jenjang tersendiri, tidak disetarakan | Pemetaan kesetaraan ditambahkan sebagai atribut, bukan mengganti `level` |
