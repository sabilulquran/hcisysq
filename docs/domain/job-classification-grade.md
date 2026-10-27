# Job Classification and Grade

**Status:** DRAFT / DISCOVERY  
**Specification:** ORG-011  
**Proposed:** 2026-10-27  
**ADR:** ADR-0004 (PROPOSED)  
**Related:** ORG-004, ORG-006, ORG-007, EMP-005, EMP-006, PAY-003, AUTH-011  
**Evidence:** `apps/api/migrations/0019_dynamic_organization.sql`, `apps/api/migrations/0056_employment_history_foundation.sql`, `docs/domain/payroll-calculation-v1.md`, `docs/product/roadmap.md` bagian C

Spesifikasi ini menutup gap roadmap C: HCIS belum punya cara stabil untuk menyebut *klasifikasi pekerjaan* dan *golongan*, sehingga tunjangan fungsional/jabatan masih dicocokkan lewat label teks.

## 1. Masalah

Hari ini ada dua representasi jabatan dan keduanya tidak cocok dipakai sebagai kunci kompensasi:

| Representasi | Lokasi | Kenapa tidak cukup |
|---|---|---|
| `organization_positions` (ORG-004) | per change set, `stable_key` + `title` | kursi struktural dan authority; satu kursi per unit, bukan kelas pekerjaan yang dipakai banyak kursi |
| `employment_placements.functional_label` / `.structural_label` (EMP-006) | teks bebas | tidak stabil, tidak effective-dated sebagai referensi, tidak dapat divalidasi, rawan typo |

PAY-003 §3.3 sudah menyatakan jabatan fungsional dan struktural harus dipetakan ke tabel tunjangan "lewat referensi stabil, bukan label teks". Referensi stabil itu belum ada. ORG-011 menyediakannya.

## 2. Keputusan desain

1. **Klasifikasi bukan struktur.** Katalog klasifikasi dan golongan hidup di luar change set ORG-004. Menerbitkan change set struktur tidak boleh menerbitkan ulang katalog kompensasi, dan sebaliknya.
2. **Klasifikasi tidak memberi authority.** Approval authority tetap sepenuhnya milik `organization_authority_bindings`. Tidak boleh ada jalur dari klasifikasi atau golongan ke permission maupun approver.
3. **ORG-011 tidak memperkenalkan model gaji kedua.** Tidak ada kolom nominal di katalog ORG-011. Skala gaji pokok tetap milik PAY-003 (pendidikan terakhir x MKG), tabel tunjangan tetap milik kebijakan payroll berversi. ORG-011 hanya menyediakan *kunci* tabel itu.
4. **Semua effective-dated.** Perubahan klasifikasi atau golongan tidak menimpa histori; payroll periode lampau membaca klasifikasi yang berlaku pada tanggal periode.
5. **Golongan opsional.** YSQ hari ini memakai klasifikasi (guru, kepala unit, staf) tanpa golongan numerik. Model menyediakan `job_grades`, tetapi kebijakan boleh membiarkannya kosong sampai ada keputusan owner.

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

Resolusi: **placement menang bila terisi; bila kosong, pakai klasifikasi position yang ditempati; bila keduanya kosong, hasilnya `null` dan konsumen harus menanganinya secara eksplisit.**

`functional_label` dan `structural_label` tetap ada sebagai teks tampilan/legacy dan **tidak boleh** dipakai sebagai kunci perhitungan setelah ORG-011 aktif.

### 3.4 Multi-entitas

Bila ORG-007 diaktifkan (lihat ADR-0005 dan `docs/domain/multi-entity-readiness.md`), `job_grades` dan `job_classifications` mendapat `legal_entity_id`. Katalog tidak otomatis dibagi antar entity.

## 4. Kontrak untuk payroll (PAY-003)

Satu fungsi resolusi, dipanggil payroll dengan tanggal periode:

```text
resolveJobClassification(employmentId, onDate)
  -> { classificationCode, gradeCode | null, family, source: PLACEMENT | POSITION } | null
```

Aturan konsumsi:

- Tabel tunjangan fungsional dan tunjangan jabatan PAY-003 di-key ke `classificationCode`.
- Rangkap jabatan (PAY-003: fungsional 70% bila merangkap struktural) dideteksi dari adanya placement `ADDITIONAL` dengan klasifikasi `family = STRUCTURAL`, bukan dari teks jabatan.
- Pengali per unit dan pola kerja (Taman Tahfizh 50%, Half Day 60%/65%) **tetap atribut unit atau pola kerja milik payroll**, bukan atribut klasifikasi.
- Skala gaji pokok tidak membaca ORG-011 sama sekali pada v1.
- Payroll yang sudah disahkan menyimpan `classificationCode` hasil resolusi pada snapshot input, sehingga perubahan katalog berikutnya tidak mengubah hasil periode lampau.

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
5. Payroll beralih ke `resolveJobClassification` setelah parallel run menunjukkan hasil identik dengan pencocokan label lama.
6. Label teks dibekukan menjadi read-only setelah langkah 5 lolos.

## 8. Keputusan terbuka

| Butir | Default DRAFT yang dipakai | Perlu keputusan owner |
|---|---|---|
| Apakah YSQ memakai golongan numerik | tidak; `job_grades` tersedia tetapi kosong | ya |
| Apakah satu pegawai boleh punya dua klasifikasi `FUNCTIONAL` bersamaan | tidak; satu per placement, rangkap lewat placement `ADDITIONAL` | ya |
| Siapa yang mengelola katalog | Kepala HCM dan staf HC | ya |
| Apakah klasifikasi tampil di direktori ORG-006 | tidak pada v1 | ya |
| Apakah golongan tampil di slip gaji | tidak | ya (proses owner payroll) |
