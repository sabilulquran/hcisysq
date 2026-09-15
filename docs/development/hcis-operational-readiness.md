# HCIS Operational Readiness — One-Unit Pilot

**Status:** REVIEW-READY REPOSITORY PACKAGE; PILOT NOT AUTHORIZED  
**Date:** 2026-09-15  
**Specifications:** ORG-004, AUTH-011, ATT-005  
**Repository baseline inspected:** `sabilulquran/hcisysq@9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`

This document is the current operational status note for the one-unit pilot. Historical MVP checkpoints remain valid evidence for what was verified at those checkpoints; they are not automatically proof of current production state.

## Evidence classes

Use these labels consistently:

- **Repository fact:** directly observed in the GitHub repository during this package.
- **Supplied VPS audit:** evidence reported by Codex Local on 2026-09-15; this agent did not independently access the VPS.
- **Unverified/TBD:** requires local, CI, VPS, hardware, or operational-owner evidence.

## Executive status

| Category | Current state | Evidence / closure requirement |
| --- | --- | --- |
| Selesai terverifikasi | MVP checkpoint remains historically verified; repository transfer to `sabilulquran/hcisysq` is observed; AUTH-011 has recorded synthetic verification from 2026-09-07. | MVP checkpoint + repository inspection + `docs/testing/AUTH-011-verification.md`. Do not reinterpret historical tests as a rerun for this package. |
| Implemented but not yet operationally verified | ORG-004 implementation; AUTH-011 production-style role model; ATT-005 software capabilities; Work Code export fix in separate PR. | Require current CI/local verification plus pilot/VPS evidence below. |
| Belum aktif | ORG-004 resolver rollout for pilot remains `LEGACY` according to supplied VPS audit because `organization_rollout_settings` had zero rows; real pilot users/unit not selected; biometric collection remains OFF. | HC selection + reviewed configuration + SHADOW gates + explicit activation approval. |
| Bug | Main baseline contains Work Code export SQL referencing nonexistent `attendance_adms_work_code_targets.last_command_id`. | Fixed in separate code PR; close only after CI + synthetic PostgreSQL export regression + later read-only smoke. |
| Keputusan masih diperlukan | Pilot unit/participants; real manager/approver/acting authority; operator roles; RPO/RTO; restore-drill environment/data approval; notification/recovery expectations; whether/which active device canaries are required. | Decision owner must record approval and evidence; repository must not guess. |

## Reconciliation of project documents

### MVP and scope

`docs/product/mvp.md` and `docs/product/mvp-release-checkpoint.md` remain historical acceptance evidence. They are intentionally not rewritten to imply later production validation.

`docs/product/scope.md` is updated by this package to replace the stale “implemented locally / not deployed” wording. The current distinction is:

```text
software/schema installed != structure configured != rollout activated != pilot validated
```

The supplied VPS audit states migration `0045_hcis_human_capital_admin.sql` is applied and ORG-004 code/schema is installed at the inspected SHA, while rollout configuration is absent and therefore behavior remains `LEGACY`. Scope now records this as an implemented/deployed baseline with operational validation pending.

### Feature parity

`docs/product/feature-parity.yaml` is updated from ORG-004 `planned` to `implemented`, not `verified`. Real structure selection, SHADOW comparison, access review, STRUCTURE activation, and pilot UAT remain operational gates.

ATT-005 remains `implementing`. The supplied VPS audit reports three rows in `attendance_adms_physical_capabilities` with state `verified`, but did not identify capability keys/evidence. Therefore no specific physical capability row is promoted by this package and ATT-005 is not closed.

### AUTH-011

The accepted AUTH-011 contract and its 2026-09-07 synthetic verification remain the basis for pilot access boundaries. The implementation exists in the inspected main baseline according to repository history/audit evidence, but no real `human_capital_admin` assignment or pilot UAT is inferred. HC administration does not imply leave approval, approval-policy management, or technical attendance-device permissions.

### Repository transfer and deployment

GitHub inspection on 2026-09-15 observed `sabilulquran/hcisysq` as active and the old `imadjinasi/hcisysq` endpoint redirecting. `AGENTS.md`, AI-assisted workflow, and transfer documentation are updated in this package to name the observed canonical repository. This does not change GHCR/runtime ownership; the proven personal GHCR namespace remains a separate deployment concern until organization package publication/consumption is verified and approved.

## Work package and ownership

| Work | Status | Primary role owner | Dependencies | Closing evidence |
| --- | --- | --- | --- | --- |
| Operational status consolidation | Repository-ready | Product/HCIS owner | Review of dated evidence | Approved status note, no contradictory current-state claims used for go/no-go |
| Select one pilot unit and participants | Waiting operational owner | Human Capital | Authoritative organization data | Signed/recorded pilot roster and role mapping outside repo; no guessed structure |
| ORG-004 configuration validation | Ready to execute | Human Capital + authorized HCIS operator | Pilot selection, active accounts/capabilities | DRAFT validation + SHADOW evidence + zero unexplained mismatch |
| Access/UAT review | Ready to execute | Human Capital + security/reviewer | Synthetic fixtures; later real pilot sessions | Positive + negative matrix with audit evidence |
| Work Code export defect | Code fix proposed | HCIS engineer/reviewer | PR CI, synthetic PostgreSQL | Export succeeds, command ID sourced from physical operation history, secrets absent |
| ATT-005 pilot boundary | Partially evidenced | Technical device operator + HC owner | Approved device/canary scope | Passive evidence first; each active command separately approved and recorded |
| Backup/restore readiness | Not proven | Operations owner | Isolated DB/host + approved backup handling | Successful isolated restore drill, integrity/app checks, measured duration |
| Pilot go/no-go | Waiting decision | Operational owner | All mandatory gates | Signed go/no-go record; rollback owner and trigger confirmed |

## Supplied VPS audit facts — not independently re-run here

The 2026-09-15 audit supplied with this task reported:

- VPS API, Web, PostgreSQL healthy at SHA `9e9098c5...`;
- `/healthz`, `/api/health`, `/api/ready` succeeded and `/login` returned 200;
- migration 0045 applied;
- zero `organization_rollout_settings` rows, therefore `LEGACY` by contract;
- ORG-004 code/schema installed but operational activation not proven;
- three physical-capability records had state `verified`, without enough detail here to close ATT-005;
- `BIOMETRIC_COLLECTION_ENABLED=0`;
- deployment backups existed through 2026-09-07, but schedule and restore drill were not proven;
- approximate 2 GB RAM, swap in use, disk 64%, shared host — capacity observation, not incident proof;
- PR #54 checks previously passed, but the full suite was not rerun during that audit.

These statements remain labeled supplied audit evidence until Codex Local records fresh commands/output.

## Pilot go/no-go minimum

**GO requires all mandatory items:** reviewed pilot roster; ORG-004 DRAFT validation; SHADOW zero unexplained mismatch; intended approvers eligible; AUTH-011 positive/negative UAT; Work Code export regression closed if that export is in pilot scope; isolated restore drill passed; health/monitoring owner and escalation path assigned; biometric collection OFF unless separately approved; no active device command bundled into passive verification; rollback trigger/owner agreed.

**NO-GO / STOP:** unknown approver or authority, cross-unit/privacy leak, unauthorized capability, unexplained SHADOW mismatch, mutable historical approval snapshot, failed restore/integrity check, inability to identify rollback owner, production change required merely to complete a test, or any biometric/device action lacking explicit authorization.

RPO and RTO are **TBD — operational-owner decision**. Do not infer them from backup frequency or observed restore duration.
