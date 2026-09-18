# ORG-004 Operational Validation Runbook

**Status:** REVIEW-READY PLAN — NOT EXECUTED

**Specification:** ORG-004

**Runtime scope:** Leave only

**Safety default:** absence of rollout configuration means `LEGACY`

This runbook governs the gradual operational validation of the Dynamic Organization Foundation. It does not authorize deployment, real-user account activation, production data mutation, or `STRUCTURE` activation. Every production-facing phase requires its normal human approval and change record.

## Source/schema reconciliation status

Canonical source now preserves the production-evolved ORG-004 holder/principal fields and rejects unsafe ambiguity. This closes a source/schema compatibility gap only.

It does **not** advance the operational rollout phase:

```text
schema/source compatibility available
!= SHADOW accepted
!= STRUCTURE activated
!= direct cutover authorized
```

With no rollout setting, resolver authority remains `LEGACY`. Account-held structural data cannot become new routing authority through this compatibility work; separately accepted configuration, capability mapping, SHADOW evidence, and activation approval remain required.

## Immutable safety boundaries

- Keep all workflows in `LEGACY` immediately after an eventual deployment.
- Do not create a default rollout row and do not seed a synthetic YSQ structure.
- Do not infer hierarchy or authority from job titles, unit labels, numeric levels, imports, or visual rank.
- Do not rewrite existing employee reporting fields or submitted Leave approval snapshots.
- Do not create/activate accounts or grant role/capability assignments as a side effect of organization configuration.
- Do not send external notifications during validation; inspect notification intents/outbox records only in an approved isolated environment.
- Keep `BIOMETRIC_COLLECTION_ENABLED=0`; USERINFO and fingerprint-device work are outside ORG-004.
- Keep the post-transfer deployment freeze for new SHAs until exact-SHA organization GHCR publication is independently proven. Do not change the existing runtime image namespace as part of ORG-004.

## Evidence record

For every phase, record:

- environment and application SHA;
- actor/change approval reference;
- workflow key, selected node keys, and effective business date;
- configuration change-set ID and rollout-setting ID, when present;
- resolver result, concrete approvers, explanation path, and eligibility result;
- relevant audit-event and notification-intent identifiers;
- before/after counts for existing submitted approval steps;
- outcome, unexplained mismatch count, and rollback decision.

Use identifiers and normalized metadata only. Do not copy employee documents, payroll values, secrets, or unnecessary personal data into evidence.

## Phase A — LEGACY baseline

After an eventual authorized deployment, keep rollout configuration absent or explicitly `LEGACY` for every workflow/node scope.

Verify:

- a missing rollout setting resolves as `LEGACY`;
- ORG-002 Direct Manager and Unit Approver remain authoritative;
- Leave submission snapshots the same concrete ordered chain as before deployment;
- no structural resolver result changes routing;
- no `leave.oversight.approved` intent is created;
- no existing submitted request, approval step, reporting field, or audit history changes.

Gate: zero approval-behavior change. Any difference stops the rollout and requires investigation before Phase B.

## Phase B — real structure as DRAFT

An authorized YSQ owner may model the real organization only after the environment and data-use approval are documented. Configure explicit:

- nodes and structural parent relationships;
- positions and position parents;
- memberships;
- primary and acting incumbencies;
- authority bindings;
- vacancy policies;
- reasoned reporting overrides, only for real exceptions.

Keep the change set in `DRAFT` until validation reports no cycles, invalid parent references, illegal effective-date overlaps, duplicate primary incumbencies, or unresolved mandatory authority. Publication makes structure data effective; it does not by itself authorize `STRUCTURE` rollout.

Separately verify every proposed workflow authority has an active employee, active account, and required capability/scope. Missing eligibility is a configuration gap; ORG-004 must not repair it automatically.

## Phase C — selected-node SHADOW

Enable `SHADOW` only for workflow `LEAVE` and named candidate node(s). ORG-002 remains authoritative. Structural resolution may be compared and persisted in submission explanation metadata, but it must not:

- replace an approver or approval snapshot;
- create structural oversight notification intent;
- alter an in-flight request;
- silently mutate accounts, roles, scopes, or reporting fields.

Classify every mismatch using the repository diagnostic code plus one operational disposition:

| Disposition | Meaning | Required action |
| --- | --- | --- |
| `EXPECTED_IMPROVEMENT` | Reviewed structural result intentionally corrects known ORG-002 mapping debt. | Link owner approval and planned mapping cleanup; do not count it as unexplained. |
| `CONFIG_ERROR` | Nodes, position parents, bindings, dates, vacancy policy, or snapshot configuration is wrong/incomplete. | Correct a new DRAFT and repeat SHADOW. |
| `ELIGIBILITY_GAP` | Selected authority lacks active employee/account/capability/scope eligibility. | Resolve through separately authorized access administration; never auto-grant. |

Required gate before `STRUCTURE`:

- unexplained mismatch = 0;
- unresolved mandatory authority = 0;
- self/cycle errors = 0;
- invalid effective-date overlap = 0;
- required approver eligibility gaps = 0;
- existing Leave snapshots changed = 0;
- structural oversight intents from `LEGACY`/`SHADOW` = 0.

Any non-zero gate keeps the selected scope in `SHADOW` or returns it to `LEGACY`.

## Phase D — STRUCTURE canary

This phase requires explicit human approval after all Phase C gates are met. Enable only one selected node and workflow `LEAVE`.

First canary: an ordinary Annual Leave request with a simple hierarchy. Verify in order:

1. Direct Manager resolution and eligibility;
2. Unit Approver resolution and eligibility;
3. deduplicated, concrete submission snapshot plus structural explanation metadata;
4. approval actions continue exclusively from that immutable snapshot;
5. final overall `APPROVED` state;
6. one informational, idempotent `leave.oversight.approved` intent one structural layer above the final line/governance approver;
7. audit evidence without an extra approval step.

Then test a deduplication case. Vacancy climbing, acting incumbency, and Director governance are later, separately approved canaries. Director governance must resolve Secretary as approver and Chair as the informational recipient; Pembina/Foundation Supervisor is not the target of that rule.

`STRUCTURE` must fail closed for missing/ambiguous structure, invalid eligibility, self-resolution, cycle, bounded-traversal exhaustion, `REQUIRE_ACTING_OR_BLOCK` without acting authority, and `BLOCK` vacancy. A structural failure is never permission to fall back to ORG-002.

## Rollback and stopping rules

Rollout configuration is additive and effective-dated. Operational rollback means creating an authorized `LEGACY` setting for the affected future scope/date; do not delete history and do not rewrite submitted snapshots. Requests submitted under `STRUCTURE` continue using their stored mode and concrete approval chain.

Stop and return the affected scope to the safe operational state when:

- `main`/deployed SHA changes outside the approved window;
- SHADOW changes routing or creates oversight side effects;
- STRUCTURE silently falls back to LEGACY;
- any submitted snapshot changes after organization or rollout edits;
- migration or configuration validation cannot preserve the existing schema/data;
- production data or access escalation would be required to complete a test;
- repository-transfer/GHCR state would require an unsafe runtime mutation.

## Repository verification before merge

The review branch must provide evidence for:

- typecheck, lint, full automated tests, API build, and Web build;
- clean PostgreSQL migration;
- `apps/api/scripts/rehearse-org004-upgrade.mjs`, proving upgrade from the pre-ORG-004 schema preserves ORG-002 mappings and submitted Leave snapshots and creates no rollout/structure seed data;
- targeted resolver, rollout, authorization-negative, Leave, date, acting, vacancy, cycle/self, deduplication, governance, oversight-idempotency, and Organization Designer regression tests;
- staging Compose static validation.

This repository verification makes the implementation ready for human review. It does not complete Phases A-D and does not authorize merge or deploy.
