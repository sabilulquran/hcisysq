> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# ATT-005 — Accelerated WDMS Implementation Plan

**Status:** ACCEPTED  
**Specification:** ATT-005  
**Parent specification:** `docs/domain/attendance-wdms-device-parity.md`  
**Updated:** 2026-08-28

## Decision

HCIS will pursue WDMS-compatible fingerprint-device parity using a small number of large, integrated delivery waves rather than serializing the work into many tiny feature slices.

This document supersedes the earlier ATT-005A..G delivery sequencing as an execution plan. The A..G labels may still be used as capability groups, but they are not mandatory merge boundaries.

The goal is faster delivery without weakening the repository quality gates in `AGENTS.md`, `docs/development/ai-assisted-workflow.md`, `docs/security/security-baseline.md`, and `docs/testing/definition-of-done.md`.

## Why the delivery model changes

The WDMS device surface is highly coupled at the transport and device-state level:

- device health depends on ingress activity;
- command delivery depends on `/iclock/getrequest`;
- command completion depends on `/iclock/devicecmd`;
- historical transaction recovery depends on the command engine;
- roster and biometric synchronization depend on the same command transport;
- the Admin UI depends on the same device capability, command, sync and audit models.

Implementing each capability as a separate tiny PR would repeatedly touch the same schema, routes, repository functions and Admin UI, increasing integration overhead and slowing hardware validation.

The preferred model is therefore: parallel implementation lanes inside one coordinated feature wave, one coherent migration/API/UI contract per wave, one CI verification loop, then one controlled production canary.

## Reference hierarchy

For device-management behavior, use this order:

1. ZKBio WDMS behavior and user-facing capability model;
2. ZKTeco PUSH protocol documentation for wire-level commands and payloads;
3. observations from physical HCIS production devices;
4. independent compatible implementations as secondary evidence;
5. RuangHadir only as implementation history/reference, not protocol authority.

Do not invent undocumented remote commands. Unsupported or unproven commands remain capability-disabled.

## Fixed domain boundaries

The accelerated plan does not relax these boundaries:

- HCIS Employee is the canonical employee identity/master;
- HCIS Organization is the canonical organization model;
- fingerprint devices are operational replicas/endpoints, not employee sources of truth;
- HCIS Biometric Credential Vault is the managed master copy for supported biometric credentials;
- `attendance_adms_events` remains raw device evidence;
- `attendance_daily_records` remains factual punch/correction presentation only;
- no device-management path may infer late, absence, overtime, working hours, leave conversion, payroll deduction or attendance-resolution outcome;
- manual attendance must never be overwritten by fingerprint integration;
- raw attendance evidence is not deleted by device maintenance;
- device-side biometric deletion and HCIS-vault deletion are separate explicit operations.

## Delivery topology

Implementation is grouped into three large waves.

Each wave may be built by parallel agents/worktrees, but all lanes must integrate against one named specification and one shared schema/API model before merge.

### Wave 1 — WDMS Core Device Plane

**Outcome:** HCIS becomes operationally reliable for machine connectivity, commands and attendance transaction recovery.

This wave combines the previous health, command and transaction-recovery slices.

Scope:

- automatic unknown-device detection into `detected` / `claim_pending`;
- manual claim/activation and lifecycle management;
- online/offline state distinct from lifecycle;
- configurable connectivity threshold and Admin auto-refresh;
- model, firmware, Push version, source IP and device counters where available;
- last activity, last successful request, last sync and last command activity;
- heartbeat/transfer policy metadata and supported configuration;
- durable command queue;
- stable numeric/device command ID allocation;
- `/iclock/getrequest` command delivery with vendor-compatible idle `OK`;
- `/iclock/devicecmd` result ingestion;
- command states: pending, delivered, acknowledged, succeeded, failed, expired, cancelled;
- command retry rules only for explicitly safe/idempotent commands;
- Read Information / INFO-style capability discovery where supported;
- immediate transaction check/sync command where supported;
- Upload Transaction — all transactions;
- Upload Transaction — bounded start/end range;
- reconnect/backlog recovery;
- automatic cursor recovery from durable acknowledged history where safe;
- registration-after-capture recovery for durable unknown-device ATTLOG;
- transaction-count verification/reconciliation where supported;
- periodic bounded reconciliation mechanism;
- exact raw-event deduplication;
- transaction table and upload/command diagnostics;
- command log, upload log and immutable Admin audit;
- Admin UI for Overview, Transactions, Data Transfer, Commands and Logs;
- safe empty/error/offline states.

Wave 1 is the first production priority because it removes dependence on perfect realtime ATTLOG delivery.

### Wave 2 — Personnel, Roster and Biometric Control Plane

**Outcome:** HCIS becomes the source of operational device roster and managed biometric backup/restore, replacing WDMS personnel/device-sync functions without duplicating the HCIS employee master.

Scope:

- device roster inventory;
- upload/reconcile user records from devices;
- explicit PIN assignment/mapping to `employees.id`;
- leading-zero PIN preservation;
- roster conflicts and preview before write;
- selected employee -> selected device synchronization;
- employee name, card, privilege and verify-mode metadata where supported;
- inactive/resigned employee handling;
- roster removal from selected devices;
- encrypted biometric credential vault;
- supported credential classes: fingerprint, face, palm, bio-photo and related vendor metadata;
- opaque/lossless vendor credential payload storage;
- modality, slot/finger index, format/version, origin device, source PIN, integrity hash and provenance;
- import biometric credentials from device;
- associate imported credentials to canonical HCIS Employee;
- inventory comparison between HCIS vault and each device;
- backup and restore after device reset/replacement;
- compatible cross-device distribution;
- per-device credential sync state;
- missing/stale/conflict detection;
- remote enrollment where the physical model/protocol proves support;
- retrieval of newly enrolled credential into HCIS vault where supported;
- device-side credential delete without deleting HCIS master;
- separate explicit HCIS master-credential deletion lifecycle;
- attendance-photo / bio-photo handling where supported, with restricted access and retention policy;
- Work Code distribution where supported;
- Admin UI for Device Roster and Biometrics.

Biometric implementation must not perform biometric matching, reverse engineer minutiae, or convert incompatible vendor template formats.

### Wave 3 — Full WDMS Operations and Maintenance

**Outcome:** Admin HCIS covers the remaining relevant WDMS operational surface.

Scope where device capability is proven:

- public/private device messages;
- duplicate-punch-period configuration;
- device time/timezone synchronization;
- selected safe configuration read/write;
- reboot;
- firmware version inspection;
- guarded firmware upgrade with model/package preflight;
- offline transaction import fallback;
- device error/operation logs;
- exports and saved operational filters;
- retention controls for operational logs and sensitive device media;
- clear pending commands;
- break-glass clear attendance on device;
- break-glass clear attendance-photo/cache on device;
- break-glass selected biometric deletion on device;
- break-glass clear all device data;
- capability-driven UI hiding/disablement;
- audit completeness and recovery documentation.

Destructive operations never delete HCIS raw attendance evidence or silently delete HCIS biometric master copies.

## Parallel execution lanes

To reduce calendar time, implementation work should be parallelized by technical boundary rather than serialized by UI feature.

### Lane P — Protocol, command and device adapter

Owns:

- PUSH wire compatibility;
- command serialization/parsing;
- `/iclock/getrequest`;
- `/iclock/devicecmd`;
- ATTLOG/user/biometric payload ingestion adapters;
- device capability parsing;
- device-specific compatibility tests.

### Lane D — Database, domain state and reconciliation

Owns:

- migrations;
- command state machine;
- device health projection;
- reconciliation jobs/services;
- roster state;
- biometric credential metadata and encrypted payload persistence;
- audit and retention model;
- idempotency/concurrency.

### Lane U — Admin API and Web UI

Owns:

- Admin API contracts;
- Overview/Transactions/Data Transfer/Commands/Roster/Biometrics/Logs/Maintenance surfaces;
- loading/error/offline states;
- capability-driven actions;
- destructive confirmations;
- no raw biometric payload exposure.

### Lane Q — Verification, security and integration

Owns:

- protocol fixtures with synthetic data;
- migration tests;
- authorization negative tests;
- command retry/idempotency tests;
- biometric encryption/log-redaction tests;
- browser smoke tests;
- production-canary checklist;
- rollback/recovery notes.

The lanes may commit independently to working branches, but no lane may redesign the accepted ATT-005 domain model in isolation.

## Merge strategy

Prefer one implementation PR per large wave, not one PR per button or command.

A wave PR may be large if all of the following remain true:

- one specification/outcome;
- no unrelated refactor;
- schema and API changes are coherent;
- tests cover the integrated state transitions;
- rollback/recovery is documented;
- sensitive-data controls are reviewed;
- the PR can be reverted as one product capability wave.

Do not split merely to reduce line count when the split would require temporary incompatible schemas or duplicate implementation work.

Do split when a change introduces an independent security boundary, destructive migration, or unrelated product concern.

## Database and migration strategy

Prefer additive migrations.

Wave migrations must:

- preserve existing ATT-002/ATT-003/ATT-004 tables and provenance;
- avoid rewriting immutable raw attendance evidence;
- use explicit foreign keys to existing HCIS Employee/device IDs;
- provide deterministic unique/idempotency constraints for command and credential synchronization;
- separate searchable biometric metadata from encrypted opaque payload;
- include upgrade-path tests from the current production schema;
- include recovery notes before merge.

Do not require destructive migration merely to match WDMS naming.

## API strategy

The Admin API should become capability-oriented while preserving existing endpoints during migration where practical.

Expected resource groups include:

- devices and detected devices;
- device health/capabilities;
- transactions;
- mappings and roster;
- commands and command results;
- data-transfer/reconciliation operations;
- biometric credential metadata/inventory/sync operations;
- logs;
- maintenance actions.

Raw biometric payloads are never returned from normal list/detail APIs.

Changes to HTTP contracts must update `docs/api/openapi.yaml` in the same implementation wave.

## Security strategy for biometrics

Biometric material is Restricted/credential-grade sensitive data even though the current generic security baseline does not yet name it explicitly.

Before Wave 2 production enablement, implementation must define and test:

- application-level encryption-at-rest for biometric payloads;
- deployment secret/key ownership and rotation procedure;
- encrypted backup behavior;
- access control for biometric operations;
- log/error redaction;
- retention and employee-exit deletion rules;
- device-copy vs HCIS-master deletion semantics;
- audit events for import, enrollment, restore, distribution, delete and exceptional export;
- restore drill using synthetic/non-production credential fixtures.

Production biometric payloads must never be used in development fixtures, prompts, screenshots or CI.

## Production strategy

There is no separate ADMS staging ingress for the physical fingerprint fleet. Production hardware validation remains a controlled canary after CI/local verification.

For each wave:

1. merge only after CI and required local/integration verification;
2. production deployment requires explicit human approval;
3. deploy a pinned merge commit, not an arbitrary working branch;
4. migrate first with a documented recovery path;
5. validate API health and machine polling;
6. exercise one bounded canary operation;
7. inspect durable request/command/audit evidence;
8. only then enable broader actions/devices.

Wave 1 canary must validate at minimum:

- idle `/iclock/getrequest` protocol response;
- online/offline transition;
- one durable command delivery/result;
- one historical/ranged transaction request;
- ATTLOG dedup after retransmission;
- recovered raw event -> mapped employee projection without overwriting manual attendance.

Wave 2 canary must use explicitly approved test credentials/employee flow and must not bulk-copy all production biometrics on first enablement.

## Definition of ready for implementation

Implementation may begin when:

- this plan and the parent ATT-005 parity spec are merged to `main`;
- the current production baseline SHA is known;
- the Wave 1 schema/API ownership is agreed;
- protocol commands used in Wave 1 have vendor documentation or observed proof;
- no open requirement blocks online/offline, command state or transaction recovery semantics.

Biometric code may be developed before final retention policy is approved, but production biometric collection must remain disabled until the required security/retention decision is documented.

## Definition of done per wave

A wave is not complete until:

- migrations run on clean and upgrade-path databases;
- typecheck, lint, tests and build pass;
- authorization negative tests pass;
- command/retry/idempotency behavior is tested;
- UI loading/error/empty/offline states are tested;
- audit events exist for sensitive transitions;
- OpenAPI is synchronized;
- rollback/recovery notes exist;
- production canary evidence is recorded when the wave is deployed;
- no regression violates ATT-001/ATT-002/ATT-003/ATT-004 attendance invariants.

## Immediate execution order

After this documentation is merged:

1. implement Wave 1 as the immediate priority;
2. begin Wave 2 schema/security groundwork in parallel once the Wave 1 command/data model is stable enough to reuse;
3. start Wave 3 protocol research in parallel, but do not block Wave 1/2 on optional device capabilities;
4. avoid cosmetic refactors until WDMS parity is operationally usable.

The objective is rapid WDMS parity through parallel engineering and integrated verification, not artificially small merge units.