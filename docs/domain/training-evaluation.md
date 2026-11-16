# Pelatihan Pegawai — R3: Evaluasi Pelatihan

**Status:** ACCEPTED (R3 awal) — spesifikasi ini mengizinkan implementasi R3 awal. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal (instruksi owner 2026-11-17: tuntaskan tanpa menunggu, asumsi dilaporkan).
**Spesifikasi:** TRAIN-001 (tahap R3)
**Tanggal:** 2026-11-17
**Terkait:** `docs/domain/training.md` (Paket 1), `docs/domain/training-lms-discovery.md` §7 (kerangka), PERF-001, ORG-004, NOTIF-004, AUTH-011, ENG-LIST-001

## 1. Tujuan

Paket 1 mencatat siapa ikut apa dan berapa jam. R3 menjawab **seberapa berhasil** pelatihan itu, dengan kerangka empat tingkat (discovery §7.1):

| Tingkat | Pertanyaan | Alat di R3 |
| --- | --- | --- |
| 1 — Reaksi | Apakah peserta menilai pelatihan bermanfaat? | Kuesioner reaksi standar, anonim |
| 2 — Pembelajaran | Apakah pengetahuan/keterampilan bertambah? | Pre-test dan post-test berskor, tes, rubrik praktik |
| 3 — Penerapan | Apakah hasil pelatihan dipakai di pekerjaan? | Formulir atau rubrik yang diisi **atasan** peserta, formulir penilaian diri |
| 4 — Hasil | Apakah ada dampak bagi unit/yayasan? | Formulir indikator yang diisi HC sekali per program |

Hasil yang dituju:

- HC menyusun **rencana evaluasi** per program dari komponen-komponen;
- **instrumen** (formulir, tes, rubrik) disusun di sistem dan dipakai ulang;
- **peserta** mengisi reaksi, pre/post test, tes, dan penilaian diri; **atasan** mengisi penilaian penerapan; **HC** mengisi rubrik praktik dan indikator hasil;
- tes dinilai **di server**; kunci jawaban tidak pernah dikirim ke browser;
- **rekap per program** (reaksi per butir, rata-rata pre/post dan peningkatan, nilai akhir, kelulusan) dan **rekap per pegawai**.

## 2. Batas

Termasuk: instrumen, rencana evaluasi per program (komponen, bobot, nilai minimal lulus), pengisian oleh peserta/atasan/HC, penilaian otomatis tes, rubrik 1–4, pre/post test, kuesioner reaksi standar anonim, rekap per program dan per pegawai, audit, notifikasi in-app.

**Tidak** termasuk di R3 awal (tetap discovery):

| Di luar lingkup | Alasan / rencana |
| --- | --- |
| Esai dinilai manual, dua penilai, penilai akhir, status rilis nilai (§7.7 discovery) | Tahap R3 lanjutan. R3 awal hanya soal bernilai otomatis dan rubrik yang diisi satu penilai. |
| Bank soal dengan pengacakan, batas waktu tes, beberapa percobaan, remedial | R3 lanjutan. Satu kali isi per orang per komponen per tahap. |
| RTL dengan laporan hari ke-N dan daftar tunggakan (§7.8) | R3 lanjutan. Penerapan tingkat 3 diwakili formulir/rubrik atasan dengan jendela waktu. |
| Reaksi per sesi dan rekap per narasumber | R3 lanjutan. Reaksi di R3 per program. |
| Usulan kompetensi ke EMP-008 | Discovery §10. |
| Penilai yang ditunjuk selain HC/atasan | R3 lanjutan; HC dapat mengganti atasan penilai per peserta (§6.4). |
| Ekspor laporan | R3 lanjutan. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| E-01 | Tiga jenis **instrumen**: `FORM` (tanpa kunci), `TEST` (berkunci, berskor), `RUBRIC` (kriteria × tingkat 1–4). Satu model butir dipakai bersama (discovery §7.4). | ACCEPTED (discovery §7.4) |
| E-02 | Jenis butir: FORM — `SCALE` (1–5), `CHOICE` (satu pilihan tanpa kunci), `TEXT` (≤ 2000 huruf). TEST — `SINGLE`, `MULTI`, `TRUE_FALSE`, `SHORT` (isian singkat dengan jawaban yang diterima). RUBRIC — `CRITERION` dengan empat deskriptor tingkat. 1–50 butir per instrumen; poin per soal 1–10. | DRAFT |
| E-03 | Komponen menyimpan **salinan butir** instrumen saat ditambahkan ke rencana (*snapshot-on-attach*). Mengubah instrumen tidak mengubah komponen yang sudah ada atau nilainya. | ACCEPTED (discovery §7.6 versi dan salinan soal) |
| E-04 | `MULTI` dinilai **semua-atau-tidak**: poin penuh hanya bila himpunan jawaban sama persis dengan kunci. `SHORT` dibandingkan setelah huruf kecil, trim, dan spasi beruntun dirapatkan. Soal yang tidak dijawab bernilai 0. | DRAFT |
| E-05 | Nilai disimpan **0–100** dua desimal. Tes: poin diperoleh ÷ poin maksimum × 100. Rubrik: jumlah tingkat ÷ (4 × jumlah kriteria) × 100. | ACCEPTED (discovery §3 no. 11, §7.3) |
| E-06 | Jenis **komponen** dan pasangannya tetap (§5.2). Tingkat 1 dan 4 tidak berbobot; bobot hanya untuk tes, post-test, dan rubrik tingkat 2. | DRAFT |
| E-07 | **Nilai akhir** = rata-rata berbobot dari komponen berbobot. **Nilai minimal lulus** per program 0–100, bawaan **75**. Status: `PASSED`, `FAILED`, `INCOMPLETE` (komponen wajib tingkat 1–2 belum lengkap), `NOT_GRADED` (tidak ada komponen berbobot). | DRAFT (bawaan 75 dari contoh discovery §7.2) |
| E-08 | Kelulusan hanya dari komponen tingkat 1–2. Tingkat 3–4 dicatat terpisah dan **tidak** mengubah kelulusan. | ACCEPTED (discovery §12 no. 10) |
| E-09 | Kelulusan **dihitung saat dibaca**, tidak dibekukan ke catatan pelatihan, dan **tidak** menghalangi penutupan program Paket 1. Catatan pelatihan tetap membedakan ikut dan menyelesaikan kehadiran (D-06). | DRAFT |
| E-10 | Kuesioner reaksi **standar** (6 butir skala 1–5 + komentar, discovery §7.5) disediakan sistem sebagai instrumen bawaan yang tidak dapat diubah. Komponen `REACTION` selalu **anonim**. | ACCEPTED (discovery §7.5, §12 no. 9) |
| E-11 | Respons anonim tidak menyimpan pengisi. "Siapa sudah mengisi" disimpan terpisah tanpa jam (hanya tanggal) dan respons anonim tanpa jam, supaya waktu tidak dapat dipakai menautkan keduanya. Tidak ada audit per respons anonim. Sebaran butir dan komentar anonim baru tampil bila komponen **sudah tidak menerima jawaban** (jendela ditutup, diarsipkan, atau program dibatalkan) **dan** respons ≥ 3, supaya satu jawaban atau selisih dua kali baca tidak dapat ditautkan ke orang yang baru mengisi. Anonimitas berlaku terhadap pengguna aplikasi (termasuk HC); di tingkat basis data, urutan sisipan dan id transaksi masih dapat menautkan baris, jadi akses basis data production tetap terbatas pada operator (risiko diterima). | DRAFT (ambang 3) |
| E-12 | **Pre-test** dan **post-test** adalah satu komponen `PRE_POST_TEST` dengan satu instrumen yang dipakai dua kali, sehingga skornya sebanding. Pre-test dapat diisi selama peserta belum mengisi post-test; post-test terbuka sejak sesi terjadwal terakhir program dimulai (atau sejak program ditutup). Peningkatan = post − pre. Bobot memakai skor post-test. | DRAFT |
| E-13 | Satu kali isi per (komponen, tahap, pengisi, subjek). Respons final; tidak dapat diubah atau dihapus. | DRAFT |
| E-14 | **Atasan penilai** komponen `SUPERVISOR` ditetapkan per peserta dari atasan langsung (resolver yang sama dengan PERF-001/APR-001, alur `TRAINING`) saat komponen dibuat atau peserta ditambahkan, lalu disalin. Bila tidak terselesaikan, HC menunjuk penilai. HC dapat mengganti penilai selama penilaian peserta itu belum diisi. | DRAFT |
| E-15 | Penilai tidak menilai dirinya sendiri: HC yang juga peserta tidak mengisi rubrik/indikator tentang dirinya, dan penilai yang ditunjuk tidak boleh peserta yang dinilainya. | DRAFT |
| E-20 | Kunci jawaban (`correct`, `accepted`) hanya dikirim ke pemegang `training.manage` (penyusun instrumen). Pemegang `training.read` saja melihat instrumen dan komponen tanpa kunci, karena ia bisa juga menjadi peserta. | DRAFT |
| E-16 | Peserta melihat **skor tesnya sendiri** segera setelah mengirim. Kunci dan jawaban benar tidak pernah ditampilkan di R3. Nilai rubrik dan penilaian atasan tampil bagi peserta di rekap pribadinya. | DRAFT |
| E-17 | Izin memakai `training.read` (rekap) dan `training.manage` (instrumen, rencana, penilai, pengisian HC). **Tidak ada permission baru**, jadi tidak ada migrasi izin. Atasan mengisi berdasarkan penugasan, bukan permission. | DRAFT |
| E-18 | Paling banyak **20 komponen aktif** per program. | DRAFT |
| E-19 | Jendela isi per komponen: `opensAt` dan `closesAt` opsional. Program yang dibatalkan menutup semua komponennya. Program yang sudah ditutup (COMPLETED) **tetap** dapat dievaluasi, karena penerapan (tingkat 3) terjadi sesudahnya. | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Peserta (pegawai) | Melihat tugas evaluasinya, mengisi komponen `PARTICIPANT` (reaksi, pre/post test, tes, penilaian diri), melihat skor dan rekap evaluasinya sendiri |
| Atasan penilai (pegawai) | Melihat dan mengisi komponen `SUPERVISOR` tentang peserta yang ditugaskan kepadanya; tidak melihat nilai lain peserta |
| HC dengan `training.read` | Melihat instrumen, rencana, rekap per program, hasil per peserta, rekap per pegawai |
| HC dengan `training.manage` | Menyusun instrumen, rencana evaluasi, nilai minimal lulus; menunjuk penilai; mengisi komponen `HC` (rubrik praktik, indikator hasil) |
| Sistem | Menilai tes, menghitung nilai akhir dan status, audit, notifikasi |

## 5. Objek dan aturan

### 5.1 Instrumen

```text
ACTIVE -> ARCHIVED   (HC; instrumen yang diarsipkan tidak dapat ditambahkan ke rencana baru)
```

Input: `kind` (`FORM`/`TEST`/`RUBRIC`), `title` (3–200), `description?` (≤ 1000), `items` (1–50). Server menomori ulang `id` butir menjadi `q1`…`qN` sesuai urutan. Butir:

| Jenis | Instrumen | Isi wajib | Kunci |
| --- | --- | --- | --- |
| `SCALE` | FORM | `prompt` (≤ 500), `required` | — |
| `CHOICE` | FORM | `prompt`, `options` (2–10, ≤ 200), `required` | — |
| `TEXT` | FORM | `prompt`, `required` | — |
| `SINGLE` | TEST | `prompt`, `options` (2–10), `correct` (indeks), `points` (1–10) | ya |
| `MULTI` | TEST | `prompt`, `options` (2–10), `correct` (1–10 indeks unik), `points` | ya |
| `TRUE_FALSE` | TEST | `prompt`, `correct` (boolean), `points` | ya |
| `SHORT` | TEST | `prompt`, `accepted` (1–10 jawaban, ≤ 200), `points` | ya |
| `CRITERION` | RUBRIC | `prompt`, `levels` (tepat 4 deskriptor, ≤ 300; tingkat 1 sampai 4) | — |

Instrumen sistem (`system = true`, kuesioner reaksi standar) tidak dapat diubah atau diarsipkan (409 `TRAINING_INSTRUMENT_SYSTEM`). 400 `INVALID_TRAINING_INSTRUMENT` untuk isi tidak valid.

### 5.2 Komponen rencana evaluasi

| `kind` | Instrumen | Tingkat | Pengisi (`respondent`) | Subjek | Anonim | Berbobot |
| --- | --- | --- | --- | --- | --- | --- |
| `REACTION` | FORM | 1 | `PARTICIPANT` | program | selalu | tidak |
| `PRE_POST_TEST` | TEST | 2 | `PARTICIPANT` | diri sendiri | tidak | ya (post) |
| `TEST` | TEST | 2 | `PARTICIPANT` | diri sendiri | tidak | ya |
| `RUBRIC` | RUBRIC | 2 atau 3 | `HC` atau `SUPERVISOR` | peserta | tidak | hanya tingkat 2 |
| `FORM` | FORM | 1, 2, atau 3 | `PARTICIPANT` atau `SUPERVISOR` | diri sendiri / peserta | opsional bila `PARTICIPANT` | tidak |
| `RESULT` | FORM | 4 | `HC` | program | tidak | tidak |

Input: `kind`, `instrumentId`, `title?` (bawaan judul instrumen), `level` (untuk `RUBRIC`/`FORM`), `respondent` (untuk `RUBRIC`/`FORM`), `anonymous?`, `weight?` (1–100, hanya komponen berbobot; bawaan 0 = tidak dihitung), `required` (bawaan `true`), `opensAt?`, `closesAt?` (`closesAt > opensAt`). Pasangan yang tidak ada di tabel → 400 `INVALID_TRAINING_COMPONENT`. Instrumen harus `ACTIVE` dan jenisnya cocok (409 `TRAINING_INSTRUMENT_MISMATCH`). Program harus `ACTIVE` atau `COMPLETED` (409 `TRAINING_PROGRAM_CLOSED` bila dibatalkan). Batas E-18 → 409 `TRAINING_COMPONENT_LIMIT`.

```text
ACTIVE -> ARCHIVED   (HC, alasan 5–500; respons tetap tersimpan, komponen tidak dihitung lagi)
```

Ubah (`PATCH`): `title`, `opensAt`, `closesAt`, `required` kapan saja selama `ACTIVE`; `weight` hanya selama komponen belum punya respons (409 `TRAINING_COMPONENT_LOCKED`). Instrumen dan jenis tidak dapat diubah; arsipkan lalu buat komponen baru.

Rencana: `PATCH /admin/training/programs/:id/evaluation` dengan `passingScore` (0–100).

### 5.3 Tugas dan pengisian

Komponen **terbuka** bila: komponen `ACTIVE`, program bukan `CANCELLED`, `now ≥ opensAt` (bila ada), `now < closesAt` (bila ada). Pengisian di luar jendela → 409 `TRAINING_COMPONENT_NOT_OPEN`.

| Pengisi | Syarat |
| --- | --- |
| `PARTICIPANT` | Pegawai adalah peserta program dengan status `ENROLLED`, `COMPLETED`, atau `INCOMPLETE` (bukan `WITHDRAWN`). Subjek = dirinya (anonim: tanpa subjek). |
| `SUPERVISOR` | Pegawai adalah penilai yang tercatat untuk subjek itu di komponen itu (E-14), dan subjek masih peserta (bukan `WITHDRAWN`). |
| `HC` | Pemegang `training.manage`; subjek peserta (bukan dirinya, E-15) untuk `RUBRIC`, tanpa subjek untuk `RESULT`. |

Tahap (`stage`): `SINGLE` untuk semua komponen kecuali `PRE_POST_TEST` (`PRE` atau `POST`, E-12). 409 `TRAINING_STAGE_NOT_OPEN` bila tahap belum/tidak lagi terbuka. Isi kedua kali → 409 `TRAINING_RESPONSE_EXISTS`.

Jawaban (`answers`, objek `{ [itemId]: nilai }`): `SCALE` bilangan bulat 1–5, `CHOICE`/`SINGLE` indeks, `MULTI` larik indeks unik, `TRUE_FALSE` boolean, `SHORT`/`TEXT` teks (≤ 200 / ≤ 2000), `CRITERION` bilangan bulat 1–4. Butir FORM `required` dan semua `CRITERION` wajib dijawab; soal tes boleh kosong (bernilai 0). Butir yang tidak dikenal atau nilai yang salah bentuk → 400 `INVALID_TRAINING_RESPONSE`.

Formulir yang dikirim ke pengisi tidak memuat `correct` dan `accepted`. Respons tes menyimpan jawaban, skor, poin diperoleh, dan poin maksimum; penilaian di server.

### 5.4 Rekap

**Per program** (`training.read`):

- per komponen: jumlah wajib isi, jumlah sudah isi, rata-rata skor; `PRE_POST_TEST`: rata-rata pre, rata-rata post, rata-rata peningkatan (hanya peserta yang mengisi keduanya); FORM: rata-rata dan sebaran per butir `SCALE`, jumlah per pilihan `CHOICE`; jumlah komentar `TEXT` (isi lewat daftar komentar berhalaman; anonim mengikuti E-11);
- per peserta (berhalaman): pre, post, peningkatan (kolom utama dari pre/post test pertama di rencana; semua pre/post test per komponen di `prePost`), skor tiap komponen berbobot, nilai akhir, status E-07, dan tingkat 3 (rata-rata penilaian atasan) terpisah.

**Per pegawai**: daftar program yang diikuti beserta pre/post, nilai akhir, status, dan rata-rata penilaian penerapan. Pegawai melihat miliknya sendiri; HC (`training.read`) melihat semua pegawai. Atasan tidak melihat rekap bawahan di R3 (Paket 1 D-11).

## 6. Alur khusus

### 6.1 Penugasan atasan (E-14)

Saat komponen `SUPERVISOR` dibuat, sistem menyelesaikan atasan setiap peserta non-`WITHDRAWN` (tanggal efektif hari ini WIB) dan menyimpan `training_evaluation_assessors (component, subject, assessor, source)`. Saat peserta ditambahkan (Paket 1 §6.3), hal yang sama dijalankan untuk komponen `SUPERVISOR` aktif program itu, di transaksi yang sama. Hasil tidak terselesaikan disimpan tanpa penilai (`assessor = null`) dan tampil sebagai "penilai belum ada" di layar HC.

`PUT /admin/training/evaluation/components/:id/assessors` (`entries` 1–100: `subjectEmployeeId`, `assessorEmployeeId`) mengganti penilai: penilai harus pegawai aktif, bukan subjek itu sendiri (409 `TRAINING_ASSESSOR_SELF`), dan penilaian subjek itu belum diisi (409 `TRAINING_RESPONSE_EXISTS`). Penilai baru diberi tahu.

### 6.2 Kelulusan (E-07)

Untuk satu peserta: komponen dihitung = `ACTIVE`, tingkat 1–2. `INCOMPLETE` bila ada komponen `required` yang belum diisi peserta (untuk `REACTION` dicek dari catatan "sudah mengisi"; untuk `RUBRIC` HC dicek dari respons tentang peserta; untuk `PRE_POST_TEST` cukup tahap `POST`). Selain itu, bila tidak ada komponen berbobot (`weight > 0`) → `NOT_GRADED`; bila ada → nilai akhir = Σ(bobot × skor) ÷ Σ bobot dari komponen berbobot yang sudah punya skor, `PASSED` bila ≥ nilai minimal lulus, `FAILED` bila kurang. Komponen berbobot yang belum dinilai dan tidak wajib dihitung bernilai 0.

## 7. Permission

Tidak ada permission baru (E-17). `training.read` membaca instrumen, rencana, dan rekap; `training.manage` menulis instrumen, rencana, penilai, dan respons HC. Pengisian peserta dan atasan adalah kepemilikan/penugasan dari sesi pegawai, bukan permission. Respons, rekap, atau tugas orang lain menjawab 404.

## 8. Audit

Ditulis ke `training_audit_events` (Paket 1 §10) dengan `metadata.componentId`/`metadata.instrumentId`:

`training.instrument.created`, `training.instrument.updated`, `training.instrument.archived`, `training.evaluation.plan.updated`, `training.evaluation.component.created`, `training.evaluation.component.updated`, `training.evaluation.component.archived`, `training.evaluation.assessor.assigned`, `training.evaluation.response.submitted`.

Respons anonim **tidak** diaudit (E-11). Audit respons non-anonim memuat id komponen, tahap, subjek, dan skor; tidak memuat isi jawaban.

## 9. Notifikasi (NOTIF-004, kategori `system`)

- komponen `PARTICIPANT` dibuat → peserta non-`WITHDRAWN` ("evaluasi perlu diisi");
- penilai atasan ditetapkan atau diganti → penilai.

Idempoten per `eventKey`: `training.evaluation.<componentId>.<employeeId>` untuk peserta; untuk penilai, per penetapan (penambahan peserta atau penggantian penilai memberi tahu lagi).

## 10. Penyimpanan (migrasi `0155`)

```text
training_programs.evaluation_passing_score   kolom baru, bawaan 75
training_instruments                         instrumen; satu baris sistem (kuesioner reaksi standar)
training_evaluation_components               komponen rencana, salinan butir (jsonb)
training_evaluation_assessors                penilai SUPERVISOR per peserta
training_evaluation_completions              siapa sudah mengisi (tanggal saja), unik per komponen/tahap/subjek/pengisi
training_evaluation_responses                isi jawaban dan skor; anonim tanpa pengisi/subjek, tanggal saja
```

Hanya penambahan; tidak ada tabel Paket 1 yang diubah selain kolom bawaan di `training_programs`. Rollback ditulis sebagai `-- Down:` di berkas migrasi. Tidak ada kolom nominal.

## 11. API

Pegawai: `GET /training/me/evaluation/tasks`, `GET /training/me/evaluation/components/:id/form`, `POST /training/me/evaluation/components/:id/responses`, `GET /training/me/evaluation/results`.

HC: `GET|POST /admin/training/instruments`, `GET|PATCH /admin/training/instruments/:id`, `POST /admin/training/instruments/:id/archive`, `PATCH /admin/training/programs/:id/evaluation`, `GET|POST /admin/training/programs/:id/evaluation/components`, `PATCH /admin/training/evaluation/components/:id`, `POST /admin/training/evaluation/components/:id/archive`, `GET|PUT /admin/training/evaluation/components/:id/assessors`, `GET /admin/training/evaluation/components/:id/form`, `POST /admin/training/evaluation/components/:id/responses`, `GET /admin/training/evaluation/components/:id/comments`, `GET /admin/training/programs/:id/evaluation/summary`, `GET /admin/training/programs/:id/evaluation/results`, `GET /admin/training/employees/:employeeId/evaluation`.

Kontrak: `docs/api/training.openapi.yaml`. Daftar mengikuti ENG-LIST-001: instrumen, tugas, komentar, hasil per peserta, dan rekap per pegawai berhalaman (`page`/`pageSize` 25/100 + `total`); komponen per program dibatasi E-18 (≤ 20 aktif; arsip ikut tampil, terbatas 100); ringkasan program adalah agregat.

## 12. Layar

- Pegawai `/app/training`: bagian **Evaluasi** — daftar tugas (sebagai peserta dan sebagai atasan penilai) yang membuka formulir dalam pop-up, skor tes setelah kirim, dan rekap evaluasi pribadi per program.
- HC `/admin/training`: tab **Instrumen** (daftar berhalaman, pop-up buat/ubah dengan penyusun butir); di pop-up program, bagian **Evaluasi**: nilai minimal lulus, komponen (tambah, ubah jendela, arsipkan), penilai atasan, isian HC, ringkasan per komponen, dan hasil per peserta; tab **Rekap jam** tetap; rekap evaluasi per pegawai dibuka dari daftar hasil.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 13. Acceptance criteria

- TRAIN-R3-A: kunci jawaban (`correct`, `accepted`) tidak pernah ada di respons API formulir pengisi; skor tes dihitung server sesuai E-04/E-05.
- TRAIN-R3-B: hanya peserta non-`WITHDRAWN` yang mengisi komponen `PARTICIPANT`; hanya penilai tercatat yang mengisi komponen `SUPERVISOR`; orang lain mendapat 404; pengisian kedua 409.
- TRAIN-R3-C: respons `REACTION` tidak menyimpan pengisi atau jam; "sudah mengisi" tetap tercatat; sebaran dan komentar anonim tersembunyi selama komponen masih menerima jawaban atau respons < 3.
- TRAIN-R3-D: pre-test ditolak setelah post-test diisi; post-test ditolak sebelum sesi terakhir dimulai; rekap menghitung peningkatan post − pre.
- TRAIN-R3-E: nilai akhir dan status mengikuti E-07; tingkat 3 tidak mengubah status.
- TRAIN-R3-F: mengubah instrumen tidak mengubah salinan komponen yang sudah ada; bobot terkunci setelah ada respons.
- TRAIN-R3-G: tanpa `training.read` rekap 403; tanpa `training.manage` penulisan HC 403; HC tidak menilai dirinya sendiri.
- TRAIN-R3-H: setiap penulisan HC dan respons non-anonim menulis audit event; tidak ada isi jawaban di audit.
- TRAIN-R3-I: peserta yang ditambahkan ke program dengan komponen `SUPERVISOR` mendapat penilai atasan bila terselesaikan.

## 14. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| E-04 | Skor pilihan ganda kompleks? | Semua-atau-tidak |
| E-07 | Nilai minimal lulus bawaan? | 75 |
| E-09 | Kelulusan dibekukan ke catatan atau menghalangi penutupan? | Tidak; dihitung saat dibaca |
| E-11 | Kapan hasil anonim tampil? | Setelah komponen ditutup dan minimal 3 respons |
| E-12 | Kapan pre-test dan post-test terbuka? | Pre sampai peserta mengisi post; post sejak sesi terakhir dimulai |
| E-13 | Boleh mengulang tes? | Tidak di R3 awal |
| E-14 | Siapa menilai penerapan? | Atasan langsung (resolver PERF/APR); HC dapat mengganti |
| E-16 | Kapan peserta melihat skor? | Segera; kunci tidak pernah ditampilkan |
| E-18 | Batas komponen per program? | 20 aktif |
