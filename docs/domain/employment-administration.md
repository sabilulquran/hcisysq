# Employment Administration

**Status:** ACCEPTED PRODUCT DIRECTION  
**Specifications:** EMP-005, EMP-006, EMP-007, EMP-008, EMP-009  
**Decision date:** 2026-09-22  
**Related:** EMP-001, EMP-003, ORG-001, ORG-004, ORG-005, APR-001

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

## EMP-005 — Employment relationship and contracts

Mencakup:

- jenis hubungan kerja;
- status aktif/nonaktif;
- tanggal mulai;
- tanggal akhir bila ada;
- kontrak dan perpanjangan;
- nomor/referensi dokumen administratif;
- masa percobaan bila berlaku;
- alasan berakhir;
- attachment/document reference melalui storage boundary yang disetujui;
- audit dan effective dating.

Tidak boleh menghapus kontrak lama saat kontrak baru dibuat.

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
- alasan/perintah administratif;
- riwayat karier.

ORG-004 tetap menjadi sumber struktur dan authority. EMP-006 mencatat hubungan pegawai terhadap struktur tersebut sepanjang waktu.

Perubahan jabatan tidak boleh menulis ulang histori ORG-004 atau approval snapshot lama.

## EMP-007 — Education and qualification

Mencakup:

- tingkat pendidikan;
- institusi;
- program/jurusan;
- tahun/periode;
- status selesai;
- gelar/kualifikasi;
- bukti dokumen bila diperlukan.

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

Action seperti "Mutasi", "Promosi", atau "Perpanjang kontrak" harus menghasilkan history baru, bukan sekadar overwrite field.

## Non-goals for first implementation

- payroll grade otomatis;
- succession planning;
- competency scoring otomatis;
- generic document management;
- collecting unnecessary sensitive family data.

## Definition of ready for implementation

Setiap specification ID di atas masih membutuhkan workflow rinci berisi actor, permission, state transition, validation, audit event, migration impact, dan acceptance criteria sebelum kode runtime dibangun.
