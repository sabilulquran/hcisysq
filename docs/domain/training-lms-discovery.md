# Training / LMS Pegawai — Discovery

**Status:** DISCOVERY / DRAFT — dokumen ini tidak mengizinkan implementasi, migrasi database, atau perubahan production.
**Spesifikasi:** TRAIN-001
**Tanggal:** 2026-10-20 (revisi 3 — jumlah peserta dan pengelola harian terjawab; revisi 2 menambah keputusan evaluasi dan rujukan LMS mapan; revisi 1 pada tanggal yang sama)
**Terkait:** EMP-008, PERF-001, ORG-004, NOTIF-004, APR-001, ADR-0001, ADR-0002
**Rujukan:** LMS mapan (Moodle, Totara, Canvas, Docebo) dan model evaluasi Kirkpatrick; lihat §14

## 1. Tujuan dan batas dokumen

TRAIN-001 adalah kemampuan HCIS untuk mencatat, menyelenggarakan, dan mengevaluasi pelatihan pegawai. Dokumen ini merumuskan arah, objek inti, tahapan, dan keputusan yang masih terbuka. Spesifikasi implementasi per tahap dibuat terpisah setelah pertanyaan terbuka di §12 dijawab.

Dokumen ini **tidak** mengulang isi dokumen yang sudah ada. Yang sudah ada dan tetap berlaku:

| Dokumen | Yang sudah ditetapkan |
| --- | --- |
| `docs/product/hcis-capability-map.md` | TRAIN-001 termasuk ruang lingkup produk HCIS (ACCEPTED 2026-09-18), kelompok *Kinerja & Pengembangan* |
| `docs/product/feature-parity.yaml` | TRAIN-001 `discovery`, prioritas `later`. Modul LMS di HCIS lama tercatat ada, tetapi tidak dijadikan acuan (§3 keputusan 6) |
| `docs/product/mvp.md` | LMS/training penuh berada di luar MVP |
| `docs/domain/employment-administration.md` (EMP-008) | TRAIN-001 boleh memakai data kompetensi, tetapi tidak boleh mengubah fakta kompetensi secara implisit |
| `docs/design/employee-self-service-experience.md` | Training/LMS tampil sebagai layanan *coming soon* |

## 2. Masalah dan hasil yang dituju

> **DISCOVERY.** Peserta adalah semua guru dan pegawai, kira-kira 100 orang (§3 keputusan 15). Jumlah program dan materi per tahun belum didata, sehingga angka penyimpanan di §8.2 masih perkiraan kasar.

Hasil yang dituju:

1. HC dapat menjawab "siapa sudah ikut pelatihan apa, kapan, dengan hasil apa" tanpa membuka spreadsheet terpisah.
2. Program internal (orientasi pegawai baru, pembinaan rutin, workshop) punya peserta, kehadiran, dan evaluasi yang tercatat.
3. Evaluasi dapat diandalkan: dirancang sesuai jenis pelatihan, dinilai konsisten, dan hasilnya tidak mudah dimanipulasi.
4. Pelatihan diikuti sampai penerapan di tempat kerja, bukan berhenti di nilai tes.
5. Materi daring benar-benar ditonton utuh sebelum dianggap selesai.

## 3. Keputusan Product Owner (2026-10-20)

| # | Keputusan |
| --- | --- |
| 1 | TRAIN-001 adalah **fitur HCIS**, bukan aplikasi SQ Core terpisah (alasan di §4). |
| 2 | Pendekatan bertahap: mulai dari catatan pelatihan, lalu program luring, evaluasi, dan modul daring (§9). |
| 3 | **Video disimpan di server sendiri**, bukan di YouTube/Google Drive. Asumsinya server production tidak selamanya Mi8VPS, jadi rancangan tidak boleh terikat pada Mi8. |
| 4 | **Evaluasi pelatihan dirancang sebagai kerangka tersendiri** (§7), bukan sekadar kuis. Pembuat formulir/soal hanya salah satu alat di dalamnya. |
| 5 | **Video daring tidak bisa dilewati dan tidak bisa dipercepat** (§8.4). |
| 6 | **Dibangun baru.** Format evaluasi, data, dan kode internal yang ada tidak dijadikan acuan dan tidak dimigrasikan. Rujukan diambil dari LMS mapan (§14). |
| 7 | Reaksi dievaluasi **per sesi secara singkat** (3 butir dan komentar) dan **satu kuesioner lengkap di akhir program** (§7.5). |
| 8 | Kuesioner reaksi program memakai **6 butir standar skala 1–5** dan satu kolom komentar, agar hasil antarprogram dapat dibandingkan (§7.5). |
| 9 | Penilaian manual memakai **satu penilai** sebagai bawaan. **Dua penilai** dipakai untuk komponen yang berujung kompetensi atau sertifikat (§7.7). |
| 10 | **Rencana tindak lanjut (RTL)** ditulis peserta di akhir program, dilaporkan pada hari ke-30/45/60, lalu dikonfirmasi dan dinilai atasan. Ada pengingat, dan HC melihat daftar tunggakan (§7.8). |
| 11 | Nilai disimpan **0–100**. Rubrik memakai tingkat 1–4 yang dikonversi. Predikat hanya untuk tampilan, batasnya diatur per templat (§7.3). |
| 12 | Hasil pelatihan **tidak menjadi komponen nilai PERF-001**, hanya keterangan (§10). |
| 13 | Pelatihan eksternal wajib **laporan singkat dan RTL**. **Diseminasi** ke rekan unit dicatat sebagai sesi luring kecil (§7.9). |
| 14 | Hasil evaluasi narasumber internal: narasumber melihat agregat miliknya sendiri, HC melihat semua, atasan narasumber tidak otomatis melihat (§11). |
| 15 | **Peserta: semua guru dan pegawai, kira-kira 100 orang.** Tidak ada pegawai yang dikecualikan dari TRAIN-001. |
| 16 | **Pengelola harian adalah Product Owner sendiri.** Pada awalnya peran Admin HC (pengelola pelatihan) dipegang satu orang (§5). |

## 4. Penempatan: fitur HCIS atau aplikasi terpisah

| Kriteria | Fitur HCIS | Aplikasi terpisah |
| --- | --- | --- |
| Pengguna | Hanya pegawai; login Akun SQ staf yang sudah ada | Diperlukan bila ada pengguna non-pegawai |
| Pemilik data | Riwayat pelatihan adalah data kepegawaian; HCIS adalah pemilik Employee master | Butuh kontrak sinkron pegawai dan unit dari HCIS |
| Keterkaitan | Langsung ke EMP-008 kompetensi, PERF-001 kinerja, ORG-004 unit/jabatan | Semua lewat kontrak API |
| ADR-0001 (*exit criteria*) | Belum ada bukti kebutuhan scaling, isolasi, atau tim terpisah | Satu-satunya alasan kuat: beban video |

**Kesimpulan:** fitur HCIS, modul `training` di `apps/api/src/modules`. Beban video ditangani tanpa memecah aplikasi: berkas video disajikan oleh proses/server statis tersendiri dengan URL bertanda tangan berumur pendek (§8.3), sehingga jalur request API HCIS tidak ikut terbebani. ADR-0001 memang mengizinkan proses terpisah untuk web/API dan worker.

Keputusan ini ditinjau ulang bila salah satu terjadi:

- peserta meluas ke non-pegawai (narasumber tamu, relawan, santri, wali) — pola Karir SQ: realm eksternal dan aplikasi terpisah;
- yang dibutuhkan ternyata pembelajaran sekolah/santri — itu domain Akademik/Sekolah, bukan HCIS;
- beban video terbukti mengganggu layanan HCIS lain walau sudah disajikan terpisah.

## 5. Pelaku dan izin awal

| Pelaku | Kemampuan |
| --- | --- |
| Pegawai | Melihat penugasan dan riwayat sendiri, mengikuti modul, mengisi instrumen evaluasi yang ditugaskan, menyusun dan melaporkan RTL, mengajukan catatan pelatihan eksternal |
| Admin HC (pengelola pelatihan) | Mengelola program, sesi, materi, rencana evaluasi, templat, instrumen, bank soal, penugasan; memverifikasi pengajuan; menetapkan nilai akhir bila dua penilai berselisih; melihat hasil seluruh peserta sesuai scope |
| Penilai | Menilai esai, praktik, atau rubrik observasi pada komponen yang ditugaskan kepadanya; tidak melihat nilai penilai lain sebelum penilaiannya sendiri selesai; tidak otomatis melihat seluruh nilai |
| Atasan sebagai pengisi | Mengonfirmasi dan menilai RTL, mengisi penilaian penerapan (tingkat 3) untuk anggota unitnya bila komponen itu ada di rencana evaluasi |
| Atasan / Kepala unit | Melihat status pelatihan anggota unitnya (scope `U`) |
| Narasumber internal | Pegawai yang mengisi sesi; melihat agregat evaluasi atas dirinya sendiri |
| Organ Yayasan | Hanya ringkasan agregat bila nanti disepakati; tidak melihat nilai perorangan |

Pada awalnya peran Admin HC dipegang satu orang, yaitu Product Owner (§3 keputusan 16). Karena itu rancangan tidak boleh mengandalkan pemisahan tugas antar-admin. Pemeriksaan silang yang benar-benar dibutuhkan (misalnya penilai akhir di §7.7) dilakukan dengan menunjuk pegawai lain per komponen.

Nama permission masih usulan dan mengikuti gaya `board.read`: `training.read`, `training.manage`, `training.assess`, `training.grade`, `training.record.verify`. Nama final ditetapkan di spesifikasi implementasi bersama `docs/domain/hcis-authorization-modernization.md`.

## 6. Objek inti

```text
Program ──┬─ Sesi luring ──────────┐
          ├─ Modul daring ─ Materi ├─> Penugasan peserta ─> Hasil ─> Catatan pelatihan ─> (usulan) Kompetensi EMP-008
          └─ Rencana evaluasi ─────┘                          └─> RTL ─> Evaluasi penerapan
               └─ Komponen evaluasi ─> Instrumen (formulir, tes dari bank soal, rubrik, tugas, kehadiran)
Pengajuan pelatihan eksternal ─(verifikasi HC)─> Catatan pelatihan ─> RTL, diseminasi
```

| Objek | Arti |
| --- | --- |
| Program | Wadah pelatihan, misalnya "Orientasi Pegawai Baru 2027". Punya jenis (§7.2), tujuan, penanggung jawab, dan periode. |
| Sesi luring | Pertemuan tatap muka: waktu, tempat, narasumber, kuota, daftar hadir. Kehadiran sesi **bukan** presensi kerja (ATT). |
| Modul daring | Urutan materi (video, dokumen) dan tes/formulir yang harus diselesaikan berurutan. |
| Materi | Berkas video atau dokumen beserta metadata (durasi, versi). |
| Templat evaluasi | Rencana evaluasi siap pakai per jenis pelatihan (§7.2). |
| Rencana evaluasi | Daftar komponen evaluasi sebuah program beserta bobot dan aturan kelulusan (§7.2). |
| Komponen evaluasi | Satu kegiatan evaluasi: apa yang dinilai, kapan, oleh siapa, dengan instrumen apa (§7.2). |
| Instrumen | Alat ukur yang dipakai komponen: formulir/kuesioner, tes, rubrik observasi, tugas, atau data kehadiran (§7.4). |
| Bank soal | Kumpulan soal tes yang dapat dipakai ulang, dikelompokkan per kategori/topik. |
| Penugasan peserta | Siapa wajib/boleh ikut apa, sejak kapan, sampai tenggat kapan. Target dapat dipilih per pegawai, unit, atau jabatan (ORG-004). |
| Respons | Satu kali pengisian instrumen oleh satu pengisi; untuk tes disebut percobaan (*attempt*) dan menyimpan salinan soal saat itu. |
| Hasil | Status akhir peserta di program/modul: hadir, lulus, tidak lulus, nilai, tanggal selesai. |
| RTL | Rencana tindak lanjut peserta: 1–3 komitmen penerapan beserta laporan progres dan penilaian atasan (§7.8). |
| Catatan pelatihan | Riwayat resmi per pegawai: internal (otomatis dari hasil) atau eksternal (dari pengajuan yang diverifikasi). Peran sebagai narasumber juga tercatat. |
| Sertifikat | Dokumen bukti: diunggah (eksternal) atau diterbitkan sistem (internal). |

## 7. Evaluasi pelatihan

Evaluasi menjawab lebih dari "berapa nilai tesnya". Rancangan ini memisahkan tiga hal: **apa yang dievaluasi** (kerangka tingkat, §7.1), **bagaimana sebuah program dievaluasi** (rencana evaluasi, kelulusan, dan skala, §7.2–7.3), dan **alat ukurnya** (instrumen, §7.4–7.6). Pembuat formulir/soal termasuk lapisan ketiga. Proses yang berjalan setelah pengisian — penilaian manual, RTL, dan laporan — ada di §7.7–7.10.

### 7.1 Kerangka: empat tingkat evaluasi

Mengikuti model empat tingkat Kirkpatrick yang umum dipakai dalam diklat:

| Tingkat | Pertanyaan | Contoh instrumen | Kapan | Pengisi |
| --- | --- | --- | --- | --- |
| 1 — Reaksi | Apakah peserta menilai pelatihan bermanfaat dan terselenggara baik? | Kuesioner reaksi (§7.5) | Akhir sesi dan akhir program | Peserta |
| 2 — Pembelajaran | Apakah pengetahuan dan keterampilan bertambah? | Pre-test dan post-test, ujian, praktik/unjuk kerja dengan rubrik, tugas atau proyek | Sebelum, selama, dan di akhir program | Peserta mengerjakan; penilai menilai |
| 3 — Penerapan | Apakah hasil pelatihan dipakai dalam pekerjaan? | RTL (§7.8), penilaian atasan, observasi kerja (misalnya observasi mengajar untuk guru), penilaian diri | Hari ke-30/45/60 setelah program | Peserta, atasan, pengamat |
| 4 — Hasil | Apakah ada dampak bagi unit atau yayasan? | Indikator unit yang sudah ada (laporan unit), bukan formulir per peserta | Per semester atau tahun | HC dan pimpinan |

Di luar penilaian peserta, ada dua evaluasi lain:

- **Evaluasi narasumber/fasilitator:** agregat reaksi per sesi untuk narasumber tersebut ditambah catatan HC.
- **Evaluasi penyelenggaraan:** dilakukan HC atas program, misalnya tingkat kehadiran, tingkat penyelesaian, dan ketepatan jadwal.

Perhitungan ROI (tingkat 5 Phillips) di luar ruang lingkup. Analisis kebutuhan pelatihan (TNA) juga belum dirancang, tetapi hasil tingkat 3–4 nantinya menjadi masukan untuk menyusun program berikutnya.

### 7.2 Rencana evaluasi dan templat per jenis pelatihan

Setiap program punya **rencana evaluasi** yang disusun sebelum program berjalan. Rencana terdiri dari komponen-komponen dengan atribut berikut:

| Atribut | Isi |
| --- | --- |
| Tingkat | 1–4 (§7.1) |
| Instrumen | Formulir, tes, rubrik, tugas, atau kehadiran (§7.4) |
| Waktu | Sebelum, selama, segera setelah, atau N hari setelah program/sesi berakhir |
| Pengisi | Peserta, penilai yang ditugaskan, atasan peserta, atau HC |
| Subjek | Program, sesi, narasumber, atau peserta |
| Dinilai | Ya/tidak; bila ya, bobotnya dalam nilai akhir |
| Wajib | Apakah komponen harus selesai untuk menyelesaikan program |
| Jumlah penilai | Satu (bawaan) atau dua (§7.7) |
| Anonim | Apakah isi respons dapat ditautkan ke pengisi |

Program dibuat dari **templat** sesuai jenis pelatihannya, lalu boleh disesuaikan. Hanya mengandalkan tes akan meleset untuk sebagian besar jenis pelatihan, sehingga templat bawaan disusun per jenis:

| Jenis pelatihan | Contoh | Evaluasi utama dalam templat |
| --- | --- | --- |
| Keterampilan Qur'ani | Tahsin, metode tahfidz | Praktik dinilai dengan rubrik (makhraj, tajwid, kelancaran), dua penilai bila berujung kompetensi |
| Pedagogi guru | Metode mengajar, kurikulum, asesmen kelas | RTL dan observasi mengajar dengan rubrik oleh kepala sekolah/koordinator |
| Pengasuhan | Musyrif/pengasuh asrama | Studi kasus (esai), lalu penilaian atasan |
| SOP / administrasi | Keuangan, layanan, K3 | Tes pilihan ganda |
| Orientasi pegawai baru | Nilai yayasan, aturan kerja | Post-test dan penilaian atasan di akhir masa percobaan |
| Pembinaan rutin | Kajian pegawai | Kehadiran saja, tanpa tes |
| Pelatihan eksternal | Seminar, diklat dari pihak luar | Laporan, RTL, dan diseminasi (§7.9) |

Contoh rencana evaluasi dari templat:

**Pelatihan tahsin guru**

| Komponen | Tingkat | Dinilai | Wajib |
| --- | --- | --- | --- |
| Pre-test praktik bacaan (rubrik) | 2 | Tidak — hanya untuk mengukur peningkatan | Ya |
| Kehadiran ≥ 80% | — | Syarat | Ya |
| Ujian praktik akhir (rubrik, dua penilai) | 2 | Bobot 70% | Ya |
| Tes teori tajwid | 2 | Bobot 30% | Ya |
| Reaksi per sesi dan akhir program | 1 | Tidak | Ya |

Lulus bila nilai akhir ≥ 75, lalu sistem mengusulkan kompetensi "Tahsin" ke EMP-008 untuk dikonfirmasi HC.

**Workshop metode mengajar**

| Komponen | Tingkat | Dinilai | Wajib |
| --- | --- | --- | --- |
| Reaksi akhir program | 1 | Tidak | Ya |
| RTL: 1–3 hal yang akan diterapkan | 3 | Tidak | Ya |
| Observasi mengajar hari ke-45 (rubrik, atasan/koordinator) | 3 | Dicatat pada evaluasi penerapan | Ya |

Setelah program dimulai, rencana evaluasi dikunci. Perubahan setelahnya membuat versi baru dengan alasan dan audit.

### 7.3 Kelulusan, nilai akhir, dan skala

- **Skala penyimpanan:** semua nilai disimpan 0–100.
- **Rubrik:** tiap kriteria memakai tingkat 1–4. Nilai rubrik dikonversi linear: jumlah skor ÷ skor maksimum × 100.
- **Predikat:** hanya tampilan, batasnya diatur per templat. Contoh bawaan: Sangat baik ≥ 90, Baik 80–89, Cukup 70–79, Kurang < 70.
- **Syarat minimal:** misalnya kehadiran minimal sekian persen dan semua komponen wajib selesai.
- **Nilai akhir:** jumlah nilai komponen yang dinilai dikali bobotnya, dibandingkan dengan nilai minimal lulus.
- **Status hasil:** Lulus, Tidak lulus, Belum selesai, atau Dibebaskan (dengan alasan).
- Catatan pelatihan membedakan **ikut** dan **lulus**.
- Kelulusan ditetapkan di akhir program dari komponen tingkat 1–2. Evaluasi penerapan (tingkat 3) terjadi setelah program selesai, sehingga dicatat terpisah pada catatan pelatihan dan tidak mengubah kelulusan (§12, pertanyaan 10).
- Pre-test dan post-test menghasilkan angka peningkatan per peserta dan rata-rata program.

### 7.4 Instrumen

| Instrumen | Dipakai untuk | Ciri |
| --- | --- | --- |
| Formulir/kuesioner | Reaksi, penilaian diri, penilaian atasan, laporan pelatihan eksternal | Tanpa kunci jawaban; bisa anonim |
| Tes | Pembelajaran | Soal dari bank soal, kunci jawaban, skor, batas waktu (§7.6) |
| Rubrik observasi/unjuk kerja | Praktik (tingkat 2), observasi kerja (tingkat 3) | Kriteria × tingkat skor 1–4; diisi penilai **tentang** peserta |
| Tugas/unggahan | Tugas, proyek, RTL | Berkas atau isian, dinilai manual atau hanya dicek selesai |
| Kehadiran | Syarat kelulusan | Dari daftar hadir sesi luring atau penyelesaian materi daring |
| Indikator eksternal | Hasil (tingkat 4) | Diisi HC dari sumber yang ada; bukan penilaian individu |

**Pembuat formulir** adalah satu model yang dipakai bersama oleh formulir, tes, dan rubrik: daftar butir dengan jenis isian (§7.6). Bedanya hanya di aturan tambahan: tes punya kunci, skor, dan waktu; rubrik punya kriteria dan tingkat skor; formulir tidak punya keduanya. Setiap respons mencatat **pengisi** dan **subjek** secara terpisah, sehingga "atasan menilai peserta" dan "peserta menilai narasumber" memakai model yang sama.

Untuk pengisian **anonim**, catatan "siapa sudah mengisi" disimpan terpisah dari isi respons. Dengan begitu kewajiban mengisi dapat dicek tanpa isi jawaban dapat ditautkan ke pegawai.

### 7.5 Kuesioner reaksi standar

Butir tetap disediakan sistem agar hasil dapat dibandingkan antarsesi, antarprogram, dan antarnarasumber. HC boleh menambah butir, tetapi tidak mengubah atau menghapus butir standar.

**Akhir program — 6 butir, skala 1 (sangat tidak setuju) sampai 5 (sangat setuju):**

1. Materi relevan dengan pekerjaan saya.
2. Narasumber menguasai materi.
3. Metode penyampaian membantu saya memahami.
4. Waktu pelaksanaan memadai.
5. Fasilitas dan sarana mendukung.
6. Saya akan merekomendasikan pelatihan ini kepada rekan.

Ditambah satu kolom komentar/saran.

**Akhir sesi — 3 butir** (butir 1–3 di atas, untuk narasumber sesi itu) dan satu kolom komentar. Dibuat sesingkat ini supaya peserta tidak jenuh pada program dengan banyak sesi.

### 7.6 Tes

#### Jenis soal dan isian

| Jenis | Penilaian | Tahap |
| --- | --- | --- |
| Pilihan ganda (satu jawaban) | Otomatis | Awal |
| Pilihan ganda kompleks (beberapa jawaban) | Otomatis, aturan skor parsial dipilih per soal | Awal |
| Benar/salah | Otomatis | Awal |
| Isian singkat | Otomatis dengan normalisasi (huruf besar/kecil, spasi); jawaban alternatif boleh lebih dari satu | Awal |
| Esai | Manual oleh penilai, dengan rubrik | Awal |
| Unggah/rekaman praktik (misalnya rekaman bacaan) | Manual oleh penilai | Lanjutan |
| Menjodohkan, mengurutkan | Otomatis | Lanjutan |
| Skala penilaian / pilihan tanpa kunci | Tidak dinilai; untuk formulir/kuesioner (§7.4) | Awal |

Soal dapat memuat gambar. Audio/video di dalam soal mengikuti penyimpanan §8.

#### Pengaturan tes

- Susunan bagian (*section*); soal dipilih tetap atau diacak dari bank soal menurut kategori dan jumlah.
- Pengacakan urutan soal dan urutan pilihan per peserta.
- Batas waktu, jendela ketersediaan (buka–tutup), dan jumlah percobaan.
- Bila percobaan lebih dari satu: nilai yang dipakai adalah nilai **tertinggi**, **rata-rata**, **pertama**, atau **terakhir**. Jeda minimum antarpercobaan dapat diatur.
- Nilai minimal lulus (KKM) per tes.
- Kapan nilai, jawaban benar, dan pembahasan ditampilkan diatur terpisah untuk empat waktu: segera setelah dikirim, selama tes masih dibuka, setelah tes ditutup, atau tidak pernah.
- Tes dapat menjadi syarat: misalnya post-test baru terbuka setelah semua materi modul selesai.

#### Integritas tes

- Kunci jawaban tidak pernah dikirim ke browser; penilaian dilakukan di server.
- Waktu mulai dan batas waktu dicatat server; jam perangkat peserta tidak dipercaya.
- Jawaban tersimpan otomatis berkala sehingga koneksi putus tidak menghapus pekerjaan.
- Satu percobaan aktif per peserta per tes.
- Peristiwa keluar tab/jendela **dicatat** sebagai bukti untuk penilai, tidak otomatis menggugurkan.
- Pengawasan kamera (*proctoring*) di luar ruang lingkup.

#### Versi dan salinan soal

Mengikuti prinsip *snapshot-on-submit* (`docs/domain/workflows/approval-engine.md`): saat percobaan dimulai, soal yang dipakai disalin ke percobaan itu. Mengubah soal di bank setelahnya tidak mengubah nilai yang sudah ada. Susunan tes juga dikunci begitu ada percobaan pertama. Perbaikan kunci jawaban yang salah dilakukan sebagai **penilaian ulang** eksplisit dengan alasan dan audit, bukan menimpa diam-diam.

#### Remedial dan analisis

- Remedial: percobaan tambahan dapat dibuka HC per peserta dengan alasan.
- Analisis butir soal (tingkat kesukaran, daya beda) sebagai tahap lanjutan.

### 7.7 Penilaian manual: penilai, dua penilai, dan rilis nilai

Berlaku untuk esai, praktik, rubrik observasi, dan tugas yang dinilai.

**Penugasan penilai.** HC menugaskan penilai per komponen, lalu dapat membagi peserta ke beberapa penilai. Penilai hanya melihat respons peserta yang ditugaskan kepadanya.

**Status penilaian per respons:**

```text
Belum dinilai → Sedang dinilai → Selesai dinilai → (Ditinjau) → Siap dirilis → Dirilis
```

Peserta hanya melihat nilai dan komentar setelah status **Dirilis**. Status *Ditinjau* hanya dipakai bila ada dua penilai yang berselisih, atau bila HC memilih meninjau.

**Dua penilai** (untuk komponen yang berujung kompetensi atau sertifikat):

1. Kedua penilai menilai secara independen dan tidak melihat nilai satu sama lain sebelum selesai.
2. Bila selisih kedua nilai ≤ ambang (§12, pertanyaan 14), nilai komponen adalah rata-ratanya.
3. Bila selisih > ambang, respons masuk *Ditinjau* dan **penilai akhir** menetapkan nilainya. Penilai akhir adalah HC atau orang yang ditunjuk, dan bukan salah satu dari dua penilai itu.
4. Kedua nilai awal tetap tersimpan sebagai bukti dan ikut diaudit.

Karena pengelola harian hanya satu orang (§3 keputusan 16), sistem menolak penunjukan bila penilai akhir sama dengan salah satu dari dua penilai. Bila pengelola sendiri ikut menilai, penilai akhir harus pegawai lain yang ditunjuk.

Nilai akhir program baru final setelah semua komponen manual berstatus *Dirilis*.

### 7.8 Rencana tindak lanjut dan evaluasi penerapan

```text
Disusun (akhir program) → Menunggu laporan (hari ke-N) → Dilaporkan peserta → Dinilai atasan → Selesai
                                     └─ Terlambat ──────────────┘          └─ Terlambat (atasan)
```

1. Di akhir program peserta menulis 1–3 komitmen penerapan. Ini menjadi komponen wajib bila ada dalam rencana evaluasi.
2. Pada hari ke-N setelah program (30, 45, atau 60, dipilih per templat), peserta melaporkan progres setiap komitmen.
3. Atasan langsung (dari ORG-004), atau pengamat yang ditunjuk HC, mengonfirmasi laporan dan menilainya dengan rubrik singkat atau formulir penilaian atasan.
4. Pengingat dikirim ke peserta dan atasan menjelang dan pada tenggat, lalu berkala selama masih tertunggak.
5. HC melihat **daftar tunggakan**: RTL yang belum dilaporkan peserta dan yang belum dinilai atasan, beserta umurnya.
6. Hasilnya dicatat sebagai evaluasi penerapan pada catatan pelatihan dan **tidak mengubah kelulusan** (§7.3).

Bila atasan berganti sebelum penilaian, penilaian dialihkan ke atasan yang berlaku pada tanggal tenggat. Aturan rinci ditetapkan di spesifikasi.

### 7.9 Pelatihan eksternal

1. Pegawai mengajukan catatan pelatihan eksternal beserta sertifikat (R1), lalu HC memverifikasi.
2. Pegawai mengisi **laporan singkat** dengan formulir standar: tujuan, ringkasan materi, dan hal yang dapat diterapkan di unit.
3. Pegawai menyusun **RTL** dengan alur yang sama seperti §7.8.
4. Bila diminta atasan atau HC, pegawai melakukan **diseminasi** ke rekan unit. Diseminasi dicatat sebagai sesi luring kecil: pegawai tersebut tercatat sebagai narasumber, dan rekan yang hadir mendapat catatan pelatihan internal.

### 7.10 Laporan evaluasi

- **Per program:** rekap reaksi per butir standar beserta komentar, sebaran nilai dan perbandingan pre/post, tingkat kelulusan, status RTL dan evaluasi penerapan, dan rekap per narasumber.
- **Per narasumber:** agregat reaksi per sesi dari semua program yang diisinya.
- **Per pegawai:** riwayat pelatihan, nilai, RTL, dan hasil evaluasi penerapan.
- **Per unit:** penyelesaian pelatihan wajib, rata-rata hasil, dan tunggakan RTL, sesuai scope atasan.
- **Antarprogram:** perbandingan butir reaksi standar.
- Laporan dapat diekspor. Respons anonim hanya tampil sebagai agregat.

### 7.11 Batas dengan Karir SQ

Tes untuk pelamar adalah urusan Karir SQ. Mesin tes dan formulir TRAIN-001 dibangun untuk pegawai di HCIS dengan batas modul yang bersih. Penggunaan bersama dengan Karir SQ **tidak** dirancang sekarang (§12, pertanyaan 7).

## 8. Video di server dan kontrol tonton

### 8.1 Penyimpanan

- Memakai port `ObjectStorage` dari ADR-0002. Ini kebutuhan nyata pertama untuk port itu di HCIS API; saat ini belum ada implementasinya.
- Adapter awal: sistem berkas lokal di server production. Adapter berikutnya dapat berupa penyimpanan objek kompatibel S3 bila server pindah. Kode domain tidak boleh mengenal Mi8, path host, atau vendor tertentu.
- Tidak ada URL publik permanen (sejalan dengan `docs/data/legacy-mapping.md`). Berkas diakses lewat URL bertanda tangan berumur pendek yang diterbitkan setelah izin peserta diperiksa.

### 8.2 Ukuran dan kapasitas (perkiraan kasar)

| Kualitas | Bitrate kira-kira | Per menit | Per jam materi |
| --- | --- | --- | --- |
| 480p | ± 0,8 Mbps | ± 6 MB | ± 360 MB |
| 720p | ± 1,5 Mbps | ± 11 MB | ± 650 MB |

Konsekuensi:

- Kapasitas disk dan bandwidth menjadi masukan rencana perpindahan server. Rencana kapasitas SQ Core di repo SQ Hub (`docs/operations/sq-core-capacity-and-migration-plan.md`, masih di branch `docs/rapat-sq-and-capacity-plan`) sudah mencatat bahwa media dan backup adalah bagian yang tumbuh.
- Video perlu kebijakan backup sendiri. Memasukkannya ke backup harian off-host akan membengkakkan ukuran backup.
- Batas ukuran unggah per berkas dan kuota total ditetapkan di spesifikasi.

**Bandwidth untuk ±100 peserta.** Satu jam materi 720p yang ditonton semua peserta berarti ±65 GB lalu lintas keluar. Bila 100 orang menonton bersamaan, dibutuhkan ±150 Mbps. Angka itu tidak realistis untuk Mi8, sedangkan 10 penonton bersamaan (±15 Mbps) masih masuk akal. Karena itu modul daring diberi jendela pengerjaan beberapa hari, bukan jadwal tonton serentak, dan kualitas 480p tetap disediakan. Ukuran penyimpanan ditentukan oleh jumlah materi, bukan jumlah peserta.

### 8.3 Format dan penyajian

- Tahap awal: HC mengunggah MP4 (H.264/AAC). Server hanya memeriksa format dan durasi, lalu menyimpan. Tidak ada transcoding di server, karena pekerjaan itu berat untuk CPU dan RAM, terutama di Mi8.
- Penyajian memakai HTTP range request oleh proses/server statis tersendiri, bukan oleh proses API.
- Tahap lanjutan (setelah pindah server): transcoding ke HLS bersegmen dan beberapa kualitas lewat job worker.
- Bila server tetap di belakang Cloudflare Tunnel, ketentuan layanan Cloudflare untuk lalu lintas video perlu dicek sebelum produksi. **TBD.**

### 8.4 Tidak bisa dilewati, tidak bisa dipercepat

Aturan pemutar:

1. Peserta boleh mundur, tetapi tidak boleh maju melewati posisi terjauh yang sudah ditonton.
2. Kecepatan putar dikunci 1×. Upaya mengubahnya dikembalikan ke 1×.
3. Tidak ada tombol unduh, dan URL berkas berumur pendek.
4. Video berhenti saat tab/aplikasi tidak terlihat (TBD, §12 pertanyaan 5).
5. Tonton dapat dilanjutkan dari posisi terakhir di perangkat mana pun.
6. Satu sesi tonton aktif per peserta per materi; sesi lain dihentikan.

**Batas yang perlu diterima apa adanya:** semua aturan di browser dapat dibobol oleh pengguna yang paham alat pengembang (mengubah kecepatan lewat konsol, mengunduh aliran video). Karena itu penentu "selesai" **bukan** browser, melainkan server:

- pemutar mengirim detak (*heartbeat*) berkala, misalnya tiap 10–15 detik, berisi posisi putar;
- server hanya mengkredit kemajuan yang **tidak lebih cepat dari waktu nyata** sejak detak sebelumnya (dengan toleransi kecil), dan hanya untuk rentang yang bersambung dari posisi terjauh sebelumnya;
- materi dinyatakan selesai bila rentang yang dikredit mencakup hampir seluruh durasi (ambang ditetapkan di spesifikasi).

Dengan cara ini, mempercepat atau melompati video di browser tidak memberi kemajuan apa pun di server. Yang masih mungkin adalah membiarkan video berputar tanpa ditonton. Itu tidak dapat dicegah secara teknis tanpa *proctoring*, sehingga pembuktian pemahaman tetap lewat evaluasi (§7).

Pengecualian: HC dapat menandai materi selesai secara manual untuk peserta tertentu (misalnya kebutuhan aksesibilitas atau gangguan teknis) dengan alasan wajib dan audit.

## 9. Tahapan

| Tahap | Isi | Butuh |
| --- | --- | --- |
| R1 — Catatan pelatihan | Riwayat pelatihan per pegawai (internal dan eksternal), jam pelatihan, sertifikat unggahan; pegawai mengajukan, HC memverifikasi | `ObjectStorage` untuk sertifikat (dokumen kecil) |
| R2 — Program dan sesi luring | Program, sesi dengan kuota, penugasan per pegawai/unit/jabatan, daftar hadir sesi, hasil otomatis ke catatan | ORG-004 untuk target peserta, NOTIF-004 untuk pengingat |
| R3 — Evaluasi | Templat per jenis pelatihan, rencana evaluasi, pembuat formulir, kuesioner reaksi standar, tes dengan bank soal, rubrik, tugas, penilaian manual dengan satu atau dua penilai, kelulusan dan skala, RTL dan evaluasi penerapan, laporan evaluasi, laporan dan diseminasi pelatihan eksternal; dapat dipakai untuk program luring R2 | NOTIF-004 untuk pengingat RTL dan penilaian |
| R4 — Modul daring | Materi video dan dokumen di server, pemutar dengan kontrol tonton §8.4, urutan materi → tes, sertifikat internal | Kebijakan kapasitas dan backup video; idealnya server baru |
| Lanjutan | Pelatihan wajib per jabatan dan pemantauan kepatuhan, masa berlaku sertifikat, analisis butir soal, penilaian sejawat, HLS/transcoding, ringkasan untuk Ringkasan Yayasan | Keputusan terpisah |

R3 sengaja ditempatkan sebelum R4: evaluasi juga dibutuhkan untuk pelatihan luring, dan tidak bergantung pada keputusan server. R3 adalah tahap terbesar dan kemungkinan dipecah lagi di spesifikasi implementasi.

## 10. Integrasi dan batas

| Sistem | Hubungan |
| --- | --- |
| EMP-008 Kompetensi | Hasil pelatihan dapat **mengusulkan** penambahan kompetensi/sertifikasi; HC mengonfirmasi secara eksplisit. Tidak ada perubahan otomatis. |
| ORG-004 Organisasi | Target penugasan per unit/jabatan; atasan langsung untuk RTL dan evaluasi penerapan. |
| ATT Presensi | Tidak terhubung. Kehadiran sesi pelatihan bukan presensi kerja. Pelatihan eksternal yang memerlukan dinas luar ditangani TRIP-001 bila sudah ada. |
| NOTIF-004 | Pengingat penugasan, tenggat, RTL, penilaian, dan rilis nilai di dalam aplikasi. |
| Kirim SQ (WhatsApp) | Melalui port `WhatsAppSender`, bukan langsung ke gateway. Tahap lanjutan. |
| APR-001 | Pengajuan pelatihan eksternal yang memerlukan biaya/izin. Tahap lanjutan; R1 hanya mencatat. |
| PERF-001 | Data pelatihan tampil sebagai **keterangan** pada kinerja, **bukan komponen nilai** (§3 keputusan 12). |
| SQ Hub Ringkasan Yayasan | Hanya angka agregat (misalnya persentase penyelesaian pelatihan wajib) bila disepakati. |

## 11. Audit dan privasi

- Peristiwa yang diaudit: pembuatan/perubahan program, templat, rencana evaluasi, instrumen, dan soal; penguncian dan versi rencana evaluasi; mulai/kirim percobaan; penugasan penilai; penilaian, penetapan oleh penilai akhir, penilaian ulang, rilis nilai, dan pembebasan komponen; laporan dan penilaian RTL; verifikasi atau penolakan catatan eksternal; penandaan selesai manual; unggah/hapus materi.
- Nilai perorangan adalah data pribadi pegawai. Hanya peserta, penilai yang ditugaskan, HC, dan atasan sesuai scope yang dapat melihatnya.
- Hasil evaluasi atas **narasumber internal** juga data pribadi: narasumber melihat agregat miliknya sendiri, HC melihat semua, atasan narasumber tidak otomatis melihat.
- Respons anonim tidak dapat ditautkan ke pengisinya, juga oleh HC (§7.4).
- Log tidak memuat isi jawaban atau isi sertifikat.

## 12. Pertanyaan terbuka

| # | Pertanyaan | Saran |
| --- | --- | --- |
| 1 | Berapa perkiraan program dan jam materi daring per tahun? Jumlah peserta sudah terjawab (§3 keputusan 15). | Perkirakan saat menyusun spesifikasi R4; R1–R3 tidak bergantung pada angka ini. |
| 2 | ~~Siapa pengelola harian?~~ | **Terjawab:** Product Owner sendiri (§3 keputusan 16). Koordinator per unit dapat ditambahkan nanti. |
| 3 | Apakah ada target jam pelatihan per pegawai per tahun? | Catat jam pelatihan sejak R1; target ditetapkan HCM sebagai kebijakan, tidak ditanam di kode. |
| 4 | Siapa penilai esai/praktik? | Ditugaskan per komponen evaluasi: HC atau pegawai yang ditunjuk (misalnya koordinator tahfidz). |
| 5 | Apakah video harus berhenti saat tab/aplikasi tidak terlihat? | Ya. Lebih sesuai dengan tujuan "benar-benar ditonton". |
| 6 | Kualitas video maksimal saat masih di Mi8? | 720p dan batas ukuran per berkas; HLS multi-kualitas setelah pindah server. |
| 7 | Apakah mesin tes dan formulir perlu dipakai bersama Karir SQ? | Belum. Dibangun di HCIS dengan batas modul bersih; ditinjau bila Karir SQ membutuhkannya. |
| 8 | Ambang "selesai menonton"? | 95% durasi terkredit, dengan toleransi detak ±20%. Diuji pada materi nyata sebelum ditetapkan. |
| 9 | Apakah kuesioner reaksi diisi anonim? | Ya, anonim terhadap narasumber dan penyelenggara; sistem hanya tahu siapa sudah mengisi (§7.4). |
| 10 | Apakah evaluasi penerapan (tingkat 3) memengaruhi kelulusan? | Tidak. Kelulusan final di akhir program; tingkat 3 dicatat terpisah dan dipakai untuk tindak lanjut dan perencanaan program. |
| 11 | Apakah mengisi kuesioner reaksi menjadi syarat terbit sertifikat? | Ya. Ini cara umum menjaga tingkat pengisian tanpa memengaruhi nilai. |
| 12 | Siapa yang mengisi evaluasi penerapan: atasan langsung, atau pengamat yang ditunjuk? | Atasan langsung sebagai bawaan (dari ORG-004); HC dapat menunjuk pengamat lain per komponen, misalnya untuk observasi mengajar. |
| 13 | Hari ke-N untuk RTL tetap atau dipilih per templat? | Dipilih per templat (30/45/60), bawaan 45 hari. |
| 14 | Berapa ambang selisih dua penilai yang memicu peninjauan? | 15 poin pada skala 0–100, dapat diubah per templat. |
| 15 | Apakah sertifikat internal punya masa berlaku dan resertifikasi? | Opsional per program, bawaan tanpa masa berlaku. Dipakai nanti untuk kompetensi yang perlu diperbarui berkala (§14, pola Totara). |
| 16 | Perlu impor bank soal dari format standar? | Belum di R3 awal; soal disusun di sistem. Impor Moodle XML/GIFT dipertimbangkan bila ada bank soal dari luar. |
| 17 | Perlu dukungan konten SCORM/xAPI/cmi5 dari pihak luar? | Tidak. Pelacakan sendiri (§8.4) cukup untuk materi internal; ditinjau bila ada paket konten dari luar. |

## 13. Langkah berikutnya

1. Tulis spesifikasi implementasi R1 (TRAIN-001 R1, catatan pelatihan) lengkap dengan aktor, state, transisi, permission, audit event, dan failure behavior sesuai `AGENTS.md` §3. Pertanyaan §12 yang tersisa tidak menghalangi R1.
2. Perbarui `feature-parity.yaml` saat spesifikasi R1 diterima.

## 14. Rujukan LMS mapan

Konsep di bawah dipakai sebagai rujukan perilaku, bukan untuk menyalin kode atau memasang produk tersebut. Perilaku produk dapat berbeda antarversi.

| Konsep | Rujukan | Yang diadopsi | Yang tidak/belum diadopsi |
| --- | --- | --- | --- |
| Pengaturan kuis | Moodle Quiz | Aturan nilai beberapa percobaan (tertinggi, rata-rata, pertama, terakhir); empat waktu tampil hasil dan pembahasan; jeda antarpercobaan; susunan soal terkunci setelah ada percobaan (§7.6) | Mode umpan balik interaktif dengan beberapa kali coba; *certainty-based marking*; batasan alamat IP |
| Alur penilaian | Moodle Assignment — *marking workflow* dan *marker allocation* | Status penilaian sampai *Dirilis*; peserta hanya melihat nilai yang dirilis; penugasan penilai per peserta (§7.7) | — |
| Dua penilai | Canvas — *moderated grading* | Penilai independen; penilai akhir bukan salah satu penilai; nilai awal tersimpan (§7.7) | Canvas menyerahkan semua rekonsiliasi ke penilai akhir; di sini selisih kecil dirata-rata otomatis |
| Rubrik | Moodle *advanced grading* (rubrik) | Kriteria × tingkat skor (§7.4) | Panduan penilaian (*marking guide*) bebas tanpa tingkat |
| Kuesioner tanpa nilai | Moodle Feedback | Formulir tanpa kunci, analisis agregat, ekspor (§7.4, §7.10) | — |
| Penilaian sejawat | Moodle Workshop | — | Seluruhnya; kandidat tahap lanjutan |
| Kompetensi | Moodle Competencies | Dari pilihan aksi saat aktivitas selesai (lampirkan bukti, kirim untuk ditinjau, langsung selesaikan kompetensi), hanya "kirim untuk ditinjau" yang dipakai, sesuai EMP-008 (§10) | Kompetensi selesai otomatis |
| Pelatihan tatap muka | Moodle Facetoface / Totara Seminar; Moodle Attendance | Sesi dengan kuota dan daftar hadir (R2) | Daftar tunggu dipertimbangkan di spesifikasi R2 |
| Masa berlaku sertifikasi | Totara Certifications | — | Jendela resertifikasi sebelum kedaluwarsa; kandidat tahap lanjutan (§12, pertanyaan 15) |
| Evaluasi tingkat 1–3 | Docebo — survei evaluasi dan *observation checklist* | Reaksi lewat survei; penerapan lewat rencana aksi yang ditagih ulang; daftar observasi yang diisi atasan (§7.5, §7.8) | — |
| Pertukaran soal dan konten | Format Moodle XML/GIFT, 1EdTech QTI; SCORM, xAPI, cmi5 | — | Belum dibutuhkan (§12, pertanyaan 16–17) |

Sumber yang dibaca saat discovery (2026-10-20):

- Moodle Docs — [Quiz settings](https://docs.moodle.org/en/Quiz_settings), [Workshop activity](https://docs.moodle.org/en/Workshop_activity), [Competencies](https://docs.moodle.org/en/Competencies), [Feedback activity](https://docs.moodle.org/en/Feedback_activity)
- Moodle *marking workflow* — [Monash University](https://www.monash.edu/learning-teaching/TeachHQ/moodle/assignment/how-to/marker-allocation-and-marking-workflow), [University of Glasgow](https://www.gla.ac.uk/myglasgow/moodle/guides/assignmentmarkingworkflow/)
- Canvas — [Moderated grading API](https://developerdocs.instructure.com/services/canvas/resources/moderated_grading), [Griffith University guide](https://www.griffith.edu.au/vle-help/staff/marking-and-feedback/marking-assessments/moderated-grading)
- Totara — [Recertification settings](https://totara.help/docs/recertification-settings)
- Docebo — [Community: observation checklist](https://community.docebo.com/product-q-a-7/observation-checklist-10806)
- Moodle plugins — [Facetoface](https://moodle.org/plugins/mod_facetoface), [Attendance](https://moodle.org/plugins/mod_attendance/2023020108/32671)
