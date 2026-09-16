# Annual Leave Submission and Approval Snapshot

**Status:** VERIFIED MVP BASELINE — ORG-004 CODE/SCHEMA DEPLOYED; STRUCTURE ACTIVATION/PILOT VALIDATION PENDING
**Specification:** LEAVE-004  
**Related:** LEAVE-001, LEAVE-002, LEAVE-003, APR-001, ORG-002, ORG-004

## Purpose

Implement the first real employee leave transaction as Annual Leave for non-education employees while preserving the YSQ rule that the employee-facing annual right remains **12 working days per year** and usage is limited to **3 working days per quarter-period**.

The verified MVP uses the simple organization model already agreed for approvals:

```text
Direct Manager
  -> Unit Approver
  -> approved
  -> Human Capital notified
```

The same employee is never required to approve twice. The approver chain is resolved once at submission and persisted as a snapshot.

## Current implementation boundary

The flow above remains the **verified MVP checkpoint** and is also the authoritative production behavior while ORG-004 rollout resolves to `LEGACY`.

ORG-004 (`docs/domain/dynamic-organization-structure.md`) is now implemented and its code/schema are deployed at the inspected production baseline. It provides structure-driven authority resolution, effective-dated positions/incumbencies, vacancy fallback, and post-approval structural oversight behavior.

Deployment does not equal activation. Codex Local evidence reports no `organization_rollout_settings` rows at the inspected production SHA, so `LEGACY` remains authoritative. Real YSQ structure configuration, selected-unit `SHADOW` comparison, explicit `STRUCTURE` activation, and production pilot validation remain pending. Agents must not treat structural resolution as active merely because the implementation is deployed.

## Annual right versus current availability

HCIS must never describe a late-year employee as having only a 3-day annual right.

```text
Annual right:          12 working days / year
Period usage limit:     3 working days
Current availability:  depends on eligibility, period and previous usage
```

Eligibility begins after 12 continuous months of employment. Periods before the eligibility date are not made retroactively available. No automatic carry-forward is enabled in this baseline.

Example: employment starts 15 October 2025.

```text
Annual right shown: 12 working days / year
Eligible from:       15 October 2026
Oct-Dec 2026:        up to 3 working days available
Jan-Sep 2026:        not retroactively available
```

## Work calendar

Working-day calculation is backend-authoritative and must not assume Monday-Friday or any other schedule without configuration.

The organization configures:

- weekly working weekdays using ISO weekday numbers 1=Monday through 7=Sunday;
- date-specific exceptions for holidays, collective leave, or exceptional working days;
- timezone is Asia/Jakarta in the current baseline.

If the workweek is not configured, annual leave preview and submission fail closed with an actionable configuration error.

## Submission validation

Before submission the API validates:

- requester account maps to an active employee;
- employee is explicitly classified as `non_education`;
- employment start date is present;
- 12-month eligibility has been reached by the leave start date;
- request respects the minimum H-7 notice;
- the date range does not cross two period buckets;
- backend-calculated working days are greater than zero;
- existing `in_review` and `approved` requests are counted as reserved/used period quota;
- requested working days do not exceed the remaining 3-day period availability;
- Direct Manager and Unit Approver are configured;
- each concrete approver is an active employee with an active employee account.

Concurrency is serialized by locking the requester employee row during submission. An idempotency key prevents duplicate requests.

## Approval snapshot

At submission HCIS stores all concrete approval steps in order.

```text
request submitted
  -> step 1 pending
  -> later steps waiting
```

Approving the active step activates the next stored step. The hierarchy is never recomputed after submission. Rejecting the active step rejects the request.

A Direct Manager and Unit Approver resolving to the same employee become one stored step with both source labels.

ORG-004 preserves this invariant when `STRUCTURE` authority is explicitly activated: structure changes resolution for a new submission, never an existing snapshot.

## Notifications — verified MVP

This slice writes notification intents to an outbox rather than coupling the transaction to a provider.

- first/next approver receives an approval-request intent;
- requester receives final approved/rejected intent;
- final approved Annual Leave creates an HC-role notification intent because HC is notified, not an approver, for this policy.

Notification-provider failure must not roll back the leave transaction.

## ORG-004 structural oversight notification

Implemented ORG-004 rule, active only for requests submitted under `STRUCTURE`:

> After the **overall leave request reaches final `approved`**, notify one structural layer above the **final line/governance approver**.

For ordinary Annual Leave:

```text
Employee
-> Direct Manager
-> Unit Approver                 [final line approver]
-> overall request APPROVED
-> one structural layer above Unit Approver NOTIFIED
```

This notification is:

- informational only;
- emitted after final approval;
- not an additional approval step;
- separate from the existing Human Capital notification required by Annual Leave policy;
- resolved through ORG-004 structure/authority configuration rather than job-title code.

Therefore an Annual Leave request submitted under `STRUCTURE` may legitimately produce both:

```text
HC notification               [existing leave-policy responsibility]
Structural oversight notice   [ORG-004 STRUCTURE behavior]
```

`LEGACY` and `SHADOW` requests do not produce the ORG-004 oversight side effect.

### Director requester

Implemented ORG-004 governance behavior, pending real structure configuration and `STRUCTURE` activation:

```text
Director
-> Secretary of the Foundation APPROVES
-> request APPROVED
-> Chair of the Foundation NOTIFIED
```

Pembina/Foundation Supervisor is not included by this rule.

At the historical MVP checkpoint this was a planned post-MVP rule. The code/schema now implement the rule, but the inspected production rollout remains `LEGACY`; it must still be represented through reviewed structure/authority configuration, not a source-code title check.

## Employee surfaces

The employee leave surface shows:

- annual right as 12 days/year;
- eligibility date;
- four period buckets;
- current period availability;
- preview of backend-calculated working dates;
- snapshotted approval chain preview before submit;
- recent request history and current approver;
- pending approval inbox for employees who are approvers.

When a selected scope is explicitly activated to ORG-004 `STRUCTURE`, preview should explain the resolved structural approvers without exposing unnecessary internal configuration detail.

## Slice boundary and later MVP slices

When LEAVE-004 was first introduced, the following were intentionally outside this slice:

- medical/document attachment storage;
- HC Validator queue for leave types that require validation;
- HC approval step for Unpaid Leave;
- half-day leave;
- post-approval cancellation;
- notification-provider adapter;
- collective/academic calendar event management beyond working-day exceptions.

By the final MVP checkpoint, encrypted evidence/HC validation, planned/unpaid leave, and Attendance Resolution are implemented by later leave slices and were verified separately. They do **not** change the verified LEAVE-004 annual approval rule: under `LEGACY`, normal Annual Leave remains Direct Manager -> Unit Approver -> approved -> HC notified. ORG-004 code/schema are now deployed, but structure-driven routing is authoritative only after explicit `STRUCTURE` activation for the applicable scope.

Half-day leave, post-approval cancellation, production notification delivery adapters, and fuller collective/academic calendar management remain outside the verified MVP unless specified elsewhere.

## Verification

The final isolated synthetic MVP UAT completed a real browser Annual Leave flow from preview and submission through snapshotted Direct Manager and Unit Approver decisions to final approved state. This verification used synthetic employees/accounts only and did not touch VPS employee data.

ORG-004 automated/synthetic evidence is separate from production pilot evidence. Deployment of its code/schema does not prove real structure correctness, SHADOW parity, STRUCTURE activation, or user UAT.

## Audit and privacy

Store identifiers, dates, policy metadata, and—when ORG-004 is used—structural resolution metadata and decision metadata only. Do not copy raw employee import rows into leave audit payloads.

Decision notes and leave reasons are authorized leave-domain data and must not be included in notification payloads by default.

## Acceptance criteria

### Verified MVP

- LEAVE-004-A: annual right is always represented as 12 days/year while current availability is calculated separately.
- LEAVE-004-B: employee becoming eligible in October can use at most the Oct-Dec 3-day bucket; earlier buckets are not retroactive.
- LEAVE-004-C: backend working-day calculation requires an explicitly configured calendar.
- LEAVE-004-D: in-review requests reserve period quota and concurrent submission cannot overspend it.
- LEAVE-004-E: submission snapshots concrete Direct Manager and Unit Approver steps and rejects unavailable approver accounts.
- LEAVE-004-F: approval proceeds only through the stored snapshot; organization changes do not rewrite an existing request.
- LEAVE-004-G: duplicate approvers are deduplicated and self-unit-approval is not added.
- LEAVE-004-H: final annual approval notifies HC without adding HC as an approval step.
- LEAVE-004-I: submission is idempotent by employee + idempotency key.
- LEAVE-004-J: employee and approver APIs are authenticated as EMPLOYEE and cannot operate on another employee's request or step.

### ORG-004 extension — implemented; operational activation pending

- LEAVE-004-K: Annual Leave authority can be resolved from effective organization structure without changing the immutable approval-snapshot rule.
- LEAVE-004-L: vacant supervisory positions follow the configured ORG-004 vacancy policy; no title-text inference is permitted.
- LEAVE-004-M: after overall final approval, one structural layer above the final line/governance approver receives an informational notification intent for requests submitted under `STRUCTURE`.
- LEAVE-004-N: the structural oversight notification remains separate from the existing HC notification.
- LEAVE-004-O: Director leave resolves Secretary as approver and Chair as the post-approval structural notification recipient; Pembina is not included by this rule.

These ORG-004 criteria being implemented in software do not by themselves prove the selected real structure or production pilot; those require the ORG-004 operational-validation gates.