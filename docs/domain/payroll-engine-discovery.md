# Payroll Engine Discovery

**Status:** DISCOVERY / PRODUCT DIRECTION  
**Specification:** PAY-003  
**Decision date:** 2026-09-22  
**Related:** PAY-001, PAY-002, ATT-007, EMP-005, EMP-006, ORG-004, ORG-007, LEAVE-001, LEAVE-002  
**Benchmark evidence:** `docs/product/semarthris-benchmark-2026-09-22.md`

## Purpose

PAY-003 defines the discovery boundary for a future authoritative payroll calculation engine.

This document does **not** convert current HCIS into a payroll engine. PAY-001/PAY-002 remain authoritative for imported payroll/payslip data until PAY-003 receives complete business rules, legal/statutory verification, workflows, permissions, migrations, tests, and production acceptance.

## Product goal

Future payroll should support an operator workflow that is understandable while keeping calculation evidence auditable:

```text
Payroll Period
  -> Collect Inputs
  -> Calculate
  -> Review
  -> Adjust
  -> Recalculate
  -> Reconcile
  -> Finalize
  -> Payment Handoff
  -> Publish Payslip
  -> Lock
```

A controlled reopen/revision path must exist for authorized corrections after finalization.

## Core payroll objects

### Component catalog

A payroll component describes the semantic meaning of a line, not its value for a specific employee.

Candidate attributes:

- stable code;
- display name;
- category;
- earning / deduction / employer-cost treatment;
- fixed/recurring or variable eligibility;
- taxable/statutory treatment reference;
- active/effective period;
- reporting/accounting mapping where later approved.

Examples such as "Gaji Pokok", "Tunjangan Jabatan", "Lembur", and deductions are product examples only. The final catalog must be approved by the payroll process owner.

### Recurring compensation

Recurring compensation assigns a component/value or policy to an employment relationship for an effective period.

Examples:

- base salary;
- recurring position allowance;
- other recurring fixed compensation.

Recurring compensation must be effective-dated. A new value does not overwrite historical periods.

Changes should be able to reference an approved employment decision/SK when required.

### Period adjustment

A period adjustment represents a one-period or exceptional addition/deduction, for example:

- one-off allowance;
- one-off deduction;
- correction;
- bonus;
- manually approved adjustment.

Every adjustment must carry actor, reason, source, period, audit trail, and approval/permission appropriate to the amount type.

### Payroll period

A payroll period defines the business calculation window and lifecycle.

It may use a cutoff window that is not identical to the calendar month. For example, attendance inputs may be collected from a prior-month cutoff through the current cutoff.

The cutoff policy must be explicit and effective-dated.

### Payroll result and lines

An authoritative result must preserve:

- employee/employment;
- legal entity when ORG-007 is active;
- payroll period;
- calculation version;
- source/input snapshot identifiers;
- result status;
- gross/earning totals;
- employee deduction totals;
- take-home pay;
- employer cost totals;
- detailed calculation lines;
- statutory/tax evidence references;
- finalization actor/time;
- revision lineage where applicable.

Historical finalized results must not be silently recomputed into different numbers because a future policy changes.

## Calculation pipeline

PAY-003 should use composable processors rather than one monolithic formula.

Illustrative pipeline:

```text
Base / Recurring Compensation
        |
Attendance Inputs
        |
Overtime Inputs
        |
Variable Allowance / Deduction
        |
Statutory Contribution
        |
Tax
        |
Manual Approved Adjustment
        v
Payroll Result + Lines
```

The exact ordering and formula contract remain TBD until payroll rules are documented.

Each processor must:

- declare required inputs;
- return explicit calculation lines/evidence;
- avoid hidden mutation of unrelated domains;
- be deterministic for the same input snapshot and policy versions;
- expose failures that block finalization.

## Attendance, overtime, and leave boundary

Payroll must consume approved/resolved outputs, not infer HR policy directly from raw device punches.

Expected boundary:

```text
raw attendance evidence
-> attendance engine
-> resolved/finalized attendance facts
-> payroll input
```

Likewise:

```text
overtime fact/request
-> approval/policy resolution
-> approved payable overtime input
-> payroll
```

and:

```text
leave request
-> approval
-> resolved leave/entitlement effect
-> payroll input if policy says it affects payroll
```

PAY-003 may not rewrite ATT/LEAVE facts to make payroll calculation easier.

## Employee amount versus employer cost

Employee take-home pay and employer cost are separate concepts.

A future result should be able to explain:

```text
Gross employee earnings
- Employee deductions
= Take-home pay

+ Employer-only contributions/costs
= Total employer cost
```

Employer-paid statutory contributions must not be misrepresented as take-home pay merely because they belong to the same payroll period.

## Exact monetary arithmetic

Authoritative payroll values must never use binary floating-point arithmetic.

Allowed direction:

- integer rupiah when fractional rupiah is not required; or
- fixed-precision decimal with explicit rounding rules.

Every formula that can round must define:

- precision;
- rounding mode;
- rounding stage;
- whether totals are summed from rounded lines or rounded after summation.

## Statutory policy versioning

BPJS, PPh21, and other statutory formulas/rates must not be hard-coded as timeless constants.

Target model:

```text
Statutory Policy
  -> effective_from
  -> effective_to
  -> policy/version identifier
  -> rates
  -> thresholds/ceilings/floors
  -> formula/configuration
  -> source/reference
```

Before implementation, current legal/business rules must be re-verified against authoritative sources and approved by the process owner.

A finalized historical payroll keeps the policy version used at calculation time.

## Statutory employee profile

Employee/employment attributes that influence statutory processing should be effective-dated rather than mutable singleton fields.

Discovery examples:

- tax status/classification;
- BPJS participation/state;
- work-risk classification;
- other statutory eligibility/profile facts.

The final set remains TBD and must follow privacy-by-purpose.

## Job classification / grade dependency

A job grade/classification may later influence compensation policy.

It must remain separate from ORG-004 authority:

```text
ORG-004 Position
  -> organization/reporting/approval authority

Job Classification / Grade
  -> compensation classification/policy
```

A grade may not automatically grant approval authority.

The final job-classification specification ID is TBD; PAY-003 must not implement an ad-hoc grade table without an accepted domain specification.

## Relationship to employment actions and SK

Recurring compensation or grade changes should be able to reference the employment decision that caused them.

Illustrative linkage:

```text
Promotion / Compensation Change
  -> effective date
  -> approved decision/SK reference
  -> new effective-dated compensation assignment
```

A document attachment is supporting evidence; the structured effective-dated change remains the domain truth.

## Proposed payroll lifecycle

Candidate lifecycle for discovery:

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

Corrections after finalization must use an explicit controlled path, for example:

```text
LOCKED
  -> REOPEN_AUTHORIZED
  -> REVISION
  -> REVIEW
  -> FINALIZED
  -> ...
```

Exact names and transition permissions remain TBD.

## Review and reconciliation

Before finalization, Human Capital must be able to explain at minimum:

- which employees are included/excluded;
- missing/invalid payroll inputs;
- changes compared with prior period;
- unusual adjustments;
- employee take-home pay;
- employer cost;
- statutory totals;
- reconciliation status;
- blocking exceptions.

Bulk operations must not remove per-employee traceability.

## Payment handoff

Finance/payment execution is a separate responsibility from Human Capital calculation.

HCIS may later produce an approved payment handoff/export, but PAY-003 must define:

- what data is handed off;
- who can approve it;
- whether Finance can reject/return it;
- whether payment confirmation returns to HCIS;
- which states permit payslip publication.

HCIS must not claim a bank payment occurred merely because payroll is finalized.

## PAY-001 / PAY-002 compatibility

Until PAY-003 is implemented and cut over:

- PAY-001 continues importing externally calculated payroll/payslip data;
- PAY-002 continues publishing employee read-only payslips;
- PAY-003 must not silently recalculate imported values;
- PAYSLIP-002..PAYSLIP-006 presentation/operational rules remain authoritative for current payslips.

Future migration from import-based payroll to calculation-based payroll needs a separate cutover plan.

## Failure behavior direction

Future payroll should fail closed when:

- required input is missing or ambiguous;
- a statutory policy version cannot be resolved;
- monetary calculation is invalid;
- unauthorized adjustment is attempted;
- reconciliation blockers remain;
- finalization input snapshot changed unexpectedly;
- legal-entity scope is ambiguous under ORG-007.

A failure may not silently substitute a guessed value.

## Non-goals for this discovery document

- final YSQ salary formula;
- current statutory legal advice;
- accounting/general-ledger implementation;
- direct bank integration;
- automatic job-grade design;
- payroll schema/migration;
- runtime implementation.

## Definition of ready for implementation

PAY-003 may move from discovery toward implementation only after repository documentation defines:

1. payroll actors and permissions;
2. component catalog semantics;
3. recurring and period adjustment models;
4. payroll period/cutoff;
5. exact formulas and rounding;
6. effective-dated statutory profiles/policies;
7. attendance/overtime/leave input contracts;
8. employer-cost treatment;
9. lifecycle and correction/reopen behavior;
10. review/reconciliation acceptance criteria;
11. payment handoff;
12. PAY-002 publication integration;
13. audit/privacy requirements;
14. migration/cutover from imported payroll;
15. automated verification strategy.
