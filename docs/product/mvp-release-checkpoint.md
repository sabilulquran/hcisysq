> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# HCIS YSQ MVP Release Checkpoint

**Status:** MVP VERIFIED COMPLETE  
**Checkpoint date:** 2026-08-22  
**Verified application SHA:** `be9967dd38f689139f7af8d44ff053f0ba85d78f`  
**Verification environment:** pre-release/VPS plus isolated synthetic local UAT

This document is the durable handoff for the completed HCIS YSQ MVP. It exists so later contributors do not repeat completed infrastructure, domain, authorization, or browser audits unless the relevant implementation/environment changes.

## Release conclusion

**MVP engineering status: COMPLETE.**

At the verified application SHA:

- automated quality gates passed;
- clean and realistic-upgrade PostgreSQL migration paths passed;
- pre-release deployment health passed;
- broad real-browser UAT passed;
- verified UAT defects were fixed and targeted browser retest passed;
- isolated synthetic mutation UAT passed for all requested MVP workflows;
- final payslip period-serialization defect was fixed and browser/regression-tested;
- no MVP release blocker remained.

MVP complete does **not** mean Pilot Ready or Production Ready. Those remain separate gates in `docs/product/scope.md`.

## Verified deployed application

Application SHA deployed to the HCIS verification environment:

```text
be9967dd38f689139f7af8d44ff053f0ba85d78f
```

Final deployment verification:

- PostgreSQL container healthy;
- API container healthy;
- web container healthy;
- internal `/healthz` passed;
- internal `/api/health` passed;
- internal `/api/ready` passed;
- public HTTPS `/healthz` passed;
- public HTTPS `/api/health` passed;
- public HTTPS `/api/ready` passed.

The final application commit changed payslip period serialization only and introduced no database migration/schema change.

Documentation-only commits after the verified application SHA do not require application redeployment unless they also change runtime code/configuration.

## Automated verification

Before final MVP freeze, the integrated application had passing:

- typecheck;
- lint;
- full automated tests;
- web/API build;
- PostgreSQL clean migration;
- realistic migration upgrade from the prior baseline;
- database invariants for leave/HC/payslip behavior.

The final synthetic-UAT defect patch additionally passed:

- typecheck;
- lint;
- web tests `5/5`;
- API tests `149/149`;
- web build;
- API build.

The payslip regression test asserts that an imported period such as `2026-07` remains `2026-07` rather than shifting month through timezone conversion.

## Broad browser UAT — completed, do not repeat by default

Real Microsoft Edge was controlled with Playwright (`headless=false`) against the verification URL.

Verified positive surfaces included:

- employee dashboard;
- employee attendance;
- employee leave/special/planned leave;
- employee payslip;
- employee approval inbox;
- Foundation Board dashboard;
- Super Admin dashboard and employee/organization/attendance/leave/payslip/access administration.

Negative principal-boundary checks passed:

- Employee -> `/admin` denied;
- Employee -> `/board` denied;
- Foundation Board -> `/admin` denied;
- Foundation Board -> `/app` denied;
- Super Admin -> `/app` denied.

No blank screens or fatal JavaScript crashes were observed in the broad pass.

## Verified UAT defect correction

Broad browser UAT exposed that the available Human Capital employee account had a `human_capital` assignment with **unit scope**, while global HC APIs correctly require **organization scope**.

The backend `403` responses were correct. The defect was frontend capability presentation/error handling:

- organization-wide HC navigation had been inferred too loosely from a role label;
- HC leave and attendance-resolution pages could remain in a loading state after `403`;
- employee payslip shell used a raw account fallback rather than linked employee identity.

The fix preserved backend authorization:

- unit-scoped Human Capital does not receive global HC navigation;
- organization scope remains required by the global HC queues;
- direct unauthorized access terminates with a clear error state;
- payslip shell uses linked employee identity.

Targeted post-fix Edge UAT passed all of these checks.

**Backend organization-scope checks MUST NOT be relaxed merely to make a unit-scoped HC account reach global queues.**

## Final isolated synthetic mutation UAT

A disposable local environment was built from the verified application line using:

- isolated PostgreSQL 16;
- migrated local HCIS database;
- dedicated local API/web ports;
- installed Microsoft Edge + Playwright, `headless=false`;
- synthetic accounts/employees only.

Production/VPS data was **not** touched by this mutation UAT.

Synthetic personas included:

- employee requester;
- direct manager;
- Unit Approver;
- organization-scoped Human Capital;
- unit-scoped Human Capital;
- Foundation Board;
- MFA-enabled Super Admin.

### Mutation/UAT matrix

| Workflow | Result |
| --- | --- |
| Organization-scoped HC positive access | PASS |
| Unit-scoped HC global-access denial | PASS |
| Attendance manual create/update/delete + audit | PASS |
| Annual Leave end-to-end approval | PASS |
| Special Leave + encrypted evidence + HC validation | PASS |
| Planned Leave + line/HC validation boundary | PASS |
| Unpaid Leave: Unit Approver -> actual HC approval | PASS |
| Attendance Resolution | PASS |
| Payslip upload -> preview -> review -> commit -> publish -> owner self-read | PASS |
| Payslip cross-employee/Foundation Board denial | PASS |
| Published payslip immutability | PASS |
| Data privacy boundaries | PASS |

The disposable browser profiles, local servers, database server/directory, and synthetic environment were removed after verification.

## Final defect found during synthetic UAT

On `/admin/payslips`, imported period `2026-07` appeared as `2026-06` during Review because a PostgreSQL `DATE` value crossed JavaScript/local-time/UTC serialization.

Final patch:

```text
be9967dd38f689139f7af8d44ff053f0ba85d78f
fix(payslips): preserve imported period month
```

Resolution:

- API returns canonical period strings from PostgreSQL;
- preview detail returns `YYYY-MM` explicitly;
- commit path consumes canonical date text;
- regression test covers the timezone month-shift case;
- visible Edge retest confirmed `2026-07` renders as `2026-07`.

## Domain boundaries frozen at MVP

### Attendance

Raw attendance is factual punch/correction data only.

Do not automatically infer:

- lateness;
- absence;
- overtime;
- worked hours;
- payroll deduction;
- annual leave conversion;
- attendance-resolution outcome.

Manual correction must preserve source/provenance and integration records remain protected from silent manual overwrite/delete.

### Leave

Preserve distinctions between:

- HC notified;
- HC administrative validator;
- actual HC approver.

Normal Annual Leave does not add HC as a routine approver. Unpaid Leave uses Unit Approver followed by actual HC approval. Annual conversion in Attendance Resolution requires explicit employee acceptance.

### Payslip

Payslip MVP is controlled imported display data. HCIS does not calculate payroll or derive financial values from imported lines.

### Access

- active `EMPLOYEE` + active employee record is required for self-service;
- role and scope are separate;
- same role in a unit is not organization-wide authority;
- Foundation Board is aggregate-first/read-only;
- Super Admin is technical administration and is not employee self-service;
- backend authorization remains authoritative.

## Data/environment caution

The VPS verification database contains real employee master data and is not disposable.

Do not casually:

- reset/drop the database;
- recreate credentials;
- use destructive synthetic mutation against real employees;
- run `docker compose down -v`;
- remove the PostgreSQL volume;
- create duplicate Super Admin bootstrap records.

Future destructive workflow testing should use isolated synthetic environments unless an explicit sanitized pilot dataset/process is approved.

## What must NOT be re-audited without a reason

Unless the implementation/environment materially changes, do not repeat:

- original parallel-agent integration audit;
- clean/upgrade migration audit already completed for MVP;
- broad principal route inventory;
- broad browser UAT of all previously passing employee/Board/admin screens;
- the five cross-principal negative authorization checks;
- unit-scoped HC global-queue denial semantics;
- synthetic Attendance/Leave/Payslip mutation UAT described above;
- VPS compose/Caddy/database discovery already captured by deployment docs/checkpoints.

When a later change touches one of these boundaries, run **targeted regression for the affected area**, not a full re-audit by default.

## Remaining work after MVP

These are not MVP blockers:

- Pilot readiness: sanitized/synthetic staging policy, restore drill, observability, pilot users, rollback/incident path, organization configuration readiness.
- Production readiness: security review, legacy cutover/reconciliation rehearsal, operational ownership/runbook, recovery verification, go-live approval.
- Product work explicitly deferred in `docs/product/scope.md`: reimbursement, payroll calculation/reconciliation, loan, performance, training, recruitment, data-change request, production notification adapters, and attendance schedule/GPS/biometric/overtime semantics.

## Handoff rule

For new work, start from the latest repository branch/ref containing this documentation, but treat the verified application SHA above as the runtime evidence anchor for MVP completion.

If a future code commit supersedes `be9967dd38f689139f7af8d44ff053f0ba85d78f`, preserve this checkpoint as historical evidence and create a new targeted release checkpoint rather than rewriting the old verification claims.
