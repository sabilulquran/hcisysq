# HCIS Capability Map

**Status:** ACCEPTED PRODUCT DIRECTION  
**Decision date:** 2026-09-18  
**Updated:** 2026-09-22  
**Related:** UX-001 and `docs/product/feature-parity.yaml`  
**Reference benchmark:** `docs/product/semarthris-benchmark-2026-09-22.md`

## Product boundary

HCIS YSQ is the operational platform for the employee lifecycle, workforce administration, organization, attendance, compensation, development, and employee services.

This scope is broader than the verified MVP. Inclusion in this capability map means the capability belongs in the HCIS product direction; it does **not** mean the backend behavior is implemented, production-ready, or scheduled for a release date.

Until a capability is implemented and verified, the UI may expose it only as a clearly labeled planned/coming-soon service. Coming-soon UI must not fabricate balances, transactions, operational status, delivery dates, or permissions.

General chat, CRM, accounting/general ledger, generic project management, and general cloud storage remain outside HCIS product ownership. HCIS may integrate with those systems later.

## Capability domains

### 1. Time, attendance, and workforce scheduling

- Daily attendance factual records — ATT-001.
- Attendance clarification and permission — ATT-002.
- Work schedules, shifts, holidays, and employee schedule visibility — ATT-003.
- Fingerprint/device operations — ATT-005.
- Mobile clock in/out with controlled attendance evidence — ATT-006.
- Attendance evaluation such as lateness and overtime outcomes — ATT-007.
- Shift exchange / shift-swap workflow — ATT-008.

Implementation packages that support the attendance capability family are ATT-009 (operations/reporting polish) and ATT-010 (canonical attendance convergence). These package IDs do not replace ATT-008; ATT-008 remains uniquely reserved for shift exchange.

- Operational simplification of the admin/employee experience — ATT-011 (PROPOSED). Target operator mental model: **Shift -> Jadwal -> Kehadiran -> Lembur**, while backend versioning/evidence/audit remains intact.

ATT-011 should prefer bulk schedule-range operations, explicit schedule replacement/conflict preview, and one human-readable daily attendance outcome with drill-down evidence. Missing punch remains missing/incomplete; schedule time is not evidence.

ATT-006 may use approved evidence mechanisms such as GPS, geotagging/geofence, photo evidence, and face recognition. Those are capture/evidence mechanisms, not separate authorization domains. Privacy, retention, spoofing resistance, fallback, device trust, and biometric policy must be specified before activation.

ATT-007 must not be inferred from raw punches alone. Schedule, holiday, tolerance, leave/permission, and approved policy inputs are prerequisites for lateness/overtime conclusions.

### 2. Leave and approval

- Leave and permission submission — LEAVE-001.
- Leave balance and working-day calculation — LEAVE-002.
- Reusable approval engine — APR-001.

Approved leave/permission may feed attendance/payroll as a resolved fact. Submission alone must not silently rewrite attendance truth.

### 3. Compensation and employee financial services

- Payslip import/validation — PAY-001.
- Employee read-only payslip — PAY-002.
- Payroll calculation, review, reconciliation, finalization, payment handoff, and publication — PAY-003.
- Reimbursement — REIMB-001.
- Employee loans and installments — LOAN-001.

PAY-003 is an accepted roadmap domain expansion and must not reinterpret the verified PAY-001/PAY-002 MVP as a payroll engine.

Current discovery direction requires:

- component catalog;
- recurring/effective-dated compensation;
- period adjustments;
- resolved attendance/overtime/leave inputs;
- composable calculation processors;
- exact monetary arithmetic;
- effective-dated/versioned statutory rules;
- employee earnings/deductions separated from employer contributions/company cost;
- review/reconciliation/finalization;
- controlled reopen/revision;
- payment handoff;
- historical calculation evidence.

See `docs/domain/payroll-engine-discovery.md`.

### 4. Performance and development

- Performance review and KPI — PERF-001.
- Training / LMS and learning records — TRAIN-001.

### 5. Employment administration and employee services

Classic employment administration is an explicit HCIS direction, using effective-dated history rather than overwriting current employee fields:

- Employment relationship and contracts — EMP-005.
- Placement and career movement (promotion, demotion, mutation) — EMP-006.
- Education and qualification — EMP-007.
- Skills and competencies — EMP-008.
- Family, dependents, and employee relations — EMP-009.

EMP-005/EMP-006 should support explicit Human Capital business actions and supporting decision/SK references. Current state must be explainable from historical/effective records.

Job classification/grade is a separate discovery concern from ORG-004 hierarchy/authority. A grade may later influence compensation, but must not grant approval authority implicitly. Final specification ID is TBD.

Employee services continue with:

- Employee data change request — EMP-003.
- Employment and HR documents — DOC-001 / DOC-002.
- Business travel / official travel workflow — TRIP-001.
- Employee asset assignment and return — ASSET-001.
- Desk/workplace booking — WORK-001.

### 6. Communication

- Delivery adapters for transactional notifications — NOTIF-001. The in-app adapter is implemented through NOTIF-004; external email/WhatsApp adapters remain separate.
- Recipient-owned in-app notification center — NOTIF-004.
- Announcements — NOTIF-002.
- Reminders and scheduled notifications — NOTIF-003.

### 7. Talent acquisition

- Recruitment/candidate workflow — REC-001.

Recruitment belongs to HCIS but is an HC/admin workspace capability rather than an employee self-service launcher.

Target integration direction:

```text
ORG-004 vacant position
-> requisition/vacancy
-> candidate
-> screening/interview/decision
-> hire
-> EMP-005 employment
-> EMP-006 placement
```

Candidate remains distinct from Employee until the accepted hire/activation boundary.

### 8. Organization and work locations

- Current organization/access foundation — ORG-001.
- Dynamic organization structure and authority resolution — ORG-004.
- Organization sites, branches, and work locations — ORG-005.
- Organization Directory publishing to SQ Hub as a read-only projection/distribution boundary — ORG-006 (DISCOVERY).
- Multi-company / multi-legal-entity boundary above ORG-004 structures — ORG-007 (PROPOSED/DISCOVERY).

`ORG-005` represents one organization operating across multiple sites/branches/work locations. It is not commercial multi-tenancy. Work location may later participate in schedule assignment, attendance/geofence policy, temporary assignment, and workplace booking.

`ORG-006` keeps HCIS as the workforce-organization authoring/system-of-authority side while SQ Hub is planned as a read-only projection/distribution layer. It is discovery only: external identifiers, privacy, versioning, transport, freshness, replay, and bootstrap remain undecided, and no runtime publication path exists yet.

`ORG-007` adds an optional legal-entity/company boundary above ORG-004 without turning HCIS into SaaS multi-tenancy. Each legal entity owns its own organization structure and sites; a person/account may later have separate employment relationships in more than one entity. Existing YSQ remains compatible as the first/default legal entity if this capability is implemented.

## UX presentation

Employee-facing services are grouped by user intent rather than implementation package:

1. **Waktu & Kehadiran** — Kehadiran, Clock In/Out, Jadwal & Shift, Tukar Shift, Klarifikasi, Keterlambatan, Lembur.
2. **Cuti** — Cuti & Izin, Saldo Cuti.
3. **Keuangan Saya** — Slip Gaji, Reimbursement, Pinjaman.
4. **Kinerja & Pengembangan** — Kinerja/KPI, Training/LMS.
5. **Layanan Pegawai** — Data Saya, Dokumen, Perjalanan Dinas, Asset Saya, Desk Booking.
6. **Informasi** — Pengumuman, Notifikasi, dan Pengingat. Notifikasi in-app may be available before reminder scheduling or external delivery adapters.

Administrative/HC workspaces expose capabilities such as payroll processing, recruitment, device management, site/branch configuration, attendance policy, and organization operations separately from the employee launcher.

Attendance administration should prefer the operational language **Shift, Jadwal, Kehadiran, Lembur** instead of exposing internal roster/versioning concepts as primary navigation.

Employment administration should prefer explicit actions such as **Penempatan, Promosi, Demosi, Mutasi, Perpanjang kontrak** rather than using generic employee edit for historically meaningful changes.

## Coming-soon rule

A coming-soon surface is allowed when all of the following are true:

- the capability has a product/specification ID in the repository;
- its status is accurately shown;
- the route performs no unimplemented mutations and calls no imaginary API;
- access to employee/admin shells remains authenticated and role-appropriate;
- no release date is invented;
- no fake operational data is shown.

## Current implementation rule

The verified MVP and operational-readiness documentation remain authoritative for what actually works today. This capability map is product direction, not implementation evidence.
