# Employment Administration Package 1 — Implementation Plan

**Status:** ACCEPTED PRODUCT DIRECTION — all owner decisions D-01..D-19 accepted 2026-10-16 (spec §15); S1–S3 merged (#113, #117, #120) and released to production in `hcis-5e4ddc96-20261017` with rollout mode OFF; S4 merged (#183); S5 API implemented (#208; the dialog is its own step S5B); S5A implemented; S2B and S6–S8 not started  
**Specifications:** EMP-005, EMP-006, EMP-010  
**Spec:** `docs/domain/employment-administration-package1.md`  
**Prepared:** 2026-10-16

The owner accepted the spec and all decisions on 2026-10-16, so steps may start in dependency order. Every step is one pull request with its own spec reference, tests, docs update, and rollback note (AGENTS.md §7, §9). Auth/permission/migration steps need the extra review AGENTS.md §8 requires. Production rollout happens only through OPS-MI8-REL-001 with explicit owner approval; no step deploys anything by itself.

Migration numbers below are placeholders (`00NN`); use the next free number at implementation time and keep `npm run migrations:check` green.

## Dependency overview

```text
S1 schema + resolver ──> S2 baseline + read API + permissions (re-import master once first) ──> S3 admin read UI (SHADOW UAT)
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

**Status:** IMPLEMENTED on branch `feat/emp-s1-employment-history-foundation` (2026-10-16); merged in #113 and released in `hcis-5e4ddc96-20261017`. Delivered: migration `0056_employment_history_foundation.sql`; pure domain module `apps/api/src/modules/employment/domain/` (`resolveEmployment`, `planEmploymentAction`, `applyPlan`, policy table); tests `apps/api/test/employment-history-domain.test.ts` (unit) and `apps/api/test/employment-history-migration.test.ts` (PostgreSQL, CI). At release nothing reads the tables yet; rollout mode stays OFF (no settings row).

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

**Status:** IMPLEMENTED on branch `feat/emp-s2-baseline-read-api` (2026-10-16); merged in #117 and released in `hcis-5e4ddc96-20261017`. Delivered: migration `0058_employment_permissions.sql`; EMP-004 import writes the four raw classification values to `employee_import_source_snapshots`; pure baseline mapping/consistency (`domain/baseline.ts`); store, baseline service and CLI `npm --workspace @hcis/api run employment:baseline` (dry-run default, `--apply`, `--cutoff`, `--employee`, `--rerun`); routes `GET/PUT /admin/employment/rollout` (AUTHORITATIVE refused until S5/S5A), `GET /admin/employees/{id}/employment`, `.../employment/timeline`, `GET /admin/employment/consistency`; `docs/api/employment.openapi.yaml`; AUTH-011 manifest entries (admin routes; Super Admin is denied because employment.* is not in legacy compatibility). ORG-004 placement-vs-incumbency rows in the consistency report move to S6 with the career actions. The baseline backfill CLI has not been run in production; running it and moving rollout OFF → SHADOW are separate owner-approved steps.

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

**Status:** IMPLEMENTED on branch `feat/emp-s3-read-screens` (2026-10-16); merged in #120 and released in `hcis-5e4ddc96-20261017`. Delivered: employee detail tabs **Ringkasan / Kepegawaian & Kontrak / Penempatan & Karier** (tabs visible only with `employment.read`; data loaded on first open), menu **Pegawai → Kecocokan Data** at `/admin/employment/consistency` (UI gate `employment.read`; Super Admin legacy compatibility never opens it), shared view states (loading, OFF/disabled, forbidden, error, empty, ready) with a SHADOW read-only banner; `apps/web/src/lib/employment.ts` (client + display labels only), `apps/web/src/components/employment/EmploymentPanels.tsx`. Evidence: 16 static-render tests; browser smoke against a loopback synthetic mock API (desktop dark/light, 375 px mobile without horizontal scroll, OFF and empty states). Not verified against a real API/database in a browser; that happens in S8 SHADOW UAT.

**Spec:** §13.1, §13.2 (read parts), §13.6, EMP-PKG1-X2.  
**Prerequisite:** S2 merged. Can run parallel to S4.

- `apps/web`: employee detail tabs **Kepegawaian & Kontrak** and **Penempatan & Karier** (read-only, action buttons hidden), menu **Kepegawaian → Periksa kecocokan data**.
- States: loading, empty, error, forbidden/session-expired, mobile.
- Tests: component/route tests; browser smoke with synthetic data in mode `SHADOW` on a local stack.
- **OpenAPI:** none (consumes S2).
- **Rollback:** revert PR; routes hidden while mode `OFF`.

## S4 — Perjanjian Kerja & SK register (EMP-010)

**Status:** IMPLEMENTED on branch `feat/emp-s4-decision-document-register`. Delivered without a migration (the tables came with S1): pure validation `apps/api/src/modules/employment/domain/decision-documents.ts`; store `infrastructure/postgres-decision-document-store.ts`; routes `decision-document-routes.ts` (`GET/POST /admin/decision-documents`, `GET/PATCH /admin/decision-documents/{documentId}`, `POST .../corrections`); `docs/api/employment.openapi.yaml` 0.3.0; AUTH-011 manifest entries; admin screen **Pegawai → Perjanjian Kerja & SK** (`/admin/decision-documents`). Tests: 12 domain, 19 route, 10 web.

Two decisions this step settled, both DRAFT until the owner says otherwise:

- the register follows the employment rollout mode and answers `EMPLOYMENT_HISTORY_DISABLED` while it is `OFF`, so no document is recorded before HC starts the SHADOW review;
- a document that no action uses yet is edited in place with `employment.manage` (`PATCH`); the audited correction path (`employment.correct`) is for a document already linked, which is what the spec locks. Neither path ever rewrites the kind, nor the employee of a Perjanjian Kerja: those make a different document.

New error codes beyond the original spec §12 table, now added to it: `DECISION_DOCUMENT_NUMBER_TAKEN` (409) for the unique (kind, number, signing year) series, `DECISION_DOCUMENT_INVALID` (400) which carries the offending `field`, `DECISION_DOCUMENT_NOT_FOUND` (404) and `EMPLOYEE_NOT_FOUND` (404). `EMPLOYMENT_VERSION_CONFLICT` is reused for an edit whose `expectedUpdatedAt` is stale.

Independent review (2026-10-27) closed on this step: the lock, the kind, the Perjanjian Kerja employee, and the values a correction keeps are all decided inside the transaction on the row read under `FOR UPDATE`, so an action linking the document meanwhile cannot let a plain edit slip past the lock once S5/S6 add the linking path; `PATCH` replaces the document in full (documented in OpenAPI); paging has a unique tiebreaker; search escapes `%` and `_`; a Perjanjian Kerja cannot extend itself.

**Spec:** EMP-010-A/B/C, §4.5, §13.5.  
**Prerequisite decisions:** D-08 (accepted: PK and SK are separate kinds), D-09 (accepted).

- Endpoints: `GET/POST /admin/decision-documents?kind=PERJANJIAN_KERJA|SURAT_KEPUTUSAN`, `GET/PATCH /admin/decision-documents/{documentId}` (PATCH rejected with `DECISION_DOCUMENT_LOCKED` once linked), `POST /admin/decision-documents/{documentId}/corrections` (`employment.correct`).
- UI: **Kepegawaian → Perjanjian Kerja & SK** with separate tabs, list/detail/create.
- Tests: separate numbering per kind, PK belongs to one employee, SK may cover many, kind-specific required fields, lock after link, correction keeps prior values, permissions, audit events.
- **OpenAPI:** add paths + `DecisionDocument` as a discriminated union (`PerjanjianKerja`, `SuratKeputusan`).
- **Rollback:** revert; table remains empty-or-unused.

## S5 — Contract actions, projection writer, import guard

**Status:** API IMPLEMENTED on branch `feat/emp-s5-contract-actions` (split: the action dialog is step S5B). Delivered without a migration: pure projection mapping `domain/projection.ts`; store `infrastructure/postgres-action-store.ts` (plan writer, idempotent replay, optimistic version check, projection refresh); routes `action-routes.ts` (`POST /admin/employees/{id}/employment-actions/preview` and `POST /admin/employees/{id}/employment-actions`) for `HIRE`, `CONTRACT_EXTENSION`, `CATEGORY_CHANGE` and `TERMINATION`; EMP-004 import guard plus audit `employment.import.fields_ignored`; projection service and CLI `npm --workspace @hcis/api run employment:refresh-projection` (dry-run default); OpenAPI 0.4.0; AUTH-011 manifest entries. Tests: 16 route, 4 import guard, on top of the S1 planner unit tests.

Decisions taken in this step, DRAFT until the owner says otherwise:

- **Preview needs AUTHORITATIVE too.** Spec §8.1 disables actions in `SHADOW`; a preview is an action, so both endpoints answer `EMPLOYMENT_HISTORY_DISABLED` outside `AUTHORITATIVE`. The rollout endpoint still refuses `AUTHORITATIVE` until S5A, so nothing can be recorded in production yet.
- **Daily refresh host (spec §8.4 TBD).** Mi8VPS has no cron or systemd, so the refresh runs as the CLI above under `sq-core-worker.sh` supervision rather than an in-process scheduler: a release that is restarted or rolled back then cannot silently stop the job, and the same command serves a manual re-projection. The worker entry is added with the S8 runbook.
- **`HIRE` locks the employee row**, not an employment (there is none yet), so two concurrent hires cannot both pass the "no active employment" check.
- **Import preview wording.** The commit-side guard and its audit event are implemented here; showing "Diabaikan — dikelola lewat riwayat kepegawaian" in the EMP-004 preview screen lands with S5B, which owns the employment UI.
- **Placements stay on the legacy unit/position tables in Package 1.** The nine projected columns point at those tables, so a placement recorded against an ORG-004 stable key would clear an employee's unit for every legacy consumer, and the import guard would stop import from restoring it. The route refuses `unitKey`/`positionKey`; S6 adds them together with the key-to-legacy mapping.
- **The projection keeps `functional_position`/`structural_position` when the placement carries no label.** Only a baseline placement carries them; an action-recorded placement has nothing to say about those two columns, so the stored values stay.
- **Idempotency is scoped to the employee.** The same key sent for another employee is refused with `IDEMPOTENCY_KEY_CONFLICT` (409) instead of answering "already recorded" and dropping that action. A key reused for the same employee still replays the original.
- **Still open, deliberately.** The §11 preview note about ORG-004 authority ("Penempatan ini tidak mengubah kewenangan approval…") belongs to the dialog and lands with S5B. The §12 exclusions `EMPLOYMENT_EXCLUDED_BUMY` and `EMPLOYMENT_EXCLUDED_FOUNDATION_BOARD` need the S2B marker on `employees`; until then a hire for such a record is possible, which is why S2B must land before AUTHORITATIVE (added to the S8 exit criteria).

Independent review (2026-10-27) closed on this step: the replay lookup moved behind authentication and is scoped to the employee; the projection service refuses to write outside AUTHORITATIVE and now commits in batches of 200; closing a term or placement records `closed_by_action_id`; exclusion-constraint violations answer 409 `EMPLOYMENT_OVERLAP` instead of 500; the preview state is computed from the post-action history; an employee removed from the master is refused; a document id that does not exist answers 404; and the guarded import branch no longer creates unit/position rows it throws away. Tests added for HIRE, CATEGORY_CHANGE, the version conflict, the constraint refusal, and both replay cases.

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

**Status:** IMPLEMENTED on branch `feat/emp-s5a-account-deactivation`. Delivered: migration `0091_account_temporary_reactivation.sql` (table plus the permission `access.accounts.temporary_reactivate`, granted to `human_capital_admin` only); `apps/api/src/modules/auth/employment-access.ts` (state query, allowlist, deactivation and expiry helpers); `temporary-reactivation-routes.ts` (grant, revoke, list, and the central `onRequest` guard); the termination effect inside the S5 action transaction and in the daily refresh; login and OIDC session creation refuse an account whose employment has ended without a valid grant. `AUTHORITATIVE` is now an available rollout mode. Tests: 11 cases covering permissions, the maximum window, self-grant, revoke, the fail-closed guard and the allowlist.

Decisions taken here, DRAFT until the owner says otherwise:

- **The guard is one central `onRequest` hook**, not a check inside `getSession`: every route would otherwise pay for an extra query on every call, and a self-service route could forget it. The hook runs before every request, so the allowlist cannot be bypassed by a new route.
- **One live grant per account** (a partial unique index). Extending means revoking and granting again, so the audit trail always names who extended the access and why, within the 30-day maximum.
- **Revoking a grant closes the account immediately** and revokes its sessions, rather than letting the expiry job do it later.
- `/auth/logout`, `/auth/me` and `/auth/launcher` stay open to a reactivated account, because the app cannot show any of the three pages without them; everything else answers `EMPLOYMENT_ENDED_READ_ONLY`.
- **Chaining is allowed, each link audited.** A grant lasts at most 30 days; extending means revoking and granting again with a new reason, so there is no hard ceiling on the total. Capping the total would need an owner decision, so the audit trail carries the accountability for now (DRAFT).
- **A rehire wins over every closing step.** The expiry sweep, the revoke path and the termination effect all read the latest employment first: someone who works here again keeps their account, whatever an old grant or an old termination says.

Independent security review (2026-10-27) closed on this step: the expiry sweep now marks the grant it processed and checks the employment first, so a rehired employee is no longer locked out every night; the allowlist names `/auth/me` (the route the app actually bootstraps on) instead of a path that does not exist, and a test ties every allowlisted path to a registered route; the grant path judges "ended" by the latest employment and runs the same `assertAccountManagementTarget` delegation check as the manual status change; a termination leaves the account open while another employment still runs; the guard is registered before every route and reads the session without the extra session write; `ORDER BY ... NULLS LAST` keeps a row without a start date from masking a real one. A PostgreSQL integration test now covers the constraints of migration 0091, the deactivation, the expiry and the rehire case.

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
