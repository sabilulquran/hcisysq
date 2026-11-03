# Penilaian Kinerja

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** PERF-001
**Tanggal:** 2026-11-02
**Terkait:** APR-001, ORG-002, ORG-004, ORG-011, PAY-003, NOTIF-004, AUTH-011, ENG-LIST-001
**Roadmap:** `docs/product/roadmap.md` (PERF-001), `docs/product/hcis-capability-map.md` §4

## 1. Tujuan

Penilaian kinerja di HCIS lama dilakukan atasan setiap bulan dan disahkan Kepala HC, tetapi tidak ada penilaian diri, tidak ada tutup periode, penilaian yang sudah disahkan masih dapat diubah atau dihapus, dan hasilnya tidak pernah sampai ke payroll: persentase kinerja di slip gaji diketik manual di sheet. Paket 1 memberi YSQ satu siklus penilaian yang tertib dan tercatat:

- HC membuka **siklus penilaian per periode** dengan rubrik (indikator, bobot, predikat) yang dibekukan saat siklus dibuka;
- pegawai mengisi **penilaian diri**;
- **atasan menurut struktur** memberi nilai, kekuatan, dan area perbaikan;
- HC **mengesahkan** atau mengembalikan ke penilai; nilai akhir dan **predikat** dihitung server;
- pegawai melihat hasilnya dan menandai sudah dibaca;
- **riwayat** per pegawai lintas siklus dan **rekap HC** per siklus;
- setiap langkah tercatat sebagai riwayat dan audit event.

Paket 1 **hanya menyimpan hasil**. Nilai kinerja tidak mengubah gaji siapa pun sampai paket sambungan PAY-003 dibangun (§11).

## 2. Kajian HCIS lama

Sumber: `hcysq/hcis-ysq` (Laravel, HEAD `30264ba`), `hcysq/GAS-HCIS`. Dibaca saja.

| Hal | HCIS lama | Paket 1 |
| --- | --- | --- |
| Periode | Bulanan (`period_month`, `period_year`), unik per pegawai per bulan | Siklus `MONTHLY` (sama) dan `ANNUAL` tahun ajaran (D-02) |
| Penilai | Kepala/Wakil Kepala Unit menilai staf unitnya; "tier" berarti level penilai: Kepala Bidang → Kepala Unit, Direktur → Kepala Bidang, Ketua Yayasan → Direktur. Penilai = siapa pun yang login dan lolos policy | Atasan langsung menurut struktur, disnapshot saat pegawai masuk siklus (D-01). Level penilai mengikuti struktur dengan sendirinya |
| Penilaian diri | Tidak ada | Ada, tidak dihitung ke nilai (D-03) |
| Komponen | Aspek dinamis dengan bobot 1–100 (tidak harus berjumlah 100), tanpa seed | Indikator per siklus, bobot bulat berjumlah 100, default `DRAFT` (D-05) |
| Skala | 1–4: Sangat Baik, Baik, Cukup, Kurang | Sama (D-04) |
| Nilai | Rata-rata berbobot 1,00–4,00 | Sama (D-05) |
| Predikat | A ≥ 3,5; B ≥ 2,5; C ≥ 1,5; D di bawahnya | Sama, dengan label (D-06) |
| Pengesahan | Kepala HC/super admin approve/reject satu langkah; rantai lain kosmetik | HC mengesahkan atau mengembalikan ke penilai (D-07) |
| Tanda tangan | Hanya blok penilai di cetakan LPK; pegawai "Tandai dibaca" | Pegawai menandai sudah dibaca dengan tanggapan opsional (D-09); cetak di luar Paket 1 |
| Payroll | **Tidak tersambung.** Persentase "Kinerja Tahunan/Bulanan" di slip GAS adalah input manual sheet | Tidak tersambung di Paket 1; kontrak di §11 |
| Trend | Kolom `trend` (naik/stabil/turun dibanding periode sebelumnya, PO 2026-05-31), dihitung dari grade di layar | Disimpan saat disahkan (D-16) |
| Kunci | Penilaian yang sudah disahkan masih dapat diubah dan dihapus; tidak ada tutup periode | Hasil final tidak berubah; siklus ditutup (D-10, D-11) |

Data penilaian lama dikosongkan saat go-live legacy, sehingga tidak ada migrasi data.

## 3. Batas

Termasuk (Paket 1): siklus, rubrik per siklus, peserta, penilaian diri, penilaian atasan, pengesahan HC, predikat, tanda dibaca, riwayat, rekap HC, notifikasi in-app.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Persentase kinerja dan tunjangan kinerja | Menyentuh payroll PAY-003 yang belum lulus parallel run. Kontrak di §11. Paket 1 **tidak** menyimpan persentase atau nominal. |
| Penilaian 360, rekan sejawat, atau bawahan | Tidak ada di legacy; belum ada kebutuhan tertulis. |
| KPI kuantitatif dengan target angka per pegawai | Indikator Paket 1 bersifat kualitatif berskala; target angka butuh keputusan owner. |
| Banding atas hasil, koreksi setelah final | D-09, D-11. |
| Penilai akun yayasan (`FOUNDATION_BOARD`) | Penilai Paket 1 hanya pegawai. Direktur yang atasannya Ketua Yayasan ditunjuk penilainya oleh HC atau dikeluarkan dari siklus (D-01). |
| Cetak LPK dan ekspor CSV | Rekap dibaca di layar; cetak dan ekspor menyusul. |
| Kaitan ke kompetensi jabatan dan pelatihan | TRAIN-001. |

## 4. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Penilai adalah **atasan langsung menurut struktur**: resolver yang sama dengan APR-001 dan lembur ATT-011-6b (kunci alur ORG-004 `PERF`, sumber `DIRECT_MANAGER`, bila struktur memakai approver tata kelola maka orang itu). Diresolusi dan disnapshot saat pegawai ditambahkan ke siklus pada tanggal efektif `min(hari ini, akhir periode)`. Perubahan struktur sesudahnya tidak memindahkan penilai. Bila tidak teresolusi, penilaian menunggu HC menunjuk penilai. HC boleh mengganti penilai dengan alasan selama penilai belum mengirim nilai. Penilai tidak pernah pegawai yang dinilai. | DRAFT |
| D-02 | Dua jenis siklus: `MONTHLY` (satu bulan kalender, sama dengan legacy) dan `ANNUAL` (satu tahun ajaran, 1 Juli–30 Juni). Satu jenis hanya punya satu siklus tidak-batal per periode. Satu pegawai satu penilaian per siklus. | DRAFT |
| D-03 | Penilaian diri ditawarkan kepada setiap peserta tetapi **tidak dihitung**; nilai akhir hanya dari penilai. Penilai melihat penilaian diri sebelum menilai. | DRAFT |
| D-04 | Skala 1–4 legacy: 4 Sangat baik, 3 Baik, 2 Cukup, 1 Kurang. | DRAFT (mengikuti legacy) |
| D-05 | Nilai akhir = Σ(nilai × bobot) / 100, antara 1,00 dan 4,00, tepat dua desimal. Bobot bilangan bulat dengan jumlah tepat 100. Rubrik default lima indikator: Hasil kerja 30, Disiplin dan kehadiran 20, Akhlak dan adab 20, Kerja sama dan komunikasi 15, Inisiatif dan pengembangan diri 15. HC mengubahnya selama siklus `DRAFT`. | DRAFT |
| D-06 | Predikat: **A Sangat baik** ≥ 3,50; **B Baik** ≥ 2,50; **C Cukup** ≥ 1,50; **D Kurang** di bawahnya — batas legacy. Batas dapat diubah per siklus selama `DRAFT`; harus mencakup 1,00. | DRAFT |
| D-07 | Hasil penilai disahkan HC (`performance.manage`). HC dapat **mengembalikan** ke penilai dengan alasan; itulah kalibrasi Paket 1 — HC tidak pernah mengetik nilai pengganti. Pengesah tidak boleh pegawai yang dinilai maupun penilainya. Admin HC yang juga peserta tidak dapat mengganti penilai, mengeluarkan, atau memasukkan kembali penilaiannya sendiri, dan di layar HC melihat penilaiannya sendiri seperti pegawai lain (hasil baru tampak setelah final). | DRAFT |
| D-08 | Penilai dapat menilai setelah pegawai mengirim penilaian diri, atau setelah batas penilaian diri lewat tanpa kiriman, supaya pegawai yang diam tidak menahan siklus. Pegawai masih boleh mengirim penilaian diri terlambat selama penilai belum menilai. | DRAFT |
| D-09 | Pegawai melihat nilai penilai dan predikat **setelah disahkan**, lalu dapat menandai sudah dibaca dengan tanggapan opsional (≤ 1000 karakter). Tanggapan tidak mengubah nilai. Tidak ada banding di Paket 1. | DRAFT |
| D-10 | Siklus ditutup HC pada atau sesudah akhir periode. Penutupan ditolak selama masih ada penilaian menunggu pengesahan. Penilaian yang belum dinilai menjadi `UNRATED` (tanpa predikat). Siklus tertutup tidak dapat dibuka kembali. | DRAFT |
| D-11 | Penilaian `FINALIZED` tidak dapat diubah atau dihapus. Kesalahan setelah final dicatat lewat siklus berikutnya; koreksi resmi menunggu keputusan owner. | DRAFT |
| D-12 | Paket 1 tidak menyimpan persentase atau nominal dan tidak dibaca payroll. | ACCEPTED |
| D-13 | `performance.read` dan `performance.manage` dibawa `human_capital_admin`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy. Penilai melihat penilaian yang ditugaskan kepadanya saja; pegawai melihat miliknya saja. | DRAFT |
| D-14 | Peserta dapat ditambahkan selama `DRAFT` dan `OPEN` (satu per satu atau semua pegawai aktif sekaligus). Pegawai yang berhenti atau dipindahkan dari siklus dikeluarkan HC dengan alasan (`REMOVED`); menambahkannya kembali menghidupkan penilaian yang sama. | DRAFT |
| D-16 | Saat disahkan, sistem menyimpan **trend** dibanding penilaian final sebelumnya dengan jenis siklus yang sama: `FIRST` (belum ada pembanding), `IMPROVING`, `STABLE`, `DECLINING`. Dibandingkan pada nilai akhir, bukan kode predikat, karena rubrik dua siklus bisa berbeda. Legacy menyimpan trend atas keputusan PO 2026-05-31. | DRAFT |
| D-15 | Penilai yang akunnya belum aktif tetap dapat ditunjuk; rekap HC menandainya. Penilaian menunggu sampai akun itu aktif. Ini sengaja: HCIS belum live ke staf dan approval berbasis struktur menunggu akun pemimpin. | DRAFT |

## 5. Actor

| Actor | Tindakan |
| --- | --- |
| HC dengan `performance.manage` | Membuat dan mengubah siklus `DRAFT`, membuka, menutup, membatalkan siklus; menambah dan mengeluarkan peserta; menunjuk penilai; mengesahkan atau mengembalikan |
| HC dengan `performance.read` | Rekap siklus, detail penilaian, riwayat per pegawai |
| Pegawai yang dinilai | Mengisi penilaian diri, melihat hasil setelah disahkan, menandai sudah dibaca, melihat riwayat miliknya |
| Penilai | Melihat penilaian yang ditugaskan kepadanya, termasuk penilaian diri; mengirim nilai |
| Sistem | Resolusi penilai, perhitungan nilai dan predikat, audit, notifikasi |

## 6. State

### 6.1 Siklus

```text
DRAFT -> OPEN       (HC; minimal satu peserta; rubrik dibekukan)
DRAFT -> CANCELLED  (HC, alasan; peserta -> REMOVED)
OPEN  -> CLOSED     (HC; hari ini >= akhir periode; tidak ada HC_VALIDATION)
CLOSED / CANCELLED -> terminal
```

### 6.2 Penilaian

```text
SELF_ASSESSMENT -> MANAGER_REVIEW   (pegawai mengirim penilaian diri)
SELF_ASSESSMENT -> HC_VALIDATION    (penilai menilai setelah batas penilaian diri lewat, D-08)
MANAGER_REVIEW  -> HC_VALIDATION    (penilai mengirim nilai; nilai akhir dan predikat dihitung)
HC_VALIDATION   -> FINALIZED        (HC mengesahkan)
HC_VALIDATION   -> MANAGER_REVIEW   (HC mengembalikan, alasan wajib)
SELF_ASSESSMENT / MANAGER_REVIEW -> UNRATED   (siklus ditutup)
SELF_ASSESSMENT / MANAGER_REVIEW / HC_VALIDATION -> REMOVED  (HC, alasan)
REMOVED -> SELF_ASSESSMENT          (HC menambahkan kembali, siklus DRAFT/OPEN)
FINALIZED / UNRATED -> terminal
```

Tanda sudah dibaca (`acknowledged_at`) adalah atribut `FINALIZED`, bukan state.

Selama siklus `DRAFT`, penilaian peserta berstatus `SELF_ASSESSMENT` tetapi tidak terlihat oleh pegawai maupun penilai, dan semua tindakan pegawai/penilai ditolak `PERFORMANCE_CYCLE_NOT_OPEN`.

## 7. Alur

Semua perubahan state berjalan dalam satu transaksi dengan baris penilaian dikunci `FOR UPDATE`, dan baris siklus dikunci lebih dulu bila tindakan memeriksa state siklus, sehingga dua tindakan bersamaan tidak memenangkan transisi yang sama.

### 7.1 Membuat dan menyiapkan siklus

Input: `name` (3–120), `kind`, `periodStart`, `periodEnd`, `selfDueOn`, `reviewDueOn` (`YYYY-MM-DD`), `rubric` opsional (default D-05/D-06). Validasi D-02, D-05, D-06; batas penilaian diri ≥ awal periode, batas penilai ≥ batas penilaian diri. Periode yang sudah dipakai siklus tidak-batal jenis yang sama: 409 `PERFORMANCE_CYCLE_PERIOD_TAKEN`.

Selama `DRAFT`, `PATCH` mengubah nama, tanggal, dan rubrik. Siklus `OPEN` ke atas: 409 `PERFORMANCE_CYCLE_LOCKED`.

### 7.2 Peserta

`POST .../participants` dengan `employeeIds` (1–100) atau `allActive: true`. Untuk tiap pegawai aktif yang belum menjadi peserta aktif: resolusi penilai (D-01), simpan penilaian `SELF_ASSESSMENT`, audit `performance.review.added`. Penilai tak teresolusi tidak menggagalkan penambahan; penilaian tersimpan tanpa penilai dan rekap menandainya. Pegawai tidak aktif atau tidak dikenal ditolak 409 `PERFORMANCE_EMPLOYEE_NOT_ACTIVE` (mode `employeeIds`) atau dilewati (mode `allActive`). Hasil melaporkan jumlah ditambahkan, dihidupkan kembali, dilewati, dan tanpa penilai. Bila siklus sudah `OPEN`, peserta baru menerima notifikasi.

### 7.3 Membuka siklus

Precondition `DRAFT` dan minimal satu penilaian `SELF_ASSESSMENT`; lainnya 409 `PERFORMANCE_CYCLE_EMPTY`. Rubrik yang tersimpan pada siklus menjadi rubrik final. Audit `performance.cycle.opened`; notifikasi ke setiap peserta.

### 7.4 Penilaian diri

Pegawai pemilik, siklus `OPEN`, status `SELF_ASSESSMENT`. Input `scores` (setiap indikator tepat sekali, bulat 1–4) dan `note` opsional (≤ 2000, capaian dan kendala). Status → `MANAGER_REVIEW`; audit `performance.review.self_submitted`; notifikasi ke penilai bila ada. Lainnya 409 `PERFORMANCE_SELF_NOT_ALLOWED`; nilai tidak valid 400 `PERFORMANCE_SCORES_INVALID`.

### 7.5 Penilaian atasan

Hanya penilai tersimpan; lainnya 404 (penilaian orang lain tidak dapat dibedakan dari yang tidak ada). Siklus `OPEN` dan D-08 terpenuhi; lainnya 409 `PERFORMANCE_RATING_NOT_ALLOWED`. Input `scores`, `strengths` (≤ 2000), `improvements` (≤ 2000), `note` (≤ 2000). Server menghitung nilai akhir (D-05) dan predikat (D-06) dari rubrik siklus. Status → `HC_VALIDATION`; audit `performance.review.rated`.

### 7.6 Pengesahan dan pengembalian

`performance.manage`; status `HC_VALIDATION`; lainnya 409 `PERFORMANCE_NOT_IN_VALIDATION`. Pengesah adalah pegawai yang dinilai atau penilainya: 403 `PERFORMANCE_SELF_VALIDATION`.

- Sahkan → `FINALIZED` dengan trend (D-16), audit `performance.review.finalized`, notifikasi pegawai.
- Kembalikan (alasan 10–1000) → `MANAGER_REVIEW`, nilai akhir dan predikat dikosongkan, nilai indikator penilai disimpan sebagai isian awal, audit `performance.review.returned` dengan alasan, notifikasi penilai.

### 7.7 Menunjuk penilai

`performance.manage`; siklus `DRAFT`/`OPEN`; status `SELF_ASSESSMENT` atau `MANAGER_REVIEW`; lainnya 409 `PERFORMANCE_RATER_LOCKED`. Penilai harus pegawai aktif dan bukan pegawai yang dinilai (409 `PERFORMANCE_RATER_INVALID`). Alasan 5–500. Sumber `HC_ASSIGNED`; audit `performance.review.rater_assigned` dengan penilai lama dan baru; notifikasi penilai baru bila siklus `OPEN`.

### 7.8 Mengeluarkan peserta

`performance.manage`; siklus `DRAFT`/`OPEN`; status aktif; alasan 5–500 → `REMOVED`, audit `performance.review.removed`. Lainnya 409 `PERFORMANCE_NOT_REMOVABLE`.

### 7.9 Tanda sudah dibaca

Pegawai pemilik, status `FINALIZED`, belum ditandai; tanggapan opsional ≤ 1000. Audit `performance.review.acknowledged`. Lainnya 409 `PERFORMANCE_NOT_ACKNOWLEDGEABLE`.

### 7.10 Menutup dan membatalkan siklus

Tutup: D-10; 409 `PERFORMANCE_CYCLE_NOT_ENDED` sebelum akhir periode, 409 `PERFORMANCE_CYCLE_HAS_PENDING_VALIDATION` bila masih ada `HC_VALIDATION`. Penilaian `SELF_ASSESSMENT`/`MANAGER_REVIEW` → `UNRATED` dengan audit `performance.review.unrated` per penilaian. Audit `performance.cycle.closed` dengan rekap jumlah.

Batal: hanya `DRAFT`, alasan 10–500, peserta → `REMOVED`, audit `performance.cycle.cancelled`.

Kegagalan umum: input tidak valid 400 (`INVALID_PERFORMANCE_REQUEST`), siklus/penilaian tidak ditemukan 404, rubrik tidak valid 400 `PERFORMANCE_RUBRIC_INVALID`, periode tidak valid 400 `PERFORMANCE_PERIOD_INVALID`, akun bukan pegawai aktif 403 `EMPLOYEE_NOT_ACTIVE`, tanpa permission 403 `PERFORMANCE_FORBIDDEN`.

## 8. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `performance.read` | Rekap siklus, detail penilaian siapa pun, riwayat per pegawai | `human_capital_admin` |
| `performance.manage` | Mengelola siklus, peserta, penilai, pengesahan | `human_capital_admin` |

Akses pegawai ke penilaiannya sendiri dan akses penilai ke penilaian yang ditugaskan adalah kepemilikan dari sesi dan snapshot, bukan permission. Nilai kinerja adalah data pribadi: tidak ada permission unit-scoped, dan Super Admin legacy tidak membawanya.

Migrasi `0121` menambah izin ke role yang sudah ada, jadi rilisnya berdiri sendiri (DOC-001 D-17, OPS-MI8-REL-001 §4.5). `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama.

## 9. Audit dan riwayat

`performance_events` adalah riwayat sekaligus audit event, per siklus dan per penilaian:

`performance.cycle.created`, `performance.cycle.updated`, `performance.cycle.opened`, `performance.cycle.closed`, `performance.cycle.cancelled`, `performance.review.added`, `performance.review.readded`, `performance.review.rater_assigned`, `performance.review.self_submitted`, `performance.review.rated`, `performance.review.returned`, `performance.review.finalized`, `performance.review.acknowledged`, `performance.review.removed`, `performance.review.unrated`.

Setiap event memuat aktor, waktu (`clock_timestamp()`), alasan sebagai `note`, dan metadata aman (penilai lama/baru, sumber penilai, predikat). Nilai per indikator **tidak** disalin ke event; nilai hanya ada di baris penilaian.

Pegawai melihat riwayat penilaiannya sendiri tanpa catatan apa pun dan tanpa event kalibrasi. Penilai melihat event penilaian yang ditugaskan kepadanya, tetapi catatannya hanya alasan pengembalian HC; alasan penunjukan ulang atau pengeluaran tetap hanya untuk HC. Mengeluarkan peserta menghapus nilai akhir dan predikatnya.

## 10. Notifikasi (NOTIF-004, kategori `system`)

- siklus dibuka atau peserta ditambahkan ke siklus terbuka → pegawai;
- penilaian diri dikirim → penilai;
- penilai ditunjuk ulang → penilai baru;
- dikembalikan HC → penilai;
- disahkan → pegawai.

Ditulis dalam transaksi yang sama dengan transisinya. Setiap kejadian memakai `eventKey` sendiri, sehingga pemberitahuan ulang (peserta dimasukkan kembali, penilai ditunjuk ulang, dikembalikan lagi) tidak tertelan oleh kejadian sebelumnya. Isi notifikasi tidak memuat nilai atau predikat.

## 11. Kontrak sambungan payroll (Paket berikutnya, belum dibangun)

PAY-003 menghitung `PERF = %tahunan × dasar × 60% + %bulanan × dasar × 40%` (`payroll-calculation-v1.md` §5.1) dan saat ini mengambil kedua persentase dari profil kompensasi atau override HC. Sambungannya kelak:

1. **Sumber.** Payroll hanya membaca penilaian `FINALIZED`. `UNRATED`, `REMOVED`, dan penilaian siklus yang belum ditutup tidak pernah dibaca.
2. **Pemetaan.** Predikat → persentase disimpan sebagai kebijakan payroll berversi baru (`PERFORMANCE_PERCENT`), bukan di PERF-001. Default yang akan diusulkan: A 100%, B 90%, C 75%, D 50% (`DRAFT`, butuh keputusan owner).
3. **Periode.** `%bulanan` periode payroll bulan *M* membaca siklus `MONTHLY` bulan *M−1* (penilaian bulan lalu, sama dengan default formulir legacy). `%tahunan` membaca siklus `ANNUAL` tahun ajaran terakhir yang sudah `CLOSED` pada tanggal gajian.
4. **Tanpa hasil.** Bila tidak ada penilaian final, payroll memakai nilai profil kompensasi seperti hari ini (termasuk default masa kerja < 1 tahun, PAY-003 §10 butir 3). Tidak ada nilai yang ditebak.
5. **Jejak.** Snapshot input payroll menyimpan `reviewId`, siklus, dan predikat yang dipakai, sehingga hasil dapat diaudit ulang.
6. **Prasyarat.** Parallel run PAY-003 lulus, kebijakan pemetaan disetujui owner, dan revisi `payroll-calculation-v1.md`.

PERF-001 tidak mengubah tabel, kebijakan, atau hasil payroll mana pun.

## 12. Penyimpanan

```text
performance_cycles    siklus, periode, batas waktu, rubrik (jsonb, dibekukan saat OPEN)
performance_reviews   satu baris per pegawai per siklus: penilai + snapshot, penilaian diri,
                      nilai penilai, nilai akhir, predikat, pengesahan, tanda dibaca
performance_events    riwayat dan audit
```

Aturan:

- `performance_cycles`: indeks unik parsial `(kind, period_start) WHERE status <> 'CANCELLED'` (D-02); `CHECK (period_end > period_start)`;
- `performance_reviews`: unik `(cycle_id, employee_id)`; `CHECK (rater_employee_id IS DISTINCT FROM employee_id)`; `final_score` `numeric(3,2)` antara 1 dan 4; `final_score` dan `predicate_code` terisi tepat ketika status `HC_VALIDATION` atau `FINALIZED`;
- tidak ada kolom persentase atau nominal;
- tidak ada endpoint hapus.

Rollback migrasi ditulis sebagai komentar `-- Down:` di berkas migrasi.

## 13. API

Pegawai: `GET /performance/me` (halaman), `GET /performance/me/:id`, `POST /performance/me/:id/self-assessment`, `POST /performance/me/:id/acknowledge`.

Penilai: `GET /performance/team` (halaman, filter status), `GET /performance/team/:id`, `POST /performance/team/:id/rating`.

HC: `GET /admin/performance/cycles` (halaman), `POST /admin/performance/cycles`, `GET /admin/performance/cycles/:id` (dengan rekap per status dan predikat), `PATCH /admin/performance/cycles/:id`, `POST /admin/performance/cycles/:id/open`, `POST /admin/performance/cycles/:id/close`, `POST /admin/performance/cycles/:id/cancel`, `POST /admin/performance/cycles/:id/participants`, `GET /admin/performance/cycles/:id/reviews` (halaman; filter status, predikat, tanpa penilai, pegawai, pencarian nama/NIP), `GET /admin/performance/reviews/:id`, `POST /admin/performance/reviews/:id/rater`, `POST /admin/performance/reviews/:id/finalize`, `POST /admin/performance/reviews/:id/return`, `POST /admin/performance/reviews/:id/remove`, `GET /admin/performance/employees/:employeeId/reviews` (halaman).

Kontrak lengkap: `docs/api/performance.openapi.yaml`, tag `Performance`. Semua daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`; filter dan scope berjalan sebelum `LIMIT`; pemilih pegawai (filter rekap, tambah peserta, tunjuk penilai) memakai pencarian typeahead server.

## 14. Layar

- Pegawai: `/app/performance` — tab **Penilaian saya** (daftar berhalaman, formulir penilaian diri, hasil setelah disahkan, tanda dibaca) dan tab **Tim saya** (antrean penilaian yang ditugaskan, formulir nilai dengan penilaian diri di sampingnya).
- HC: `/admin/performance` di Layanan Pegawai admin — daftar siklus, buat/ubah siklus dan rubrik, tambah peserta (semua pegawai aktif atau typeahead), buka/tutup/batal, rekap per status dan predikat, tabel penilaian berhalaman dengan filter, detail penilaian dengan Sahkan/Kembalikan/Tunjuk penilai/Keluarkan, riwayat per pegawai.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 15. Acceptance criteria

- PERF-001-A: pegawai hanya melihat penilaiannya sendiri, hanya dari siklus `OPEN`/`CLOSED`; nilai penilai dan predikat baru terlihat setelah `FINALIZED`.
- PERF-001-B: penilai disnapshot dari struktur saat pegawai ditambahkan; perubahan atasan sesudahnya tidak memindahkannya; tanpa atasan, penilaian tersimpan tanpa penilai.
- PERF-001-C: hanya penilai tersimpan yang dapat menilai; penilaian orang lain 404; penilaian sebelum penilaian diri dan sebelum batasnya lewat ditolak.
- PERF-001-D: nilai akhir dan predikat dihitung server dari rubrik siklus; nilai indikator yang hilang, berlebih, atau di luar 1–4 ditolak.
- PERF-001-E: rubrik terkunci setelah siklus dibuka; bobot yang tidak berjumlah 100 atau predikat tanpa batas 1,00 ditolak.
- PERF-001-F: pengesahan hanya dari `HC_VALIDATION` oleh `performance.manage`, bukan oleh pegawai yang dinilai atau penilainya; pengembalian wajib alasan dan mengosongkan predikat.
- PERF-001-G: siklus tidak dapat ditutup sebelum akhir periode atau selama ada penilaian menunggu pengesahan; penutupan membuat penilaian yang belum dinilai `UNRATED`.
- PERF-001-H: tanpa `performance.read` rekap menjawab 403; Super Admin legacy tidak menerima `performance.*`.
- PERF-001-I: setiap transisi menulis event dengan aktor; event tidak memuat nilai indikator.
- PERF-001-J: tidak ada kolom atau field persentase atau nominal di skema maupun kontrak.
- PERF-001-K: dua siklus tidak-batal dengan jenis dan periode sama ditolak.

## 16. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| D-01 | Siapa menilai? | Atasan langsung menurut struktur; HC dapat menunjuk penilai lain |
| D-02 | Periode penilaian? | Bulanan (seperti legacy) dan tahunan per tahun ajaran |
| D-03 | Penilaian diri ikut dihitung? | Tidak, hanya pembanding |
| D-04/D-06 | Skala dan predikat? | 1–4; A ≥ 3,5, B ≥ 2,5, C ≥ 1,5, D (legacy) |
| D-05 | Indikator dan bobot? | Hasil kerja 30, Disiplin 20, Akhlak 20, Kerja sama 15, Inisiatif 15 |
| D-07 | Siapa mengesahkan, dan bagaimana kalibrasi? | HC; kalibrasi = mengembalikan ke penilai |
| D-09 | Ada banding? | Tidak; pegawai memberi tanggapan |
| §11 | Predikat → persentase tunjangan kinerja? | Diusulkan A 100%, B 90%, C 75%, D 50%; belum dipakai payroll |
