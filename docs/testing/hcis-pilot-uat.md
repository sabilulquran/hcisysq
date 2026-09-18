# HCIS One-Unit Pilot UAT and Access Review

**Status:** READY TO EXECUTE; NOT EXECUTED BY THIS DOCUMENT  
**Specifications:** AUTH-011, AUTH-010, ORG-004, LEAVE-001

Use synthetic accounts locally/CI. Real-user validation is a separate pilot step after Human Capital selects the unit/participants and authorized operators configure accounts/structure. Never commit real credentials, cookies, employee documents, payroll values, or biometric data.

## Execution baseline

Before real-pilot UAT, record the exact application SHA actually deployed in the test environment and its exact API/Web image tags. Repository `main`, a merged PR, or green CI is not runtime proof. If a scenario depends on behavior introduced by PR #59/#60, the deployed test SHA must contain that behavior and must have passed the normal exact-SHA deployment/verifier path.

## Required personas

| Persona | Expected baseline |
| --- | --- |
| Employee | `/app`; own self-service only plus explicitly granted authority |
| Manager/approver employee | `/app`; own access plus exact approval capability/scope resolved for the test |
| Human Capital admin employee | employee workspace + permitted HC administration; organization scope required for global HC admin; no automatic approval/device privileges |
| Foundation Board | `/board`; aggregate-first/read-only unless an explicit accepted narrow capability exists |
| Super Admin | `/admin`; technical/system administration boundary; not organizational leader and no implicit employee self-service |

## Core scenarios

| ID | Scenario | Expected result | Synthetic locally | Real pilot required |
| --- | --- | --- | --- | --- |
| UAT-A01 | Central login with active Employee | Login succeeds, backend resolves account, lands `/app` | Yes | Yes, later |
| UAT-A02 | Foundation Board login | Lands `/board`; employee/admin principal areas denied | Yes | Optional later |
| UAT-A03 | Super Admin login | Lands `/admin`; no implicit employee self-service | Yes | Technical reviewer only if needed |
| UAT-A04 | Employee reads own profile/attendance/published payslip | Own data only | Yes | Yes |
| UAT-A05 | Employee requests another employee's payslip/data by URL/API | 403/404 according to contract; no data leakage | Yes | Spot-check later |
| UAT-A06 | Employee submits leave | Accepted request snapshots concrete approval chain | Yes | Yes |
| UAT-A07 | Wrong manager/cross-unit approver attempts decision | Denied server-side; no workflow mutation | Yes | Yes |
| UAT-A08 | Correct snapshotted approver acts | Accepted only inside effective scope; audit/state transition recorded | Yes | Yes |
| UAT-A09 | HC admin validates/administers allowed HC function | Allowed according to AUTH-011 organization permission | Yes | Yes |
| UAT-A10 | HC admin attempts `leave.approve`/`leave.hc.approve` without explicit permission | Denied; HC admin bundle does not imply actual workflow approval | Yes | Yes |
| UAT-A11 | HC admin attempts device operate/export/destructive/biometric action without separately granted technical permission | Denied | Yes | Do not run active command in routine UAT |
| UAT-A12 | Board without exact snapshot ownership/accepted governance capability attempts employee mutation, leave approval, role management, or payslip-personal access | Denied | Yes | Optional later |
| UAT-A13 | Unit-scoped HC assignment attempts organization-wide administration | Denied | Yes | Yes |
| UAT-A14 | Expired/future assignment attempts privileged route | Denied | Yes | Optional |
| UAT-A15 | Actor attempts self-role elevation | Denied and no assignment committed | Yes | Do not use real privileged identity just to prove this |
| UAT-A16 | Acting structural authority inside effective dates | Allowed only with explicit binding/scope and correct snapshot | Yes | Yes if acting is in pilot |
| UAT-A17 | Same acting authority outside effective dates | Denied/not resolved | Yes | Yes if acting is in pilot |
| UAT-A18 | Manually typed admin URL without backend permission | UI may render forbidden state; API denies | Yes | Yes |
| UAT-A19 | Relevant role/scope/structure change | Required audit event exists without secret/PII payload | Yes | Yes |
| UAT-A20 | Logout/session invalidation then protected request | Protected request denied | Yes | Yes |
| UAT-A21 | Exact snapshotted governance account with explicit organization-scoped `leave.governance.approve` acts on its own stored approval step | Allowed only for that exact account/step; another account or missing capability is denied | Yes | Only if governance approval is explicitly in pilot scope |
| UAT-A22 | Account-held organization position/incumbency is present but no separately accepted structural account-routing contract exists | Must not create new routing authority; structural use fails closed and does not grant RBAC/Application Access | Yes | Only if such data exists in selected pilot scope |

## ORG-004 comparison cases

Before STRUCTURE activation, run SHADOW cases for normal manager chain, deduplication, vacancy if relevant, acting if relevant, and governance only if the pilot scope needs it. Every mismatch needs a disposition and owner. Do not use a successful synthetic resolver test as evidence that the real YSQ structure is correct.

## Audit review

For each mutation/privileged case, record only safe identifiers and verify actor, action, target class, timestamp, scope/reason where defined, and before/after metadata required by contract. Do not copy secrets or unnecessary personal values into evidence.

## Negative-test stop conditions

Stop pilot preparation and investigate on any cross-employee data disclosure, wrong-unit approval, privilege obtained from job-title text, HC admin obtaining technical/device privilege implicitly, Board mutation without explicit contract, self-elevation, stale/ineffective assignment being accepted, or submitted approval snapshot changing after structure edits.

## Evidence form

For each UAT row record: environment, exact deployed application SHA and image references, synthetic/real-pilot classification, actor persona (pseudonymized in shared evidence), precondition, request/action, expected result, actual result, audit reference if applicable, pass/fail, issue owner. A row is not PASS until executed; this document itself is only the test plan.
