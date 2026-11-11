# HCIS Capability Map

**Status:** ACCEPTED PRODUCT DIRECTION
**Decision date:** 2026-09-18
**Updated:** 2026-11-02
**Related:** UX-001 and `docs/product/feature-parity.yaml`
**Reference benchmark:** `docs/product/semarthris-benchmark-2026-09-22.md`
**Legacy parity audit:** `docs/product/legacy-parity-audit-2026-11-02.md` (legacy features not recorded before are listed below as DISCOVERY)

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

- Work arrangement requests — ATT-015. Package 1 implemented 2026-11-03, `docs/domain/attendance-remote-and-schedule-requests.md`: *tugas luar*, WFH/WFA and an employee's own schedule change, approved through APR-001; HC applies schedule changes. An approved tugas luar or WFH/WFA explains a day without punches (result status `field_assignment` / `remote_work`) and never creates punches. WFH/WFA policy is DRAFT (per day, always approved, no quota).

### 2. Leave and approval

- Leave and permission submission — LEAVE-001.
- Leave balance and working-day calculation — LEAVE-002.
- Reusable approval engine — APR-001.

Approved leave/permission may feed attendance/payroll as a resolved fact. Submission alone must not silently rewrite attendance truth.

- Leave postponement with proposed alternative dates — LEAVE-008 (IMPLEMENTED 2026-11-11, `docs/domain/leave-postponement.md`). A line approver can answer "not those dates, these instead" with a note; the employee accepts or declines in their leave history. Accepting submits a new replacement request that goes through the whole approval chain again; the original keeps its dates as history. DRAFT defaults: notice counted from the original submission date, HC does not propose.
- Approver in-app notification and requester cancellation of pending leave — LEAVE-010 (IMPLEMENTED 2026-11-03, `docs/domain/workflows/leave-request.md`). The active line approver is notified in HCIS when their step opens; the employee can cancel Cuti Tahunan and planned leave until it is decided.
- Critical periods for leave — LEAVE-009 (IMPLEMENTED 2026-11-03, `docs/domain/leave-critical-periods.md`). HC marks periods (for the whole yayasan or one unit) such as exam weeks, PPDB, report cards and year-end; Cuti Tahunan and planned leave in such a period get an HC review after line approval. DRAFT default kept: review only, never block.

### 3. Compensation and employee financial services

- Payslip import/validation — PAY-001.
- Employee read-only payslip — PAY-002.
- Payroll calculation, review, reconciliation, finalization, payment handoff, and publication — PAY-003.
- Reimbursement — REIMB-001.
- Employee loans and installments — LOAN-001. Package 1 (request, APR-001 approval, Finance disbursement, interest-free schedule, repayments, payoff, reversal) is implemented; see `docs/domain/employee-loans.md`. Automatic payroll deduction waits for PAY-003 (Package 2).

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

- Performance review and KPI — PERF-001. Package 1 (cycles, self-assessment, rating by the structural line manager, HC validation, A–D predicate, history and recap) is implemented; see `docs/domain/performance-review.md`. Results do not feed tunjangan kinerja until the PAY-003 link (spec §11).
- Training / LMS and learning records — TRAIN-001. Package 1 (training record keeping: programs, sessions with time blocking, participants, attendance, internal and external records, certificates, yearly hours) is implemented; see `docs/domain/training.md`. Evaluation and online modules remain discovery.

TRAIN-001 stays inside HCIS (Product Owner decision, 2026-10-20). Discovery direction, including training evaluation and server-hosted video, is in `docs/domain/training-lms-discovery.md`.

### 5. Employment administration and employee services

Classic employment administration is an explicit HCIS direction, using effective-dated history rather than overwriting current employee fields:

- Employment relationship and contracts — EMP-005.
- Placement and career movement (promotion, demotion, mutation) — EMP-006.
- Education and qualification — EMP-007.
- Skills and competencies — EMP-008.
- Family, dependents, and employee relations — EMP-009.
- Employment basis documents: Perjanjian Kerja and Surat Keputusan — EMP-010.

Package 1 (EMP-005, EMP-006, EMP-010) is specified and accepted by the owner (2026-10-16) in `docs/domain/employment-administration-package1.md`. Package 2 (EMP-007, EMP-008, EMP-009 and addresses/contacts through the EMP-003 data-change flow) is specified in `docs/domain/employment-administration-package2.md` (2026-10-27); its step P2-2 shipped EMP-007 and EMP-008 (education, skills and certificates, with the worklist of certificates about to expire) and P2-3 shipped EMP-009 with dated addresses and P2-4 the employee's own data-change proposal with HC's decision on it (EMP-003 §7.3, §7.4). Package 2 is complete.

EMP-005/EMP-006 should support explicit Human Capital business actions and supporting decision/SK references. Current state must be explainable from historical/effective records.

Job classification/grade is a separate discovery concern from ORG-004 hierarchy/authority — ORG-011 (DRAFT/DISCOVERY, ADR-0004 PROPOSED, `docs/domain/job-classification-grade.md`). A classification is the stable key PAY-003 allowance tables are keyed to; it never grants approval authority and never holds monetary values.

Employee services continue with:

- Employee data change request — EMP-003.
- Employment and HR documents — DOC-001 / DOC-002. Package 1 (work certificate request/issuance and warning letters) is implemented; see `docs/domain/hr-documents.md`. The income certificate waits for PAY-003.
- Business travel / official travel workflow — TRIP-001. Package 1 (request, APR-001 approval, numbered surat tugas, cancellation, completion) is implemented; see `docs/domain/business-travel.md`. Attendance disposition is Package 2; costs stay with REIMB-001.
- Employee asset assignment and return — ASSET-001. Aset SQ remains the asset/custody system of record; HCIS shows a read-only Asset Saya and an outstanding-asset warning in the Termination dialog (`docs/domain/employee-assets.md`).
- ~~Desk/workplace booking — WORK-001~~ — removed by the product owner on 2026-11-02; not to be built.
- Employee document file archive — EMP-011. Package 1 is implemented (`docs/domain/employee-documents.md`): scans of KTP, KK, NPWP, BPJS cards, diplomas, transcripts, certificates and licences with an expiry date. HC uploads and verifies; the employee sees and downloads their own documents and proposes uploads from Data Saya; HC's worklist Dokumen Pegawai lists documents about to expire and proposals waiting. EMP-011 owns the employee-document storage boundary (D-01): files encrypted in the HCIS database behind the `EmployeeFileStore` port, so object storage later is an adapter swap. The same boundary carries the scanned Perjanjian Kerja / Surat Keputusan of EMP-010. Only the owner and HC Admin read; every read is audited.
- Employee ID card — EMP-012. Package 1 is implemented (`docs/domain/employee-id-card.md`): HC uploads the photo, issues, prints (CR80) and replaces cards with history; the employee sees a digital card and can report it lost; the QR opens a public check page that reads the card's status live.
- Organization-wide letter numbering — DOC-003. Package 1 is implemented (`docs/domain/outgoing-letter-register.md`, DRAFT D-01: the book lives in HCIS): HC keeps letter types (yearly or monthly reset), issuers (yayasan, unit, committee) and per-issuer grants; a granted employee takes a gap-free number `TYPE.SEQ/ISSUER/ROMAN-MONTH/YEAR` from **Nomor Surat**, can change its subject or void it (voided numbers stay visible); HC reads one register that also lists the letters HCIS issued itself (DOC-001 numbering unchanged), searches, pages and exports CSV, and can continue a manual book with a starting number. Reuses `documents.read`/`documents.manage`; no file upload, no legacy import.

### 6. Communication

- Delivery adapters for transactional notifications — NOTIF-001. The in-app adapter is implemented through NOTIF-004; external email/WhatsApp adapters remain separate.
- Recipient-owned in-app notification center — NOTIF-004.
- Announcements — NOTIF-002. Package 1 is implemented; see `docs/domain/announcements-and-reminders.md`. Scheduled auto-publication and external channels are not included.
- Reminders and scheduled notifications — NOTIF-003.
- Meeting invitations with participant time blocking and a personal calendar — CAL-001. Package 1 is accepted in `docs/domain/meeting-calendar.md` and implemented (menu Kalender, `/me/calendar`, `/me/meetings`): in-app and WhatsApp (Kirim SQ) notifications and a 30-minute reminder; no room booking. WhatsApp runs on the `log` adapter (dry run) until the HCIS number is paired.

### 7. Talent acquisition

- Recruitment/candidate workflow — REC-001.

Recruitment is a separate SQ Core application outside HCIS (Product Owner decision, 2026-10-16; see SQ Hub `docs/product/roadmap-and-decision-register.md` and ADR-0008). Candidates sign in through an external Akun SQ realm. HCIS keeps the employment side of the hand-off: vacant-position facts going out and the hire -> employment contract coming in.

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
- Organization sites, branches, and work locations — ORG-005 (DRAFT spec `docs/domain/organization-sites-work-locations.md`; ORG-005-1 unit work location built).
- Organization Directory publishing to SQ Hub as a read-only projection/distribution boundary — ORG-006 (ACCEPTED contract; runtime deployment gated).
- Multi-company / multi-legal-entity boundary above ORG-004 structures — ORG-007 (PROPOSED/DISCOVERY, ADR-0005 PROPOSED).
- Job classification and grade catalog, separate from structure and from payroll salary scales — ORG-011 (DRAFT/DISCOVERY, ADR-0004 PROPOSED).
- Committees (kepanitiaan) — ORG-012. Package 1 implemented (`docs/domain/committees.md`).

`ORG-012` covers the time-boxed committees a school runs every year (PPDB, exams, graduation, Ramadhan, events). Legacy let an employee propose a committee, a leader approve it, and the committee then had a chair, secretary, treasurer and members with join and leave dates until it was completed or cancelled; an active committee could also issue numbered letters (DOC-003). Legacy modelled each committee as a virtual unit in the organization tree. HCIS should not copy that without an ADR, because ORG-004 units carry approval authority and a committee should not. Package 1 therefore keeps committees outside the structure: HC records the committee and its line-up from active employees, decrees it with an SK numbered in the DOC-001 register (code `SKP`) or records an SK signed outside HCIS, and keeps the history; employees see "Kepanitiaan Saya", can invite a whole committee to a CAL-001 meeting, and HC reads a yearly participation recap for PERF-001. The proposal/approval flow and committee fees are not included.

`ORG-005` represents one organization operating across multiple sites/branches/work locations. It is not commercial multi-tenancy. Work location may later participate in schedule assignment, attendance/geofence policy, temporary assignment, and workplace booking.

`ORG-006` keeps HCIS as the workforce-organization authoring/system-of-authority side while SQ Hub is a read-only projection/distribution layer. The accepted v1 contract uses authenticated full-snapshot pull, stable namespaced HCIS identifiers, content-addressed versions, explicit effective/deactivation semantics, privacy minimization, and a default-OFF production export gate. Contract acceptance does not itself claim deployment or runtime activation.

`ORG-007` adds an optional legal-entity/company boundary above ORG-004 without turning HCIS into SaaS multi-tenancy. Each legal entity owns its own organization structure and sites; a person/account may later have separate employment relationships in more than one entity. Existing YSQ remains compatible as the first/default legal entity if this capability is implemented. The readiness assessment, staged plan E1..E6, and DRAFT defaults for the open ORG-007 decisions are in `docs/domain/multi-entity-readiness.md`.

`ORG-011` introduces effective-dated job classification and optional grade catalogs that live outside ORG-004 change sets. They carry no monetary values and no authority; PAY-003 keeps the salary scale (education x MKG) and the versioned allowance policy tables.

### 9. Reporting and user support

- HR reports and exports — RPT-001 (DISCOVERY). Legacy HC could download the employee list, a leave report and a payroll summary as CSV, besides the monthly attendance report. HCIS already has attendance reports (ATT-009, ATT-014) but no employee-list export and no leave report. Every export needs its own permission, scope filtering before the export, an audit event, and leaves out identity and bank numbers by default.
- In-app help center — HELP-001. Package 1 is implemented (`docs/domain/help-center.md`): FAQ and a short guide per service on a fixed topic list, search, HC contacts, and an HC admin screen with revisions and audit history. The initial content ships as drafts for HC to review before publishing. There is no contact form; a form must not grow into general chat, which stays outside HCIS.

## UX presentation

Employee-facing services are grouped by user intent rather than implementation package:

1. **Waktu & Kehadiran** — Kehadiran, Clock In/Out, Jadwal & Shift, Tukar Shift, Klarifikasi, Keterlambatan, Lembur.
2. **Cuti** — Cuti & Izin, Saldo Cuti.
3. **Keuangan Saya** — Slip Gaji, Reimbursement, Pinjaman.
4. **Kinerja & Pengembangan** — Kinerja/KPI, Training/LMS.
5. **Layanan Pegawai** — Data Saya, Dokumen, Perjalanan Dinas, Asset Saya.
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
