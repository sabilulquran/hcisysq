# Product Scope

**Status:** ACCEPTED — MVP COMPLETE, POST-MVP OPERATIONAL VALIDATION ACTIVE  
**Updated:** 2026-09-18

## Sequencing principle

HCIS is built through vertical slices rather than by creating every screen first. Each slice must include the relevant UI, API, domain rules, permissions, audit, tests, and minimum operational behavior.

Detailed MVP scope is defined in `docs/product/mvp.md`. Final MVP evidence is frozen in `docs/product/mvp-release-checkpoint.md`. Those documents are historical verification checkpoints; current deployment/pilot readiness is tracked separately in `docs/development/hcis-operational-readiness.md`.

Current production evidence is also separate from the historical MVP checkpoint. Codex Local verification reported on 2026-09-16 records API/Web running exact-SHA `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab` from `ghcr.io/sabilulquran/hcisysq-api` and `ghcr.io/sabilulquran/hcisysq-web`. This does not itself close pilot-readiness gates.

## Verified MVP foundation

The verified MVP foundation includes:

- API/runtime configuration and health checks;
- PostgreSQL local/CI/runtime verification and migration runner;
- employee master + controlled CSV/XLSX import;
- organization unit/position reference data, current reporting line, and Unit Approver foundation;
- identity, session, and account activation foundation;
- role, permission, scope, and policy foundation;
- audit trail;
- notification outbox/intents required by MVP workflows;
- encrypted leave evidence storage adapter;
- logging/deployment/backup runbook foundation.

Production delivery adapters, full legacy cutover, and production security sign-off remain separate gates.

## Employee master — VERIFIED

```text
Start API + PostgreSQL
  -> upload synthetic employee workbook/CSV
  -> preview validation
  -> confirm import
  -> upsert employee by NIP
  -> normalize unit + position references
  -> review import history
```

Employee import remains the upstream source for employee/organization reference data and does not automatically create accounts.

## Leave vertical slices — VERIFIED

The MVP now includes more than the original annual-leave minimum:

```text
Login
  -> employee leave preview/submit
  -> working-day/policy validation
  -> approval chain resolved and snapshotted
  -> line approval where policy requires it
  -> HC notification / validation / actual approval according to policy
  -> attendance resolution when administration leaves unresolved dates
  -> audit + notification intents
```

Synthetic browser UAT verified annual, special, planned, unpaid, and attendance-resolution boundaries.

## Attendance factual foundation — VERIFIED

ATT-001 provides a raw/factual attendance foundation:

- employee self-read;
- Super Admin manual create/update/delete;
- immutable audit history;
- explicit source/provenance;
- Asia/Jakarta business-time handling.

Still post-MVP:

- work schedules/shift;
- lateness tolerance;
- absence inference from missing punch;
- overtime/work-hour calculation;
- GPS/photo/fingerprint production flow;
- payroll consequence.

## Payslip read-only — VERIFIED

The MVP includes read-only payslip data from controlled import. HCIS does not calculate payroll.

```text
Authorized importer
  -> upload CSV
  -> validate
  -> preview/review
  -> commit draft
  -> publish
  -> employee reads own published payslip
```

Import/publish, owner-only read, Board denial, published immutability, audit, and canonical period serialization were verified with synthetic data.

Reimbursement is not part of the completed MVP.

## Foundation Board — VERIFIED

`/board` is an aggregate-first, read-only governance dashboard. Browser UAT verified that Foundation Board cannot cross into employee/admin principal areas and does not receive personal payslip access.

# Immediate post-MVP operational priority: ORG-004 Dynamic Organization Foundation

Before broad employee-account activation or deeper feature expansion, HCIS must operationally validate the implemented and deployed modular, effective-dated organization structure model for a controlled pilot.

Design baseline:

`docs/domain/dynamic-organization-structure.md`

The reason is operational rather than cosmetic: YSQ organization structure may change frequently, and normal restructuring must not require source-code changes or repetitive per-employee approver maintenance.

The accepted target includes:

- visual Organization Designer;
- organizational nodes/teams;
- authority-bearing positions/seats;
- employee membership;
- effective primary and acting incumbencies;
- supervisory and governance relationships;
- explicit authority bindings;
- vacancy policies;
- structural direct-manager resolution;
- employee-level reporting override for real exceptions;
- effective dating and historical/future views;
- draft/validate/preview/publish restructure flow;
- approval-chain preview;
- immutable transaction snapshots after semantic authority resolution.

Key accepted policy decisions:

```text
Leave with line/governance approval:
after the overall request reaches final approved
-> notify one structural layer above the final line/governance approver
```

The notification is informational only. HC validation or later HC actual approval does not automatically redefine the structural oversight target.

Director leave governance:

```text
Director
-> Secretary of the Foundation APPROVES
-> request APPROVED
-> Chair of the Foundation NOTIFIED
```

Pembina/Foundation Supervisor is not notified by this rule.

Supervisory vacancy example:

```text
Director
-> Head of Social Division [VACANT]
-> Social Staff
```

Target direct-manager resolution:

```text
Social Staff -> Director
```

The vacant seat remains in the organization structure; the resolver climbs according to configured vacancy policy.

ORG-004 is the **implemented and deployed software/schema successor** to the verified MVP current-state organization model, but it is not automatically authoritative. The inspected production baseline has no rollout rows, so the contract resolves to `LEGACY`. Real structure configuration, SHADOW evidence, STRUCTURE activation, and production pilot validation remain pending. Migration and deployment must preserve all existing approval snapshots. Rollout remains explicitly controlled through `LEGACY -> SHADOW -> STRUCTURE`.

## Why ORG-004 validation comes before broad real-user approval testing

The completed MVP already proves the technical approval engine with synthetic data. The next important operational proof is that authoritative employee identities can participate in a reviewed organization-driven approval chain without weakening access boundaries.

Activating many employee accounts before one selected unit passes structure, authority, SHADOW, access, restore, and rollback gates would expand risk before the operating model is proven.

Recommended sequence:

```text
MVP COMPLETE
  -> ORG-004 code/schema deployed; LEGACY remains authoritative
  -> Human Capital selects one pilot unit
  -> configure/validate authoritative structure as DRAFT
  -> SHADOW-compare structural resolver with current explicit resolver
  -> positive/negative access UAT
  -> controlled STRUCTURE canary after approval
  -> monitor + rollback readiness
  -> only then consider broader activation
```

## Other post-MVP target modules

The longer-term HCIS product direction was explicitly accepted on 2026-09-18 and is mapped in `docs/product/hcis-capability-map.md`. Inclusion there means the capability belongs to HCIS product scope; it does not mean implementation, production readiness, or a release date.

After organization/pilot readiness is stable, target modules include:

- work schedules, shifts, holidays, and shift exchange;
- mobile clock in/out with policy-controlled GPS/geotagging, photo evidence, and face-recognition capability;
- schedule-aware attendance evaluation including lateness and overtime;
- reimbursement;
- payroll calculation, review, reconciliation, finalization, statutory semantics, and payslip publication beyond opaque imported lines;
- employee loan and installments;
- performance review and KPI;
- training/LMS and learning records;
- employment certificates, warning letters, and broader employee document services;
- business/official travel;
- employee-assigned asset handover and return;
- desk/workplace booking;
- organization sites, branches, and work locations within one YSQ organization;
- richer organization/academic calendar management;
- announcement, reminder, production email, and WhatsApp notification adapters;
- employee data change request;
- recruitment/careers;
- additional role-aware/governance reporting;
- full legacy-data migration/cutover.

The employee/admin UI may expose these accepted future capabilities as clearly marked Coming Soon surfaces before backend implementation. Such placeholders must not fabricate operational data, permissions, or release dates.

## Outside initial scope

- separate native mobile application;
- general internal real-time chat;
- full general ledger/accounting;
- vendor-specific biometric device management without an adapter boundary;
- separate data warehouse;
- commercial multi-tenancy.

# Release gates

## Foundation ready — PASS

- API and PostgreSQL run in clean/local verification environments.
- Clean migration and realistic upgrade path passed.
- Employee import has automated synthetic verification.
- Identity, permission, scope, audit, and environment configuration have tests.
- Lint, typecheck, tests, and build passed at the verified MVP checkpoint.

## MVP ready — PASS

- Leave vertical slices passed synthetic end-to-end browser UAT.
- Approval snapshot and role/scope boundaries were verified.
- Attendance factual mutation + audit passed synthetic UAT.
- Payslip import/publish/read-only access passed synthetic UAT.
- Foundation Board read-only boundary passed browser UAT.
- Cross-principal authorization passed browser UAT.
- Final verified application SHA is recorded in `docs/product/mvp-release-checkpoint.md`.

## Organization foundation ready — CODE/SCHEMA DEPLOYED; OPERATIONAL VALIDATION PENDING

Repository main contains the ORG-004 data model, resolver, Organization Designer, draft/validate/impact/publish lifecycle, controlled rollout, Leave consumption, and post-approval oversight intent with synthetic automated coverage.

Codex Local audit evidence reports that the inspected production runtime is on SHA `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`, required schema is installed, and `organization_rollout_settings` contains zero rows. By contract, absence of rollout configuration means `LEGACY`. This is evidence of deployed software/schema with the safe rollout mode, **not** evidence that the real YSQ structure is configured, SHADOW-comparable, STRUCTURE-active, or pilot-validated.

Before structure-driven approval is activated for real pilot users:

- Human Capital explicitly selects one pilot unit and participants from authoritative data;
- current structure is represented as nodes/positions/memberships/incumbencies without inferring authority from job titles;
- acting and vacancy behavior remain covered by automated tests and are reviewed if used by the pilot;
- organization cycles and invalid effective-date overlaps are rejected;
- Organization Designer validates the selected DRAFT and approval-chain preview;
- SHADOW resolution compares ORG-004 results with current explicit mapping;
- Director governance and one-level-above oversight rules are tested only when relevant to the pilot scope;
- structure-derived authority remains constrained by backend RBAC;
- selected real configuration and access are reviewed before STRUCTURE activation.

The phased operational gate is documented in `docs/development/org004-operational-validation.md` and the one-unit decision form in `docs/development/org004-pilot-unit-validation.md`.

## Pilot ready — PENDING

MVP complete and deployed ORG-004 code do not automatically mean Pilot Ready. Before pilot:

- select one unit/persona set and document the data-use boundary;
- validate manager, approver, acting authority, role/scope, and calendar for that pilot;
- complete LEGACY baseline and SHADOW comparison with zero unexplained mismatch;
- execute positive/negative access UAT from `docs/testing/hcis-pilot-uat.md`;
- perform a backup **and isolated restore drill**, not only backup creation;
- assign minimum observability, incident, stop, and rollback ownership;
- keep biometric collection OFF unless separately approved;
- separate passive device verification from any explicitly approved active hardware canary;
- decide whether password recovery and production notification delivery are required for the selected pilot population or whether documented administrative/manual fallback is acceptable;
- record a human go/no-go decision before STRUCTURE activation/deployment changes.

## Production ready — PENDING

Production application delivery is active, but full HCIS production-readiness/cutover remains broader than “application currently running.” The following remain separate gates:

- legacy-data migration/cutover rehearsal succeeds and reconciles;
- security review is complete;
- production operational ownership remains current;
- legacy freeze/cutover plan is approved;
- rollback/data-recovery procedure is tested, including isolated restore drill;
- old system remains read-only during the agreed verification period when full cutover occurs;
- broader production go-live/cutover is approved by the authorized operational owner.