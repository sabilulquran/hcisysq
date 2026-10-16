# Employment Administration Package 1 — Implementation Plan

**Status:** DRAFT — PENDING OWNER APPROVAL  
**Specifications:** EMP-005, EMP-006, EMP-010  
**Spec:** `docs/domain/employment-administration-package1.md`  
**Prepared:** 2026-10-16

No step may start before the owner approves the spec (decision D-01) and the decisions each step lists as prerequisites. Every step is one pull request with its own spec reference, tests, docs update, and rollback note (AGENTS.md §7, §9). Auth/permission/migration steps need the extra review AGENTS.md §8 requires. Production rollout happens only through OPS-MI8-REL-001 with explicit owner approval; no step deploys anything by itself.

Migration numbers below are placeholders (`00NN`); use the next free number at implementation time and keep `npm run migrations:check` green.

## Dependency overview

```text
S1 schema + resolver ──> S2 baseline + read API + permissions ──> S3 admin read UI (SHADOW UAT)
                                   │
                                   └──> S4 SK register (EMP-010)
S2 + S4 ──> S5 contract actions + projection + import guard (AUTHORITATIVE capable)
S5 ──> S6 career actions (placement/transfer/promotion/demotion)
S6 ──> S7 reversal, contract worklist, self-service
S7 ──> S8 pilot activation runbook (ops doc; production only with owner approval)
```

S3 and S4 can run in parallel after S2. S6 and the self-service part of S7 can be split further if review load requires it.

## S1 — Schema and domain resolver (no routes, no UI)

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
**Prerequisite decisions:** D-02 (category mapping list may be provisional; unmapped stays `BELUM_DIKLASIFIKASIKAN`), D-14, D-16.

- Migration `00NN_employment_permissions.sql`: insert `employment.read`, `employment.manage`, `employment.correct`; grant `employment.read`/`employment.manage` to `human_capital_admin`; `employment.correct` per D-16 (no account is assigned by migration, consistent with migration 0045).
- Add the keys to `apps/api/src/modules/auth/permissions.ts` and `docs/domain/AUTH-011-admin-route-permissions.json`.
- CLI `employment-baseline` (`--dry-run` default, `--apply`, `--employee <id>` re-run, `--purge-baseline`): counts-only stdout; per-employee issues stored for the consistency report; audit `employment.baseline.*`.
- Rollout endpoints (permission `access.governance.manage`): `GET/PUT /admin/employment/rollout` with reason; audit `employment.mode.changed`.
- Read endpoints (permission `employment.read`, scope-checked):
  - `GET /admin/employees/{employeeId}/employment` — derived current summary + employments, terms, placements.
  - `GET /admin/employees/{employeeId}/employment/timeline` — actions with "dari → menjadi" snapshot and SK refs.
  - `GET /admin/employment/consistency` — grouped issue counts + paginated rows (incl. ORG-004 incumbency mismatch and projection lag).
- **OpenAPI:** add the five paths above with schemas `EmploymentSummary`, `EmploymentTerm`, `Placement`, `EmploymentAction`, `EmploymentConsistencyReport`, `EmploymentRolloutSetting`, and error codes. (Note: existing `/admin/employees*` routes are not yet in `docs/api/openapi.yaml`; this step documents only the new paths and records that gap as a follow-up.)
- Tests: route permission positive/negative (including unit scope), self-access via admin route still requires permission, mode `OFF` returns `EMPLOYMENT_HISTORY_DISABLED`, baseline idempotency, baseline never invents dates, baseline issue codes, audit payload has no PII (assert key allowlist).
- **Rollback:** mode stays `OFF`; `--purge-baseline`; revert permissions migration only if no account holds them.

## S3 — Admin read UI (tabs, timeline, consistency report)

**Spec:** §13.1, §13.2 (read parts), §13.6, EMP-PKG1-X2.  
**Prerequisite:** S2 merged. Can run parallel to S4.

- `apps/web`: employee detail tabs **Kepegawaian & Kontrak** and **Penempatan & Karier** (read-only, action buttons hidden), menu **Kepegawaian → Periksa kecocokan data**.
- States: loading, empty, error, forbidden/session-expired, mobile.
- Tests: component/route tests; browser smoke with synthetic data in mode `SHADOW` on a local stack.
- **OpenAPI:** none (consumes S2).
- **Rollback:** revert PR; routes hidden while mode `OFF`.

## S4 — Decision document register (EMP-010)

**Spec:** EMP-010-A/B, §4.5, §13.5.  
**Prerequisite decisions:** D-08 (types), D-09 (correction rule).

- Endpoints: `GET/POST /admin/decision-documents`, `GET/PATCH /admin/decision-documents/{documentId}` (PATCH rejected with `DECISION_DOCUMENT_LOCKED` once linked), `POST /admin/decision-documents/{documentId}/corrections` (`employment.correct`).
- UI: **Kepegawaian → Surat Keputusan** list/detail/create.
- Tests: uniqueness rule, lock after link, correction keeps prior values, permissions, audit events.
- **OpenAPI:** add paths + `DecisionDocument` schema.
- **Rollback:** revert; table remains empty-or-unused.

## S5 — Contract actions, projection writer, import guard

**Spec:** EMP-005-A/B/C/D/F/G/H, §6, §7, §8.4, §8.5, §11, §12.  
**Prerequisite decisions:** D-03, D-04, D-05, D-07, D-10, D-12, D-13, D-15, D-19; ops decision for the daily refresh host (spec §8.4 TBD).

- Endpoints (`employment.manage`, `Idempotency-Key`, `expectedVersion`):
  - `POST /admin/employees/{employeeId}/employment-actions/preview`
  - `POST /admin/employees/{employeeId}/employment-actions`
  - Supported types in this step: `HIRE`, `CONTRACT_EXTENSION`, `CATEGORY_CHANGE`, `TERMINATION`.
- Projection writer in the same transaction; daily/manual refresh command; `employment.projection.refreshed` audit.
- EMP-004 import change: in `AUTHORITATIVE`, skip employment fields for baselined employees, show "Diabaikan" in preview, audit `employment.import.fields_ignored`; D-19 transitional baseline for new NIPs.
- UI: action dialog (§13.3) for the four contract actions; termination follow-up hint.
- Tests: transaction atomicity (inject failure → nothing written), idempotent replay, version conflict, self-action denial, SK required, warnings acknowledgement, projection equality for annual-leave eligibility/Board/ORG-006 regression fixtures, import unchanged in `OFF`/`SHADOW`, import guard in `AUTHORITATIVE`, no account/role change.
- **OpenAPI:** add both paths, `EmploymentActionRequest` (discriminated by `actionType`), `EmploymentActionPreview`, error schema codes.
- **Rollback:** set mode `OFF` (import writes again); history kept; see spec §8.6.

## S6 — Career actions

**Spec:** EMP-006-A/B/C/D.  
**Prerequisite decisions:** D-06, D-18. ORG-004 acceptance state determines whether placements use stable keys or legacy references for pilot.

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
- If D-17 approved: `GET /employees/me/employment` (own data, no reason notes) and **Profil saya → Kepegawaian**.
- Tests: reversal exactness, non-latest rejection, double reversal rejection, self-service shows only own record and hides restricted fields, worklist scope.
- **OpenAPI:** add paths + `EmploymentSelfView`.
- **Rollback:** revert PR; reversals already recorded remain valid history.

## S8 — Pilot activation runbook (documentation + owner-approved ops)

- Document in `docs/development/` how to: take the verified backup, deploy the release via OPS-MI8-REL-001, run baseline dry-run (counts only), owner review of counts, apply baseline, switch to `SHADOW`, HC UAT, resolve consistency issues, switch to `AUTHORITATIVE` for the pilot.
- Exit criteria for `AUTHORITATIVE`:
  1. zero `BASELINE_STATUS_CONFLICT`;
  2. all employment categories mapped (no `BELUM_DIKLASIFIKASIKAN` for active employees);
  3. every active fixed-term employee has a known contract end date or an explicit HC acknowledgement;
  4. projection equals current `employees` columns for every baselined employee (no unintended change at switch-over);
  5. annual-leave eligibility, Board, ORG-006 outputs unchanged on a scratch-restore rehearsal;
  6. HC sign-off and owner approval recorded.
- No production change without explicit owner approval.

## Documentation to update in each step

- `docs/domain/employment-administration-package1.md` (status per acceptance criterion), `docs/product/feature-parity.yaml` (status `implementing` → `implemented` → `verified`), `docs/api/openapi.yaml`, `docs/domain/AUTH-011-admin-route-permissions.json` when routes are added, `docs/domain/glossary.md` when vocabulary is finalized by D-02/D-10.
