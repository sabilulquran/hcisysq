# HCIS Pilot Recovery, Device Boundary, and Codex Local Handoff

**Status:** READY FOR HANDOFF; EXECUTION PENDING  
**Date:** 2026-09-15  
**Baseline main:** `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`

This runbook separates passive/read-only verification from state-changing operations. Creating this document does not complete Task 7 or Task 8.

## ATT-005 boundary for this pilot

ATT-005 remains `IMPLEMENTING`. Repository code includes typed physical operations and safe observability/export surfaces, but repository implementation is not physical-device proof.

The supplied 2026-09-15 VPS audit reports three `attendance_adms_physical_capabilities` rows in state `verified`. Because the audit summary supplied to this package does not identify which capability keys or underlying canary evidence correspond to those rows, this package does not promote any specific ledger row to verified and does not close ATT-005.

### Passive verification — may be performed read-only

Codex Local may, subject to normal VPS read authorization:

- confirm exact deployed SHA/image tags and health/readiness;
- confirm latest migration and `BIOMETRIC_COLLECTION_ENABLED=0`;
- confirm retired USERINFO safety control and that verification requests zero commands;
- inspect device inventory/last-seen, request journal summaries, capability states, operation history, and safe audit/export surfaces;
- confirm Work Code export returns CSV after the fix and excludes `wire_command`/biometric secrets;
- reconcile the count and keys of `verified` capability rows with recorded canary evidence;
- record disk/memory/container observations without treating capacity alone as an incident.

A passive verification must finish with **zero new device commands requested**.

### Active device tests — separate authorization required

Any time sync, duplicate-punch setting, Work Code delivery, message, profile push, enable/disable, reboot, server/NTP config, firmware, biometric query/enrollment/restore/delete, or destructive clear operation is a state-changing hardware test. Run one capability at a time only after an authorized owner approves exact device, capability, expected command, recovery/restore value, test window, and evidence capture.

Biometric collection remains OFF. Do not enable global/per-device biometric gates as part of routine pilot readiness. Active USERINFO reads remain retired. No arbitrary/raw command escape hatch is permitted. Do not expand this package into full WDMS parity closure.

## Isolated restore drill

**Never restore over the active production database.**

Prerequisites: operational owner approves the backup copy/use, isolated PostgreSQL target exists with network/access controls, enough disk is available, target database name/host cannot be confused with production, and evidence handling excludes personal row contents.

Suggested procedure (adapt credentials/paths only in the approved environment):

```bash
sha256sum <approved-backup-file>
createdb <isolated_restore_db>
pg_restore --exit-on-error --no-owner --no-privileges --dbname=<isolated_restore_db> <approved-backup-file>
# Point only an isolated API process/session at this database.
# Keep notification/device workers disabled for the drill.
```

Record start/end/duration; backup checksum; PostgreSQL restore exit result; migration table consistency; expected table/index/constraint presence; safe aggregate row counts (not personal values); ability of an isolated API to start/read representative synthetic or approved non-sensitive records; and absence of outbound notification/device side effects.

**Failure handling:** preserve logs with secrets/PII redacted, stop the isolated app, do not retry against production, classify whether backup corruption/version/storage/config caused the failure, and escalate to operations owner. A failed drill is NO-GO until resolved/repeated successfully.

**RPO:** TBD by operational owner.  
**RTO:** TBD by operational owner.  
Measured drill duration informs RTO discussion but does not set an RTO automatically.

## Monitoring and incident ownership

Before pilot, name owners for application health, database/storage, access/auth, organization/approval workflow, device integration if in scope, and operational decision/escalation. Define who may stop the pilot and who may approve rollback/deployment.

Minimum monitor set during pilot: API/Web/DB health; readiness; HTTP error/auth-denial anomalies; DB/storage capacity; queue/outbox backlog if used; failed approval resolution; audit stream for privileged changes; device last-seen/ingress if attendance device is in pilot. Do not log private payloads merely for observability.

Stop pilot on privacy/authorization breach, wrong approval routing, unexplained STRUCTURE/SHADOW behavior, repeated critical errors/data-integrity concern, inability to restore service within owner-approved tolerance, or unauthorized device/biometric action.

## Codex Local handoff — Task 7

### Repository, branches, commits, PRs

- Canonical repository: `sabilulquran/hcisysq`.
- Baseline main: `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`.
- Bug branch: `fix/hcis-operational-readiness`.
- Bug implementation commit: `ba9732d89c0461baa296579b77c734f5ae4ef1dd`.
- Bug test-correction commit after first CI feedback: `948cbc86f4b81df847465ae713fff10de25066a0`.
- Bug PR: `#55` — Work Code export command lookup.
- Documentation branch: `docs/hcis-operational-readiness`.
- Documentation content head verified by GitHub CI before this metadata-only handoff update: `cae3f3fd921e255cc76f96c53f361e81c26f1906`.
- Documentation PR: `#56` — one-unit operational readiness.
- For execution, always verify `git rev-parse HEAD` against the current PR head because this file itself may add a later documentation-only commit.

### Changed files to inspect

PR #55:

- `apps/api/src/modules/attendance/adms/physical-parity-observability-routes.ts`
- `apps/api/test/adms-physical-parity-observability.test.ts`

PR #56:

- `AGENTS.md`
- `docs/development/ai-assisted-workflow.md`
- `docs/development/github-org-transfer-readiness.md`
- `docs/development/hcis-operational-readiness.md`
- `docs/development/hcis-pilot-recovery-and-handoff.md`
- `docs/development/org004-pilot-unit-validation.md`
- `docs/product/feature-parity.yaml`
- `docs/product/scope.md`
- `docs/testing/hcis-pilot-uat.md`

### Local verification and prerequisites

Use a clean checkout, Node version required by repository/CI, PostgreSQL 16, and empty disposable loopback databases. Synthetic data only.

```bash
npm ci
npm run migrate:api
npm run typecheck
npm run lint
npm run test
npm run build
node apps/api/scripts/rehearse-org004-upgrade.mjs
node apps/api/scripts/rehearse-wave2-upgrade.mjs
node apps/api/scripts/rehearse-wave2-userinfo-upgrade.mjs
node apps/api/scripts/rehearse-wave2-user-correction-upgrade.mjs
```

For AUTH-011 PostgreSQL coverage, reproduce the documented setup in `docs/testing/AUTH-011-verification.md` with two empty loopback databases named `hcis_auth011_test` and `hcis_auth011_permissions_test` (or the exact names enforced by the test), set `DATABASE_URL` and `HCIS_AUTH011_TEST_DATABASE_URL`, migrate, then run the full gates. Do not point these variables at production.

Targeted Work Code regression expectations:

- all migrations apply to a fresh synthetic database;
- export query does not read `attendance_adms_work_code_targets.last_command_id`;
- a synthetic Work Code target with no physical operation exports an empty `last_command_id` rather than SQL error;
- after a synthetic physical Work Code operation/command exists, export reports the latest related command ID;
- unrelated device/work-code operations are not selected;
- route still requires `attendance.devices.export`;
- output contains no wire command or biometric secret fields.

The repository regression in PR #55 is a schema/query contract test. If local tooling permits, add/run a PostgreSQL route-level regression for the two data cases above; do not weaken existing authorization or safety tests.

### VPS read-only verification

After local/CI review and only with authorized VPS access:

```bash
./scripts/verify-vps.sh <EXPECTED_DEPLOYED_SHA>
```

Use the actually deployed approved SHA. Confirm the result records `verification_device_commands_requested=0`. Supplement with read-only SQL/API inspection for rollout mode, capability keys/evidence, backup inventory, health, and safe Work Code export as appropriate. Do not execute active physical routes during this phase.

### State-changing steps — separate approval required

- merge PR;
- deploy/recreate containers or apply a new SHA;
- create/modify role assignments or accounts;
- create/publish organization structure or change LEGACY/SHADOW/STRUCTURE rollout;
- restore a backup, even to isolated DB, until environment/data-use approval exists;
- send external notifications;
- request any device command;
- enable biometric collection.

## Pilot execution handoff — Task 8

1. Human Capital selects one real unit and participants using `org004-pilot-unit-validation.md`; do not derive them from titles/import labels.
2. Authorized operator validates account status, capability/scope, approver and acting assignments without auto-granting missing rights.
3. Configure structure as DRAFT, validate, then run selected-unit SHADOW comparison while LEGACY remains authoritative.
4. Execute `docs/testing/hcis-pilot-uat.md`; record actual results, not planned status.
5. Complete isolated restore drill and monitoring/escalation assignments.
6. Hold go/no-go review. STRUCTURE activation/deployment requires explicit approval after all mandatory gates pass.
7. If approved, activate only the selected workflow/unit/date window, monitor, and preserve rollback route to a reviewed future-effective LEGACY setting.
8. Do not expand the pilot to other units, technical device permissions, biometric collection, payroll engine, reimbursement, or full WDMS parity without separate scope/approval.

## Expected result and rollback

Expected handoff result is evidence sufficient for a human go/no-go decision, not automatic activation. For application regressions, rollback to the previously proven application SHA according to the deployment runbook; database migrations are never automatically rolled back. For ORG-004 routing, operational rollback is an authorized future-effective LEGACY setting while preserving submitted snapshots/history. For restore-drill failure, discard/stop the isolated target and investigate; never compensate by restoring over production.

## Inputs still needed from operational owner

Pilot unit/participants; pilot window; real manager/approver/acting mapping; authority/capability approvals; notification expectations/fallback; RPO; RTO; isolated restore environment/data-use approval; monitoring/escalation owners; whether any active attendance-device canary is required for this pilot; exact authorization for each such canary; final go/no-go and later deploy/activation approval.
