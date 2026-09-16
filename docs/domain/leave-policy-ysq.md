# Leave Policy YSQ

**Status:** VERIFIED MVP BASELINE — ORG-004 CODE/SCHEMA DEPLOYED; STRUCTURE ACTIVATION/PILOT VALIDATION PENDING — POLICY SOURCE STILL REQUIRES LEGAL REVIEW
**Specification:** LEAVE-003  
**Related:** LEAVE-001, LEAVE-002, APR-001, ORG-002, ORG-004

## Source boundary

This specification translates the current internal `Master Ketentuan Cuti Final Sabilul Quran` working baseline into HCIS behavior.

The source itself states that it remains an internal policy working document that should receive legal review before becoming a final company regulation/SOP. HCIS therefore keeps the policy configurable and does not hardcode legal conclusions outside the approved YSQ rules.

The **implementation behavior** described here was verified for the MVP. That verification does not convert the underlying working policy source into a legally final regulation.

At the historical MVP checkpoint, ORG-004 was a planned post-MVP organization/authority-resolution extension. Its code/schema are now implemented and deployed at the inspected production baseline, but deployment does not activate structural routing. Codex Local evidence reports no `organization_rollout_settings` rows, so `LEGACY` remains authoritative. Real structure configuration, SHADOW comparison, STRUCTURE activation, and production pilot validation remain pending.

ORG-004 structural routing and notification rules are system workflow decisions and must not be mistaken for legal conclusions about leave entitlement.

## Human Capital handling

HCIS separates three Human Capital responsibilities:

```text
HC_NOTIFIED
  = HC receives the completed/ongoing leave information.

HC_VALIDATOR
  = HC verifies eligibility, documents, duration, or administrative compliance.
    Validation is not discretionary line approval.

HC_APPROVER
  = HC has explicit authority to approve/reject because the policy requires HC approval.
```

These responsibilities must not be collapsed into one generic `HC approval` step.

## Line approval — verified MVP / current LEGACY behavior

For leave that needs line approval, the verified MVP and current `LEGACY` rollout use ORG-002:

```text
DIRECT_MANAGER
  -> UNIT_APPROVER
  -> deduplicate
  -> remove requester self-approval
```

The resolved concrete people are snapshotted at submission according to APR-001.

## ORG-004 authority resolution

`docs/domain/dynamic-organization-structure.md` defines the implemented structure-driven organization model.

When `SHADOW` or `STRUCTURE` is explicitly configured, ORG-004 can resolve line/governance authority from:

- employee team/node membership;
- authority-bearing organizational positions;
- effective primary/acting incumbency;
- structural parent relationships;
- explicit authority bindings;
- configured vacancy fallback;
- documented employee reporting override.

It must not infer approval from free-text job-title strings or numeric organization levels.

Concrete approvers are still snapshotted at submission. A later restructure does not rewrite an existing request.

The resolved rollout mode is also snapshotted. `LEGACY` and `SHADOW` preserve the verified routing and produce no ORG-004 oversight notification; only a request submitted in `STRUCTURE` may produce that structural side effect. A later rollout-mode change does not alter an in-flight request.

Current production evidence shows the software/schema is present but rollout remains `LEGACY`; no real-user structural routing is inferred from deployment alone.

## Post-final-approval structural oversight notification

Implemented ORG-004 workflow rule, active only under a request's snapshotted `STRUCTURE` mode:

> For every leave workflow that contains a line/governance approval stage, once the **overall request reaches final `approved`**, notify one structural layer above the **final line/governance approver**.

This notification:

- is informational only;
- occurs after overall final approval;
- is not an additional approval step;
- does not block the completed request if delivery fails;
- remains separate from Human Capital notification/validation/approval responsibilities;
- is resolved through ORG-004 structure/authority configuration;
- applies only when the request's submission snapshot selected `STRUCTURE` mode.

The reference point is the final **line/governance approver**, not automatically the last actor in the whole workflow.

Examples:

```text
Annual Leave
Employee
-> Direct Manager
-> Unit Approver                 [final line approver]
-> overall APPROVED
-> one structural layer above Unit Approver NOTIFIED
```

```text
Planned leave requiring HC validation
Employee
-> Direct Manager
-> Unit Approver                 [final line approver]
-> HC validates
-> overall APPROVED
-> one structural layer above Unit Approver NOTIFIED
```

```text
Unpaid Leave
Employee
-> Unit Approver                 [final line approver]
-> HC actual approval
-> overall APPROVED
-> one structural layer above Unit Approver NOTIFIED
```

The HC approver's own supervisor is not automatically the oversight recipient merely because HC made the final workflow decision.

Existing policy-specific HC notifications remain additive where required.

## Director governance rule — ORG-004

Implemented configuration-driven rule, pending real structure configuration and STRUCTURE activation:

```text
Director
-> Secretary of the Foundation APPROVES
-> overall request APPROVED
-> Chair of the Foundation NOTIFIED
```

Pembina/Foundation Supervisor is not notified by this rule.

This must be configuration-driven through organizational positions and authority relationships, not title-specific source code.

If YSQ later changes this governance arrangement, future requests should follow the newly effective configuration while existing approval snapshots remain unchanged.

At the historical MVP checkpoint this was a planned ORG-004 rule. The code now implements it, but the inspected production rollout remains `LEGACY` and therefore does not prove the real governance configuration or a production pilot.

## Leave behavior groups

### 1. Individual request with line approval

Used when the employee requests planned leave and line management needs to approve operational scheduling.

Baseline examples:

- Annual Leave;
- Employee Marriage Leave;
- Child Marriage Leave;
- Child Circumcision Leave;
- Mandatory Hajj Leave.

Document-heavy types may additionally require HC validation.

### 2. Notice / administrative validation

Used for rights or emergency events where the workflow should not imply that a manager decides whether the underlying event may occur.

Baseline examples:

- Maternity Leave;
- Miscarriage Leave;
- Menstrual Rest;
- Sick Leave;
- Spouse Childbirth Accompaniment Leave;
- Spouse Miscarriage Accompaniment Leave;
- Family Bereavement Leave.

The line is notified as needed for staffing/operations. HC validates documents or administrative conditions where the policy requires it.

These notification/validation-only workflows do not automatically enter the ORG-004 one-level-above rule unless a line/governance **approval** stage is actually present.

### 3. Explicit HC approval

`Unpaid Leave` requires approval by the work-unit authority and Human Capital.

HC is therefore an actual approver for this leave type, not merely a validator.

For ORG-004 structural oversight under `STRUCTURE`, the reference point remains the final **line/governance approver** (for example Unit Approver), while HC continues as the policy-required actual approver.

### 4. Organization event, not individual leave request

- End-of-Semester / End-of-Academic-Year Leave;
- Foundation Collective Leave.

These are established by YSQ and should appear as organization/academic calendar events rather than individual employee requests.

### 5. Attendance dispensation

`Force Majeure / Disaster` is handled as attendance dispensation based on objective conditions and leadership decision. It is not an automatic leave entitlement.

## Annual Leave — non-education employees

### Right versus usage availability

HCIS must always distinguish the annual right from current-period availability.

```text
Annual entitlement shown to employee = 12 working days / year
Current period usage limit            = 3 working days
```

The UI must never describe an employee as having only `3 days annual leave entitlement` merely because only one period is currently usable.

Recommended presentation:

```text
Annual Leave Right
12 days / year

Eligibility status
Active since <eligibility date>

Current period
October-December: 3 days
Used: 0 days
Available now: 3 days
```

### Eligibility

Annual Leave applies to non-education employees after 12 continuous months of service.

Before the eligibility date:

- annual entitlement is still presented as `12 days / year` as the policy definition;
- available-to-use days are `0`;
- the UI shows the future eligibility date.

### Four usage periods

The 12-day annual entitlement is administered through four 3-day usage periods:

| Period | Usage limit |
| --- | ---: |
| January-March | 3 working days |
| April-June | 3 working days |
| July-September | 3 working days |
| October-December | 3 working days |

The initial implementation does **not** carry unused days from one period into the next unless YSQ later approves an explicit carry-forward rule.

### Employee becomes eligible mid-year

Eligibility does not retroactively unlock earlier periods.

Example:

```text
Employment start : 15 October 2025
Eligible from     : 15 October 2026
Annual right      : 12 days / year

2026 usage availability:
Jan-Mar           : not yet eligible
Apr-Jun           : not yet eligible
Jul-Sep           : not yet eligible
Oct-Dec           : up to 3 days
```

The correct HCIS display is **not** `Annual leave entitlement: 3 days`.

It is:

```text
Annual entitlement: 12 days / year
Available in current period: 3 days
```

In the following full eligible year, each of the four periods has a 3-day usage limit.

### Notice period

Annual Leave is submitted at least 7 days before the leave starts.

The policy engine must validate this before submission. The exact day-count convention should remain configuration-driven if YSQ later clarifies whether the notice uses calendar days or working days.

### Verified MVP/current LEGACY approval flow

```text
System validation
  -> Direct Manager
  -> Unit Approver
  -> APPROVED
  -> HC notified
```

System validation includes at minimum:

- employee is active;
- employee belongs to the non-education entitlement group;
- 12-month eligibility has been reached by the leave start date;
- minimum notice is satisfied;
- requested working days fit the current period's remaining 3-day limit;
- request does not cross an unsupported period boundary without being split;
- no prohibited overlap exists.

HC does not manually validate every normal Annual Leave request unless an exception workflow is introduced later.

When ORG-004 `STRUCTURE` is explicitly activated for a scope, the concrete Direct Manager/Unit Approver may be structure-derived. The approval chain remains snapshotted and HC notification remains separate from structural oversight notification.

## Education employees

End-of-Semester / End-of-Academic-Year Leave is the implementation/fulfillment of annual leave for education employees according to the academic calendar and YSQ decision.

It is not an individual `Annual Leave` balance request in the initial implementation.

HCIS must keep education/non-education classification explicit; it must not infer the classification solely from unit or job-title strings.

## Other leave baseline

| Leave type | Initial HCIS behavior | HC handling |
| --- | --- | --- |
| End-of-Semester / End-of-Academic-Year Leave | Organization/academic calendar event | administrative administration |
| Annual Leave | Individual line approval | notified |
| Foundation Collective Leave | Organization event | administrative administration |
| Maternity Leave | Individual notice/request with medical data | validator |
| Miscarriage Leave | Emergency notice; administration may follow | validator |
| Menstrual Rest | Notice; no H-7 requirement | notified; conditional follow-up validation |
| Sick Leave | Emergency notice; medical administration may follow | validator |
| Employee Marriage Leave | Individual line approval; supporting document | validator |
| Child Marriage Leave | Individual line approval; supporting document | validator |
| Child Circumcision Leave | Individual line approval; supporting document | validator |
| Spouse Childbirth Accompaniment Leave | Notice for base right; extension handled separately | validator |
| Spouse Miscarriage Accompaniment Leave | Emergency notice | validator |
| Family Bereavement Leave | Emergency notice | validator |
| Mandatory Hajj Leave | Individual line approval; official schedule/evidence | validator |
| Unpaid Leave | Unit approval then HC approval | approver |
| Force Majeure / Disaster | Attendance dispensation | outside normal leave approval |

Detailed duration/payroll consequences remain policy data and must not be inferred by the frontend.

## Data model direction implemented by MVP and ORG-004

The MVP keeps the policy small and explicit:

```text
Employee
  leave_entitlement_group = education | non_education

Organizational Unit
  leave_approver_employee_id

Leave Policy Catalog
  request_mode
  line_handling
  hc_handling
  notice_days
  evidence_requirement
  eligibility rule
  balance/period rule
```

Leave requests/slices persist the relevant submission-time facts needed by their workflow, including:

- policy key/version or policy metadata used at submission;
- calculated entitlement/usage facts;
- concrete approval steps where line approval applies;
- validation requirements and HC task kind;
- audit/events and notification intents.

Later organization changes must not rewrite already snapshotted approval chains.

ORG-004 is now implemented/deployed as the effective-dated structure/position authority successor for new resolution, while current rollout remains `LEGACY`. Real structure configuration and activation are operational work, not source-code assumptions.

## Verification

Final synthetic browser UAT verified the implemented MVP policy boundaries across:

- Annual Leave: system validation -> Direct Manager -> Unit Approver -> approved -> HC notified;
- Special Leave: HC administrative validation with encrypted evidence where applicable;
- Planned Leave: line approval plus planned-domain HC validation where required;
- Unpaid Leave: Unit Approver followed by **actual HC approval**;
- Attendance Resolution: unresolved administrative dates remain an attendance-classification concern, not automatic payroll or leave deduction;
- organization-scoped HC positive access and unit-scoped HC denial for global queues.

These tests verify HCIS behavior against the working policy baseline. They do not replace the pending legal review of the underlying YSQ policy document.

ORG-004 structural resolution and oversight notification are implemented and have synthetic automated coverage. Codex Local evidence shows the software/schema is deployed, but real structure configuration, SHADOW, STRUCTURE activation, and production pilot UAT remain unverified.

## Acceptance criteria

### Verified policy/MVP behavior

- LEAVE-003-A: Annual Leave always exposes the policy right as 12 days/year while separately showing current-period availability.
- LEAVE-003-B: annual usage is limited to 3 working days per Jan-Mar, Apr-Jun, Jul-Sep, and Oct-Dec period.
- LEAVE-003-C: an employee reaching 12 months during a year only becomes usable from the period containing the eligibility date; earlier periods are not retroactively available.
- LEAVE-003-D: unused period quota does not automatically carry forward in the initial implementation.
- LEAVE-003-E: Annual Leave uses system validation plus line approval; HC is notified, not a routine approver/validator.
- LEAVE-003-F: HC validator and HC approver are distinct workflow responsibilities.
- LEAVE-003-G: Unpaid Leave requires actual HC approval.
- LEAVE-003-H: organization-event leave and attendance dispensation are not modeled as ordinary individual leave requests.
- LEAVE-003-I: education/non-education classification is explicit and never inferred from title text.

### ORG-004 extension — implemented; operational activation pending

- LEAVE-003-J: line/governance authority can be resolved from effective organization structure without title-text inference.
- LEAVE-003-K: concrete approvers remain snapshotted at submission even when structural resolution is used.
- LEAVE-003-L: after overall final approval, leave with a line/governance approval stage creates an informational notification intent for one layer above the final line/governance approver when the request was submitted under `STRUCTURE`.
- LEAVE-003-M: later HC validation/actual approval does not automatically redefine the structural oversight target.
- LEAVE-003-N: Director leave resolves Secretary as approver and Chair as post-approval recipient; Pembina is not notified by this rule.
- LEAVE-003-O: existing HC notification requirements remain separate and additive to the structural oversight notification.

Implementation of these criteria is not evidence that real YSQ structure configuration or production pilot validation has completed.