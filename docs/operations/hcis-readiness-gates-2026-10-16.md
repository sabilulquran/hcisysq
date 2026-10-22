# HCIS Pilot-ready and Production-ready gate status — 2026-10-16

**Spec ID:** OPS-READY-001
**Status:** ASSESSMENT (read-only; updated after the 2026-10-16 restore drill). Pilot ready: **NOT MET**. Production ready: **NOT MET**.
**Source of the gates:** `docs/product/scope.md` → "Pilot ready — PENDING" and "Production ready — PENDING". This note does not change those gates; it records evidence against them.
**Evidence sources:** repository at `origin/main` `c2746a3`; read-only inspection of Mi8VPS via `ssh mi8vps-root` on 2026-10-16 13:27–14:30 WIB (process `cwd`, file modes, backup logs, aggregate `SELECT count(*)` inside `BEGIN READ ONLY … ROLLBACK`); public HTTPS probes. No production change was made.

## 1. Production snapshot (aggregates only)

| Item | Value (2026-10-16) |
|---|---|
| Running release | `hcis-3b670849-20261016` (API pid `cwd`), released 2026-10-16 through OPS-MI8-REL-001 |
| ORG-004 rollout rows | 0 → routing is `LEGACY` |
| Organization change sets | 15 PUBLISHED, 3 VALIDATED, 7 DRAFT |
| Accounts | 4 active, 75 invited, 2 inactive |
| Role assignments | 1 Human Capital, 1 Human Capital Administrator |
| Employees | 330 rows incl. 1 `Synthetic UAT` record (see `production-uat-account-hygiene.md`) |
| Leave requests | 0 (no real leave workflow use yet) |
| Published payslips | 5 202 |
| ADMS devices / punches last 7 days | 2 / 438 |
| Biometric collection | OFF (`BIOMETRIC_COLLECTION_ENABLED` absent) |

HCIS is live mainly for **payslip reading and attendance ingest**; the approval workflows the pilot is meant to prove have not been used by real users yet.

## 2. Pilot ready

| # | Gate (scope.md) | Status | Evidence | What closes it |
|---|---|---|---|---|
| P1 | Select one unit/persona set; document data-use boundary | **MISSING** | `org004-pilot-unit-validation.md` status "NO REAL UNIT SELECTED"; no rollout rows | HC fills the form (outside Git for names) |
| P2 | Validate manager, approver, acting authority, role/scope, calendar for the pilot | **MISSING** | depends on P1; only 2 role assignments exist in production | HC + operator review per `org004-operational-validation.md` |
| P3 | LEGACY baseline + SHADOW comparison, zero unexplained mismatch | **MISSING** | rollout rows = 0 (no SHADOW configured); 15 published change sets exist but HC acceptance not recorded | SHADOW phase of `org004-operational-validation.md` |
| P4 | Positive/negative access UAT (`hcis-pilot-uat.md`) | **PARTIAL** | Synthetic AUTH-011 verification 2026-09-07 (`docs/testing/AUTH-011-verification.md`); real-pilot rows not executed. Security review found the AUTH-011 manifest missed 51 routes and the matrix test was skipped in CI (SEC-02/03); both fixed in #107 (2026-10-16) | Execute the UAT rows with pilot personas |
| P5 | Backup **and isolated restore drill** | **DONE** | Backup: OPS-MI8-BAK-001 daily production sets since 2026-10-15, encrypted Drive copy (`scheduled off-host copy completed` 2026-10-16 02:01), restore check PASS 2026-10-15. **Isolated restore drill PASS 2026-10-16** (`hcis-restore-drill-2026-10-16.md`): set `set-20261016T002118Z` restored into a disposable DB, current release started on it, 6/6 smoke checks, teardown clean, 48 s total | Repeat after major schema changes; weekly automatic check first due 2026-10-19 03:00 WIB |
| P6 | Minimum observability, incident, stop, rollback ownership | **MISSING** | Roles named in docs only as placeholders; no alert channel (OPS-MI8-BAK-001 §8); RPO/RTO `TBD` | Owner fills `go-live-decision-record-template.md` §2 and §4 |
| P7 | Biometric collection OFF unless separately approved | **DONE** | env key absent on device; `hcis-operational-readiness.md` | Keep checking at each release preflight |
| P8 | Passive device verification separate from active hardware canary | **DONE (process)** | `hcis-pilot-recovery-and-handoff.md` ATT-005 boundary; ADMS canary docs under `docs/testing/attendance-adms-*` | Re-confirm in the pilot decision record |
| P9 | Decide password recovery / notification needs or manual fallback | **MISSING** | No self-service reset in OIDC mode (Keycloak handles passwords); no notification adapter | Owner/HC decision in the go-live record |
| P10 | Human go/no-go before STRUCTURE activation | **MISSING** | Template now exists (`go-live-decision-record-template.md`, OPS-GOLIVE-001) | Signed record |

Supporting operations already in place (not separate gates, but pilot depends on them):

| Item | Status | Evidence |
|---|---|---|
| Release + rollback flow on Mi8 | DONE | OPS-MI8-REL-001; first release and 10-minute watch PASS 2026-10-16 (`production-release-verification-2026-10-16.md`); rollback command documented |
| Keycloak (login) stability | PARTIAL | OPS-MI8-KC-001 part A applied 2026-10-16; 48 h watch due 18 Oct; part B on hold |
| Phone suspend behaviour | OPEN DECISION | `mi8vps-host-suspend-plan.md` (OPS-MI8-PWR-001) |

## 3. Production ready

| # | Gate (scope.md) | Status | Evidence | What closes it |
|---|---|---|---|---|
| R1 | Legacy-data migration/cutover rehearsal succeeds and reconciles | **MISSING** | No rehearsal has run. Legacy system itself is unidentified in the repo. Plan drafted: `docs/migration/legacy-migration-and-freeze-plan.md` (MIG-002, DRAFT/DISCOVERY) | D1–D7 answered, WP1–WP6 executed |
| R2 | Security review complete | **PARTIAL** | Review done: `hcis-security-review-2026-10-16.md` — 0 Critical. Highs: SEC-16 and SEC-02 fixed, SEC-01 risk accepted by the owner. Mediums: SEC-05 and SEC-06 fixed in code (fix/sec-auth-login-csrf), SEC-07 API part fixed in code (fix/sec-hardening-headers-lows); both live only after the next owner-approved release; SEC-07 SPA/edge part still open (update 2026-10-22) | Mediums fixed or accepted in the go-live record |
| R3 | Production operational ownership current | **PARTIAL** | Operator + owner exist de facto (release approvals in chat); not recorded as named roles with backups | Go-live record §2 |
| R4 | Legacy freeze/cutover plan approved | **MISSING** (draft exists) | MIG-002 §6 | Owner approval of MIG-002 after discovery |
| R5 | Rollback/data-recovery procedure tested incl. isolated restore drill | **PARTIAL** | App rollback path exists and the previous release is kept; same-host isolated restore drill PASS 2026-10-16 (`hcis-restore-drill-2026-10-16.md`). Recovery from **loss of the phone** (Drive copy → other host, secrets bundle) untested | Off-host drill on a second host; secret-bundle coverage confirmed |
| R6 | Old system read-only during verification period | **MISSING** | depends on R1/R4; legacy host unknown | MIG-002 §6 |
| R7 | Broader go-live/cutover approved by authorized owner | **MISSING** | — | Signed go-live record (cutover scope) |

## 4. Approvals needed from the owner (in order)

1. ~~Run the isolated restore drill~~ — approved and PASS 2026-10-16.
2. ~~Release the dependency security update (SEC-16)~~ — **in production.** PR #106 merged 2026-10-16. Release `hcis-4a578253-20261016` (main `4a57825`, which contains #106 and #105) went live at 14:14 WIB through OPS-MI8-REL-001 by another operator, with a pre-release backup. Read-only check: `fastify` 5.12.7 is in the running release, and public `/login` and `/api/health` return 200. The separately built `hcis-07eae767-20261016` was approved by the owner but deliberately **not** applied, because it would be a downgrade.
3. ~~Cloudflare changes for SEC-01 and SEC-17~~ — SEC-17 was already protected by an access policy. For SEC-01 the owner **accepted the risk** on 2026-10-16 and declined an edge allowlist, because each new device site would need a rule change; unregistered devices stay blockable in the WDMS screen.
4. Name the pilot unit and the stop/rollback/incident owners (P1, P6) and decide RPO/RTO.
5. Identify the legacy system and its administrator (MIG-002 D1) so migration discovery can start.
