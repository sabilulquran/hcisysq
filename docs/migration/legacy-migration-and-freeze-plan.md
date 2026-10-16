# Legacy HCIS data migration, reconciliation and freeze plan

**Spec ID:** MIG-002 (implements the phases of MIG-001, `docs/migration/strategy.md`)
**Status:** DRAFT / DISCOVERY — no migration has been run; nothing here is approved
**Prepared:** 2026-10-16
**Closes (when executed):** *Production ready* items "legacy-data migration/cutover rehearsal succeeds and reconciles", "legacy freeze/cutover plan is approved" and "old system remains read-only during the agreed verification period" (`docs/product/scope.md`).
**Related:** `docs/data/legacy-mapping.md`, `docs/domain/employee-import.md` (EMP-004), `docs/domain/payslip-operational-compatibility.md` (PAYSLIP-002), `docs/product/org006-identity-coverage-acceptance-2026-10-14.md`.

## 1. Situation (what the repository already says)

HCIS YSQ already serves real users on Mi8VPS. Some data reached it through dedicated import paths; most legacy history has no migration path yet. Nothing in the repository identifies the legacy system's technology, host, database or owner.

"Legacy" here means the previous HCIS implementation. It is **not** the ORG-004 routing mode `LEGACY`.

| Domain | Current state in HCIS YSQ | Source today | Migration status |
|---|---|---|---|
| Employee master | Imported through EMP-004 (allowlisted fields, upsert by NIP, raw rows in `employee_import_source_snapshots`) | HC Google Sheet `Master Data SDM YSQ` (CSV export) | **Partial.** NIK, BPJS, bank, NPWP, family, address are deliberately not imported (`employee-import.md`). |
| Organization structure | Authored by hand in Organization Designer (ORG-004); routing still `LEGACY` | HC knowledge + import UNIT/JABATAN labels | **Rebuilt, not migrated.** Legacy unit/position/manager history: DISCOVERY. |
| Accounts / identities | Created by activation (AUTH-002) or exact OIDC mapping (HUB-IMPL-003); 2 of 97 active people mapped on 2026-10-14 | — | **Not migrated by design** (`hcis-authorization-modernization.md`). Legacy passwords must never be migrated. |
| Roles / permissions | AUTH-011 model; legacy roles are evidence only | — | **Not migrated by design.** Each grant is a fresh, reviewed assignment. |
| Leave balances and history | LEAVE-002 live; no opening-balance mechanism; carry-forward not implemented | Legacy HCIS (DISCOVERY) | **Not migrated. No mechanism exists.** This is the largest functional gap for a full cutover. |
| Attendance history | New punches flow from devices via ADMS to HCIS | Legacy HCIS records (GPS/photo) and device memory | **Not migrated.** Device-side re-pull exists only for what devices still hold. |
| Payslips | PAYSLIP-002 imports current periods from two CSV shapes, amounts as source strings | Payroll CSVs | **Ongoing per-period import.** Historical periods: DISCOVERY whether needed. |
| Loans | Not implemented (LOAN-001 discovery) | Legacy HCIS | **Not migrated.** Financial reconciliation critical. |
| Documents / attachments | Not implemented (DOC-001/002 discovery) | Legacy HCIS | **Not migrated.** Needs file + checksum migration. |
| Activity log | HCIS has its own audit tables | Legacy HCIS | **Not migrated.** Archive, do not convert into HCIS audit events. |

## 2. Decisions needed before any migration work (owner / HC)

Each item is DISCOVERY until a named owner answers it. Record answers in a dated decision note, not in this file.

| # | Question | Why it matters | Owner (proposed) |
|---|---|---|---|
| D1 | Which system and host is "legacy HCIS"? Who administers it? Is it still accepting writes today? | Nothing can be extracted or frozen without this. | Owner |
| D2 | Which domains must exist in HCIS YSQ before legacy is frozen? Proposed minimum: employee master (done), **leave balances as of a cut-off date**, open leave requests, last N months of payslips employees still need to see. | Defines the rehearsal scope; everything else can be archived read-only. | Owner + HC |
| D3 | Source of truth for leave balances at cut-off: legacy computed balance, HC spreadsheet, or recomputation from history? | LEAVE-002 has no opening-balance import; we must build one (§4) and know what to reconcile against. | HC |
| D4 | Historical attendance and payslips: migrate, or keep legacy read-only as the archive? | Migrating history is expensive; a read-only archive with a retention date is often enough. | Owner + HC + Finance |
| D5 | Loans, documents, activity logs: archive only, or migrate when LOAN-001/DOC-001 exist? | No target model exists yet. Proposed: archive only. | Owner + Finance |
| D6 | Read-only verification period length and legacy retention / deletion date. | Required by MIG-001 §7 and the open question in `legacy-mapping.md`. | Owner |
| D7 | Is any legacy data subject to deletion requests or special retention (payroll, tax)? | Affects what may be copied at all. | Owner |

## 3. Migration principles (binding for MIG-002)

- MIG-001 tool rules apply: idempotent, dry-run first, `run_id`, transform version, source→target map, structured report, no secrets or full sensitive values in logs.
- Extracts are handled only on the owner-approved machine; they never enter Git, prompts, CI, screenshots or issue trackers. Rehearsal evidence is **aggregate counts and checksums only**.
- Rehearsals run against a disposable database built with the OPS-MI8-DRILL-001 restore procedure (or a non-production host), never against `sqcore_hcis`.
- No account, password, session or role is migrated. Employees keep activating/OIDC-mapping as today.
- Amounts stay as source values; no payroll calculation is introduced (AGENTS.md §5).
- Every migrated row carries the metadata from `legacy-mapping.md` (source system/entity/ID, run ID, transform version, timestamp, checksum).

## 4. Work packages

| WP | Content | Needs spec / code? | Depends on |
|---|---|---|---|
| WP1 Discovery | Answer D1–D7; schema/row-count inventory of the legacy store **without** personal values; list orphans, duplicates, invalid enums, timezone semantics. | Discovery note only | Legacy access |
| WP2 Leave opening balance | Spec + import for "balance per employee and leave type as of cut-off date", with audit event and reversal path. Likely a LEAVE-00x spec. | **Yes — new spec and code** (not in this PR) | D2, D3 |
| WP3 Open leave requests | Decide: finish in legacy before freeze (preferred) or re-submit in HCIS. No automatic import of in-flight approvals (snapshot-on-submit semantics cannot be faked). | Decision only (preferred path) | D2 |
| WP4 Payslip history | If D4 says migrate: reuse PAYSLIP-002 importer per historical period, publish only after reconciliation. | Probably no new code | D4 |
| WP5 Archive | Read-only export of legacy data not migrated (attendance history, loans, documents, logs) to an encrypted, access-controlled archive with checksum manifest and retention date. | Ops runbook | D4–D7 |
| WP6 Rehearsal | Full dry run on a disposable DB; reconciliation report; measured duration. Repeat until two consecutive runs are deterministic. | Tooling from WP2/WP4 | WP1–WP5 |
| WP7 Freeze + cutover | §6 below. | Ops | WP6 PASS + go-live record |

## 5. Reconciliation (what "reconciles" means)

Counts are necessary but not sufficient (MIG-001 §3). Each check has a tolerance agreed **before** the rehearsal; default tolerance is zero.

| Check | Legacy side | HCIS side | Pass rule |
|---|---|---|---|
| Active employees per unit and status | Legacy query / HC sheet at cut-off | `employees` grouped by unit/status | Equal, or every difference has a named disposition |
| Employees present in legacy but not in HCIS (and reverse) | NIP list | NIP list | Zero unexplained |
| Leave balance per employee per leave type at cut-off | D3 source | WP2 import result | Equal per employee (not only in total) |
| Leave requests per type/period/state (history, if migrated) | Legacy | `leave_requests` | Equal |
| Payslip periods and row count per period; checksum of source amount strings per period | Payroll CSV / legacy | `payslip_import_rows`, `payslips` | Equal; checksum identical |
| Employee self-access sample | — | 3 synthetic or consented employees can see exactly their own migrated data | PASS, plus negative cross-employee check (UAT-A05) |
| Archive completeness | File/row counts and checksum manifest | Archive manifest | Identical |

The reconciliation report lists counts and checksums only, signed off by HC (and Finance for payslips).

## 6. Legacy freeze and read-only plan

Pre-conditions: WP6 rehearsal PASS; isolated restore drill PASS (OPS-MI8-DRILL-001); go-live decision record approved (`docs/operations/go-live-decision-record-template.md`).

| Step | Action | Owner | Evidence |
|---|---|---|---|
| F-14d | Announce freeze date, what moves, what stays read-only, where to ask for help | Owner / HC | Announcement copy |
| F-7d | Final rehearsal on fresh legacy extract; confirm duration fits the freeze window | Operator | Rehearsal report |
| F-1d | Ask users to finish open leave requests in legacy (WP3); confirm none open, or list exceptions | HC | Count of open requests |
| F 00:00 | **Stop legacy writes**: switch legacy to maintenance/read-only mode or revoke write roles (mechanism: DISCOVERY, depends on D1) | Legacy admin | Screenshot/log of the setting; a write attempt fails |
| F +0:15 | Final legacy backup, checksum, store encrypted | Legacy admin | Backup checksum |
| F +0:30 | Fresh HCIS production backup (OPS-MI8-REL-001 `backup` phase style) | Operator | Dump checksum |
| F +0:45 | Final extract → migrate (WP2/WP4) into production with the rehearsed tool | Operator | Run report |
| F +2:00 | Reconcile (§5) | HC + Operator | Signed report |
| F +2:30 | Smoke test in HCIS (login, own leave balance, own payslip, approver queue) | HC pilot users | UAT rows |
| F +3:00 | Go/no-go #2 (keep or roll back); announce | Owner | Decision record |
| F … F+N | Legacy stays read-only for the verification period (D6); access limited to named HC/admin users; any correction is made in HCIS only | Legacy admin | Access list |
| F+N | Archive (WP5) verified; legacy decommission decision recorded separately | Owner | Archive manifest |

**Rollback during the freeze window** (before HCIS writes on migrated data are opened): delete nothing; mark the migration `run_id` as rejected, restore the F+0:30 HCIS backup into production only if migrated rows cannot be cleanly reversed by `run_id`, re-open legacy writes, and announce. After HCIS writes are opened, rollback becomes two-way reconciliation (MIG-001 §Rollback), so go/no-go #2 must happen before opening writes.

## 7. Risks

- **Unknown legacy system (D1)** blocks everything. Highest priority discovery.
- **Leave balances** are what employees notice first; without WP2 a cutover silently resets balances.
- **Personal data in extracts** — keep extracts off Git/CI/prompts; aggregate evidence only.
- **Phone-hosted production** — a migration write load on Mi8VPS must be timed outside 02:00 WIB backups and with fresh backups (OPS-MI8-BAK-001).
