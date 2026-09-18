# ORG-004 One-Unit Pilot Validation Form

**Status:** READY FOR HC REVIEW; NO REAL UNIT SELECTED  
**Specification:** ORG-004  
**Related runbook:** `docs/development/org004-operational-validation.md`

Use this form with authoritative Human Capital data. Do not infer real structure from job-title text, organization level, imported labels, or UI ordering. Store only the minimum evidence appropriate for the approved environment; do not commit real employee personal data to Git.

## Plain-language rollout modes

- **LEGACY:** existing manager/Unit Approver mapping decides routing. New organization structure does not change approvals. This is the safe default when no rollout setting exists.
- **SHADOW:** system calculates what the new structure *would* decide, but LEGACY still routes the request. Compare results and fix configuration without changing real workflow.
- **STRUCTURE:** the approved structure becomes the resolver for the selected workflow/scope. This is allowed only after SHADOW gates pass and an authorized owner explicitly approves activation.

Moving to the next mode is a controlled operational decision, not a repository merge side effect.

## HC pilot definition form

Complete outside Git with real identities; use synthetic identifiers in repository evidence/examples.

| Field | Required decision | Synthetic example |
| --- | --- | --- |
| Pilot execution SHA | Exact application SHA proven deployed for the pilot environment | `66da50cb...` |
| Runtime evidence | Exact API/Web images + health/verifier evidence for that SHA | `sha-66da50cb...` |
| Pilot unit/node | Exact authoritative unit selected by HC | `UNIT-PILOT-A` |
| Pilot date window | Start/end/effective business date | `2026-10-01..2026-10-14` |
| Employee participants | Active employees in scope | `EMP-A01`, `EMP-A02` |
| Direct manager | Explicit effective authority for each path | `EMP-MGR-A` |
| Unit/line approver | Explicit approver where workflow requires | `EMP-APR-A` |
| Acting/alternate officer | Who acts, exact effective dates, reason | `EMP-ACT-A`, 2-day window |
| Vacancy behavior | CLIMB / REQUIRE_ACTING_OR_BLOCK / BLOCK per accepted config | `CLIMB` |
| Capability binding | Permission/capability + scope supporting authority | `leave.approve`, unit A |
| HC validator/admin | HC role and scope, separate from approval authority | `HC-ADMIN-SYN` |
| Technical operator | Separate device/system capability if needed | `TECH-OPS-SYN` |
| Governance participant | Only if workflow explicitly requires it | `BOARD-SYN` read-only by default |
| Rollback owner | Person/role authorized to restore `LEGACY` | `OPS-OWNER-SYN` |
| Evidence owner | Person/role collecting UAT/audit references | `UAT-OWNER-SYN` |

## Authority review checklist

For each participant/authority, verify:

- pilot execution SHA is actually deployed and verified; repository `main` alone is not runtime proof;
- employee is active where employee principal is required;
- account is active;
- assignment/incumbency is effective for the test date;
- authority binding is explicit and in scope;
- acting assignment has effective dates and reason;
- no authority is derived from free-text title or numeric level;
- approver is not the submitter unless an accepted rule explicitly allows it;
- Human Capital admin capability is not mistaken for `leave.approve`;
- technical/device capability is separately granted and is not inherited from HC admin;
- Board account remains governance/read-only unless a specific accepted capability says otherwise;
- an account-held organization position/incumbency is persistence data, not an access grant and not structural routing authority under the current accepted boundary;
- an already-snapshotted account approval step, if governance is in scope, belongs only to the exact stored account and still requires the explicit workflow capability;
- no assignment implies `SUPER_ADMIN`.

## Validation sequence

### 0. Execution baseline gate

Before any real pilot configuration or SHADOW work, prove the exact application SHA that is running in the pilot environment. If the pilot depends on source/schema reconciliation merged in PR #59/#60, the deployed SHA must contain those changes and must have passed the normal exact-SHA publication/deployment/verifier path.

**Pass:** deployed repository SHA, API/Web image tags, health/readiness, biometric OFF, and current rollout state are recorded without mutation.  
**Stop:** the selected behavior exists only on repository `main`, runtime SHA cannot be proven, or the environment would need an unapproved deployment merely to continue the test.

### 1. LEGACY baseline

Capture current synthetic/local or approved pilot baseline: expected manager, approver chain, snapshot, audit references, and absence of structural oversight intent. No new rollout row is required merely to prove default LEGACY behavior.

**Pass:** route matches accepted current behavior and no structural side effect occurs.  
**Stop:** any existing submitted snapshot changes, unexpected account/role mutation, or structure affects routing while mode is LEGACY.

### 2. DRAFT structure

Model only the selected pilot scope with explicit nodes, positions, memberships, incumbencies, authority bindings, vacancy policy, and justified overrides. Validate cycles, parents, overlaps, duplicate primary incumbencies, and mandatory authority.

**Pass:** structural validation returns no blocking error; every mandatory authority maps to an eligible principal.  
**Stop:** unresolved authority, cycle/self-resolution, date overlap, or need to guess organizational meaning.

### 3. SHADOW comparison

Enable SHADOW only for `LEAVE` and the named pilot scope after authorization. Compare LEGACY and STRUCTURE candidates for representative synthetic/approved cases.

Record every mismatch as `EXPECTED_IMPROVEMENT`, `CONFIG_ERROR`, or `ELIGIBILITY_GAP` with owner/action.

**Pass to STRUCTURE only when:** unexplained mismatch 0; mandatory authority unresolved 0; self/cycle errors 0; invalid overlap 0; required eligibility gap 0; changed existing snapshots 0; structural oversight intents while LEGACY/SHADOW 0.

### 4. STRUCTURE canary

Requires explicit operational approval. Start with one ordinary leave path; verify resolver explanation, immutable concrete snapshot, correct final approver, idempotent informational oversight intent, and audit. Test acting/vacancy/governance only as separately approved cases.

**Pass:** actual route equals reviewed SHADOW expectation, backend authorization accepts only intended actor/scope, snapshot stays immutable, audit complete.  
**Stop:** silent fallback to LEGACY, wrong/cross-unit approver, self-approval, missing authority, snapshot mutation, unauthorized access, or notification side effect outside approved plan.

## Rollback

Operational rollback is a reviewed future-effective `LEGACY` rollout setting for the affected scope/date. Do not delete organization history or rewrite requests already submitted under STRUCTURE; those requests keep their stored mode and concrete approval snapshot. If rollback itself cannot be performed safely, stop the pilot and escalate rather than editing database rows ad hoc.

## Closure evidence

A one-unit ORG-004 pilot gate closes only when evidence includes environment, exact deployed application SHA and image references, approved pilot scope, configuration/change-set IDs, mode/date, resolver explanations, mismatch table, actor eligibility, audit references, before/after snapshot counts, decision owner, and rollback owner. Repository documentation alone is not closure evidence.
