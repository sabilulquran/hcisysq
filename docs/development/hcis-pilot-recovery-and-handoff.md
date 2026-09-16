# HCIS Pilot Recovery, Device Boundary, and Codex Local Handoff

**Status:** READY FOR HANDOFF; EXECUTION PENDING  
**Updated:** 2026-09-16  
**Baseline main/runtime SHA discussed:** `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`

This runbook separates passive/read-only verification from state-changing operations. Creating or updating this document does not complete Task 7 or Task 8.

## Current verified runtime context from Codex Local

Codex Local evidence supplied on 2026-09-16 reports production API/Web running exact-SHA organization-owned images:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
ghcr.io/sabilulquran/hcisysq-web:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
```

ORG-004 code/schema are installed, while no `organization_rollout_settings` row exists, so `LEGACY` remains authoritative by contract. Real structure configuration, SHADOW evidence, STRUCTURE activation, and pilot validation remain pending.

`scripts/deploy-vps.sh` still contains legacy personal-GHCR defaults, but the production GitHub workflow supplies organization-GHCR overrides. Do not infer the current production image source from the script defaults alone. This documentation PR does not modify deployment code/defaults.

## ATT-005 boundary for this pilot

ATT-005 remains `IMPLEMENTING`. Repository code includes typed physical operations and safe observability/export surfaces, but repository implementation is not physical-device proof.

The supplied VPS evidence reports three `attendance_adms_physical_capabilities` rows in state `verified`. Because that count alone does not prove every ATT-005 capability or the underlying canary evidence, this package does not close ATT-005.

### Passive verification — may be performed read-only

Codex Local may, subject to normal VPS read authorization:

- confirm exact deployed SHA/image tags and health/readiness;
- confirm latest migration and `BIOMETRIC_COLLECTION_ENABLED=0`;
- confirm retired USERINFO safety control and that verification requests zero commands;
- inspect device inventory/last-seen, request journal summaries, capability states, operation history, and safe audit/export surfaces;
- confirm Work Code export returns CSV after an approved deployment of PR #55 and excludes `wire_command`/biometric secrets;
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

### Repository, branches, PRs

- Canonical repository: `sabilulquran/hcisysq`.
- Baseline main/runtime SHA discussed: `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`.
- Bug branch: `fix/hcis-operational-readiness`.
- Bug PR: `#55` — Work Code export command lookup.
- PR #55 head after PostgreSQL integration-regression revision: `5bc45868f1378fa207579306aebe62aee6a063a5`.
- Documentation branch: `docs/hcis-operational-readiness`.
- Documentation PR: `#56` — one-unit operational readiness.
- For PR #56, always verify `git rev-parse HEAD` against the current GitHub PR head. This handoff file itself contributes to the final documentation head, so an embedded pre-write SHA would immediately become stale.

### Changed files to inspect

PR #55:

- `apps/api/src/modules/attendance/adms/physical-parity-observability-routes.ts`
- `apps/api/test/adms-physical-parity-observability.test.ts`

PR #56 includes:

- `README.md` and `AGENTS.md`;
- `docs/development/ai-assisted-workflow.md`;
- `docs/development/github-org-transfer-readiness.md`;
- `docs/development/vps-deployment.md`;
- `docs/development/github-vps-production-deployment.md`;
- `docs/development/hcis-operational-readiness.md`;
- `docs/development/hcis-pilot-recovery-and-handoff.md`;
- `docs/development/org004-pilot-unit-validation.md`;
- `docs/domain/dynamic-organization-structure.md`;
- `docs/domain/annual-leave-vertical-slice.md`;
- `docs/domain/leave-policy-ysq.md`;
- `docs/domain/organization-designer-visual-ranking.md`;
- `docs/domain/workflows/approval-engine.md`;
- `docs/product/feature-parity.yaml`;
- `docs/product/scope.md`;
- `docs/testing/hcis-pilot-uat.md`.

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

For AUTH-011 PostgreSQL coverage, reproduce `docs/testing/AUTH-011-verification.md` with the required empty loopback databases and environment variables. Do not point test variables at production.

### Work Code regression — PR #55

Codex Local reported that the implementation passed PostgreSQL 16 semantic verification. PR #55 now also contains a PostgreSQL integration regression that executes the SQL extracted from the actual production route against the migrated test database.

The regression uses synthetic rows inside `BEGIN` and always `ROLLBACK`; it proves:

1. a target with no physical operation returns `NULL last_command_id`;
2. the latest related Work Code physical command is returned;
3. a newer operation for another Work Code is ignored;
4. migrated `attendance_adms_work_code_targets` has no `last_command_id` column;
5. the route still requires `attendance.devices.export` and export safety does not expose wire commands or biometric secret material.

GitHub CI on head `5bc45868f1378fa207579306aebe62aee6a063a5` completed successfully. A later production smoke remains a separate read-only check after an approved merge/deploy; CI success is not deployment evidence.

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
- enable biometric collection;
- change `deploy-vps.sh` GHCR defaults.

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