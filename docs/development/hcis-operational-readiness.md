# HCIS Operational Readiness — One-Unit Pilot

**Status:** REVIEW-READY REPOSITORY PACKAGE; PILOT NOT AUTHORIZED
**Updated:** 2026-09-19
**Specifications:** ORG-004, AUTH-011, ATT-005
**Repository baseline:** canonical `main`; **latest verified production application SHA:** `66da50cbd2a12f6099a59adbda28b657863e8e40`

This document is the current operational status note for the one-unit pilot. Historical MVP checkpoints remain valid evidence for what was verified at those checkpoints; they are not automatically proof of current production or pilot state.

## Evidence classes

Use these labels consistently:

- **Repository fact:** directly observed in the GitHub repository/CI during this package.
- **Codex Local evidence:** environment/VPS/PostgreSQL verification reported by Codex Local on 2026-09-15 or 2026-09-16; this GitHub-only agent did not independently access the VPS/local machine.
- **Operator-supplied production evidence:** authorized production/browser verification supplied on 2026-09-18 after the exact-SHA deployment; GitHub-observed workflow state is recorded separately.
- **Unverified/TBD:** requires local, VPS, hardware, user, or operational-owner evidence not yet supplied.

## Executive status

| Category | Current state | Evidence / closure requirement |
| --- | --- | --- |
| Selesai terverifikasi | MVP checkpoint remains historically verified; repository transfer to `sabilulquran/hcisysq` is observed; AUTH-011 has recorded synthetic verification from 2026-09-07; exact SHA `66da50c...` was published and deployed through the production workflow with preflight, deploy/verify, exact runtime images, and health/readiness PASS. | Keep historical and current evidence dated separately. Deployment/runtime acceptance is recorded independently from optional pilot/UAT work. |
| Implemented but not yet operationally verified | ORG-004 code/schema are deployed; AUTH-011 production-style role model exists; ATT-005 software capabilities exist. | Real ORG-004 structure, SHADOW, STRUCTURE activation, real pilot UAT, and physical-device evidence remain separate gates. |
| Belum aktif | ORG-004 resolver rollout for the pilot remains `LEGACY` according to Codex Local evidence because `organization_rollout_settings` had zero rows; real pilot users/unit are not selected; biometric collection remains OFF. | HC selection + reviewed configuration + SHADOW gates + explicit STRUCTURE activation approval. |
| Bug / fix evidence | The Work Code export defect was repaired in merged PR #55 and the fix is an ancestor of the verified `66da50c...` production baseline. | Route-specific passive smoke may be run only when operationally useful; it is not required to consider the current application deployment healthy. |
| Keputusan masih diperlukan | Pilot unit/participants; real manager/approver/acting authority; operator roles; RPO/RTO; restore-drill environment/data approval; notification/recovery expectations; whether/which active device canaries are required. | Decision owner must record approval and evidence; repository must not guess. |

## Reconciliation of project documents

### MVP and scope

`docs/product/mvp.md` and `docs/product/mvp-release-checkpoint.md` remain historical acceptance evidence. They are intentionally not rewritten to imply later production validation.

Current distinction:

```text
structure records exist != Human Capital acceptance complete != SHADOW validated != STRUCTURE activated != production pilot accepted
```

Latest supplied read-only evidence states ORG-004 schema and organization records/revisions exist, while rollout configuration is absent and therefore workflow behavior remains `LEGACY`. Repository source recovery is required because four production-recorded migration filenames were missing from canonical main.

### ORG-004 domain documentation

Current-state wording in `dynamic-organization-structure.md`, Annual Leave, leave policy, Organization Designer visual ranking, and approval-engine documentation is reconciled by this PR. Historical MVP/design checkpoints remain visible, but “implemented locally/not deployed” is no longer a current-state claim.

ORG-004 status for operational decisions is:

- code/schema: deployed at the inspected production baseline;
- structure records/published revisions: present; latest inspected published revision stored validation is valid;
- Human Capital acceptance of the real structure: not proven;
- selected-unit SHADOW comparison: pending;
- STRUCTURE activation: pending explicit approval;
- production pilot validation: pending.

### Feature parity

`docs/product/feature-parity.yaml` records ORG-004 as `implemented`, not `verified`. Real structure selection, SHADOW comparison, access review, STRUCTURE activation, and pilot UAT remain operational gates.

ATT-005 remains `implementing`. Codex Local reported three rows in `attendance_adms_physical_capabilities` with state `verified`, but that alone does not close all ATT-005 capabilities or physical parity.

### AUTH-011

The accepted AUTH-011 contract and its 2026-09-07 synthetic verification remain the basis for pilot access boundaries. No real `human_capital_admin` assignment or pilot UAT is inferred. HC administration does not imply leave approval, approval-policy management, or technical attendance-device permissions.

### Repository transfer and production GHCR

GitHub inspection observed `sabilulquran/hcisysq` as canonical and the old `imadjinasi/hcisysq` endpoint redirecting.

The latest verified production release checkpoint is the 2026-09-19 Asia/Jakarta deployment of exact-SHA organization images:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-66da50cbd2a12f6099a59adbda28b657863e8e40
ghcr.io/sabilulquran/hcisysq-web:sha-66da50cbd2a12f6099a59adbda28b657863e8e40
```

Publisher run `35381914922` completed successfully for API and Web. Production run `35382026318` completed Production preflight and Deploy and verify successfully. GitHub Actions logs record exact runtime images, PostgreSQL/API/Web healthy, health/readiness PASS, pre-deploy backup creation, retired USERINFO safety control present, and `DEPLOY SUCCESS`. See `production-release-verification-2026-09-19.md`.

The earlier `acd22b...` release remains a dated historical checkpoint in `production-release-verification-2026-09-18.md`.

`scripts/deploy-vps.sh` still contains legacy `ghcr.io/imadjinasi/...` defaults, while the production GitHub workflow supplies `HCIS_GHCR_API_REPO` / `HCIS_GHCR_WEB_REPO` organization overrides. Therefore the default script text is **not** evidence that production still runs personal-namespace images. This PR documents the distinction only; changing deployment defaults is deliberately left to a separate reviewed code/deployment PR if desired.

## Work package and ownership

| Work | Status | Primary role owner | Dependencies | Closing evidence |
| --- | --- | --- | --- | --- |
| Operational status consolidation | Repository-ready after CI | Product/HCIS owner | Review of dated evidence | Approved status note, no contradictory current-state claims used for go/no-go |
| Select one pilot unit and participants | Waiting operational owner | Human Capital | Authoritative organization data | Recorded pilot roster and role mapping outside repo; no guessed structure |
| ORG-004 configuration validation | Ready to execute | Human Capital + authorized HCIS operator | Pilot selection, active accounts/capabilities | DRAFT validation + SHADOW evidence + zero unexplained mismatch |
| Access/UAT review | Ready to execute | Human Capital + security/reviewer | Synthetic fixtures; later real pilot sessions | Positive + negative matrix with audit evidence |
| Work Code export defect | Merged and included in verified production baseline | HCIS engineer/reviewer | PR #55 merged; production `66da50c...` verified | Repository regression remains the source proof; route-specific passive smoke is optional when operationally useful |
| ATT-005 pilot boundary | Partially evidenced | Technical device operator + HC owner | Approved device/canary scope | Passive evidence first; each active command separately approved and recorded |
| Backup/restore readiness | Not proven | Operations owner | Isolated DB/host + approved backup handling | Successful isolated restore drill, integrity/app checks, measured duration |
| Pilot go/no-go | Waiting decision | Operational owner | All mandatory gates | Recorded go/no-go decision; rollback owner and trigger confirmed |

## Production release evidence

Latest checkpoint: [`production-release-verification-2026-09-19.md`](production-release-verification-2026-09-19.md). Application SHA `66da50cbd2a12f6099a59adbda28b657863e8e40` is closed for deployment/runtime acceptance based on GitHub-observed exact-SHA publication, production preflight, deploy/verify, runtime image, health/readiness, and backup evidence.

Historical checkpoint: [`production-release-verification-2026-09-18.md`](production-release-verification-2026-09-18.md) for `acd22b438a7468dc6ea53ae001980cd06f7343cd`, including the previously supplied browser acceptance evidence.

The `66da50c...` deployment includes the canonical migration-history recovery and source/schema reconciliation merged through PR #59/#60. Deployment does not by itself create or change ORG-004 rollout settings, account/role assignments, biometric gates, or device commands.

## Codex Local evidence — 2026-09-15/16

Reported environment evidence includes:

- production API, Web, PostgreSQL healthy at application SHA `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`;
- current API/Web images are exact-SHA images from `ghcr.io/sabilulquran/...`;
- `/healthz`, `/api/health`, `/api/ready` succeeded and `/login` returned 200 in the earlier audit;
- migration 0045 applied;
- zero `organization_rollout_settings` rows, therefore `LEGACY` by contract;
- production `schema_migrations` records four organization/employee/Leave migrations that were missing from canonical source and are recovered by `docs/development/migration-source-of-truth-recovery.md`;
- organization structure records and published revisions exist; supplied aggregate evidence reports 25 change sets (15 PUBLISHED, 7 DRAFT, 3 VALIDATED) and a latest inspected published revision with valid stored validation and zero issues; these aggregates contain no employee identity data;
- ORG-004 code/schema installed but real structure/SHADOW/STRUCTURE/pilot validation not proven;
- three physical-capability records had state `verified`, insufficient to close ATT-005 as a whole;
- `BIOMETRIC_COLLECTION_ENABLED=0`;
- deployment backups existed through the earlier audit, but routine schedule and successful restore drill were not proven;
- PostgreSQL 16 semantic verification for the PR #55 Work Code export implementation passed;
- approximate 2 GB RAM, swap use, disk use and shared-host observations remain capacity observations, not incident proof.

These statements remain attributed Codex Local evidence; repository CI evidence is reported separately from GitHub runs.

## Pilot go/no-go minimum

**GO requires all mandatory items:** reviewed pilot roster; ORG-004 DRAFT validation; SHADOW zero unexplained mismatch; intended approvers eligible; AUTH-011 positive/negative UAT; Work Code export regression closed if that export is in pilot scope; isolated restore drill passed; health/monitoring owner and escalation path assigned; biometric collection OFF unless separately approved; no active device command bundled into passive verification; rollback trigger/owner agreed.

**NO-GO / STOP:** unknown approver or authority, cross-unit/privacy leak, unauthorized capability, unexplained SHADOW mismatch, mutable historical approval snapshot, failed restore/integrity check, inability to identify rollback owner, production change required merely to complete a test, or any biometric/device action lacking explicit authorization.

RPO and RTO are **TBD — operational-owner decision**. Do not infer them from backup frequency or observed restore duration.