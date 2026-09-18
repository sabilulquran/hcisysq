# HCIS Pilot Recovery, Device Boundary, and Codex Local Handoff

**Status:** READY FOR OPERATIONAL OWNER INPUT; EXECUTION PENDING  
**Updated:** 2026-09-19  
**Canonical repository main:** `66da50cbd2a12f6099a59adbda28b657863e8e40`  
**Latest verified production application SHA:** `acd22b438a7468dc6ea53ae001980cd06f7343cd`

This runbook separates repository readiness, verified production state, passive verification, and state-changing pilot operations. Updating this document does not authorize deployment, account/role changes, organization rollout changes, restore operations, device commands, biometric collection, or pilot activation.

## Repository vs production boundary

The latest operator-supplied production verification on 2026-09-18 records API/Web running exact-SHA organization images for:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd
ghcr.io/sabilulquran/hcisysq-web:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd
```

GitHub-observed publisher run `35371463160` completed successfully for API and Web, and production run `35371563402` completed Production preflight and Deploy and verify successfully. Operator-supplied evidence also records exact runtime images, healthy API/Web/PostgreSQL, health/readiness HTTP 200, biometric collection OFF, device-command delta 0, unauthenticated boundary PASS, and authenticated UI smoke PASS.

Repository `main` subsequently advanced beyond that deployed SHA:

- PR #59 restored production-recorded migration history into canonical source;
- PR #60 reconciled application source with the deployed organization/Leave principal schema;
- current `main` is `66da50cbd2a12f6099a59adbda28b657863e8e40`.

Those later repository commits are **not production evidence**. Do not infer that PR #59/#60 behavior is live merely because it is on `main`.

The last supplied read-only ORG-004 rollout inspection reported zero `organization_rollout_settings` rows. Under the accepted contract, missing rollout configuration resolves to `LEGACY`. Re-check the actual pilot execution environment before relying on that historical observation.

## Pilot execution SHA gate

Before executing DRAFT/SHADOW/STRUCTURE validation, record one exact application SHA and prove that the intended pilot environment is actually running it.

If the pilot depends on behavior introduced by PR #59/#60, the execution SHA must contain those commits and must go through the normal exact-SHA publication, approved deployment, and verifier path first. This requirement is a readiness gate, **not** authorization to deploy.

Required evidence before pilot execution:

- repository commit selected for pilot;
- published exact-SHA API/Web images for that commit;
- deployed repository SHA equals the selected commit;
- runtime API/Web images equal the selected exact-SHA tags;
- health/readiness pass;
- biometric collection remains OFF;
- verifier records zero device commands unless a separately approved device canary is explicitly in scope;
- current ORG-004 rollout mode/configuration is read and recorded without mutating it.

A green `main`, merged PR, or successful CI run is not a substitute for this runtime gate.

## ATT-005 boundary for this pilot

ATT-005 remains `IMPLEMENTING`. Repository code includes typed physical operations and safe observability/export surfaces, but repository implementation is not full physical-device proof.

PR #55, which repaired the Work Code export SQL, is merged and is an ancestor of the verified `acd22b...` production release. The supplied production release evidence did not separately record a route-specific Work Code export smoke, so treat that as a passive read-only check if Work Code export is actually relevant to the pilot.

### Passive verification

Subject to normal read authorization, an operator may:

- confirm exact deployed SHA/image tags and health/readiness;
- confirm latest migration and `BIOMETRIC_COLLECTION_ENABLED=0`;
- confirm the retired USERINFO safety control;
- inspect device inventory/last-seen, request-journal summaries, capability states, operation history, and safe exports;
- reconcile recorded physical-capability evidence with the ATT-005 ledger;
- record disk/memory/container observations without treating capacity alone as an incident.

A passive verification must finish with **zero new device commands requested**.

### Active device tests

Any time sync, duplicate-punch setting, Work Code delivery, message, profile push, enable/disable, reboot, server/NTP config, firmware, biometric query/enrollment/restore/delete, or destructive clear operation is state-changing hardware work.

Such work is **not required by default for an ORG-004/Leave one-unit pilot**. Run one capability at a time only if an authorized owner explicitly places that capability in pilot scope and approves the exact device, command, expected result, recovery value, window, and evidence capture.

Biometric collection remains OFF. Active USERINFO reads remain retired. No arbitrary/raw command escape hatch is permitted.

## Isolated restore drill

**Never restore over the active production database.**

Prerequisites:

- operational owner approves backup copy/use;
- isolated PostgreSQL target exists with network/access controls;
- target database/host cannot be confused with production;
- enough storage is available;
- notification/device workers remain disabled;
- evidence handling excludes personal row contents.

Suggested procedure in the approved environment:

```bash
sha256sum <approved-backup-file>
createdb <isolated_restore_db>
pg_restore --exit-on-error --no-owner --no-privileges --dbname=<isolated_restore_db> <approved-backup-file>
# Point only an isolated API process/session at this database.
# Keep notification/device workers disabled for the drill.
```

Record start/end/duration, checksum, restore exit result, migration consistency, expected table/index/constraint presence, safe aggregate counts, isolated API startup/read result, and absence of outbound side effects.

A pre-deploy backup existing in production is **not** a successful restore drill.

**RPO:** TBD by operational owner.  
**RTO:** TBD by operational owner.

Measured restore duration informs the RTO decision but does not set it automatically.

## Monitoring and incident ownership

Before pilot, name owners for:

- application health;
- database/storage;
- access/auth;
- organization/approval workflow;
- device integration only if included in pilot scope;
- go/no-go, stop, rollback, and escalation decisions.

Minimum monitor set during pilot:

- API/Web/DB health and readiness;
- HTTP error/auth-denial anomalies;
- DB/storage capacity;
- queue/outbox backlog when applicable;
- failed approval resolution;
- audit stream for privileged changes;
- device last-seen/ingress only when attendance device scope is included.

Stop the pilot on privacy/authorization breach, wrong approval routing, unexplained SHADOW/STRUCTURE behavior, repeated critical errors/data-integrity concern, inability to recover service within owner-approved tolerance, or unauthorized device/biometric action.

## Repository/local verification baseline

For a candidate pilot execution SHA containing current `main`, use a clean checkout, the repository/CI Node version, PostgreSQL 16, and disposable loopback databases. Synthetic data only.

```bash
npm ci
npm run migrate:api
npm run migrations:check
npm run migrations:rehearse-recovery
node apps/api/scripts/rehearse-org004-upgrade.mjs
npm run typecheck
npm run lint
npm run test
npm run build
```

Run additional ATT-005 migration rehearsals only when attendance-device work is actually in scope.

For AUTH-011 PostgreSQL coverage, follow `docs/testing/AUTH-011-verification.md` using empty disposable loopback databases. Never point test variables at production.

Repository verification proves the candidate source, not the production runtime.

## AUTH-011 access review

Before real pilot UAT:

- Human Capital selects the actual pilot participants;
- every account/employee must be active as required by the principal type;
- effective role/capability scope is reviewed explicitly;
- organization-scoped HC administration must not be confused with `leave.approve`, governance approval, technical/device permission, or Super Admin;
- no job title, organization label, or account-held organization position grants access by itself;
- no missing permission may be auto-granted merely to complete UAT.

Use `docs/testing/hcis-pilot-uat.md` as the executable test matrix.

## Pilot execution sequence

0. **Execution baseline:** prove the exact deployed pilot SHA and record current rollout state read-only.
1. **Owner decisions:** Human Capital selects one unit, participants, pilot window, real manager/approver/acting mapping, rollback owner, and evidence owner.
2. **Access review:** validate accounts, capabilities/scopes, principal types, and effective dates without auto-granting missing rights.
3. **LEGACY baseline:** prove current accepted routing and immutable snapshots before introducing pilot structure.
4. **DRAFT:** configure only the selected scope using authoritative HC data; validate structure and authority eligibility.
5. **SHADOW:** compare LEGACY vs structural candidates; require zero unexplained mismatch and zero blocking safety gaps.
6. **UAT:** execute positive and negative access/workflow cases; record actual results.
7. **Recovery/monitoring:** complete isolated restore drill and assign monitoring/escalation owners.
8. **Go/no-go:** authorized owner reviews evidence and decides whether STRUCTURE canary may begin.
9. **STRUCTURE canary, only if approved:** activate only the selected workflow/unit/date scope, monitor, and preserve the reviewed LEGACY rollback route.

Do not expand the pilot to other units, biometric collection, payroll calculation, reimbursement, or full WDMS parity without separate scope and approval.

## State-changing actions requiring separate approval

- merge or production deployment;
- create/modify role assignments or accounts;
- create/publish real organization structure;
- create/change LEGACY/SHADOW/STRUCTURE rollout settings;
- restore any backup, even to an isolated target, until environment/data-use approval exists;
- send external notifications;
- request any device command;
- enable biometric collection;
- change production deployment defaults.

## Inputs still needed from operational owner

- pilot unit and participants;
- pilot date window;
- authoritative manager/approver/acting mapping;
- authority/capability approvals;
- whether governance account approval is in scope;
- notification expectations/fallback;
- RPO and RTO;
- isolated restore environment/data-use approval;
- monitoring/escalation owners;
- whether any active attendance-device canary is required;
- exact authorization for each such canary;
- final go/no-go and later deploy/activation approval.

The expected handoff result is evidence sufficient for a human go/no-go decision, not automatic activation.
