# Employment Administration Package 1 — Implementation Plan

**Status:** ACCEPTED PRODUCT DIRECTION — all owner decisions D-01..D-19 accepted 2026-10-16 (spec §15); implementation not started  
**Specifications:** EMP-005, EMP-006, EMP-010  
**Spec:** `docs/domain/employment-administration-package1.md`  
**Prepared:** 2026-10-16

The owner accepted the spec and all decisions on 2026-10-16, so steps may start in dependency order. Every step is one pull request with its own spec reference, tests, docs update, and rollback note (AGENTS.md §7, §9). Auth/permission/migration steps need the extra review AGENTS.md §8 requires. Production rollout happens only through OPS-MI8-REL-001 with explicit owner approval; no step deploys anything by itself.

Migration numbers below are placeholders (`00NN`); use the next free number at implementation time and keep `npm run migrations:check` green.

## Dependency overview

```text
S1 schema + resolver ──> S2 baseline + read API + permissions ──> S3 admin read UI (SHADOW UAT)
                                   │
                                   ├──> S2B "di luar pengelolaan HCIS" marker (EMP-001 change)
                                   └──> S4 PK & SK register (EMP-010)
S2 + S4 ──> S5 contract actions + projection + import guard (AUTHORITATIVE capable)
S5 ──> S5A account deactivation on termination + time-boxed reactivation (AUTH change, D-15)
S5 ──> S6 career actions (placement/transfer/promotion/demotion)
S6 ──> S7 reversal, contract worklist, self-service
S7 ──> S8 pilot activation runbook (ops doc; production only with owner approval)
```

S2B, S3 and S4 can run in parallel after S2. S5A and S6 can run in parallel after S5. `AUTHORITATIVE` must not be enabled in production before S5A is merged, because termination would otherwise end the employment without the accepted automatic account deactivation. S6 and the self-service part of S7 can be split further if review load requires it.

## S1 — Schema and domain resolver (no routes, no UI)

**Status:** IMPLEMENTED on branch `feat/emp-s1-employment-history-foundation` (2026-10-16), pending review/merge. Delivered: migration `0056_employment_history_foundation.sql`; pure domain module `apps/api/src/modules/employment/domain/` (`resolveEmployment`, `planEmploymentAction`, `applyPlan`, policy table); tests `apps/api/test/employment-history-domain.test.ts` (unit) and `apps/api/test/employment-history-migration.test.ts` (PostgreSQL, CI). Not deployed; nothing reads the tables yet; rollout mode stays OFF (no settings row).

**Spec:** EMP-005-B/C, EMP-006-B/C, EMP-010 data model.  
**Prerequisite decisions:** D-01, D-06 (ADDITIONAL placements yes/no).

- Migration `00NN_employment_history_foundation.sql` (additive only):
  - `employments`, `employment_terms`, `employment_placements`, `employment_actions`, `employment_action_documents` (link table), `employment_decision_documents`, `employment_audit_events`, `employment_rollout_settings` (single row, default absent = `OFF`).
  - Exclusion constraints with `btree_gist` (already enabled by migration 0021) for: employment per employee, terms per employment, PRIMARY placements per employment; `CHECK` for date order and exactly-one unit reference.
  - `voided_by_action_id` columns instead of deletes; no `ON DELETE CASCADE` from employees.
  - Down script documented in the PR (drop new tables) — valid only while tables are empty.
- Domain module (no DB/HTTP imports, AGENTS.md §4): `packages/domain/employment` or `apps/api/src/modules/employment/domain` following the existing module layout decision at implementation time.
  - `resolveEmploymentState(records, date)` → derived state, current term, primary/additional placements, flags.
  - `planAction(currentRecords, actionInput, policy)` → rows to open/close, warnings, or a typed failure from spec §12.
  - Policy object for SK-required types, fixed-term categories, backdating window, reminder window (values from D-03, D-08, D-11, D-13; defaults from the spec proposal).
- Tests (unit, synthetic): overlap rejection, out-of-order rejection, future-dated derivation, termination last-day semantics, month-precision baseline end, reversal planning restores state, cross-entity rejection.
- CI: migration clean run + existing rehearsals; `migrations:check`.
- **OpenAPI:** no change.
- **Rollback:** revert PR; drop empty tables.

## S2 — Baseline backfill, read API, permissions, rollout setting

**Spec:** EMP-005-E, EMP-005-G (read side), EMP-PKG1-X1, X3; §8.1–8.3.  
**Prerequisite decisions:** D-02 (accepted mapping; Pegawai Lepas = kontrak lepas with end date), D-14, D-16 (accepted).

- Migration `00NN_employment_permissions.sql`: insert `employment.read`, `employment.manage`, `employment.correct`; grant `employment.read`/`employment.manage` to `human_capital_admin`; `employment.correct` per D-16 (no account is assigned by migration, consistent with migration 0045).
- Add the keys to `apps/api/src/modules/auth/permissions.ts` and `docs/domain/AUTH-011-admin-route-permissions.json`.
- CLI `employment-baseline` (`--dry-run` default, `--apply`, `--employee <id>` re-run, `--purge-baseline`): counts-only stdout; per-employee issues stored for the consistency report; audit `employment.baseline.*`. Reads STATUS AKTIF/KEPEGAWAIAN/JENIS from the latest `employee_import_source_snapshots` row, excludes `Aktif BUMY` and `Pengurus Yayasan` (leaving FOUNDATION_BOARD accounts untouched), maps `Aktif PKWT` to Pegawai Kontrak with conflict detection, applies the spec §4.2.1 mapping table (kept as versioned configuration so later vocabulary changes need no code change), and never touches accounts.
- Rollout endpoints (permission `access.governance.manage`): `GET/PUT /admin/employment/rollout` with reason; audit `employment.mode.changed`.
- Read endpoints (permission `employment.read`, scope-checked):
  - `GET /admin/employees/{employeeId}/employment` — derived current summary + employments, terms, placements.
  - `GET /admin/employees/{employeeId}/employment/timeline` — actions with "dari → menjadi" snapshot and SK refs.
  - `GET /admin/employment/consistency` — grouped issue counts + paginated rows (incl. ORG-004 incumbency mismatch and projection lag).
- **OpenAPI:** add the five paths above with schemas `EmploymentSummary`, `EmploymentTerm`, `Placement`, `EmploymentAction`, `EmploymentConsistencyReport`, `EmploymentRolloutSetting`, and error codes. (Note: existing `/admin/employees*` routes are not yet in `docs/api/openapi.yaml`; this step documents only the new paths and records that gap as a follow-up.)
- Tests: route permission positive/negative (including unit scope), self-access via admin route still requires permission, mode `OFF` returns `EMPLOYMENT_HISTORY_DISABLED`, baseline idempotency, baseline never invents dates, baseline issue codes, BUMY and Pengurus Yayasan exclusion, Aktif PKWT conflict, stray-value issues (`Tidak Aktif` as category, `#`/`-` staff type), no account change during baseline, audit payload has no PII (assert key allowlist).
- **Rollback:** mode stays `OFF`; `--purge-baseline`; revert permissions migration only if no account holds them.

## S2B — Records outside HCIS management (BUMY, Pengurus Yayasan)

**Spec:** EMP-005-L, §8.7, §13.9.
**Review:** touches EMP-001 employee master and every consumer of the active-employee population — extra review.

- Migration `00NN_employee_management_scope.sql` (additive): `employees.management_scope` (`MANAGED` default, `OUTSIDE_HCIS`), `management_scope_reason` (`BUMY`, `PENGURUS_YAYASAN`), marked at/by, `CHECK` consistency; audit `employee.management_scope.changed`.
- Mark/unmark endpoint for HC Admin (`employees.manage`, reason required): `PUT /admin/employees/{employeeId}/management-scope`; candidates come from the baseline dry-run (source snapshot values `Aktif BUMY`, `Pengurus Yayasan`) and are confirmed by HC in the SHADOW review.
- Read-only enforcement (`EMPLOYEE_OUTSIDE_HCIS_READ_ONLY`) on contact edit, manager assignment, employment actions, and EMP-004 import commit (rows skipped, shown as "Di luar pengelolaan HCIS — dilewati" in preview; new candidates flagged, never auto-marked).
- Exclusion from default admin employee list, active counts, Board aggregates, leave/attendance/approval eligibility, and the ORG-006 producer; admin list filter "Di luar pengelolaan HCIS".
- Consistency report lists EMPLOYEE accounts still linked to marked records (no automatic change).
- Tests: no delete path, history endpoints still readable, every write path refused, every consumer excludes marked rows (leave eligibility, attendance roster, Board, ORG-006, approval resolver), FOUNDATION_BOARD accounts unaffected, mark/unmark audit, permission positive/negative.
- **OpenAPI:** add the management-scope path, `managementScope` on employee read schemas when those are documented.
- **Rollback:** unmark all (audited) or revert PR; column default keeps all rows `MANAGED`.

## S3 — Admin read UI (tabs, timeline, consistency report)

**Spec:** §13.1, §13.2 (read parts), §13.6, EMP-PKG1-X2.  
**Prerequisite:** S2 merged. Can run parallel to S4.

- `apps/web`: employee detail tabs **Kepegawaian & Kontrak** and **Penempatan & Karier** (read-only, action buttons hidden), menu **Kepegawaian → Periksa kecocokan data**.
- States: loading, empty, error, forbidden/session-expired, mobile.
- Tests: component/route tests; browser smoke with synthetic data in mode `SHADOW` on a local stack.
- **OpenAPI:** none (consumes S2).
- **Rollback:** revert PR; routes hidden while mode `OFF`.

## S4 — Perjanjian Kerja & SK register (EMP-010)

**Spec:** EMP-010-A/B/C, §4.5, §13.5.  
**Prerequisite decisions:** D-08 (accepted: PK and SK are separate kinds), D-09 (accepted).

- Endpoints: `GET/POST /admin/decision-documents?kind=PERJANJIAN_KERJA|SURAT_KEPUTUSAN`, `GET/PATCH /admin/decision-documents/{documentId}` (PATCH rejected with `DECISION_DOCUMENT_LOCKED` once linked), `POST /admin/decision-documents/{documentId}/corrections` (`employment.correct`).
- UI: **Kepegawaian → Perjanjian Kerja & SK** with separate tabs, list/detail/create.
- Tests: separate numbering per kind, PK belongs to one employee, SK may cover many, kind-specific required fields, lock after link, correction keeps prior values, permissions, audit events.
- **OpenAPI:** add paths + `DecisionDocument` as a discriminated union (`PerjanjianKerja`, `SuratKeputusan`).
- **Rollback:** revert; table remains empty-or-unused.

## S5 — Contract actions, projection writer, import guard

**Spec:** EMP-005-A/B/C/D/F/G/H, §6, §7, §8.4, §8.5, §11, §12.  
**Prerequisite decisions:** D-03, D-05, D-07, D-10, D-12, D-13, D-19 (accepted); D-04 (accepted: warnings only, never blocking); ops decision for the daily refresh host (spec §8.4 TBD).

- Endpoints (`employment.manage`, `Idempotency-Key`, `expectedVersion`):
  - `POST /admin/employees/{employeeId}/employment-actions/preview`
  - `POST /admin/employees/{employeeId}/employment-actions`
  - Supported types in this step: `HIRE`, `CONTRACT_EXTENSION`, `CATEGORY_CHANGE`, `TERMINATION`.
- Projection writer in the same transaction; daily/manual refresh command; `employment.projection.refreshed` audit.
- EMP-004 import change: in `AUTHORITATIVE`, skip employment fields for baselined employees, show "Diabaikan" in preview, audit `employment.import.fields_ignored`; D-19 transitional baseline for new NIPs.
- Validation of the required document kind (PK for contract hire/extension, SK Pengangkatan for permanent appointment, SK Pemberhentian for termination) and PK/term match (`PK_TERM_MISMATCH`).
- UI: action dialog (§13.3) for the four contract actions; termination preview shows the upcoming automatic account deactivation (performed by S5A).
- Tests: transaction atomicity (inject failure → nothing written), idempotent replay, version conflict, self-action denial, required document kind, PK/term mismatch, warnings acknowledgement, masa kerja continuity across extension and category change (D-05), projection equality for annual-leave eligibility/Board/ORG-006 regression fixtures, import unchanged in `OFF`/`SHADOW`, import guard in `AUTHORITATIVE`, no role change.
- **OpenAPI:** add both paths, `EmploymentActionRequest` (discriminated by `actionType`), `EmploymentActionPreview`, error schema codes.
- **Rollback:** set mode `OFF` (import writes again); history kept; see spec §8.6.

## S5A — Automatic account deactivation and time-boxed reactivation (D-15, AUTH change)

**Spec:** EMP-005-I/J, §8.5, §13.8.
**Review:** auth/permission/migration — extra review required (AGENTS.md §8); security review sign-off before merge.
**Prerequisite decisions:** D-15 (accepted with sub-items: maximum 30 days; access only to own payslips, own attendance history, own leave history; granted only by HC Admin with mandatory reason).

- Migration `00NN_account_temporary_reactivation.sql`: `account_temporary_reactivations` (account, granted by, reason, starts at, expires at, revoked at/by, `CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '30 days')`), permission `access.accounts.temporary_reactivate` granted to `human_capital_admin` only.
- Termination effect: in the S5 action transaction (past `ended_on`) or in the daily job (future `ended_on`): set linked EMPLOYEE accounts `invited|active → inactive`, revoke sessions and activation tokens, audit `account.status.updated` (actor system, cause) + `employment.account.deactivated`.
- Auth guard (defence in depth): login (password and OIDC) and session validation deny an EMPLOYEE principal whose latest employment ended before today unless a valid, unexpired reactivation exists; then only own payslips, own attendance history, and own leave history (read-only) are allowed.
- Endpoints: `POST /admin/access/accounts/{accountId}/temporary-reactivations` (reason, expiresAt), `POST /admin/access/accounts/{accountId}/temporary-reactivations/{grantId}/revoke`, `GET` list on the account detail.
- Expiry job returns the account to `inactive`, revokes sessions, audits `.expired`; login/session checks enforce `expires_at` directly.
- UI: **Akses → Akun → Aktifkan sementara** (§13.8), badge and early stop.
- Tests: deactivation on past and future termination; job-late denial at login/session; baseline/import/reversal never change accounts; reactivation requires reason+expiry, max duration, self-grant forbidden, permission positive/negative, allowlist-only access (own payslip/attendance/leave history read allowed; own employment history, submissions, HC/admin/approver routes denied), Super Admin cannot grant, 31-day expiry rejected, expiry enforced without the job, revoke early, audit events and payload allowlist; OIDC path covered.
- **OpenAPI:** add the reactivation paths and `AccountTemporaryReactivation` schema; document new auth error codes.
- **Rollback:** revert PR; existing reactivation rows become inert; accounts already deactivated stay inactive (fail closed) and are reactivated manually through the existing access flow if needed.

## S6 — Career actions

**Spec:** EMP-006-A/B/C/D.  
**Prerequisite decisions:** D-06 (accepted), D-08 (accepted: SK Mutasi/Promosi/Demosi required), D-18 (accepted: no ORG-004 change, mismatch warning/report only). ORG-004 acceptance state determines whether placements use stable keys or legacy references for pilot.

- Extend action types: `PLACEMENT`, `TRANSFER`, `PROMOTION`, `DEMOTION`.
- Validation against the ORG-004 structure effective on the date (stable key) or the legacy unit/position tables.
- Preview hint for authority-bearing seats; consistency report placement-vs-incumbency rows.
- UI: buttons and dialog variants in **Penempatan & Karier**; timeline "dari → menjadi".
- Tests: placement closure, ADDITIONAL overlap rules, invalid key rejection, no write to any `organization_*` table (assert), approval snapshots unchanged.
- **OpenAPI:** extend `EmploymentActionRequest` variants.
- **Rollback:** feature remains behind mode; revert PR restores contract-only actions.

## S7 — Reversal, contract worklist, employee self-service

**Spec:** EMP-006-E, §6.1 reversal, §13.4, §13.7, D-17.

- `POST /admin/employment-actions/{actionId}/reversal` (`employment.correct`, reason required, latest-only rule).
- `GET /admin/employment/contracts/expiring?withinDays=60` and UI **Kontrak akan berakhir**.
- D-17 accepted: `GET /employees/me/employment` (own data, no reason notes) and **Profil saya → Kepegawaian**.
- Tests: reversal exactness, non-latest rejection, double reversal rejection, self-service shows only own record and hides restricted fields, worklist scope.
- **OpenAPI:** add paths + `EmploymentSelfView`.
- **Rollback:** revert PR; reversals already recorded remain valid history.

## S8 — Pilot activation runbook (documentation + owner-approved ops)

- Document in `docs/development/` how to: take the verified backup, deploy the release via OPS-MI8-REL-001, run baseline dry-run (counts only), owner review of counts, apply baseline, switch to `SHADOW`, HC UAT, resolve consistency issues, switch to `AUTHORITATIVE` for the pilot.
- Exit criteria for `AUTHORITATIVE`:
  1. zero `BASELINE_STATUS_CONFLICT`; BUMY and Pengurus Yayasan exclusions reviewed by HC and marked via S2B;
  2. all employment categories mapped (no `BELUM_DIKLASIFIKASIKAN` for active employees);
  3. every active fixed-term employee has a known contract end date or an explicit HC acknowledgement;
  4. projection equals current `employees` columns for every baselined employee (no unintended change at switch-over);
  5. annual-leave eligibility, Board, ORG-006 outputs unchanged on a scratch-restore rehearsal;
  6. S5A merged and its auth tests green (automatic deactivation must exist before real terminations are recorded);
  7. HC sign-off and owner approval recorded.
- No production change without explicit owner approval.

## Documentation to update in each step

- `docs/domain/employment-administration-package1.md` (status per acceptance criterion), `docs/product/feature-parity.yaml` (status `implementing` → `implemented` → `verified`), `docs/api/openapi.yaml`, `docs/domain/AUTH-011-admin-route-permissions.json` when routes are added, `docs/domain/glossary.md` when vocabulary is finalized by D-02/D-10.
