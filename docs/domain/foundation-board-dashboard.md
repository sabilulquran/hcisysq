# Foundation Board Dashboard

**Status:** VERIFIED MVP BASELINE  
**Specification:** ORG-003  
**Related:** ORG-001, ORG-002, EMP-005, LEAVE-007, ORG-010 (DRAFT)

> **ORG-010 (DRAFT, 2026-10-17)** proposes two extensions: an `EMPLOYEE` account with the board-view role (`board.read`) may also open `/board` (amends ORG-003-A), and HCIS publishes these aggregates to SQ Hub Ringkasan Yayasan through a bearer-only governance summary. The privacy, attendance and payroll boundaries below are unchanged. See [ORG-010](foundation-board-governance-summary.md).

## Purpose

`/board` is a governance-level dashboard for the Yayasan organ principal. It is not an employee self-service page and it is not the Super Admin configuration area.

The dashboard answers organization-level questions without exposing unnecessary employee-level personal data.

## Initial information set

The initial board dashboard contains live aggregate data for:

- active, inactive, and resigned employee counts;
- active headcount by organizational unit;
- education versus non-education leave-entitlement classification coverage;
- employment-status distribution;
- organization approval-readiness signals:
  - active employees with/without direct manager;
  - active units with/without current Unit Approver;
- leave workflow activity:
  - requests currently in review;
  - HC validations waiting;
  - attendance-resolution cases still open;
- current-year employee starts and recorded exits.

## Privacy boundary

The dashboard does not expose employee names, NIP, email, phone, dates of birth, identity numbers, uploaded evidence, or personal payslip lines.

Named employee drill-down is out of scope for the initial Board dashboard unless a later permission decision explicitly authorizes it.

## Data freshness

All displayed aggregates are calculated from the current HCIS database at request time. The UI must not present mock or cached placeholder metrics as production values.

## Attendance and payroll boundary

ATT-001 factual attendance and PAYSLIP-001 imported employee payslips exist in the verified MVP, but that does **not** authorize the Board dashboard to infer attendance percentages, payroll totals, salary trends, deductions, overtime, or other financial/disciplinary metrics.

Board attendance/payroll aggregates remain unavailable until a later specification defines the authoritative aggregate semantics and permission boundary. The dashboard may display an explicit `Belum terhubung`/unavailable state for those metrics, but must not fabricate them from raw attendance or imported payslip lines.

## UX principles

- show 4-6 key indicators before detailed distributions;
- use plain governance language rather than database terminology;
- highlight configuration gaps as `Perlu perhatian`, not as system errors;
- show unit distribution as a compact ranked list rather than an employee table;
- mobile layout remains readable without horizontal scrolling.

## Verification

Real browser UAT verified:

- `/board` loads live aggregate data for a `FOUNDATION_BOARD` principal;
- no personal employee detail/payslip data is exposed in the tested surface;
- Foundation Board cannot cross into `/app` or `/admin`;
- synthetic payslip UAT separately verified Foundation Board denial from personal payslip/import functionality.

## Acceptance criteria

- ORG-003-A: `/board` requires an authenticated `FOUNDATION_BOARD` principal. (ORG-010-A, DRAFT, proposes also allowing an active `EMPLOYEE` with effective organization-scope `board.read`.)
- ORG-003-B: all metrics are aggregate and live from the HCIS database.
- ORG-003-C: initial board dashboard exposes no employee-level PII, evidence, or personal payslip data.
- ORG-003-D: approval readiness reports direct-manager and Unit Approver coverage without inferring hierarchy from titles.
- ORG-003-E: leave workflow indicators show current in-review, HC-validation, and unresolved attendance-resolution workload.
- ORG-003-F: attendance/payroll aggregate metrics remain unavailable until their aggregate semantics and permissions are explicitly specified; raw ATT-001/PAYSLIP-001 data must not be repurposed to fabricate them.
