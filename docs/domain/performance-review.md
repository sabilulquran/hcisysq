# Penilaian Kinerja

**Status:** ACCEPTED (Paket 1) — spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** PERF-001
**Tanggal:** 2026-11-02
**Rilis:** `hcis-3b1c85f4-20261103`, 3 Nov 2026 01:43 UTC (migrasi 0120 + 0121); bukti `docs/development/production-release-verification-2026-11-03-3b1c85f4.md`
**Amandemen:** 18 Nov 2026 (keputusan owner) — D-17 jalur keberatan pegawai, D-18 siklus semesteran, D-19 rubrik berversi, D-20 rubrik per kelompok jabatan; migrasi 0175 dan 0176. Keputusan yang digantikan tetap tertulis di bawah dengan catatan penggantinya.
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

Paket 1 **hanya menyimpan hasil**. Sambungan ke PAY-003 sudah dibangun (§11) di balik sakelar yang default-nya mati; selama mati, nilai kinerja tidak mengubah gaji siapa pun.

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
| ~~Banding atas hasil~~, koreksi setelah final | D-11. **Diubah D-17 (18 Nov 2026):** keberatan pegawai kini termasuk lingkup, tetapi hanya **sebelum** pengesahan. Koreksi setelah final tetap di luar lingkup. |
| Penilai akun yayasan (`FOUNDATION_BOARD`) | Penilai Paket 1 hanya pegawai. Direktur yang atasannya Ketua Yayasan ditunjuk penilainya oleh HC atau dikeluarkan dari siklus (D-01). |
| Cetak LPK dan ekspor CSV | Rekap dibaca di layar; cetak dan ekspor menyusul. |
| Kaitan ke kompetensi jabatan dan pelatihan | TRAIN-001. |

## 4. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Penilai adalah **atasan langsung menurut struktur**: resolver yang sama dengan APR-001 dan lembur ATT-011-6b (kunci alur ORG-004 `PERF`, sumber `DIRECT_MANAGER`, bila struktur memakai approver tata kelola maka orang itu). Diresolusi dan disnapshot saat pegawai ditambahkan ke siklus pada tanggal efektif `min(hari ini, akhir periode)`. Perubahan struktur sesudahnya tidak memindahkan penilai. Bila tidak teresolusi, penilaian menunggu HC menunjuk penilai. HC boleh mengganti penilai dengan alasan selama penilai belum mengirim nilai. Penilai tidak pernah pegawai yang dinilai. | DRAFT |
| D-02 | Dua jenis siklus: `MONTHLY` (satu bulan kalender, sama dengan legacy) dan `ANNUAL` (satu tahun ajaran, 1 Juli–30 Juni). Satu jenis hanya punya satu siklus tidak-batal per periode. Satu pegawai satu penilaian per siklus. **Diperluas D-18 (18 Nov 2026):** jenis ketiga `SEMESTER`. | DRAFT |
| D-03 | Penilaian diri ditawarkan kepada setiap peserta tetapi **tidak dihitung**; nilai akhir hanya dari penilai. Penilai melihat penilaian diri sebelum menilai. | DRAFT |
| D-04 | Skala 1–4 legacy: 4 Sangat baik, 3 Baik, 2 Cukup, 1 Kurang. | DRAFT (mengikuti legacy) |
| D-05 | Nilai akhir = Σ(nilai × bobot) / 100, antara 1,00 dan 4,00, tepat dua desimal. Bobot bilangan bulat dengan jumlah tepat 100. Rubrik default lima indikator: Hasil kerja 30, Disiplin dan kehadiran 20, Akhlak dan adab 20, Kerja sama dan komunikasi 15, Inisiatif dan pengembangan diri 15. HC mengubahnya selama siklus `DRAFT`. **Diperbarui D-19/D-20 (18 Nov 2026):** angka itu bukan lagi tetapan kode melainkan versi rubrik 1, dan bobot boleh berbeda menurut kelompok jabatan. Rumus nilai akhir dan aturan jumlah bobot 100 tidak berubah. | DRAFT |
| D-06 | Predikat: **A Sangat baik** ≥ 3,50; **B Baik** ≥ 2,50; **C Cukup** ≥ 1,50; **D Kurang** di bawahnya — batas legacy. Batas dapat diubah per siklus selama `DRAFT`; harus mencakup 1,00. **Diperbarui D-19 (18 Nov 2026):** batas predikat ikut berada di dalam versi rubrik. | DRAFT |
| D-07 | Hasil penilai disahkan HC (`performance.manage`). HC dapat **mengembalikan** ke penilai dengan alasan; itulah kalibrasi Paket 1 — HC tidak pernah mengetik nilai pengganti. Pengesah tidak boleh pegawai yang dinilai maupun penilainya. Admin HC yang juga peserta tidak dapat mengganti penilai, mengeluarkan, atau memasukkan kembali penilaiannya sendiri, dan di layar HC melihat penilaiannya sendiri seperti pegawai lain (sejak D-17, hasil tampak begitu nilai masuk ke HC, dan tidak sedetik lebih awal). | DRAFT |
| D-08 | Penilai dapat menilai setelah pegawai mengirim penilaian diri, atau setelah batas penilaian diri lewat tanpa kiriman, supaya pegawai yang diam tidak menahan siklus. Pegawai masih boleh mengirim penilaian diri terlambat selama penilai belum menilai. | DRAFT |
| D-09 | Pegawai melihat nilai penilai dan predikat **setelah disahkan**, lalu dapat menandai sudah dibaca dengan tanggapan opsional (≤ 1000 karakter). Tanggapan tidak mengubah nilai. ~~Tidak ada banding di Paket 1.~~ **Diubah D-17 (18 Nov 2026):** pegawai melihat nilai penilai begitu nilai itu masuk ke HC (`HC_VALIDATION`), karena itulah yang dapat ia keberatani; tanda dibaca beserta tanggapannya setelah final tetap persis seperti semula. | DRAFT |
| D-10 | Siklus ditutup HC pada atau sesudah akhir periode. Penutupan ditolak selama masih ada penilaian menunggu pengesahan. Penilaian yang belum dinilai menjadi `UNRATED` (tanpa predikat). Siklus tertutup tidak dapat dibuka kembali. | DRAFT |
| D-11 | Penilaian `FINALIZED` tidak dapat diubah atau dihapus. Kesalahan setelah final dicatat lewat siklus berikutnya; koreksi resmi menunggu keputusan owner. | DRAFT |
| D-12 | PERF-001 tidak menyimpan persentase atau nominal. Payroll membaca predikat penilaian `FINALIZED` hanya bila sakelar §11 menyala; pemetaan ke persen milik kebijakan payroll. | ACCEPTED (diperbarui 2026-11-17) |
| D-13 | `performance.read` dan `performance.manage` dibawa `human_capital_admin`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy. Penilai melihat penilaian yang ditugaskan kepadanya saja; pegawai melihat miliknya saja. | DRAFT |
| D-14 | Peserta dapat ditambahkan selama `DRAFT` dan `OPEN` (satu per satu atau semua pegawai aktif sekaligus). Pegawai yang berhenti atau dipindahkan dari siklus dikeluarkan HC dengan alasan (`REMOVED`); menambahkannya kembali menghidupkan penilaian yang sama. | DRAFT |
| D-16 | Saat disahkan, sistem menyimpan **trend** dibanding penilaian final sebelumnya dengan jenis siklus yang sama: `FIRST` (belum ada pembanding), `IMPROVING`, `STABLE`, `DECLINING`. Dibandingkan pada nilai akhir, bukan kode predikat, karena rubrik dua siklus bisa berbeda. Legacy menyimpan trend atas keputusan PO 2026-05-31. | DRAFT |
| D-15 | Penilai yang akunnya belum aktif tetap dapat ditunjuk; rekap HC menandainya. Penilaian menunggu sampai akun itu aktif. Ini sengaja: HCIS belum live ke staf dan approval berbasis struktur menunggu akun pemimpin. | DRAFT |
| D-17 | **Jalur keberatan pegawai sebelum pengesahan** (18 Nov 2026). Setelah penilai mengirim nilai dan sebelum HC mengesahkan, pegawai melihat nilainya dan boleh **mengajukan keberatan satu kali**, dengan alasan 10–1000 karakter, dalam masa keberatan **7 hari** sejak nilai dikirim (`DRAFT`, usulan owner). HC memutuskan: **diterima** → penilaian kembali ke penilai untuk dinilai ulang, dan nilai akhir serta predikatnya dikosongkan — persis jalur "kembalikan" yang sudah ada, karena model kewenangan modul ini (D-07) adalah HC tidak pernah mengetik nilai pengganti; atau **ditolak** dengan alasan, dan nilai penilai tetap. Pengesahan **ditahan** selama keberatan terbuka, dan juga selama masa keberatan masih berjalan; pegawai dapat menutup masa itu lebih awal dengan menerima nilainya (`WAIVED`), sehingga HC tidak perlu menunggu tujuh hari untuk pegawai yang sudah bersikap. Satu siklus satu keberatan, dan masa keberatannya ikut habis bersamanya: penilaian yang dinilai ulang setelah keberatan diputuskan **tidak** mendapat masa keberatan baru, dan tanggal jatuh temponya dikosongkan, bukan diisi tanggal yang tidak berarti apa-apa. Setiap langkah tercatat sebagai event dengan aktornya dan pegawai diberi tahu. Pemutus keberatan tidak boleh pegawai yang dinilai maupun penilainya (D-07). | DRAFT |
| D-18 | **Siklus semesteran** (18 Nov 2026). Jenis ketiga `SEMESTER` mengikuti kalender pendidikan: ganjil 1 Juli–31 Desember, genap 1 Januari–30 Juni, sehingga dua semester menutup tepat satu tahun ajaran `ANNUAL`. Ia hanya satu bentuk periode baru: aturan nilai, predikat, trend, dan penutupan siklus tidak dikhususkan untuk jenis ini. Aturan "satu siklus tidak-batal per jenis per periode" (D-02) berlaku apa adanya. | DRAFT |
| D-19 | **Rubrik berversi milik HC** (18 Nov 2026). Indikator, bobot, dan batas predikat tidak lagi tertanam di kode: HC menambah **versi rubrik bertanggal** (`performance_rubric_versions`). Tabelnya append-only dengan pembuat dan waktunya, jadi baris itu sekaligus audit; versi tidak pernah diubah atau dihapus, hanya ditambah, dan versi baru berlaku paling awal pada tanggal berlaku versi terakhir supaya hari yang sudah dinilai tidak berpindah rubrik. Jumlah bobot tepat 100 dijaga database (`CHECK`), bukan hanya kode. Migrasi 0175 memuat angka yang sedang berjalan sebagai versi 1 berjenis `DEFAULT`, sehingga tidak ada yang berubah saat dipasang. | DRAFT |
| D-20 | **Rubrik per kelompok jabatan** (18 Nov 2026, atas contoh owner: akhlak berbobot lain bagi guru tahfizh dan bagi office boy). Satu versi rubrik bercakupan `DEFAULT` (semua jabatan) atau `JOB_GROUP` (sekumpulan kode **klasifikasi jabatan** ORG-011/ADR-0004, tidak pernah teks nama jabatan). Rubrik satu peserta dipilih saat ia masuk siklus, pada tanggal efektif yang sama dengan penentuan penilai, berlapis dari yang paling khusus: (1) versi `JOB_GROUP` yang menyebut salah satu kode klasifikasi pegawai itu; (2) rubrik yang HC ketik sendiri pada siklus itu, yang menggantikan `DEFAULT` untuk siklus tersebut; (3) versi `DEFAULT` yang berlaku. Di antara versi yang setingkat, `(tanggal berlaku, nomor versi)` terbesar menang. Pegawai yang jabatannya tidak terpetakan ke klasifikasi mana pun tetap dinilai lewat `DEFAULT`. Karena satu siklus kini memuat beberapa rubrik sekaligus, **rubrik dibekukan pada penilaian** (`performance_reviews.rubric`) beserta nomor versinya; rubrik siklus tetap ada sebagai cadangan dan tetap dibekukan saat siklus dibuka. Pembekuan itu **diulang saat siklus dibuka** untuk setiap peserta yang belum dinilai: peserta boleh ditambahkan selagi siklus `DRAFT`, dan selama itu HC masih boleh memperbaiki bobot rubrik siklus dan versi rubrik baru masih mungkin mulai berlaku, sehingga rubrik yang dibekukan saat penambahan dapat sudah basi. Membuka siklus adalah saat terakhir apa pun masih dapat berubah, jadi di situlah pembekuan dikunci. Mengubah rubrik tidak pernah mengubah penilaian yang sudah ada, termasuk yang sudah final. | DRAFT |

## 5. Actor

| Actor | Tindakan |
| --- | --- |
| HC dengan `performance.manage` | Membuat dan mengubah siklus `DRAFT`, membuka, menutup, membatalkan siklus; menambah dan mengeluarkan peserta; menunjuk penilai; mengesahkan atau mengembalikan |
| HC dengan `performance.read` | Rekap siklus, detail penilaian, riwayat per pegawai |
| Pegawai yang dinilai | Mengisi penilaian diri, melihat hasil setelah disahkan, menandai sudah dibaca, melihat riwayat miliknya |
| Penilai | Melihat penilaian yang ditugaskan kepadanya, termasuk penilaian diri; mengirim nilai |
| Sistem | Resolusi penilai, perhitungan nilai dan predikat, audit, notifikasi |

- EMP-005 S2B §8.7: data pegawai yang ditandai **di luar pengelolaan HCIS** tidak dapat membuat pengajuan baru di sini — pratinjau dan pengiriman ditolak dengan `409 EMPLOYEE_OUTSIDE_HCIS_READ_ONLY`. Riwayatnya tetap terbaca dan langkah penutup atas pengajuan yang sudah berjalan tetap terbuka. Aturan dan catatan `DRAFT` 2026-11-23 ada di `employment-administration-package1.md` §8.7.

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
HC_VALIDATION   -> FINALIZED        (HC mengesahkan; D-17: tidak selama keberatan terbuka
                                     atau masa keberatan masih berjalan)
HC_VALIDATION   -> MANAGER_REVIEW    (HC mengembalikan, alasan wajib, atau menerima keberatan)
SELF_ASSESSMENT / MANAGER_REVIEW -> UNRATED   (siklus ditutup)
SELF_ASSESSMENT / MANAGER_REVIEW / HC_VALIDATION -> REMOVED  (HC, alasan)
REMOVED -> SELF_ASSESSMENT          (HC menambahkan kembali, siklus DRAFT/OPEN)
FINALIZED / UNRATED -> terminal
```

Tanda sudah dibaca (`acknowledged_at`) adalah atribut `FINALIZED`, bukan state. Begitu pula keberatan (D-17): ia atribut penilaian yang sedang `HC_VALIDATION`, dengan statusnya sendiri.

```text
keberatan:  (belum ada) -> OPEN      (pegawai mengajukan, dalam masa keberatan)
            (belum ada) -> WAIVED    (pegawai menerima nilai, menutup masa keberatan)
            OPEN        -> UPHELD    (HC menerima; penilaian -> MANAGER_REVIEW)
            OPEN        -> REJECTED  (HC menolak, alasan wajib; nilai tetap)
```

Selama siklus `DRAFT`, penilaian peserta berstatus `SELF_ASSESSMENT` tetapi tidak terlihat oleh pegawai maupun penilai, dan semua tindakan pegawai/penilai ditolak `PERFORMANCE_CYCLE_NOT_OPEN`.

## 7. Alur

Semua perubahan state berjalan dalam satu transaksi dengan baris penilaian dikunci `FOR UPDATE`, dan baris siklus dikunci lebih dulu bila tindakan memeriksa state siklus, sehingga dua tindakan bersamaan tidak memenangkan transisi yang sama.

### 7.1 Membuat dan menyiapkan siklus

Input: `name` (3–120), `kind`, `periodStart`, `periodEnd`, `selfDueOn`, `reviewDueOn` (`YYYY-MM-DD`), `rubric` opsional. Tanpa `rubric`, siklus menyalin versi rubrik `DEFAULT` yang berlaku hari ini dan mencatat nomornya (D-19); dengan `rubric`, HC mengetik rubrik khusus siklus itu dan nomor versinya menjadi kosong. Validasi D-02, D-05, D-06, D-18; batas penilaian diri ≥ awal periode, batas penilai ≥ batas penilaian diri. Periode yang sudah dipakai siklus tidak-batal jenis yang sama: 409 `PERFORMANCE_CYCLE_PERIOD_TAKEN`.

Selama `DRAFT`, `PATCH` mengubah nama, tanggal, dan rubrik. Siklus `OPEN` ke atas: 409 `PERFORMANCE_CYCLE_LOCKED`.

### 7.2 Peserta

`POST .../participants` dengan `employeeIds` (1–100) atau `allActive: true`. Untuk tiap pegawai aktif yang belum menjadi peserta aktif: resolusi penilai (D-01), **resolusi rubrik** (D-20) pada tanggal efektif yang sama, simpan penilaian `SELF_ASSESSMENT` beserta rubrik dan nomor versinya, audit `performance.review.added` dengan nomor versi rubrik dan kode klasifikasi jabatan yang dipakai memilihnya. Penilai tak teresolusi tidak menggagalkan penambahan; penilaian tersimpan tanpa penilai dan rekap menandainya. Pegawai tidak aktif atau tidak dikenal ditolak 409 `PERFORMANCE_EMPLOYEE_NOT_ACTIVE` (mode `employeeIds`) atau dilewati (mode `allActive`). Hasil melaporkan jumlah ditambahkan, dihidupkan kembali, dilewati, tanpa penilai, dan tanpa versi rubrik (`withoutJobRubric`, yaitu peserta yang jatuh ke rubrik cadangan siklus karena belum ada versi rubrik sama sekali). Bila siklus sudah `OPEN`, peserta baru menerima notifikasi.

### 7.3 Membuka siklus

Precondition `DRAFT` dan minimal satu penilaian `SELF_ASSESSMENT`; lainnya 409 `PERFORMANCE_CYCLE_EMPTY`. Rubrik yang tersimpan pada siklus menjadi rubrik final.

D-20: sebelum siklus berpindah ke `OPEN`, rubrik setiap peserta yang belum dinilai **diresolusi dan dibekukan ulang** pada tanggal efektif yang sama dengan penentuan penilai. Ini menutup urutan yang nyata terjadi: HC menambahkan semua pegawai, melihat satu bobot keliru, memperbaikinya, lalu membuka siklus — tanpa pembekuan ulang, semua orang akan dinilai dengan bobot lama tanpa tanda apa pun. Penilaian yang berubah menulis `performance.review.rubric_refrozen` dengan nomor versi lama dan baru; `performance.cycle.opened` mencatat berapa yang berubah. Peserta yang ditambahkan **setelah** siklus dibuka memakai rubrik yang berlaku saat itu dan tidak pernah dibekukan ulang lagi. Audit `performance.cycle.opened`; notifikasi ke setiap peserta.

### 7.4 Penilaian diri

Pegawai pemilik, siklus `OPEN`, status `SELF_ASSESSMENT`. Input `scores` (setiap indikator tepat sekali, bulat 1–4) dan `note` opsional (≤ 2000, capaian dan kendala). Status → `MANAGER_REVIEW`; audit `performance.review.self_submitted`; notifikasi ke penilai bila ada. Lainnya 409 `PERFORMANCE_SELF_NOT_ALLOWED`; nilai tidak valid 400 `PERFORMANCE_SCORES_INVALID`.

### 7.5 Penilaian atasan

Hanya penilai tersimpan; lainnya 404 (penilaian orang lain tidak dapat dibedakan dari yang tidak ada). Siklus `OPEN` dan D-08 terpenuhi; lainnya 409 `PERFORMANCE_RATING_NOT_ALLOWED`. Input `scores`, `strengths` (≤ 2000), `improvements` (≤ 2000), `note` (≤ 2000). Server menghitung nilai akhir (D-05) dan predikat (D-06) dari **rubrik penilaian itu** (D-20), bukan dari rubrik siklus. Status → `HC_VALIDATION`; audit `performance.review.rated`. D-17: bila pegawai masih punya hak keberatan, saat itu juga masa keberatannya dibuka (`objection_due_on` = tanggal pengiriman + 7 hari) dan ia diberi tahu bahwa nilainya dapat dilihat serta sampai kapan ia dapat mengajukan keberatan. Bila keberatannya sudah terpakai pada siklus ini, `objection_due_on` dikosongkan: haknya habis, jadi tidak ada tanggal yang perlu dibaca siapa pun. Isi notifikasi tetap tanpa nilai dan tanpa predikat.

### 7.6 Pengesahan dan pengembalian

`performance.manage`; status `HC_VALIDATION`; lainnya 409 `PERFORMANCE_NOT_IN_VALIDATION`. Pengesah adalah pegawai yang dinilai atau penilainya: 403 `PERFORMANCE_SELF_VALIDATION`.

- Sahkan → `FINALIZED` dengan trend (D-16), audit `performance.review.finalized`, notifikasi pegawai. D-17 menahannya selama keberatan terbuka (409 `PERFORMANCE_OBJECTION_OPEN`) dan selama masa keberatan masih berjalan (409 `PERFORMANCE_OBJECTION_WINDOW_OPEN`).
- Kembalikan (alasan 10–1000) → `MANAGER_REVIEW`, nilai akhir dan predikat dikosongkan, nilai indikator penilai disimpan sebagai isian awal, audit `performance.review.returned` dengan alasan, notifikasi penilai. Ditolak selama ada keberatan terbuka (409 `PERFORMANCE_OBJECTION_OPEN`): keberatan diputuskan, tidak dilangkahi, dan keberatan yang diterima sendiri yang mengembalikan penilaian.

### 7.7 Menunjuk penilai

`performance.manage`; siklus `DRAFT`/`OPEN`; status `SELF_ASSESSMENT` atau `MANAGER_REVIEW`; lainnya 409 `PERFORMANCE_RATER_LOCKED`. Penilai harus pegawai aktif dan bukan pegawai yang dinilai (409 `PERFORMANCE_RATER_INVALID`). Alasan 5–500. Sumber `HC_ASSIGNED`; audit `performance.review.rater_assigned` dengan penilai lama dan baru; notifikasi penilai baru bila siklus `OPEN`.

### 7.8 Mengeluarkan peserta

`performance.manage`; siklus `DRAFT`/`OPEN`; status aktif; alasan 5–500 → `REMOVED`, audit `performance.review.removed`. Lainnya 409 `PERFORMANCE_NOT_REMOVABLE`. D-17: keberatan yang masih terbuka ikut dibersihkan, karena kedua keputusan HC mensyaratkan status `HC_VALIDATION` sehingga keberatan pada penilaian yang sudah dikeluarkan tidak akan pernah dapat diputuskan. Keberatan yang sudah diputuskan tidak disentuh: itu riwayat, dan riwayat tetap terbaca pada barisnya. Menambahkan peserta kembali (7.2) juga mengosongkan seluruh kolom keberatan: keberatan itu milik putaran yang dikeluarkan, bukan milik penilaian yang dihidupkan kembali.

### 7.9 Tanda sudah dibaca

Pegawai pemilik, status `FINALIZED`, belum ditandai; tanggapan opsional ≤ 1000. Audit `performance.review.acknowledged`. Lainnya 409 `PERFORMANCE_NOT_ACKNOWLEDGEABLE`.

### 7.10 Menutup dan membatalkan siklus

Tutup: D-10; 409 `PERFORMANCE_CYCLE_NOT_ENDED` sebelum akhir periode, 409 `PERFORMANCE_CYCLE_HAS_PENDING_VALIDATION` bila masih ada `HC_VALIDATION`. Penilaian `SELF_ASSESSMENT`/`MANAGER_REVIEW` → `UNRATED` dengan audit `performance.review.unrated` per penilaian. Audit `performance.cycle.closed` dengan rekap jumlah.

Batal: hanya `DRAFT`, alasan 10–500, peserta → `REMOVED`, audit `performance.cycle.cancelled`.

### 7.11 Mengelola versi rubrik (D-19, D-20)

`performance.read` membaca daftar versi rubrik; `performance.manage` menambah versi. Tidak ada endpoint ubah atau hapus: tabelnya append-only, dan koreksi dilakukan dengan menambah versi baru.

Input versi: `name` (3–120), `scope` (`DEFAULT` atau `JOB_GROUP`), `effectiveFrom`, `source` (1–200, dari mana angkanya), `note` opsional, `jobClassificationCodes` (wajib dan tidak kosong untuk `JOB_GROUP`, kosong untuk `DEFAULT`, maksimal 50 kode), `indicators`, `predicates`. Validasi rubrik sama dengan rubrik siklus (D-05/D-06), dan jumlah bobot 100 juga ditolak database. Tanggal berlaku lebih awal daripada versi terakhir: 409 `PERFORMANCE_RUBRIC_VERSION_BACKDATED`. Dua HC menyimpan bersamaan: 409 `PERFORMANCE_RUBRIC_VERSION_RACE`, muat ulang lalu simpan lagi.

Pemilihan rubrik satu peserta (D-20) berjalan saat pegawai masuk siklus, bukan saat dinilai, sehingga satu penilaian tidak pernah berpindah rubrik di tengah jalan. Menghidupkan kembali peserta yang pernah dikeluarkan (D-14) me-resolusi ulang rubriknya, karena jabatannya bisa sudah berubah.

Rekap siklus menampilkan `byRubricVersion`: rubrik apa saja yang dipakai siklus itu dan berapa penilaian masing-masing.

### 7.12 Keberatan pegawai (D-17)

**Mengajukan.** Pegawai pemilik penilaian, siklus `OPEN`, status `HC_VALIDATION`, belum pernah mengajukan, dan hari ini ≤ `objection_due_on`. Input `reason` 10–1000 karakter. Keberatan menjadi `OPEN`; status penilaian tidak berubah; audit `performance.review.objected` **tanpa** alasan. Alasannya disimpan di baris penilaian dan **tidak pernah diberikan kepada penilai**: baik alasan pegawai maupun alasan keputusan HC hanya terbaca oleh pegawai itu sendiri dan oleh HC. Penilai cukup tahu bahwa penilaiannya dikembalikan untuk dinilai ulang. Memberi tahu penilai siapa yang keberatan dan apa isinya adalah undangan untuk pembalasan, dan itulah yang membuat jalur keberatan tidak dipakai orang. Kegagalan: 409 `PERFORMANCE_OBJECTION_ALREADY_RAISED` (sudah pernah), 409 `PERFORMANCE_OBJECTION_NOT_ALLOWED` (belum dinilai atau sudah final), 409 `PERFORMANCE_OBJECTION_WINDOW_CLOSED` (lewat masa).

**Menerima nilai tanpa keberatan.** Precondition sama, tanpa input. Keberatan menjadi `WAIVED`; audit `performance.review.objection_waived`. Ini yang membuat HC tidak perlu menunggu tujuh hari untuk pegawai yang sudah bersikap.

**Memutuskan.** `performance.manage`, siklus `OPEN`, status `HC_VALIDATION`, keberatan `OPEN`; lainnya 409 `PERFORMANCE_OBJECTION_NOT_OPEN`. Pemutus bukan pegawai yang dinilai maupun penilainya: 403 `PERFORMANCE_SELF_VALIDATION` (D-07). Alasan 10–1000 karakter wajib pada kedua keputusan.

- Terima → keberatan `UPHELD`, penilaian kembali ke `MANAGER_REVIEW`, nilai akhir dan predikat dikosongkan, nilai indikator penilai tetap sebagai isian awal; audit `performance.review.objection_upheld` dengan alasan (terbaca HC, tidak terbaca penilai); notifikasi ke pegawai dan ke penilai. Penilai menilai ulang; **tidak ada masa keberatan baru** dan `objection_due_on` tetap kosong, karena hak keberatan pegawai untuk siklus ini sudah terpakai dan sudah didengar. Nilai hasil penilaian ulang itu dapat langsung disahkan HC.
- Tolak → keberatan `REJECTED`, nilai tetap, penilaian tetap menunggu pengesahan; audit `performance.review.objection_rejected` dengan alasan; notifikasi ke pegawai. Pegawai membaca alasan HC di detail penilaiannya.

Rekap siklus menampilkan `objectionsOpen`, dan tabel penilaian HC dapat disaring `objection=OPEN`. Keduanya hanya menghitung keberatan pada penilaian yang masih `HC_VALIDATION`, yaitu yang benar-benar dapat diputuskan HC.

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

`performance.cycle.created`, `performance.cycle.updated`, `performance.cycle.opened`, `performance.cycle.closed`, `performance.cycle.cancelled`, `performance.review.added`, `performance.review.readded`, `performance.review.rater_assigned`, `performance.review.self_submitted`, `performance.review.rated`, `performance.review.rubric_refrozen`, `performance.review.returned`, `performance.review.objected`, `performance.review.objection_waived`, `performance.review.objection_upheld`, `performance.review.objection_rejected`, `performance.review.finalized`, `performance.review.acknowledged`, `performance.review.removed`, `performance.review.unrated`.

Versi rubrik (D-19) tidak menulis event: tabelnya append-only dan setiap baris memuat pembuat serta waktunya, jadi baris itu sendiri adalah catatan auditnya.

Setiap event memuat aktor, waktu (`clock_timestamp()`), alasan sebagai `note`, dan metadata aman (penilai lama/baru, sumber penilai, predikat, nomor versi rubrik dan kode klasifikasi jabatan yang memilihnya). Nilai per indikator **tidak** disalin ke event; nilai hanya ada di baris penilaian.

Pegawai melihat riwayat penilaiannya sendiri tanpa catatan apa pun dan tanpa event kalibrasi, ditambah keempat event keberatannya sendiri (D-17). Alasan keberatan dan alasan keputusan HC dibacanya dari detail penilaian, bukan dari catatan event. Penilai melihat bahwa keberatan terjadi dan apa hasilnya, tetapi **tidak pernah** isi alasan pegawai maupun alasan keputusan HC — baik lewat riwayat maupun lewat detail penilaian. Penilai melihat event penilaian yang ditugaskan kepadanya, tetapi catatannya hanya alasan pengembalian HC; alasan penunjukan ulang atau pengeluaran tetap hanya untuk HC. Mengeluarkan peserta menghapus nilai akhir dan predikatnya.

## 10. Notifikasi (NOTIF-004, kategori `system`)

- siklus dibuka atau peserta ditambahkan ke siklus terbuka → pegawai;
- penilaian diri dikirim → penilai;
- penilai ditunjuk ulang → penilai baru;
- dikembalikan HC → penilai;
- nilai penilai dikirim → pegawai, dengan batas masa keberatan (D-17);
- keberatan diterima → pegawai dan penilai; keberatan ditolak → pegawai (D-17);
- disahkan → pegawai.

Ditulis dalam transaksi yang sama dengan transisinya. Setiap kejadian memakai `eventKey` sendiri, sehingga pemberitahuan ulang (peserta dimasukkan kembali, penilai ditunjuk ulang, dikembalikan lagi) tidak tertelan oleh kejadian sebelumnya. Isi notifikasi tidak memuat nilai atau predikat.

## 11. Kontrak sambungan payroll (dibangun 2026-11-17, sakelar default MATI)

PAY-003 menghitung `PERF = %tahunan × dasar × 60% + %bulanan × dasar × 40%` (`payroll-calculation-v1.md` §5.1). Tanpa sambungan, kedua persentase datang dari profil kompensasi atau override HC. Sambungan di bawah **sudah dibangun** (`payroll-calculation-v1.md` §5.5) di balik kebijakan payroll berversi `PERFORMANCE_PERCENT`, yang juga sakelarnya: tanpa versi (keadaan bawaan) atau `enabled: false`, payroll tidak membaca satu pun penilaian dan hasilnya tidak berubah. Butir kontraknya:

1. **Sumber.** Payroll hanya membaca penilaian `FINALIZED`. `UNRATED`, `REMOVED`, dan penilaian siklus yang belum ditutup tidak pernah dibaca.
2. **Pemetaan.** Predikat → persentase disimpan sebagai kebijakan payroll berversi baru (`PERFORMANCE_PERCENT`), bukan di PERF-001. Default yang akan diusulkan: A 100%, B 90%, C 75%, D 50% (`DRAFT`, butuh keputusan owner).
3. **Periode.** `%bulanan` periode payroll bulan *M* membaca siklus `MONTHLY` bulan *M−1* (penilaian bulan lalu, sama dengan default formulir legacy). `%tahunan` membaca siklus `ANNUAL` tahun ajaran terakhir yang sudah `CLOSED` pada tanggal gajian.
4. **Tanpa hasil.** Bila tidak ada penilaian final, payroll memakai nilai profil kompensasi seperti hari ini (termasuk default masa kerja < 1 tahun, PAY-003 §10 butir 3). Tidak ada nilai yang ditebak.
5. **Jejak.** Snapshot input payroll menyimpan `reviewId`, siklus, dan predikat yang dipakai, sehingga hasil dapat diaudit ulang.
6. **Prasyarat menyalakan.** Parallel run PAY-003 lulus dan owner menjadikannya jalur slip resmi, serta pemetaan disetujui owner. Revisi `payroll-calculation-v1.md` sudah dibuat (§5.5). Sampai itu, sakelar tetap mati.
7. **Predikat tanpa pemetaan** (kode predikat siklus yang tidak ada di kebijakan) memblokir hasil pegawai itu (`PERFORMANCE_PREDICATE_UNMAPPED`), bukan ditebak.

Status per butir: 1–5 dan 7 diimplementasikan dan diuji (`test/payroll-performance-link.test.ts`, `test/payroll-calculation.integration.test.ts`); butir 6 adalah keputusan owner. PERF-001 sendiri tetap tidak mengubah tabel payroll; arah bacanya hanya payroll → penilaian, dan payroll tidak pernah menulis tabel `performance_*`.

## 12. Penyimpanan

```text
performance_rubric_versions       versi rubrik bertanggal milik HC, append-only (D-19)
performance_rubric_version_jobs   kode klasifikasi jabatan yang dicakup satu versi (D-20)
performance_cycles                siklus, periode, batas waktu, rubrik cadangan (jsonb, dibekukan
                                  saat OPEN) dan nomor versi rubrik yang disalinnya
performance_reviews               satu baris per pegawai per siklus: penilai + snapshot, rubrik
                                  yang dipakai + nomor versinya, penilaian diri, nilai penilai,
                                  nilai akhir, predikat, keberatan + keputusannya, pengesahan,
                                  tanda dibaca
performance_events                riwayat dan audit
```

Aturan:

- `performance_cycles`: indeks unik parsial `(kind, period_start) WHERE status <> 'CANCELLED'` (D-02); `CHECK (period_end > period_start)`;
- `performance_reviews`: unik `(cycle_id, employee_id)`; `CHECK (rater_employee_id IS DISTINCT FROM employee_id)`; `final_score` `numeric(3,2)` antara 1 dan 4; `final_score` dan `predicate_code` terisi tepat ketika status `HC_VALIDATION` atau `FINALIZED`;
- `performance_rubric_versions`: `version` unik; `scope IN ('DEFAULT','JOB_GROUP')`; trigger menolak UPDATE dan DELETE (append-only); `CHECK` jumlah bobot payload tepat 100 lewat fungsi `performance_rubric_weight_total(jsonb)`;
- `performance_rubric_version_jobs`: kunci utama `(rubric_version_id, job_classification_code)`, kode disimpan verbatim tanpa foreign key ke katalog yang bertanggal (ORG-011 §2.6: kode permanen), trigger menolak UPDATE dan DELETE;
- `performance_cycles.rubric` dan `performance_reviews.rubric` tunduk pada `CHECK` jumlah bobot 100 yang sama;
- `performance_reviews` keberatan (D-17): `objection_status IN ('OPEN','UPHELD','REJECTED','WAIVED')`; `CHECK` keberatan ada seluruhnya atau tidak ada sama sekali, dan `WAIVED` tanpa alasan; `CHECK` keputusan HC ada tepat ketika statusnya `UPHELD`/`REJECTED`, selalu dengan pemutus dan alasannya. Satu pegawai satu penilaian per siklus, jadi satu keberatan per penilaian sudah berarti satu keberatan per siklus tanpa indeks tambahan;
- tidak ada kolom persentase atau nominal;
- tidak ada endpoint hapus, termasuk untuk versi rubrik.

Rollback migrasi ditulis sebagai komentar `-- Down:` di berkas migrasi.

## 13. API

Pegawai: `GET /performance/me` (halaman), `GET /performance/me/:id`, `POST /performance/me/:id/self-assessment`, `POST /performance/me/:id/objection`, `POST /performance/me/:id/objection/waive`, `POST /performance/me/:id/acknowledge`.

Penilai: `GET /performance/team` (halaman, filter status), `GET /performance/team/:id`, `POST /performance/team/:id/rating`.

HC rubrik: `GET /admin/performance/rubric-versions` (halaman), `POST /admin/performance/rubric-versions`.

HC: `GET /admin/performance/cycles` (halaman), `POST /admin/performance/cycles`, `GET /admin/performance/cycles/:id` (dengan rekap per status dan predikat), `PATCH /admin/performance/cycles/:id`, `POST /admin/performance/cycles/:id/open`, `POST /admin/performance/cycles/:id/close`, `POST /admin/performance/cycles/:id/cancel`, `POST /admin/performance/cycles/:id/participants`, `GET /admin/performance/cycles/:id/reviews` (halaman; filter status, predikat, tanpa penilai, pegawai, pencarian nama/NIP), `GET /admin/performance/reviews/:id`, `POST /admin/performance/reviews/:id/rater`, `POST /admin/performance/reviews/:id/finalize`, `POST /admin/performance/reviews/:id/return`, `POST /admin/performance/reviews/:id/objection/uphold`, `POST /admin/performance/reviews/:id/objection/reject`, `POST /admin/performance/reviews/:id/remove`, `GET /admin/performance/employees/:employeeId/reviews` (halaman).

Kontrak lengkap: `docs/api/performance.openapi.yaml`, tag `Performance`. Semua daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`; filter dan scope berjalan sebelum `LIMIT`; pemilih pegawai (filter rekap, tambah peserta, tunjuk penilai) memakai pencarian typeahead server.

## 14. Layar

- Pegawai: `/app/performance` — D-17 menambah tombol **Ajukan keberatan** dan **Terima nilai ini** pada penilaian yang sedang menunggu pengesahan, beserta tanggal akhir masa keberatan; HC mendapat **Terima keberatan** dan **Tolak keberatan** di pop-up detail serta angka keberatan terbuka di rekap siklus. Tab **Penilaian saya** (daftar berhalaman, formulir penilaian diri, hasil setelah disahkan, tanda dibaca) dan tab **Tim saya** (antrean penilaian yang ditugaskan, formulir nilai dengan penilaian diri di sampingnya).
- HC: `/admin/performance` di Layanan Pegawai admin — daftar siklus (siklus yang dipilih menjadi ruang kerja halaman), buat siklus lewat pop-up (`?siklus=baru`), ubah siklus dan rubrik, tambah peserta (semua pegawai aktif atau typeahead), buka/tutup/batal, rekap per status dan predikat, tabel penilaian berhalaman dengan filter, detail penilaian sebagai pop-up lebar (`?penilaian=<id>`; tautan langsung membuka siklusnya lebih dulu) dengan Sahkan/Kembalikan/Tunjuk penilai/Keluarkan dan riwayat per pegawai (aturan app-shell "Detail views open as a pop-up", 2026-11-13).

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 15. Acceptance criteria

- PERF-001-A: pegawai hanya melihat penilaiannya sendiri, hanya dari siklus `OPEN`/`CLOSED`; nilai penilai dan predikat baru terlihat ~~setelah `FINALIZED`~~ **sejak `HC_VALIDATION`** (diubah D-17, 18 Nov 2026), tidak pernah lebih awal.
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
- PERF-001-L (D-18): siklus `SEMESTER` hanya menerima periode kalender pendidikan (ganjil 1 Juli–31 Desember, genap 1 Januari–30 Juni); periode lain ditolak `PERFORMANCE_PERIOD_INVALID`.
- PERF-001-M (D-19): versi rubrik dengan jumlah bobot bukan 100 ditolak aturan domain **dan** database; versi tidak dapat diubah atau dihapus; versi bertanggal lebih awal daripada versi terakhir ditolak.
- PERF-001-P (D-17): penilai tidak pernah membaca alasan keberatan pegawai maupun alasan keputusan HC atas keberatan itu; keberatan pada penilaian yang dikeluarkan tidak lagi terhitung terbuka; peserta yang dimasukkan kembali memulai tanpa jejak keberatan putaran sebelumnya.
- PERF-001-O (D-17): keberatan hanya dapat diajukan sekali per siklus, hanya saat `HC_VALIDATION`, dan hanya dalam masa keberatan; pengesahan ditolak selama keberatan terbuka maupun selama masa keberatan berjalan; keberatan yang diterima mengembalikan penilaian ke penilai dan mengosongkan predikatnya; pemutus bukan pegawai yang dinilai maupun penilainya; setiap langkah menulis event dengan aktornya.
- PERF-001-N (D-20): dua peserta dengan klasifikasi jabatan berbeda pada satu siklus dinilai dengan rubrik berbeda; pegawai tanpa klasifikasi memakai rubrik `DEFAULT`; menambah versi rubrik sesudahnya tidak mengubah nilai akhir penilaian yang sudah ada.

## 15.1 Tindak lanjut yang sudah diketahui (ditunda dari review 18 Nov 2026)

Empat hal ini sengaja **tidak** dikerjakan bersama D-18/D-19/D-20, dan dicatat di sini supaya tidak hilang:

| # | Hal | Akibatnya hari ini |
| --- | --- | --- |
| TL-1 | Rekap `byPredicate` hanya mengenal kode predikat milik **rubrik siklus**. Sejak D-20 satu siklus dapat memakai beberapa rubrik, dan sebuah versi boleh memakai kode predikat lain. | Hitungan rekap dapat kurang: penilaian final dengan kode predikat yang tidak ada di rubrik siklus tidak muncul di baris mana pun. Jumlah per status tetap benar. |
| TL-2 | Menambahkan peserta massal (`allActive`) melakukan satu resolusi penilai dan satu resolusi rubrik **per pegawai** di dalam satu transaksi yang juga memegang `FOR KEY SHARE` atas setiap pegawai aktif. | Transaksi panjang pada populasi besar. Belum menjadi masalah pada ukuran YSQ, tetapi tumbuh linear. |
| TL-3 | PAY-003 (§11) hanya mengenal siklus `MONTHLY` dan `ANNUAL`. | Siklus `SEMESTER` tidak pernah dibaca payroll. Tidak berbahaya selama sakelar §11 mati, tetapi harus diputuskan sebelum dinyalakan. |
| TL-4 | Dua aturan versi rubrik hanya dijaga aplikasi, bukan database: "versi baru tidak boleh mulai sebelum versi terakhir", dan "`JOB_GROUP` menyebut minimal satu kode jabatan sedangkan `DEFAULT` tidak menyebut satu pun". | Penulisan langsung ke database (migrasi, perbaikan manual) dapat melanggarnya tanpa tertahan. Jumlah bobot 100 sudah dijaga database. |

## 16. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| D-01 | Siapa menilai? | Atasan langsung menurut struktur; HC dapat menunjuk penilai lain |
| D-02 | Periode penilaian? | Bulanan (seperti legacy) dan tahunan per tahun ajaran |
| D-03 | Penilaian diri ikut dihitung? | Tidak, hanya pembanding |
| D-04/D-06 | Skala dan predikat? | 1–4; A ≥ 3,5, B ≥ 2,5, C ≥ 1,5, D (legacy) |
| D-05 | Indikator dan bobot? | Hasil kerja 30, Disiplin 20, Akhlak 20, Kerja sama 15, Inisiatif 15 — sejak 18 Nov 2026 menjadi versi rubrik 1 `DEFAULT` yang dapat diubah HC (D-19) |
| D-18 | Periode semesteran? | Kalender pendidikan: ganjil 1 Juli–31 Desember, genap 1 Januari–30 Juni |
| D-19 | Siapa boleh mengubah bobot, dan sejak kapan berlakunya? | HC dengan `performance.manage`, lewat versi baru yang berlaku paling awal pada tanggal berlaku versi terakhir; versi lama tidak pernah diubah |
| D-20 | Kelompok jabatan apa yang punya rubrik sendiri? | Belum ada selain `DEFAULT`; HC membuatnya sendiri dengan kode klasifikasi jabatan ORG-011. Resolusinya memakai semua klasifikasi yang terikat pada pegawai, termasuk keluarga `SUPPORT` |
| D-07 | Siapa mengesahkan, dan bagaimana kalibrasi? | HC; kalibrasi = mengembalikan ke penilai |
| D-09 | Ada banding? | ~~Tidak; pegawai memberi tanggapan~~ → sejak 18 Nov 2026 ada keberatan **sebelum** pengesahan (D-17); tanggapan setelah final tetap ada |
| D-17 | Berapa lama masa keberatan, dan siapa yang boleh mengubah nilai? | **7 hari** sejak nilai penilai dikirim (usulan owner, dipakai sebagai default). Nilai tetap hanya diubah **penilai**: keberatan yang diterima mengembalikan penilaian kepadanya, HC tidak pernah mengetik nilai pengganti (mengikuti D-07) |
| §11 | Predikat → persentase tunjangan kinerja? | Diusulkan A 100%, B 90%, C 75%, D 50%; sambungan dibangun, kebijakan `PERFORMANCE_PERCENT` belum dimuat (sakelar mati) |
