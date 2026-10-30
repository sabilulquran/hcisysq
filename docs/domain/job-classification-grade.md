# Job Classification and Grade

**Status:** ACCEPTED (Package 1 terimplementasi); keputusan terbuka §8 tetap DRAFT  
**Specification:** ORG-011  
**Package 1:** migration 0110, `apps/api/src/modules/organization/job-classification-*.ts`, 2026-10-30  
**Proposed:** 2026-10-27  
**ADR:** ADR-0004 (ACCEPTED 2026-10-30)  
**Related:** ORG-004, ORG-006, ORG-007, EMP-005, EMP-006, PAY-003, AUTH-011  
**Evidence:** `apps/api/migrations/0019_dynamic_organization.sql`, `apps/api/migrations/0056_employment_history_foundation.sql`, `docs/domain/payroll-calculation-v1.md`, `docs/product/roadmap.md` bagian C
**Kontrak payroll:** dikonfirmasi sesi PAY-003 pada 2026-10-27 (bentuk kebijakan `byPosition`, resolver dua slot, aturan rangkap 70%, kode blocker, nasib `*_position_ref`)

Spesifikasi ini menutup gap roadmap C: HCIS belum punya cara stabil untuk menyebut *klasifikasi pekerjaan* dan *golongan*, sehingga tunjangan fungsional/jabatan masih dicocokkan lewat label teks.

## 1. Masalah

Ada tiga representasi jabatan hari ini dan tidak satu pun cocok sebagai kunci kompensasi yang tahan lama:

| Representasi | Lokasi | Kenapa tidak cukup |
|---|---|---|
| `organization_positions` (ORG-004) | per change set, `stable_key` + `title` | kursi struktural dan authority; satu kursi per unit, bukan kelas pekerjaan yang dipakai banyak kursi |
| `employment_placements.functional_label` / `.structural_label` (EMP-006) | teks bebas | tidak stabil, tidak dapat divalidasi, rawan typo |
| `payroll_compensation_profiles.functional_position_ref` / `.structural_position_ref` (PAY-003) | `uuid NULL`, tanpa foreign key | sudah berupa referensi, tetapi menunjuk **kursi** ORG-004, bukan kelas pekerjaan |

Jadi PAY-003 §3.3 sudah dipenuhi sebagian: payroll memang tidak mencocokkan teks, melainkan menyimpan uuid position. Masalahnya ada di sisi lain. Komentar migration `0069_payroll_foundation.sql:129-136` menyatakan sendiri bahwa referensi itu sengaja tanpa foreign key karena "ORG-008 is still moving the node and position tables, and a payroll profile must survive a structure revision rather than block it", dan periode gagal dengan `POSITION_NOT_MAPPED` bila referensi tidak lagi teresolusi.

Artinya kebijakan tunjangan hari ini terikat pada **kursi di satu revisi struktur**. Reorganisasi yang mengganti stable key kursi akan memutus kebijakan gaji, padahal pekerjaan yang dibayar tidak berubah. ORG-011 memberi lapisan yang stabil melintasi revisi struktur: kelas pekerjaan.

Sesi PAY-003 mengonfirmasi (2026-10-27) bahwa kebijakan `FUNCTIONAL_ALLOWANCE` dan `POSITIONAL_ALLOWANCE` sudah memakai `byPosition: Record<string, rupiah>` dengan kunci string bebas, sehingga kunci itu dapat diisi `classificationCode` tanpa mengubah bentuk kebijakan.

## 1.1 Status implementasi

| Bagian spesifikasi | Status |
|---|---|
| Katalog `job_grades` dan `job_classifications`, effective-dated (§3.1, §3.2) | **Package 1**, migration 0110 |
| Permission `job_classifications.read` / `.manage` dan audit event (§5) | **Package 1** |
| Pengikatan pada `organization_positions` dan `employment_placements` (§3.3) | Package 2, belum dibuat |
| `resolveJobClassifications` dan konsumsi payroll (§4) | Package 2, belum dibuat |
| Layar pengelolaan katalog | Package 3, belum dibuat |
| Kolom `legal_entity_key` pada katalog (§3.4) | menunggu ADR-0005 `ACCEPTED` |

Sampai Package 2 mendarat, katalog berdiri sendiri: tidak ada satu pun perhitungan payroll atau penempatan yang membacanya, sehingga mengisinya tidak mengubah nominal siapa pun.

## 2. Keputusan desain

1. **Klasifikasi bukan struktur.** Katalog klasifikasi dan golongan hidup di luar change set ORG-004. Menerbitkan change set struktur tidak boleh menerbitkan ulang katalog kompensasi, dan sebaliknya.
2. **Klasifikasi tidak memberi authority.** Approval authority tetap sepenuhnya milik `organization_authority_bindings`. Tidak boleh ada jalur dari klasifikasi atau golongan ke permission maupun approver.
3. **ORG-011 tidak memperkenalkan model gaji kedua.** Tidak ada kolom nominal di katalog ORG-011. Skala gaji pokok tetap milik PAY-003 (pendidikan terakhir x MKG), tabel tunjangan tetap milik kebijakan payroll berversi. ORG-011 hanya menyediakan *kunci* tabel itu.
4. **Semua effective-dated.** Perubahan klasifikasi atau golongan tidak menimpa histori; payroll periode lampau membaca klasifikasi yang berlaku pada tanggal periode.
5. **Golongan opsional.** YSQ hari ini memakai klasifikasi (guru, kepala unit, staf) tanpa golongan numerik. Model menyediakan `job_grades`, tetapi kebijakan boleh membiarkannya kosong sampai ada keputusan owner.
6. **Kode stabil seumur hidup klasifikasi.** Kebijakan payroll berversi menyimpan `classificationCode` apa adanya dan periode lampau membacanya kembali. Mengganti kode berarti kebijakan lama tidak lagi cocok, jadi kode tidak pernah diganti: klasifikasi yang salah dinonaktifkan dan diganti klasifikasi baru.

## 3. Model data (usulan)

```text
job_grades            (golongan, opsional, urutan saja)
job_classifications   (kelas pekerjaan, kunci tabel tunjangan)
  -> dirujuk organization_positions   (default kursi, di dalam change set)
  -> dirujuk employment_placements    (override per pegawai, menang)
```

### 3.1 `job_grades`

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid PK | |
| `code` | text | stabil, unik per rentang efektif, mis. `G3` |
| `name` | text | nama tampilan |
| `rank_order` | integer | hanya untuk urutan dan laporan; **bukan** pengali gaji |
| `active` | boolean | |
| `effective_from` / `effective_to` | date | inklusif, Asia/Jakarta |

Tidak ada kolom nominal, pengali, atau tunjangan. Menambahkannya di tabel ini melanggar ADR-0004.

### 3.2 `job_classifications`

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | uuid PK | |
| `code` | text | stabil, mis. `FUNC_GURU`, `STRUCT_KEPALA_UNIT`, `SUPPORT_ADMIN` |
| `name` | text | nama tampilan |
| `family` | text | `FUNCTIONAL`, `STRUCTURAL`, atau `SUPPORT` |
| `grade_code` | text NULL | referensi `job_grades.code`, opsional |
| `active` | boolean | |
| `effective_from` / `effective_to` | date | |

Satu klasifikasi dapat dipakai banyak position dan banyak pegawai. Satu position punya paling banyak satu klasifikasi yang berlaku pada satu tanggal.

### 3.3 Pengikatan

- `organization_positions.job_classification_code` (nullable, di dalam change set): klasifikasi default kursi. Ikut versioning struktur, karena yang berubah adalah kursi, bukan katalog.
- `employment_placements.job_classification_code` (nullable): klasifikasi efektif pegawai pada penempatan itu. Diisi melalui employment action (EMP-006), bukan edit field.

Aturan versi, supaya satu kode tidak pernah berarti dua hal:

- kode **tidak pernah dibuat ulang**. Membuat kode yang pernah ada ditolak, termasuk setelah dinonaktifkan, karena kebijakan payroll berversi masih menyimpan kode itu apa adanya;
- menulis **di belakang versi yang sudah berlaku lebih awal** ditolak (`CLASSIFICATION_HAS_LATER_VERSION` / `GRADE_HAS_LATER_VERSION`). Tanpa ini, amend akan menimpa rentang versi berikutnya, dan deaktivasi akan menutup versi berjalan sementara versi berikutnya menghidupkan kembali kode itu setelah jeda;
- perubahan harus berlaku setelah tanggal mulai versi yang berjalan, bukan pada hari yang sama.

Resolusi per placement: **placement menang bila terisi; bila kosong, pakai klasifikasi position yang ditempati; bila keduanya kosong, hasilnya `null` dan konsumen harus menanganinya secara eksplisit.**

Satu employment dapat memegang beberapa placement yang berlaku bersamaan (`PRIMARY` dan `ADDITIONAL`). Resolver karena itu mengembalikan **dua slot**, fungsional dan struktural, hasil agregasi seluruh placement yang berlaku pada tanggal itu — bukan satu klasifikasi tunggal. Ini cocok dengan `payroll_compensation_profiles` yang memang menyimpan dua referensi.

Bila dua placement yang berlaku mengisi slot yang sama (dua klasifikasi `STRUCTURAL` sekaligus), resolver **gagal eksplisit** dengan kode `CLASSIFICATION_AMBIGUOUS`, tidak memilih salah satu diam-diam.

`functional_label` dan `structural_label` tetap ada sebagai teks tampilan/legacy dan **tidak boleh** dipakai sebagai kunci perhitungan setelah ORG-011 aktif.

### 3.4 Multi-entitas

Bila ORG-007 diaktifkan (lihat ADR-0005 dan `docs/domain/multi-entity-readiness.md`), `job_grades` dan `job_classifications` mendapat `legal_entity_key`. Katalog tidak otomatis dibagi antar entity.

## 4. Kontrak untuk payroll (PAY-003)

Satu fungsi resolusi, dipanggil payroll dengan tanggal periode:

```text
resolveJobClassifications(employmentId, onDate)
  -> {
       functional: { code, gradeCode | null, source } | null,
       structural: { code, gradeCode | null, source } | null
     }
```

`source` bernilai `PLACEMENT` atau `POSITION`. Kedua slot dapat terisi sekaligus (guru yang merangkap kepala unit), salah satu saja, atau tidak sama sekali.

Aturan konsumsi:

- `functional_position_ref` dan `structural_position_ref` pada `payroll_compensation_profiles` digantikan kolom kode klasifikasi. Sesi PAY-003 menambahkan kolom itu lewat migration payroll sendiri; ORG-011 tidak menyentuh berkas payroll.
- Tabel tunjangan fungsional dan tunjangan jabatan di-key ke `code` klasifikasi, memakai bentuk `byPosition` yang sudah ada.
- Rangkap jabatan (PAY-003: fungsional 70% bila punya jabatan struktural) ditentukan dari **terisinya slot `structural`**, dari placement mana pun termasuk `PRIMARY`. Ini sama persis dengan perilaku sekarang (`engine.ts` memakai keberadaan `structuralPositionRef`), sehingga peralihan tidak mengubah nominal siapa pun.
- Pengali per unit dan pola kerja (Taman Tahfizh 50%; Half Day 60%; Half Day II 65%) **tetap milik payroll** di kebijakan `BASIC_MULTIPLIER` dan `POSITIONAL_ALLOWANCE.unitMultipliers`, bukan atribut klasifikasi.
- Skala gaji pokok tidak membaca ORG-011 sama sekali pada v1.
- Hasil payroll sudah menyimpan `compensation_profile_id` dan `policy_version_ids` per baris. Resolusi klasifikasi harus ikut tersimpan dengan cara yang sama, sehingga bulan yang sudah dibayar tetap dapat dijelaskan setelah katalog berubah.
- Unit atau klasifikasi yang tidak terpetakan ke kebijakan **memblokir periode** (`UNIT_NOT_MAPPED` / `POSITION_NOT_MAPPED`), tidak dibayar penuh diam-diam. ORG-011 tidak melonggarkan ini.
- **Urutan pemeriksaan tunjangan fungsional tidak berubah**, dan klasifikasi masuk di tempat yang sama dengan referensi kursi hari ini (`engine.ts:425-446`): slot `functional` kosong → 0; unit ada di `functionalAllowance.excludedUnits` (legacy: Pesantren Tahfizh) → 0, diperiksa **sebelum** tabel tunjangan; lalu pencarian di `byPosition`; lalu `positionsWithoutAllowance` → 0; baru blocker. Pegawai di unit yang dikecualikan tetap bernilai 0 berapa pun klasifikasinya, dan itu memang perilaku yang diharapkan pada parallel run.
- **Kode blocker baru `CLASSIFICATION_AMBIGUOUS`** untuk slot yang diisi dua klasifikasi sekaligus. Tidak dipetakan ke `POSITION_NOT_MAPPED`: sebabnya berbeda (ambigu, bukan tak terpetakan) dan penyelesaiannya ada di penempatan ORG, bukan di kebijakan payroll. Mengikuti pola `UNIT_NOT_MAPPED` / `WORK_PATTERN_NOT_MAPPED`; ditambahkan sesi PAY-003 di engine saat menyambungkan resolver.

## 5. Permission (usulan)

| Aksi | Permission | Scope |
|---|---|---|
| Baca katalog | `job_classifications.read` | organization |
| Kelola katalog dan golongan | `job_classifications.manage` | organization |
| Menetapkan klasifikasi pada position | permission change set ORG-004 yang sudah ada | organization |
| Menetapkan klasifikasi pada placement | permission employment action EMP-006 yang sudah ada | organization |

Setiap permission baru wajib automated test (AGENTS.md §7). Perubahan katalog menghasilkan audit event (`job_classification.created`, `.updated`, `.deactivated`).

## 6. Yang tidak termasuk

- Salary band atau range minimum-maksimum per golongan.
- Job evaluation scoring (Hay, Mercer, dan sejenisnya).
- Pemetaan otomatis label teks lama ke klasifikasi; migrasi dilakukan HC secara eksplisit dengan review.
- Perubahan apa pun pada perhitungan payroll v1.
- Authority atau approval berdasarkan golongan.

## 7. Migrasi

1. Buat katalog kosong; tidak ada perubahan perilaku.
2. HC mengisi klasifikasi dari daftar tunjangan fungsional dan jabatan yang dipakai PAY-003 hari ini.
3. Tetapkan klasifikasi pada position lewat change set ORG-004 biasa.
4. Backfill placement hanya untuk kasus yang berbeda dari position-nya.
5. Petakan setiap `functional_position_ref` / `structural_position_ref` yang dipakai `payroll_compensation_profiles` ke klasifikasi, lalu salin kunci kebijakan `byPosition` dari uuid kursi ke `classificationCode`. Dilakukan sesi PAY-003 di berkasnya sendiri.
6. Payroll beralih ke `resolveJobClassifications` setelah parallel run menunjukkan nominal identik dengan resolusi berbasis kursi.
7. Referensi kursi dan label teks dibekukan menjadi read-only setelah langkah 6 lolos. `functional_position_ref` dan `structural_position_ref` **tidak dihapus**: baris hasil payroll menunjuk `compensation_profile_id`, dan profil itulah yang memuat referensi tersebut, sehingga menghapus kolomnya membuat periode lampau tidak dapat dijelaskan lagi. Komentar kolom diubah untuk menyebut penggantinya.

## 8. Keputusan terbuka

| Butir | Default DRAFT yang dipakai | Perlu keputusan owner |
|---|---|---|
| Apakah YSQ memakai golongan numerik | tidak; `job_grades` tersedia tetapi kosong | ya |
| Apakah satu pegawai boleh punya dua klasifikasi `FUNCTIONAL` bersamaan | tidak; satu per placement, rangkap lewat placement `ADDITIONAL` | ya |
| Siapa yang mengelola katalog | hanya Staf Human Capital (`human_capital_admin`); Kepala HC tidak diberi akses baca maupun kelola pada Package 1 | ya |
| Apakah klasifikasi tampil di direktori ORG-006 | tidak pada v1 | ya |
| Apakah golongan tampil di slip gaji | tidak | ya (proses owner payroll) |
| Apa yang terjadi bila dua placement mengisi slot struktural bersamaan | **ditutup 2026-10-27** bersama sesi PAY-003: resolver gagal dengan `CLASSIFICATION_AMBIGUOUS`, periode diblokir | tidak |
| Apakah `*_position_ref` payroll dihapus | **ditutup 2026-10-27** bersama sesi PAY-003: tidak dihapus, berhenti dibaca, read-only selamanya demi keterjelasan periode lampau | tidak |
