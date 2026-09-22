# HCIS Product Roadmap

**Status:** ACCEPTED PRODUCT DIRECTION  
**Updated:** 2026-09-22  
**Scope:** Post-MVP product direction; no release dates are implied.

## Purpose

Roadmap ini menjaga HCIS tetap lengkap sebagai sistem Human Capital tanpa memaksa kompleksitas teknis muncul sebagai kompleksitas operasional.

Prinsip utamanya:

1. backend boleh menyimpan versioning, audit, approval snapshot, effective dating, dan evidence yang kompleks;
2. operator Human Capital harus bekerja dengan istilah dan alur yang ringkas;
3. fitur baru harus masuk melalui specification ID sebelum implementasi;
4. roadmap menyatakan arah produk, bukan bukti bahwa fitur sudah tersedia di production.

## Roadmap sequence

### A. Simplify attendance operations

Target operasional untuk Human Capital:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

Backend ATT-003/ATT-007/ATT-010 tetap boleh menggunakan roster version, default assignment, normalized event, dan versioned attendance result, tetapi konsep tersebut tidak boleh dipaksakan menjadi navigasi utama operator.

Arah simplifikasi dibahas di `docs/domain/attendance-operational-simplification.md`.

### B. Complete classic employment administration

HCIS akan mengadopsi kemampuan administrasi kepegawaian klasik yang relevan dari benchmark HRIS Indonesia, tetapi memakai model effective-dated dan audit-friendly HCIS.

Cakupan:

- hubungan/status kepegawaian dan kontrak;
- penempatan kerja;
- promosi;
- demosi;
- mutasi;
- riwayat jabatan/karier;
- pendidikan dan kualifikasi;
- keahlian/kompetensi;
- alamat/kontak administratif melalui employee master/data-change flow;
- keluarga/tanggungan/relasi pegawai.

Detail arah domain ada di `docs/domain/employment-administration.md`.

### C. Payroll discovery and staged delivery

Payroll penuh resmi masuk roadmap HCIS melalui PAY-003.

Model payroll **belum dikunci**. Sebelum implementasi engine, discovery harus menetapkan minimal:

- sumber komponen penghasilan dan potongan;
- hubungan attendance/overtime/leave terhadap payroll;
- komponen tetap vs variabel;
- honorer/fixed-pay boundary;
- BPJS Kesehatan dan BPJS Ketenagakerjaan;
- PPh21;
- review, adjustment, reconciliation, dan finalization;
- payment handoff ke proses perbankan/keuangan;
- publication ke PAY-002 payslip;
- historical payroll result dan audit;
- correction/reopen policy setelah finalization.

PAY-001/PAY-002 tetap menjadi batas verified untuk import dan akses slip sampai PAY-003 mempunyai spesifikasi yang disetujui dan implementasi tersendiri.

### D. Multi-company / multi-legal-entity discovery

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

YSQ menjadi legal entity pertama/default untuk kompatibilitas. Detail proposal ada di `docs/domain/multi-company-organization.md`.

### E. Talent and employee services

Setelah fondasi di atas cukup stabil, roadmap melanjutkan capability yang sudah ada:

- PERF-001 Performance/KPI;
- TRAIN-001 Training/LMS;
- REC-001 Recruitment;
- TRIP-001 Business travel;
- ASSET-001 Employee assets;
- REIMB-001 Reimbursement;
- LOAN-001 Employee loan;
- DOC-001/DOC-002 HR documents;
- NOTIF-001/002/003 external notification, announcements, reminders.

## Prioritization rule

Urutan implementasi tidak otomatis sama dengan urutan daftar di atas. Setiap paket implementasi harus mempertimbangkan:

- kebutuhan operasional YSQ;
- risiko payroll/authorization/security;
- dependency organisasi;
- migration impact;
- UX cost untuk operator dan pegawai;
- kemampuan melakukan UAT yang nyata.

Roadmap ini tidak menetapkan tanggal rilis.
