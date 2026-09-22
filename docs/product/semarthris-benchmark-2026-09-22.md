# SemartHRIS Benchmark Notes — 2026-09-22

**Status:** REFERENCE / DISCOVERY EVIDENCE  
**Benchmark repository:** `KejawenLab/SemartHris`  
**Inspected ref:** `master@2d2ce877e7797be79e5cd59aba7232bc375f3c24`  
**Purpose:** preserve product/domain lessons for HCIS without treating SemartHRIS source code as an implementation source of truth.

## Evidence rule

SemartHRIS is a benchmark, not HCIS authority.

Use it to answer:

- which operator concepts are easy to understand;
- which classic HR capabilities remain useful;
- which domain boundaries are worth preserving;
- which implementation patterns should explicitly **not** be copied.

HCIS source-of-truth order remains `AGENTS.md`.

## What was inspected

The benchmark covered current SemartHRIS:

- admin menu/configuration;
- employee, company, placement, mutation, career history, contract/SK;
- shift, workshift, attendance, attendance summary;
- overtime;
- payroll period, salary components, recurring benefits, allowances/deductions, payroll detail, company payroll cost;
- BPJS and PPh21 processors;
- leave;
- role hierarchy and supervisor voter;
- encryption helper;
- 2026 call-screen/recruitment addition;
- TODO/model skeletons for family, education, and skill.

## Implemented operator model observed

### Attendance

Primary concepts are simple:

```text
Shift -> Jadwal Kerja -> Absensi -> Riwayat Absensi
```

A workshift is primarily:

- employee;
- shift;
- start date;
- end date;
- description.

SemartHRIS also contains `WorkshiftSlicer`, which can split an existing date range when a newer workshift occupies a period inside it. The product lesson is valuable: the operator can express a replacement schedule without learning an internal "default assignment versus override" vocabulary.

### Employment administration

SemartHRIS distinguishes:

```text
Employee
Placement
Mutation
CareerHistory
Contract / Surat Keputusan
```

Mutation records old/new company, department, job level, job title, and supervisor and categorizes the movement as promotion, demotion, or mutation.

Placement/mutation can generate career-history records. Contract/SK records contain number, subject, effective dates, signed date, description, and tags.

### Payroll

Payroll is decomposed into:

```text
Salary Component
Recurring Salary Benefit
Salary Benefit History
Period Allowance / Deduction
Payroll Period
Payroll
Payroll Detail
Tax
Company Payroll Cost
```

Salary components distinguish:

- plus versus minus; and
- fixed versus variable.

The runtime composes multiple processors rather than one monolithic payroll formula. Attendance summary, fixed compensation, overtime, BPJS, allowances/deductions, and tax participate in separate steps.

Employer/company cost is stored separately from employee payroll detail, which is a useful distinction for future PAY-003.

### Multi-company

Company supports a parent relationship and payroll can be processed by company.

However the current employee model stores one mutable current company. HCIS must not infer from this that a person should be duplicated or that cross-company movement should overwrite history.

### Recruitment

The 2026 call-screen addition keeps `ScreeningCandidate` separate from `Employee`, masks phone numbers in routine listing, supports mock/live adapter modes, stores screening evidence, and keeps recruiter decision explicit.

This is useful reference for future REC-001 but is not a complete ATS/recruitment lifecycle.

## Partial / skeleton evidence

Some concepts exist in model interfaces or master data but are not complete operator capabilities at the inspected ref.

Examples:

- employee skill interface exists, but no current `EmployeeSkill` entity was found;
- employee family interface exists, but no current `EmployeeFamily` entity was found;
- education/skill master data exists, but complete employee lifecycle around those records is not demonstrated by current runtime;
- leave entity exists, while TODO still records leave approval as unfinished.

Do not describe these as complete SemartHRIS capabilities when using the benchmark.

## Product lessons adopted for HCIS

### 1. Hide backend complexity from normal scheduling work

HCIS keeps effective dating, published roster versions, immutable evidence, provenance, and audit.

Normal Human Capital UX should still let the operator think in terms of:

```text
Pilih pegawai/unit
+ pilih shift
+ pilih rentang tanggal / pola hari
+ simpan
```

Collision/replacement can be explained as a schedule change rather than forcing technical roster terminology into the primary workflow.

See `docs/domain/attendance-operational-simplification.md` (ATT-011).

### 2. One daily attendance outcome for humans, detailed evidence on drill-down

Human Capital should primarily see the resolved daily outcome:

```text
date | employee | check-in/out | status | exception
```

Device/mobile/manual evidence, result versions, sessions, and provenance remain available when explaining the outcome.

### 3. Employment changes are business actions

Operator actions should be explicit:

- Penempatan;
- Promosi;
- Demosi;
- Mutasi;
- Perpanjang kontrak;
- Perubahan kompensasi.

They should create new historical/effective-dated facts instead of silently overwriting current employee data.

### 4. Surat Keputusan / decision document is supporting evidence

Relevant employment actions may reference:

- document type;
- letter/decision number;
- subject;
- signed date;
- effective date;
- end date where applicable;
- attachment/reference;
- issuing authority.

The document supports the employment action; it does not replace the structured domain fact.

### 5. Job classification is distinct from organization authority

A job grade/classification may later support compensation policy, but must not be conflated with ORG-004 hierarchy or approval authority.

### 6. Payroll should be componentized

Future PAY-003 should separate:

- component catalog;
- recurring compensation;
- period adjustment;
- attendance/overtime inputs;
- calculation processors;
- payroll result lines;
- employee deductions;
- employer contributions/company cost;
- statutory/tax processing;
- finalization and payslip publication.

See `docs/domain/payroll-engine-discovery.md`.

### 7. Employer cost is not take-home pay

Employer-paid statutory contributions or other employer costs need their own accounting/reporting meaning. They must not be forced into employee take-home pay just so every payroll amount uses one table/number.

### 8. Recruitment should connect vacancy to employment

Future REC-001 should preserve Candidate != Employee and should eventually connect:

```text
ORG-004 vacant position
-> recruitment requisition/vacancy
-> candidate
-> screening/interview/decision
-> offer/hire
-> EMP-005 employment
-> EMP-006 placement
```

## Anti-patterns that must not be copied

### Synthesizing missing attendance evidence

The inspected attendance calculator may substitute scheduled start/end when a punch side is missing.

HCIS explicitly keeps missing evidence incomplete. Schedule time is not evidence that the employee actually arrived or left at that time.

### Leave immediately mutating attendance without approved workflow

SemartHRIS can create absent attendance rows from leave persistence while leave approval is still listed as unfinished.

HCIS retains:

```text
leave request -> approval -> approved leave input -> attendance resolution
```

### Mutable current-state overwrite as the primary history model

SemartHRIS mutation can capture old values and then overwrite current employee organization fields.

HCIS should prefer effective-dated employment/assignment history and derive current state from the record effective today.

### Hard-coded statutory formulas

The inspected BPJS/tax implementation contains historical hard-coded rates/formulas.

HCIS must version statutory policy by effective date and re-verify current legal/business rules before implementation.

### Floating-point money

Payroll/overtime code uses floating-point values in several places.

HCIS payroll money must use exact arithmetic (integer rupiah or approved decimal representation), never binary floating point for authoritative monetary calculation.

### Fail-open sensitive-value encryption

The inspected encryptor can return plaintext when encryption fails.

HCIS sensitive-data protection must fail closed; encryption/key failure may not silently persist plaintext.

### Employee identity coupled to application password/roles

The benchmark employee model also contains username/password/roles.

HCIS keeps employee/person facts separate from account/identity concerns.

## Current HCIS decision

The benchmark changes **product direction**, not implementation status.

Until separately specified and implemented:

- ATT-011 remains product UX direction;
- EMP-005..EMP-009 remain future employment-administration capabilities;
- PAY-003 remains payroll discovery/planning;
- ORG-007 remains discovery;
- REC-001 remains discovery;
- PAY-001/PAY-002 remain the authoritative current payslip boundary.
