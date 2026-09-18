# Employee Self-Service Experience

**Status:** ACCEPTED  
**Specification:** UX-001  
**Related feature IDs:** EMP-003, ATT-001, ATT-002, ATT-003, APR-001, LEAVE-001, LEAVE-002, PAY-002, REIMB-001, LOAN-001, PERF-001, TRAIN-001, DOC-001, DOC-002, NOTIF-002, NOTIF-003  
**Decision date:** 2026-09-18

## Purpose

HCIS employee self-service should behave like a task-oriented employee application, not a desktop dashboard merely compressed onto a phone.

The first screen should answer, in order:

1. what is relevant today;
2. what can the employee do quickly;
3. what needs the employee's action;
4. what happened recently;
5. which services are planned but not yet available.

This specification changes presentation and navigation only. It does not expand domain authority, invent attendance conclusions, enable payroll calculation, activate deferred modules, or weaken backend authorization.

## Source of truth for service availability

`docs/product/feature-parity.yaml` remains authoritative for whether a feature is verified, implementing, discovery, deferred, or otherwise planned.

Employee navigation may expose a planned service before implementation only when the service already exists in that roadmap. The UI must clearly distinguish:

- **available now** — the route and underlying workflow already exist;
- **planned** — roadmap item exists but the user-facing workflow is not available;
- **after MVP** — explicitly deferred from the completed MVP.

A visible planned menu is product discoverability, not evidence that the feature is implemented or scheduled for a particular release date.

## Employee dashboard hierarchy

### 1. Greeting and date

Keep the greeting personal and compact. On mobile, do not repeat long product naming when the global shell already establishes HCIS identity.

### 2. Today

Show factual attendance data for the current Asia/Jakarta date when available:

- check-in time;
- check-out time;
- clear no-record state;
- link to attendance history.

Do not infer lateness, absence, overtime, worked hours, or payroll consequences until the relevant attendance policy is implemented.

### 3. Quick access

Prioritize the verified employee workflows:

- Kehadiran — ATT-001;
- Cuti & Izin — LEAVE-001 / LEAVE-002;
- Slip Gaji — PAY-002;
- Persetujuan — APR-001 where relevant.

These are launcher-style actions, not explanatory marketing cards.

### 4. Needs action

Consolidate actionable employee tasks into one compact area rather than several equal-weight dashboard cards.

Current actionable sources include:

- attendance resolution awaiting employee action;
- special-leave document correction;
- approval tasks waiting for the employee as approver.

If there is nothing actionable, render a concise completed/clear state.

### 5. Summary and recent activity

Keep useful current-state information such as annual-leave availability and recent requests, but place it below today's task-oriented controls.

## Planned employee services

The following menu items may be visible before implementation because they already exist in the product roadmap.

| Menu label | Feature ID | Current roadmap state | User-facing behavior before implementation |
| --- | --- | --- | --- |
| Data Saya | EMP-003 | discovery | Coming-soon information page |
| Klarifikasi Kehadiran | ATT-002 | discovery | Coming-soon information page |
| Jadwal Kerja | ATT-003 | discovery | Coming-soon information page |
| Reimbursement | REIMB-001 | deferred / after MVP | Coming-soon information page |
| Pinjaman | LOAN-001 | discovery | Coming-soon information page |
| Kinerja | PERF-001 | discovery | Coming-soon information page |
| Pengembangan | TRAIN-001 | discovery | Coming-soon information page |
| Dokumen | DOC-001 / DOC-002 | discovery | Coming-soon information page |
| Pengumuman | NOTIF-002 / NOTIF-003 | discovery | Coming-soon information page |

Recruitment, migration, technical device administration, security controls, and authentication infrastructure are not employee launcher items merely because they appear in feature parity.

## Coming-soon contract

A planned-service destination must:

- state that the feature is not active yet;
- name the underlying roadmap/specification ID;
- show the roadmap stage in plain language;
- avoid synthetic transactions, balances, status counts, or fake employee data;
- avoid promising a launch date unless an approved release decision exists;
- provide a clear path back to employee services;
- retain employee authentication and route isolation.

The page must not call unimplemented feature APIs.

## Navigation

### Mobile

Primary mobile navigation is limited to five stable destinations:

- Beranda;
- Hadir;
- Cuti;
- Approval;
- Lainnya.

`Lainnya` opens the employee service catalog, which includes available and planned services. This avoids continuously changing the bottom navigation as HCIS grows.

### Desktop

Desktop retains the employee sidebar. Verified services remain primary. Planned services may appear in a clearly labeled **Akan hadir** group and always route to the coming-soon contract rather than a dead `#` link.

Role/capability-specific Human Capital navigation remains capability-gated and is not mixed with planned self-service items.

## Visual direction

Follow the existing YSQ brand guideline.

For employee self-service:

- use fewer, more purposeful cards;
- prefer launcher tiles for navigation;
- keep turquoise as the primary action color;
- reserve yellow/orange for attention and status support;
- reduce excessive elevation and oversized radius when hierarchy can be expressed by spacing and typography;
- keep touch targets accessible;
- preserve explicit loading, empty, error, and forbidden states.

## Authorization and privacy invariants

- Frontend visibility never grants permission.
- Backend authorization remains authoritative.
- Planned menu items do not create capabilities.
- A user typing a coming-soon URL must still be authenticated as an employee.
- Global Human Capital tools remain hidden without organization-scoped effective capability.
- No production employee, payroll, attendance, or document data is added to fixtures or screenshots.

## Acceptance criteria

- UX-001-A: employee dashboard prioritizes factual today information, quick actions, actionable tasks, and recent activity in that order.
- UX-001-B: current attendance times, when shown on the dashboard, are factual ATT-001 records only.
- UX-001-C: planned employee services from the roadmap are discoverable without dead links.
- UX-001-D: every unimplemented service route clearly says it is not yet available and identifies its roadmap feature ID/stage.
- UX-001-E: mobile primary navigation remains bounded to five items and exposes the broader catalog through **Lainnya**.
- UX-001-F: desktop planned navigation is visually separated from available services.
- UX-001-G: capability-gated Human Capital navigation behavior is preserved.
- UX-001-H: no planned feature is represented with fake operational data or an invented delivery date.
