# Employment Administration

**Status:** ACCEPTED PRODUCT DIRECTION  
**Specifications:** EMP-005, EMP-006, EMP-007, EMP-008, EMP-009  
**Decision date:** 2026-09-22  
**Related:** EMP-001, EMP-003, ORG-001, ORG-004, ORG-005, ORG-007, APR-001, PAY-003  
**Benchmark evidence:** `docs/product/semarthris-benchmark-2026-09-22.md`

## Goal

HCIS harus menangani administrasi kepegawaian klasik sebagai riwayat domain, bukan sekadar mengganti field terbaru pada employee master.

Benchmark HRIS klasik memperlihatkan kebutuhan yang tetap relevan untuk YSQ: kontrak, status kerja, penempatan, promosi, demosi, mutasi, pendidikan, keahlian, relasi keluarga, dan riwayat karier.

## Core principle

Perubahan administratif yang mempunyai makna historis harus disimpan sebagai event/record effective-dated.

Contoh yang tidak boleh dilakukan:

```text
employee.position = "Kepala Unit"
```

tanpa riwayat bagaimana employee berpindah dari posisi sebelumnya.

Target:

```text
Person / Employee
  -> Employment relationship
  -> Contract history
  -> Assignment / placement history
  -> Career movement
  -> Current effective organization position
```

Current state adalah hasil resolusi record yang efektif hari ini, bukan satu-satunya fakta yang menggantikan histori.

## Operator language: business actions, not field editing

Human Capital sebaiknya melakukan tindakan eksplisit:

- Tambah/aktifkan hubungan kerja;
- Perpanjang kontrak;
- Penempatan;
- Promosi;
- Demosi;
- Mutasi;
- Penugasan sementara bila disetujui;
- Perubahan kompensasi bila masuk authority terkait.

UI dapat menampilkan current employee summary, tetapi action di atas harus menghasilkan record baru dengan effective date, actor, alasan, evidence, dan audit yang sesuai.

"Edit pegawai" tidak boleh menjadi jalan pintas untuk perubahan karier yang seharusnya mempunyai histori.

## EMP-005 — Employment relationship and contracts

Mencakup:

- jenis hubungan kerja;
- status aktif/nonaktif;
- legal entity bila ORG-007 aktif;
- tanggal mulai;
- tanggal akhir bila ada;
- kontrak dan perpanjangan;
- nomor/referensi dokumen administratif;
- masa percobaan bila berlaku;
- alasan berakhir;
- attachment/document reference melalui storage boundary yang disetujui;
- audit dan effective dating.

Tidak boleh menghapus kontrak lama saat kontrak baru dibuat.

Satu person dapat memiliki lebih dari satu employment relationship bila kebijakan ORG-007 kelak membolehkan, tanpa menduplikasi identitas manusia/account.

## Decision document / Surat Keputusan

Benchmark menunjukkan nilai operasional dari menghubungkan perubahan kepegawaian dengan kontrak/SK.

HCIS sebaiknya mendukung supporting decision reference untuk tindakan yang membutuhkan dasar administratif.

Candidate attributes:

- tipe dokumen;
- nomor surat/keputusan;
- subjek;
- issuing authority;
- tanggal ditandatangani;
- effective date;
- end date bila berlaku;
- keterangan;
- attachment/reference.

Prinsip penting:

- dokumen/SK adalah **evidence/dasar administratif**;
- structured employment action tetap menjadi domain truth;
- upload PDF/foto surat saja tidak cukup untuk menggantikan effective-dated record;
- satu decision document dapat terkait ke satu atau beberapa tindakan bila kebijakan mengizinkan dan relasinya eksplisit.

Contoh:

```text
Promosi
Pegawai: Ahmad
Dari: Guru
Menjadi: Wakasek Kurikulum
Efektif: 1 Juli 2027
Dasar: SK Ketua Yayasan No. ...
```

Riwayat karier harus dapat menjelaskan perubahan tersebut tanpa membaca dokumen secara manual.

## EMP-006 — Placement and career movement

Mencakup:

- penempatan kerja;
- assignment ke unit/site;
- jabatan/position assignment;
- promosi;
- demosi;
- mutasi;
- temporary assignment bila dibutuhkan;
- effective date;
- end date bila applicable;
- alasan/perintah administratif;
- decision/SK reference;
- riwayat karier.

ORG-004 tetap menjadi sumber struktur dan authority. EMP-006 mencatat hubungan pegawai terhadap struktur tersebut sepanjang waktu.

Perubahan jabatan tidak boleh menulis ulang histori ORG-004 atau approval snapshot lama.

### Placement model direction

Arah model:

```text
Employment
  -> Assignment / Placement
      -> legal entity
      -> organization node
      -> ORG-004 position
      -> site/work location
      -> supervisor/authority resolved from organization policy
      -> effective_from
      -> effective_to
      -> supporting decision reference
```

Tidak semua field harus berada dalam satu tabel. Diagram ini menyatakan semantic linkage.

### Promotion / demotion / mutation

Tindakan karier tidak perlu menyimpan snapshot duplikat seluruh employee sebagai primary truth.

Target semantics:

```text
previous effective assignment
  -> Employment Action
  -> new effective assignment
```

Employment Action minimal dapat menjelaskan:

- actor/action type;
- effective date;
- affected employment;
- previous assignment reference;
- new assignment reference;
- reason;
- supporting decision/SK;
- audit metadata.

UI boleh menampilkan "dari -> menjadi", tetapi source-of-truth tetap effective-dated records.

## Job classification / grade boundary

Job classification/grade adalah konsep yang berbeda dari ORG-004 hierarchy/authority.

```text
ORG-004 Position
= posisi dalam struktur, reporting, dan authority

Job Classification / Grade
= klasifikasi pekerjaan/kompensasi
```

Contoh:

```text
Position: Kepala HCM
Job Grade: Management Grade 2
```

Aturan:

- grade tidak otomatis memberi approval authority;
- approval authority tetap berasal dari role/scope/ORG-004 policy;
- satu grade dapat dipakai beberapa position;
- perubahan grade harus effective-dated jika mempunyai dampak historis;
- bila grade memengaruhi payroll, PAY-003 hanya boleh menggunakannya setelah specification job-classification diterima.

Specification ID final untuk job classification/grade masih TBD. Jangan membuat runtime grade table ad-hoc sebelum source of truth disepakati.

## Statutory employee/employment profile

Atribut yang memengaruhi payroll/statutory sebaiknya tidak menjadi mutable singleton yang kehilangan histori.

Discovery examples:

- tax status/classification;
- BPJS participation/status;
- work-risk classification;
- statutory eligibility lain yang benar-benar diperlukan.

Target:

```text
Employment
  -> Statutory Profile
      -> effective_from
      -> effective_to
      -> verified values
```

Final attributes dan privacy purpose masih TBD dan harus diselaraskan dengan PAY-003.

## EMP-007 — Education and qualification

Mencakup:

- tingkat pendidikan;
- institusi;
- program/jurusan;
- tahun/periode;
- status selesai;
- gelar/kualifikasi;
- bukti dokumen bila diperlukan;
- verification/source bila diperlukan.

Data ini tidak otomatis memberi role atau authority.

## EMP-008 — Skills and competencies

Mencakup:

- skill/kompetensi;
- kategori;
- tingkat/proficiency bila kebijakan menggunakannya;
- sertifikasi;
- masa berlaku sertifikasi;
- sumber/verifikasi;
- riwayat perubahan.

PERF-001 dan TRAIN-001 boleh memakai data kompetensi kemudian, tetapi tidak boleh mengubah fakta kompetensi secara implisit.

## EMP-009 — Family, dependents, and employee relations

Mencakup data relasi administratif yang benar-benar diperlukan untuk operasional HR, misalnya:

- pasangan;
- anak/tanggungan;
- kontak darurat;
- relasi lain yang mempunyai tujuan administratif yang terdokumentasi.

Privacy-by-purpose wajib berlaku. Jangan mengumpulkan atribut keluarga hanya karena HRIS lain memilikinya.

## Address and contact administration

Alamat dan kontak tetap bagian dari EMP-001/EMP-003 employee master/data-change flow, tetapi target model harus mampu menyimpan:

- alamat domisili;
- alamat administratif bila memang diperlukan;
- kontak;
- emergency contact;
- effective/history behavior bila perubahan historis dibutuhkan.

## Relationship to organization

Administrasi kepegawaian tidak menggantikan ORG-004.

```text
ORG-004
= organisasi, node, position, authority, incumbent model

EMP-006
= employee ditempatkan/ditugaskan pada struktur tersebut sepanjang waktu
```

Jika multi-company ORG-007 nanti diaktifkan, employment relationship dan assignment harus selalu mempunyai legal-entity context.

Cross-company move tidak boleh direpresentasikan hanya dengan mengganti `company_id` pada current employee. Arah ORG-007 adalah menutup employment lama dan membuat employment baru bila memang pindah legal entity.

## Relationship to payroll

EMP-005/EMP-006 menyediakan fakta employment/assignment yang dapat menjadi input PAY-003.

Contoh:

```text
Promosi / perubahan grade / perubahan kompensasi
  -> approved decision/SK
  -> new effective employment/assignment/compensation fact
  -> payroll consumes effective fact for its period
```

Payroll tidak boleh mengubah assignment atau career history sebagai side effect perhitungan.

## Relationship to recruitment

REC-001 harus mempertahankan Kandidat terpisah dari Pegawai sampai hire terjadi.

Arah integrasi:

```text
ORG-004 vacant position
  -> recruitment requisition/vacancy
  -> candidate
  -> selection
  -> hire decision
  -> EMP-005 employment
  -> EMP-006 placement
```

Candidate data tidak otomatis menjadi employee master sebelum hire/activation boundary yang diterima.

## UX direction

Human Capital tidak perlu mengelola seluruh record melalui tabel teknis terpisah.

Target employee admin:

- Ringkasan;
- Data pribadi;
- Kepegawaian & kontrak;
- Penempatan & karier;
- Pendidikan;
- Kompetensi;
- Keluarga/tanggungan;
- Dokumen;
- Riwayat perubahan.

Action seperti "Mutasi", "Promosi", "Demosi", "Penempatan", atau "Perpanjang kontrak" harus menghasilkan history baru, bukan sekadar overwrite field.

Current state dan history harus sama-sama mudah ditemukan:

```text
Current
- Employment aktif
- Position aktif
- Unit/site aktif
- Grade/classification bila tersedia

History
- timeline tindakan kepegawaian
- supporting decision/SK
- effective dates
```

## Failure behavior direction

Implementation future harus fail closed untuk:

- assignment overlap ambigu;
- action tanpa effective date;
- position/legal entity yang tidak valid;
- cross-entity mutation tanpa employment transition yang benar;
- decision document wajib tetapi tidak tersedia menurut policy;
- unauthorized career/compensation action;
- conflict dengan historical/published authority snapshot.

Jangan memilih/mengoreksi histori secara diam-diam.

## Non-goals for first implementation

- payroll grade otomatis;
- succession planning;
- competency scoring otomatis;
- generic document management;
- collecting unnecessary sensitive family data;
- treating scanned SK as the only source of structured employment truth.

## Definition of ready for implementation

Setiap specification ID di atas masih membutuhkan workflow rinci berisi actor, permission, state transition, validation, audit event, migration impact, dan acceptance criteria sebelum kode runtime dibangun.

Khusus EMP-005/EMP-006, ready-to-implement juga membutuhkan keputusan tentang:

1. employment versus person/account boundary;
2. effective-dated assignment overlap rules;
3. employment action taxonomy;
4. decision/SK model;
5. job classification/grade ownership;
6. statutory profile ownership;
7. ORG-004/ORG-007 linkage;
8. payroll dependency boundary;
9. migration dari current employee fields ke historical model.
