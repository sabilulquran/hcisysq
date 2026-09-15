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
- confirm retired USERINFO safety trigger/control and that verification requests zero commands;
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

Suggested procedure (adapt credentials/paths only in the approved local/VPS environment):

```bash
# 1. Record source backup filename, timestamp and checksum without exposing data.
sha256sum <approved-backup-file>

# 2. Create a NEW isolated database/cluster. Never reuse the active HCIS database.
createdb <isolated_restore_db>

# 3. Restore custom-format backup to the isolated target.
pg_restore --exit-on-error --no-owner --no-privileges --dbname=<isolated_restore_db> <approved-backup-file>

# 4. Point an isolated API process/session only at the restored database.
# Do not reuse production secrets unnecessarily and do not start external notification/device workers.

# 5. Run migration/integrity/application read checks appropriate to the isolated environment.
```

Record start/end/duration; backup checksum; PostgreSQL restore exit result; migration table consistency; expected table/index/constraint presence; safe aggregate row counts (not personal values); ability of isolated API to start/read representative synthetic or approved non-sensitive records; and absence of outbound notification/device side effects.

**Failure handling:** preserve logs with secrets/PII redacted, stop the isolated app, do not retry against production, classify whether backup corruption/version/storage/config caused the failure, and escalate to operations owner. A failed drill is NO-GO until resolved/repeated successfully.

**RPO:** TBD by operational owner.  
**RTO:** TBD by operational owner.  
Measured drill duration informs RTO discussion but does not set an RTO automatically.

## Monitoring and incident ownership

Before pilot, name owners for: application health, database/storage, access/auth, organization/approval workflow, device integration if in scope, and operational decision/escalation. Define who may stop the pilot and who may approve rollback/deployment.

Minimum monitor set during pilot: API/Web/DB health; readiness; HTTP error/auth-denial anomalies; DB/storage capacity; queue/outbox backlog if used; failed approval resolution; audit stream for privileged changes; device last-seen/ingress if attendance device is in pilot. Do not log private payloads merely for observability.

Stop pilot on privacy/authorization breach, wrong approval routing, unexplained STRUCTURE/SHADOW behavior, repeated critical errors/data-integrity concern, inability to restore service within owner-approved tolerance, or unauthorized device/biometric action.

## Codex Local handoff — Task 7

### Repositories / branches / PRs

- Canonical repository: `sabilulquran/hcisysq`.
- Baseline main: `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`.
- Bug branch: `fix/hcis-operational-readiness`.
- Bug commit: `ba9732d89c0461baa296579b77c734f5ae4ef1dd`.
- Bug PR: `#55` — Work Code export command lookup.
- Documentation branch: `docs/hcis-operational-readiness`.
- Documentation PR/head: use the current head shown by GitHub when checking out this handoff; do not assume this document's baseline SHA is the PR head.

### Changed areas to inspect

Bug PR: `apps/api/src/modules/attendance/adms/physical-parity-observability-routes.ts`, `apps/api/test/adms-physical-parity-observability.test.ts`.

Documentation PR: `AGENTS.md`, AI workflow/transfer notes, this operational-status package, ORG-004 pilot form, and UAT plan.

### Local verification commands

Use a clean checkout and synthetic disposable PostgreSQL databases. Follow package scripts rather than inventing weaker gates:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

For migration/integration gates, follow `docs/testing/AUTH-011-verification.md`, ORG-004 runbook, and repository scripts. Use empty disposable loopback databases; never use a production dump as a general development fixture.

Targeted Work Code regression expectations:

- all migrations apply to a fresh synthetic database;
- export query no longer references `attendance_adms_work_code_targets.last_command_id`;
- a synthetic Work Code target with no physical operation exports an empty `last_command_id` rather than erroring;
- after a synthetic physical Work Code operation/command is present, export reports that latest related command ID;
- an unrelated device/work-code operation is not selected;
- route still requires `attendance.devices.export`;
- output contains no wire command or biometric secret fields.

If repository integration tooling makes it practical, add/execute a real PostgreSQL route test rather than relying only on the static regression test; do not weaken existing tests to make the branch pass.

### VPS read-only verification

After local/CI review and only with authorized VPS access:

```bash
./scripts/verify-vps.sh <EXPECTED_MAIN_SHA>
```

Use it only for the actually deployed approved SHA. Confirm its result records `verification_device_commands_requested=0`. Supplement with read-only SQL/API inspection for rollout mode, capability keys/evidence, backup inventory, health, and safe Work Code export as appropriate. Do not execute active physical routes during this phase.

### State-changing steps — require separate approval

- merge PR;
- deploy/recreate application containers or apply a new application SHA;
- create/modify role assignments or accounts;
- create/publish organization structure or change LEGACY/SHADOW/STRUCTURE rollout;
- restore a backup (even to isolated DB) until environment/data-use approval exists;
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
