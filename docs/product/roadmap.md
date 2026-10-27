# HCIS Product Roadmap

**Status:** ACCEPTED PRODUCT DIRECTION  
**Updated:** 2026-09-22  
**Scope:** Post-MVP product direction; no release dates are implied.  
**Reference benchmark:** `docs/product/semarthris-benchmark-2026-09-22.md`

## Purpose

Roadmap ini menjaga HCIS tetap lengkap sebagai sistem Human Capital tanpa memaksa kompleksitas teknis muncul sebagai kompleksitas operasional.

Prinsip utamanya:

1. backend boleh menyimpan versioning, audit, approval snapshot, effective dating, dan evidence yang kompleks;
2. operator Human Capital harus bekerja dengan istilah dan alur yang ringkas;
3. fitur baru harus masuk melalui specification ID sebelum implementasi;
4. roadmap menyatakan arah produk, bukan bukti bahwa fitur sudah tersedia di production;
5. benchmark produk lain adalah evidence/inspirasi, bukan source code atau aturan bisnis yang otomatis boleh disalin.

## Roadmap sequence

### A. Simplify attendance operations

Target operasional untuk Human Capital:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

Backend ATT-003/ATT-007/ATT-010 tetap boleh menggunakan roster version, default assignment, normalized event, dan versioned attendance result, tetapi konsep tersebut tidak boleh dipaksakan menjadi navigasi utama operator.

Arah ATT-011:

- jadwal terutama dikelola sebagai pegawai/unit + shift + rentang/pola hari;
- bulk assignment adalah operasi utama, bukan exception;
- penggantian jadwal dapat dijelaskan sebagai replacement pada tanggal/rentang tertentu;
- backend tetap mempertahankan effective dating/versioning dan menolak ambiguity;
- Human Capital melihat satu daily attendance outcome dengan evidence/provenance pada drill-down;
- missing punch tetap `incomplete`; schedule time tidak boleh disintesis menjadi attendance evidence;
- leave/permission memengaruhi attendance hanya setelah authoritative approval/resolution.

Detail ada di `docs/domain/attendance-operational-simplification.md`.

### B. Complete classic employment administration

HCIS akan mengadopsi kemampuan administrasi kepegawaian klasik yang relevan dari benchmark HRIS Indonesia, tetapi memakai model effective-dated dan audit-friendly HCIS.

Cakupan:

- hubungan/status kepegawaian dan kontrak;
- penempatan kerja;
- promosi;
- demosi;
- mutasi;
- riwayat jabatan/karier;
- supporting decision / Surat Keputusan;
- pendidikan dan kualifikasi;
- keahlian/kompetensi;
- alamat/kontak administratif melalui employee master/data-change flow;
- keluarga/tanggungan/relasi pegawai;
- statutory employee/employment profile yang effective-dated bila diperlukan.

Operator memakai business actions seperti **Penempatan**, **Promosi**, **Demosi**, **Mutasi**, dan **Perpanjang kontrak**, bukan sekadar mengedit field current employee.

Current state harus dapat diturunkan dari historical/effective records.

Detail ada di `docs/domain/employment-administration.md`.

### C. Job classification / grade discovery

HCIS perlu membedakan dua konsep:

```text
ORG-004 Position
= struktur, reporting, dan authority

Job Classification / Grade
= klasifikasi pekerjaan/kompensasi
```

Arah:

- grade tidak memberi approval authority;
- satu grade dapat dipakai beberapa position;
- perubahan grade yang mempunyai efek historis harus effective-dated;
- hubungan grade ke payroll hanya boleh aktif setelah specification khusus diterima;
- specification ID: **ORG-011** (ditetapkan 2026-10-27).

Area ini menjadi dependency discovery EMP-006/PAY-003, bukan alasan membuat tabel grade ad-hoc.

ORG-011 menetapkan katalog klasifikasi dan golongan yang effective-dated dan hidup di luar change set ORG-004, tanpa nilai uang dan tanpa authority. Skala gaji pokok tetap milik PAY-003 (pendidikan terakhir x MKG); klasifikasi hanya menjadi kunci stabil tabel tunjangan, menggantikan pencocokan label teks.

Detail ada di `docs/domain/job-classification-grade.md` (DRAFT) dan ADR-0004 (PROPOSED).

### D. Payroll discovery and staged delivery

Payroll penuh resmi masuk roadmap HCIS melalui PAY-003.

Model payroll **belum menjadi runtime**. Discovery direction sekarang menetapkan minimum architecture:

```text
Component Catalog
+ Recurring Compensation
+ Period Adjustment
+ Attendance/Overtime/Leave Resolved Inputs
+ Calculation Processor Pipeline
+ Statutory/Tax Policy Versions
= Payroll Result + Detailed Lines
```

Payroll harus membedakan:

```text
Employee earnings - employee deductions = take-home pay

Employer-only contribution/cost
= additional employer cost, bukan take-home pay
```

Discovery wajib menetapkan:

- sumber komponen penghasilan dan potongan;
- recurring compensation dan effective dates;
- one-period adjustment;
- hubungan attendance/overtime/leave terhadap payroll;
- honorer/fixed-pay boundary;
- payroll period dan cutoff;
- BPJS Kesehatan dan BPJS Ketenagakerjaan;
- PPh21;
- exact monetary arithmetic dan rounding;
- effective-dated statutory profile/policy;
- employer contribution/company cost;
- review, adjustment, reconciliation, dan finalization;
- controlled reopen/revision setelah finalization;
- payment handoff ke proses perbankan/keuangan;
- publication ke PAY-002 payslip;
- historical payroll result dan audit.

Target lifecycle direction:

```text
OPEN
-> COLLECTING
-> CALCULATED
-> REVIEW
-> RECONCILED
-> FINALIZED
-> PAYMENT_HANDOFF
-> PUBLISHED
-> LOCKED
```

Nama state final masih TBD.

PAY-003 sudah mempunyai spesifikasi v1 yang disahkan (`docs/domain/payroll-calculation-v1.md`, ADR-0003 ACCEPTED 2026-10-27), sehingga implementasi bertahap berjalan: domain engine, skema + permission, lifecycle periode, input periode, review/rekonsiliasi, publikasi slip, dan layar web.

PAY-001/PAY-002 tetap menjadi batas verified untuk import dan akses slip sampai parallel run PAY-003 lulus.

Detail discovery ada di `docs/domain/payroll-engine-discovery.md`.

### E. Multi-company / multi-legal-entity discovery

HCIS dapat dikembangkan untuk beberapa company/legal entity dalam satu instalasi tanpa mengubah produk menjadi SaaS multi-tenant.

Arah:

```text
HCIS installation / enterprise group
  -> Legal Entity A
      -> ORG-004 structure
      -> ORG-005 sites/work locations
  -> Legal Entity B
      -> ORG-004 structure
      -> ORG-005 sites/work locations
```

YSQ menjadi legal entity pertama/default untuk kompatibilitas.

Satu person/account tidak diduplikasi hanya karena mempunyai employment pada entity berbeda. Cross-company movement tidak boleh sekadar overwrite `company_id`; employment history dan entity-scoped payroll/leave/attendance harus tetap utuh.

Detail proposal ada di `docs/domain/multi-company-organization.md`. Penilaian kesiapan terhadap skema yang ada sekarang, dampak per domain, rencana bertahap E1..E6, dan default DRAFT untuk keputusan terbuka ORG-007 ada di `docs/domain/multi-entity-readiness.md` dan ADR-0005 (PROPOSED).

Arah yang ditetapkan ADR-0005: entity diturunkan dari employment (bukan dari account/employee), scope `organization` berarti satu legal entity, akses lintas entity hanya lewat scope `group` yang eksplisit, konteks entity yang tidak terselesaikan berarti akses ditolak, dan aktivasi multi-entity ditunda sampai entity kedua benar-benar dibutuhkan.

### F. Recruitment linked to organization and employment

REC-001 tetap discovery. Sejak keputusan Product Owner 2026-10-16, Recruitment adalah aplikasi SQ Core terpisah di luar HCIS, dan kandidat login melalui realm eksternal Akun SQ (SQ Hub ADR-0008, PROPOSED). HCIS hanya memiliki kontrak hand-off di kedua ujung alur berikut:

```text
ORG-004 vacant position
-> recruitment requisition / vacancy
-> candidate
-> screening / interview / decision
-> offer / hire
-> EMP-005 employment
-> EMP-006 placement
```

Candidate tetap berbeda dari Employee sampai boundary hire/activation yang diterima.

Benchmark call-screen dapat menjadi evidence untuk screening adapter/evidence/masking, tetapi bukan ATS lengkap.

### G. Talent and employee services

Setelah fondasi di atas cukup stabil, roadmap melanjutkan capability yang sudah ada:

- PERF-001 Performance/KPI;
- TRAIN-001 Training/LMS;
- REC-001 Recruitment;
- TRIP-001 Business travel;
- ASSET-001 Employee assets;
- REIMB-001 Reimbursement;
- LOAN-001 Employee loan;
- DOC-001/DOC-002 HR documents — Package 1 implemented, `docs/domain/hr-documents.md`;
- NOTIF-001/002/003 external notification, announcements, reminders. NOTIF-002 Package 1 implemented, `docs/domain/announcements-and-reminders.md`.

## Anti-copy guardrails from benchmark research

Benchmark tidak boleh menyebabkan HCIS mengadopsi pola berikut:

- synthesizing missing attendance punch dari schedule time;
- leave langsung mengubah attendance sebelum approval authoritative;
- mutable current employee state sebagai satu-satunya history;
- hard-coded statutory rate tanpa effective-dated version;
- binary floating-point untuk authoritative money;
- fail-open encryption yang menyimpan plaintext ketika encryption gagal;
- account password/role dicampur sebagai employee master fact.

## Prioritization rule

Urutan implementasi tidak otomatis sama dengan urutan daftar di atas. Setiap paket implementasi harus mempertimbangkan:

- kebutuhan operasional YSQ;
- risiko payroll/authorization/security;
- dependency organisasi;
- migration impact;
- UX cost untuk operator dan pegawai;
- kemampuan melakukan UAT yang nyata.

Roadmap ini tidak menetapkan tanggal rilis.
