# ORG-010 — Board view for Employees and HCIS governance summary for SQ Hub

**Status:** ACCEPTED by the Product Owner on 2026-10-17. Implemented in the repository (see "Implementation notes"), with the summary endpoint off by default. Release to Mi8VPS and enabling `GOVERNANCE_SUMMARY_ENABLED` still need review, CI, and explicit owner approval (OPS-MI8-REL-001).
**Specification:** ORG-010
**Date:** 2026-10-17
**Extends:** ORG-003 (`foundation-board-dashboard.md`)
**Related:** AUTH-010 (`access-model.md`), AUTH-011 (`hcis-authorization-modernization.md`), EMP-005/EMP-006 (`employment-administration-package1.md`), HCIS-ID-001, HUB-IMPL-003 (identity mapping CLI)
**External:** SQ Hub [ADR-0009](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/architecture/adr/0009-ringkasan-yayasan-governance-view.md) (ACCEPTED) and [HUB-IMPL-021](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/specs/HUB-IMPL-021-ringkasan-yayasan.md) (ACCEPTED), merged to main on 2026-10-17 ([sabilulquran/SQ-Hub#122](https://github.com/sabilulquran/SQ-Hub/pull/122))

## Why

The Product Owner decided on 2026-10-17 (recorded in SQ Hub ADR-0009, ACCEPTED) that members of the Yayasan organs (Pembina, Pengurus, Pengawas) land on **Ringkasan Yayasan** in SQ Hub. Hub shows one summary card per application. Each application owns its figures and its own governance permission. Hub fetches each summary **as the user**, with a token obtained through Keycloak token exchange.

Two of those decisions need HCIS changes:

1. **Salaried Pengurus are HCIS Employees** when their pay goes through HCIS payroll. They sign in with their staff Akun SQ, which HCIS maps to an `EMPLOYEE` account. Today `/board` accepts only a `FOUNDATION_BOARD` principal, so a salaried Pengurus cannot open it. The owner decided that HCIS adds a **board-view permission that can be given to an `EMPLOYEE` account as a role**. `FOUNDATION_BOARD` stays for members who are not staff.
2. **HCIS publishes a governance summary** in the HUB-IMPL-021 contract v1, built from the ORG-003 aggregates.

This spec covers both, plus what happens to a member who is not staff and later becomes an Employee.

## Scope

In scope:

- a new HCIS permission `board.read` and a new HCIS system role that carries it, assignable to an `EMPLOYEE` account;
- `/board` and `GET /board/dashboard` accepting either access path (§2);
- `GET /governance/summary`, bearer-only, implementing HUB-IMPL-021 contract v1 (§3, §4);
- the identity hand-over when a non-staff member becomes an Employee (§5);
- audit events, errors, tests, rollout and rollback.

Out of scope:

- any new metric beyond ORG-003, except the trend and ranking in §4.3 and §4.4;
- attendance, payroll, salary, or other financial aggregates (ORG-003-F still applies);
- named employee drill-down;
- any mutation by a board principal;
- the Hub side (membership, registry, page), which HUB-IMPL-021 owns;
- syncing Hub organ membership with the HCIS role. HCIS never reads Hub membership to grant `board.read`.

## Terms

| Term | Meaning |
| --- | --- |
| Board access | Permission to read `/board` and the governance summary. Comes from **either** an active `FOUNDATION_BOARD` account **or** an effective `board.read` role assignment on an active `EMPLOYEE` account. |
| Board-view role | The new HCIS system role (key `foundation_board_viewer`, label "Panel Organ Yayasan") that carries only `board.read` (D11). |
| Governance summary | The HUB-IMPL-021 v1 response HCIS returns to Hub for one user. Aggregate only. |
| Exchanged token | A short-lived Keycloak access token that Hub obtains by token exchange, with `aud` containing the HCIS client ID. |

## 1. Board-view role

### 1.1 Permission and role

| Item | Value |
| --- | --- |
| Permission key | `board.read` — "Membaca Panel Organ Yayasan (agregat)" |
| Role key | `foundation_board_viewer` (D11) |
| Role label | "Panel Organ Yayasan" |
| Role permissions | `board.read` only |
| Scope | `organization` only, `organizational_unit_id` null. Unit or own scope is refused (`ROLE_SCOPE_INVALID`). |
| Reason | Required, nonempty. The reason should name the mandate, for example the SK number for the Pengurus term. |
| Dates | `startsOn` optional; `endsOn` strongly recommended and should equal the organ term end. Inclusive dates, as in AUTH-011. |
| Target | `EMPLOYEE` accounts only (the existing role-assignment rule). A `FOUNDATION_BOARD` or `SUPER_ADMIN` account cannot receive it. |

`board.read`:

- is **not** in `HC_OPERATIONAL_PERMISSIONS`, `HC_ADMIN_PERMISSIONS`, or `EMPLOYMENT_PERMISSIONS`;
- is **not** in `ADMIN_PERMISSIONS`, so legacy Super Admin compatibility never grants it (a Super Admin still cannot open `/board`, as today);
- grants no other permission and no mutation. It does not let the Employee read any employee record, evidence, or payslip beyond their own self-service.

The `management` role from migration 0004 (`reports.read.organization`) is **not** reused: its meaning is "management reports per mandate", which is broader and undefined. Board access gets its own narrow permission so it can be granted and audited on its own.

### 1.2 Who may grant or remove it

Only **Super Admin**, through the existing routes:

- `POST /admin/access/accounts/:accountId/role-assignments`
- `DELETE /admin/access/role-assignments/:assignmentId`

This follows the owner decision of 2026-10-16 (AUTH-011): only Super Admin grants or removes roles. Holders of `access.governance.manage` keep their current job (preparing and activating `FOUNDATION_BOARD` accounts) but cannot grant this role. Existing guards stay: no self-assignment, known HCIS system roles only, valid scope and dates, mutation and audit in one transaction.

Decided by the owner on 2026-10-17 (D1): Super Admin only. Holders of `access.governance.manage` cannot grant it.

### 1.3 Effective board access

A request has board access when **one** of these is true at request time:

- **Path B (not staff):** the account is `FOUNDATION_BOARD` and `status = active`.
- **Path A (staff):** the account is `EMPLOYEE`, `status = active`, the linked employee is `active`, and an assignment carrying `board.read` has organization scope and today is within `startsOn..endsOn`. This is exactly `hasOrganizationPermission(db, accountId, "board.read")`.

Anything else has no board access. Ending the Employee's employment, suspending the account, or reaching `endsOn` removes board access on the next request. There is no cache.

### 1.4 Navigation

- `EMPLOYEE` still lands on `/app`. An Employee with `board.read` sees a "Panel Organ Yayasan" entry in the employee shell that links to `/board`.
- `/auth/me` already returns `authorization.organizationPermissions`. `board.read` appears there when effective; the web app uses it to show the entry. Hiding the entry is not authorization.
- `FOUNDATION_BOARD` still lands on `/board` and still cannot open `/app` or `/admin`.
- An Employee using `/board` keeps their normal `/app` access and any other roles. Board access adds nothing to `/admin`.

## 2. `/board` changes

- `GET /board/dashboard` uses a new guard `requireBoardAccessFromCookie` that implements §1.3, replacing `requirePrincipalFromCookie(..., "FOUNDATION_BOARD")`.
- The web route `/board` (`apps/web/src/router.tsx`) allows `FOUNDATION_BOARD`, or `EMPLOYEE` whose `/auth/me` lists `board.read`.
- The response keeps its shape except that `actor.email` is removed (D7). `actor.principalType` may now be `EMPLOYEE`.
- `docs/domain/AUTH-011-admin-route-permissions.json` lists `/board/dashboard` with `access: "board"` (principals `FOUNDATION_BOARD, EMPLOYEE`, permission `board.read` for `EMPLOYEE`) and `/governance/summary` with `access: "governance-bearer"`. `auth011-route-coverage.test.ts` and the AUTH-011 persona matrix check both.
- ORG-003-B to ORG-003-F are unchanged. ORG-003-A is amended by ORG-010-A.

## 3. Governance summary endpoint: authentication

### 3.1 Route

```
GET /governance/summary
Authorization: Bearer <exchanged access token>
Accept: application/json
```

Public URL on the HCIS origin: `https://<hcis-canonical-host>/api/governance/summary`. The `/api` prefix follows the existing web proxy; verify during implementation. The Hub registry gets `governance_summary_path = /api/governance/summary` and `governance_audience = <HCIS OIDC client ID>`.

`docs/api/openapi.yaml` carries the accepted, not yet implemented entry for this path and the `GovernanceSummaryBearer` scheme.

The route is **disabled by default** (`GOVERNANCE_SUMMARY_ENABLED=false` → `404`), like HCIS-ID-001. Enabling it on production needs owner approval.

### 3.2 Token checks

HCIS verifies the token with the existing `jose` pattern used by `organization-directory/machine-auth.ts` (remote JWKS from the issuer, 3-second deadline):

1. signature valid against the staff realm JWKS; algorithm `RS256` only (verify the realm's signing algorithm during implementation);
2. `iss` equals `OIDC_ISSUER` exactly (trailing slash removed), the same issuer HCIS login uses;
3. `exp` in the future and `iat`/`nbf` not in the future, with at most 30 seconds of clock skew;
4. `aud` contains `GOVERNANCE_SUMMARY_AUDIENCE` (the HCIS OIDC client ID);
5. `typ` claim equals `Bearer`, so an ID token or refresh token is refused (verify the claim on exchanged tokens in the Mi8VPS probe);
6. `azp` is in `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS`, which holds only the SQ Hub client. Only tokens exchanged by Hub are accepted (verify `azp` on a Keycloak standard token exchange result in the Mi8VPS probe);
7. `sub` present, 1–512 characters.

The Authorization header must contain exactly one bearer token. A cookie on this request is ignored: the endpoint never authenticates by cookie, and a valid cookie without a bearer token gets `401`.

### 3.3 Mapping and access

After the token checks:

1. Map `iss + sub` to one account, exactly as `OidcLoginService.findMappedAccount` does (`accounts.identity_issuer`, `accounts.identity_subject`). No match, or more than one → `403 OIDC_ACCOUNT_NOT_MAPPED`.
2. Account `status` not `active` → `403 ACCOUNT_INACTIVE`.
3. Board access per §1.3. None → `403 BOARD_ACCESS_REQUIRED`.
4. Re-check (D3) SQ Hub Application Access for this identity with the existing `SqHubApplicationAccessClient`, as login does. Denied → `403 HCIS_ACCESS_DENIED`; unavailable → `503 APPLICATION_ACCESS_UNAVAILABLE`.

No HCIS session is created, no cookie is set, and no refresh happens.

### 3.4 Bearer only on this route

- Only `GET /governance/summary` reads the `Authorization` header for a user identity. No other HCIS route accepts the exchanged token: every other user route keeps the cookie session. A test sends a valid exchanged token to `/board/dashboard`, `/auth/me`, an `/app` route and an `/admin` route and expects `401`.
- The machine-token routes (HCIS-ID-001, Organization Directory) keep their own audiences (`hcis-staff-identity`, Organization Directory audience). A governance token is refused there because the audience differs, and their tokens are refused here because `aud`/`azp` differ.
- `GOVERNANCE_SUMMARY_AUDIENCE` must differ from the two machine audiences. Startup fails if they are equal.

### 3.5 Two-step verification

The owner requires TOTP for every organ member. Keycloak enforces it (HUB-IMPL-021 `CONFIGURE_TOTP`). HCIS v1 does not inspect `acr`/`amr` on the exchanged token (D4). An `acr` check can be added once the staff realm publishes a level for TOTP sign-in.

## 4. Governance summary endpoint: content

### 4.1 Response

`200`, `Content-Type: application/json`, `Cache-Control: private, no-store`. Shape is HUB-IMPL-021 `GovernanceSummaryV1`:

| Field | HCIS value |
| --- | --- |
| `contractVersion` | `1` |
| `applicationKey` | the HCIS key in the Hub registry, from config `GOVERNANCE_SUMMARY_APPLICATION_KEY` (verify the registry key during implementation, likely `hcis`) |
| `title` | `"SDM"` |
| `dataAsOf` | request time; figures are live (ORG-003-B) |
| `detailUrl` | `https://<hcis-canonical-host>/board` |

All labels are fixed Indonesian strings in code, never data values, except unit names in §4.4.

### 4.2 Metrics (live, from ORG-003)

At most 6, in this order:

| `key` | `label` | Source (ORG-003 query) | Notes |
| --- | --- | --- | --- |
| `active_employees` | Pegawai aktif | `employees.status = 'active'` | `headline: true`, `unit: "orang"`, carries `trend` when §4.3 allows |
| `started_this_year` | Pegawai masuk tahun ini | `started_on` in current year | `unit: "orang"` |
| `ended_this_year` | Pegawai keluar tahun ini | `ended_on` in current year | `unit: "orang"` |
| `without_direct_manager` | Pegawai aktif tanpa atasan langsung | readiness query | `tone: "attention"` when > 0 |
| `units_without_approver` | Unit tanpa penyetuju cuti | readiness query | `unit: "unit"`, `tone: "attention"` when > 0 |
| `leave_in_review` | Pengajuan cuti dalam proses | workflow query | `unit: "item"` |

`attention` (0 to 3 items, only when count > 0, each `href` on the HCIS origin):

- "Unit tanpa penyetuju cuti" → `/board`;
- "Validasi HC menunggu" (`hcValidationPending`) → `/board`;
- "Kasus presensi belum selesai" (`attendanceResolutionOpen`) → `/board`.

These are workload counts, which ORG-003-E already shows. They are not attendance aggregates in the ORG-003-F sense: no attendance percentages, lateness, absence rates, or anything derived from attendance records.

Records marked "di luar pengelolaan HCIS" (EMP-005 §8.7) are excluded from every count once that marker exists, as for `/board`.

### 4.3 Monthly active-headcount trend — conditional

**Schema finding (2026-10-17, `origin/main` 5e4ddc9).** Migration `0056_employment_history_foundation.sql` (EMP-005 S1) added effective-dated history:

- `employments`: `started_on`/`ended_on` per employment, with `start_basis` and `end_basis` (`RECORDED` or `UNKNOWN`), `voided_by_action_id`;
- `employment_terms`: category per period;
- `employment_placements`: unit per period, but the baseline placement starts at the **baseline cutoff date** with `effective_from_basis = BASELINE_ASSUMED`;
- `employment_rollout_settings.mode`: `OFF`, `SHADOW`, or `AUTHORITATIVE`.

S2 (#117) added the baseline backfill. What this means for a trend:

- Headcount at a month end can be computed as employments not voided with `started_on <= month_end` and (`ended_on` null or `ended_on > month_end`).
- **It is reliable only in `AUTHORITATIVE` mode.** In `OFF` there is no history. In `SHADOW`, EMP-004 import still writes `employees` and history is not updated, so recent months drift from reality.
- Baseline rows with `start_basis = UNKNOWN` have no start date, and ended rows with `end_basis = UNKNOWN` have no end date. Each such row makes earlier months unknowable.
- Rehires before the baseline are not in history: the baseline creates one employment per employee from the current master.

Rule:

- HCIS includes `trend` on `active_employees` and a `trend` chart (`key: "active_headcount_monthly"`, title "Pegawai aktif per bulan", one `line` series, `unit: "orang"`) **only when** the mode is `AUTHORITATIVE`.
- Periods: the last 12 completed months, oldest first; the current month is not included (D6).
- A month gets `null` (a gap, never zero) when any non-voided employment has an unknown basis that could change that month's count, or when the month ends before the earliest recorded `started_on` among active baseline rows. Fewer than 6 non-null points → omit the trend and chart entirely.
- `change` compares the last point with the point 12 months earlier when both exist; `good` is not set (neutral colour), because more or fewer staff is not good or bad on its own.
- Until then, HCIS omits `trend` and the chart, which the contract allows. The card works with metrics only.

Current production mode: not inspected (verify read-only during implementation). The EMP-005 plan keeps `AUTHORITATIVE` behind S5/S5A releases and an owner decision, so expect no trend at first.

A reconstruction from `employees.started_on`/`ended_on` alone is **rejected**: it loses rehires, treats unknown dates as known, and would present a guess as history.

### 4.4 Headcount by unit — available now

The ranking needs only **current** unit placement, not history. ORG-003 already computes "active headcount by organizational unit" from `employees.organizational_unit_id`.

- Chart `kind: "ranking"`, `key: "active_headcount_by_unit"`, title "Pegawai aktif per unit", `unit: "orang"`.
- Units with fewer than 3 active employees are folded into "Lainnya" first (D5). Of the rest, up to 7 largest units by count, ties sorted by name, then one "Lainnya" item with the sum of everything folded. Without anything to fold, up to 8 units are shown. "Tanpa Unit" is an ordinary item.
- Labels are unit names from `organizational_units.name`. A unit name is an organization fact, not personal data.
- Small cells: folding units under 3 follows the HUB-IMPL-021 rule on figures that describe one person. `/board` keeps its full unit list.
- When ORG-004 becomes the unit source for placements, the ranking follows whatever ORG-003 uses at that time; it never mixes sources in one response.

No `composition`, `stages`, or `target` charts in v1.

### 4.5 Privacy

Same as ORG-003-C and HUB-IMPL-021:

- no names, NIP, NIK, e-mail, phone, dates of birth, account numbers, documents, evidence, or payslip data;
- no per-person rows;
- no attendance or payroll aggregates (ORG-003-F);
- `actor` information is **not** included;
- the response body is never logged and never written to the database or audit events.

## 5. Non-staff member who becomes an Employee

The member keeps the same Akun SQ identity (`iss + sub`). HUB-IMPL-013 must find the existing identity by e-mail and not create a second one (Hub's job).

In HCIS, `accounts.identity_issuer + identity_subject` is unique, so the identity moves from the old account to the new one:

| Step | Who | What |
| --- | --- | --- |
| 1 | HC | The person is recorded as an Employee (EMP-004 import, or **Mulai hubungan kerja** once EMP-005 is authoritative). Their `EMPLOYEE` account exists, unmapped. |
| 2 | Operator | **Identity hand-over** (new CLI mode): preview, then `--apply`. In one transaction under the existing advisory lock: clear the mapping on the `FOUNDATION_BOARD` account, set it to `inactive`, end its sessions, map the identity to the `EMPLOYEE` account. Requires `HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1`. Refuses when the target is not an active `EMPLOYEE` account or already has another identity. |
| 3 | Super Admin | If the person is still an organ member, grants the board-view role with the term end as `endsOn`. |

- The old `FOUNDATION_BOARD` account is never deleted; it stays `inactive` for audit.
- Between steps 2 and 3 the person has no board access and Hub hides the HCIS card. Doing step 3 right after step 2 keeps the gap short. The CLI does not grant the role (D8).
- The reverse (an Employee who leaves staff but stays an organ member) uses the same hand-over in the other direction to a new or re-activated `FOUNDATION_BOARD` account, prepared by a holder of `access.governance.manage`.

Without the new CLI mode, the existing command can do it in two runs (`--clear --apply` on the old account, then map on the new one) plus a separate account deactivation. That leaves a window where the identity maps to nothing, so the combined mode is preferred.

### 5.1 Non-staff member from the start (HUB-IMPL-021 Path B)

A non-staff organ member gets a `FOUNDATION_BOARD` account: prepared (`invited`) by a holder of `access.governance.manage`, mapped to their Akun SQ `iss + sub` by the operator command, then set **Aktif** by the same administrator. Activation without a local password is allowed only for a mapped identity from the configured issuer (AUTH-002 "Aktivasi melalui Akun SQ", 2026-10-18). Before this fix the status route refused `active` for any account without a password, so such a member could never pass §3.3.

## 6. Interaction with EMP-005 D-02

EMP-005 Package 1 D-02 (owner, 2026-10-16) says `Pengurus Yayasan` in STATUS KEPEGAWAIAN is **not** an employment status: the baseline creates no employment for those rows and marks them "di luar pengelolaan HCIS".

The 2026-10-17 decision says a **salaried** Pengurus paid through HCIS payroll is an Employee. These fit together if:

- the `Pengurus Yayasan` value in the workbook still creates no employment;
- a salaried Pengurus is recorded with a real employment category (for example Pegawai Tetap or Pegawai Kontrak) chosen by HC, and is counted as an active employee in `/board` and the summary like any other Employee;
- board access for them comes only from the board-view role, never from their status value or job title.

Decided by the owner on 2026-10-17 (D2): a salaried Pengurus keeps their real category, set by HC, and counts in "Pegawai aktif".

## 7. Errors

| HTTP | Code | When |
| --- | --- | --- |
| 404 | — | `GOVERNANCE_SUMMARY_ENABLED` is false |
| 401 | `UNAUTHENTICATED` | no bearer token, malformed header, or several tokens |
| 401 | `INVALID_TOKEN` | signature, issuer, expiry, `typ`, or `sub` check fails |
| 403 | `FORBIDDEN_AUDIENCE` | `aud` lacks the HCIS client ID |
| 403 | `FORBIDDEN_CLIENT` | `azp` not allowlisted |
| 403 | `OIDC_ACCOUNT_NOT_MAPPED` | no single account for `iss + sub` |
| 403 | `ACCOUNT_INACTIVE` | account not active |
| 403 | `BOARD_ACCESS_REQUIRED` | no board access per §1.3 |
| 403 | `HCIS_ACCESS_DENIED` | Application Access denied (D3) |
| 503 | `APPLICATION_ACCESS_UNAVAILABLE` | Application Access check failed (D3) |
| 503 | `JWKS_UNAVAILABLE` | signing keys unreachable within the deadline (D9) |
| 500 | — | database error; body has no detail |

Every error sets `Cache-Control: no-store`. Error bodies never echo the token or its claims.

## 8. Audit

Written to `auth_audit_events` (account ID when known, event type, IP, user agent). Never the token, claims, or response body.

| Event | When |
| --- | --- |
| `role.assignment.created` / `role.assignment.removed` | existing events, now also for the board-view role (role key, scope, dates, reason length, actor) |
| `governance.summary.served` | `200` returned |
| `governance.summary.denied` | any `401`/`403`, with a reason code from §7; account ID only when mapping succeeded |
| `auth.oidc.identity_handed_over` | §5 step 2 applied: old account ID, new account ID, actor (operator) |
| `board.dashboard.viewed` | Not added (D10); `/board` reads stay unaudited as today |

Hub caches a summary for up to 60 seconds per session, so `served` volume stays small.

## 9. Configuration

| Variable | Meaning |
| --- | --- |
| `GOVERNANCE_SUMMARY_ENABLED` | `false` by default |
| `GOVERNANCE_SUMMARY_AUDIENCE` | HCIS OIDC client ID; must differ from machine-token audiences |
| `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS` | comma-separated; only the SQ Hub client |
| `GOVERNANCE_SUMMARY_APPLICATION_KEY` | registry key returned as `applicationKey` |
| issuer | reuses `OIDC_ISSUER` |

## 10. Database changes

Additive migration (number assigned at implementation):

- insert permission `board.read`;
- insert system role `foundation_board_viewer` with only `board.read`;
- no assignment is seeded; no account is changed; no real identity appears in the migration.

Rollback: remove assignments through the reviewed DELETE route first, then the down script deletes the role-permission row, the role, and the permission. Audit rows stay.

The identity hand-over (§5) is a CLI change, not a schema change.

## 11. Tests required

Every new permission needs automated tests (AGENTS.md §7). Minimum:

**Board access (API and web)**

- `FOUNDATION_BOARD` active → `/board/dashboard` 200 (regression);
- `EMPLOYEE` with effective organization-scope `board.read` → 200;
- `EMPLOYEE` without the role → 403; with the role but unit scope (refused at grant) → cannot be created;
- assignment not yet started, or past `endsOn` → 403;
- account suspended/inactive, or employee inactive/resigned → 403;
- `SUPER_ADMIN` → 403 (no compatibility grant);
- an Employee with `board.read` gets no new `/admin` permission, and any mutation route still 403;
- `/auth/me` lists `board.read` only when effective; the web shell shows the entry only then; the `/board` route guard allows it and denies otherwise;
- `FOUNDATION_BOARD` still cannot open `/app` or `/admin`.

**Role grant**

- Super Admin grants and removes the role; both write audit events atomically;
- Human Capital, Human Capital Administrator, holders of `access.roles.assign`, `access.roles.delegate`, or `access.governance.manage` → `403 ROLE_GRANT_SUPER_ADMIN_ONLY`, nothing written;
- self-grant refused; missing reason refused; target `FOUNDATION_BOARD` account refused.

**Governance summary**

- valid exchanged token for a `FOUNDATION_BOARD` account → 200 matching contract v1;
- same for an `EMPLOYEE` with `board.read`;
- each failure in §7 returns its code: bad signature, wrong issuer, expired, `aud` without HCIS, `aud` of another app, `azp` not allowlisted, ID token, unmapped `sub`, inactive account, no board access;
- a Staff Identity or Organization Directory machine token is refused, and the exchanged token is refused on those machine routes;
- the exchanged token on `/board/dashboard`, `/auth/me`, an `/app` route, and an `/admin` route → 401;
- a session cookie alone on `/governance/summary` → 401;
- response contains no name, NIP, e-mail, or `actor`; labels are fixed strings; `applicationKey` and `detailUrl` match config;
- `GOVERNANCE_SUMMARY_ENABLED=false` → 404;
- no token, claim, or body is logged (log capture assertion);
- trend present only in `AUTHORITATIVE` mode; unknown-basis rows produce `null` points; fewer than 6 points omits trend and chart;
- ranking has at most 8 items, folds units with fewer than 3 active employees into "Lainnya", and folds the rest beyond 7 when anything is folded;
- trend has only completed months (no current month);
- JWKS unreachable → `503 JWKS_UNAVAILABLE`; Application Access denied → 403, unavailable → 503;
- `GET /board/dashboard` no longer returns `actor.email`;
- audit events written for served and denied requests.

**Identity hand-over**

- preview writes nothing; apply moves the identity, deactivates the old account, ends its sessions, writes one audit event;
- refused when the target is not an active `EMPLOYEE`, already mapped, or the source does not hold the identity;
- after hand-over, OIDC login lands the person on their `EMPLOYEE` account.

All tests use synthetic data. Quality gates (typecheck, lint, test, build) must actually run.

## 12. Rollout

1. Done: the owner answered the open questions and accepted this spec on 2026-10-17.
2. Implement in HCIS behind `GOVERNANCE_SUMMARY_ENABLED=false`; migration is additive.
3. Release to Mi8VPS through OPS-MI8-REL-001 with owner approval.
4. Keycloak token-exchange configuration (Hub's job, owner approval) and a probe: an exchanged token with `aud` = HCIS is accepted; a token for another audience, and Hub's own session token, are refused.
5. Enable the flag with owner approval. Hub adds the registry fields.
6. Super Admin grants the board-view role to salaried Pengurus who are organ members, with term end dates.

Every production change on Mi8VPS needs explicit owner approval.

## 13. Rollback

- Set `GOVERNANCE_SUMMARY_ENABLED=false`: the endpoint returns 404 and Hub hides the HCIS card. No data to purge.
- Remove board-view assignments through the DELETE route; `/board` returns to `FOUNDATION_BOARD` only in effect.
- Reverting the guard code restores ORG-003-A behaviour. The additive role and permission can stay.
- An identity hand-over is reversed by running it in the other direction.

## Implementation notes

Implemented on 2026-10-17. Facts fixed during implementation, within the decisions above:

- **Migration** `apps/api/migrations/0059_board_read_permission.sql`: permission `board.read` and system role `foundation_board_viewer` (fixed ID `10000000-0000-4000-8000-000000000010`, name "Panel Organ Yayasan") carrying only `board.read`. It also adds two nullable columns to `auth_audit_events`: `reason_code` (an upper-case code only, enforced by a CHECK) so `governance.summary.denied` carries its §7 code, and `related_account_id` so `auth.oidc.identity_handed_over` names the previous account. No assignment is seeded. Rollback as in §10; the columns may stay.
- **Grant guards** (`role-assignment.ts`): the board-view role answers `400 ROLE_SCOPE_INVALID` for unit or own scope and `400 ROLE_REASON_REQUIRED` for a missing or blank reason. The role-assignment routes answer `403 ROLE_GRANT_SUPER_ADMIN_ONLY` to every signed-in non-Super-Admin before any permission check (ORG-010-C).
- **Board guard**: `requireBoardAccessFromCookie` (`auth/authorization.ts`) uses `hasBoardAccess` (`auth/permissions.ts`). A suspended or inactive account's cookie session ends with the account, so `/board/dashboard` answers `401` for it; an inactive or resigned employee record answers `403`.
- **Aggregates** moved to `apps/api/src/modules/board/aggregates.ts`, shared by `/board/dashboard` and the summary, so both always use the same ORG-003 queries.
- **Summary** (`apps/api/src/modules/governance/`): the route is always registered and answers `404` while the flag is off. When on, configuration requires `AUTH_MODE=oidc` (issuer and Application Access client) and the three `GOVERNANCE_SUMMARY_*` values; startup fails when the audience equals a machine-token audience. `GOVERNANCE_SUMMARY_ENABLED` accepts `true`/`false` (also `1`/`0`). `detailUrl` and attention links use the origin of `OIDC_REDIRECT_URI`, the HCIS origin users sign in on; no separate variable was added. Business months follow Asia/Jakarta. `change.value` is the absolute difference, with `direction`. A month whose month end precedes the earliest recorded start among active baseline rows is `null`. Unknown dates make a month `null` only when they could change that month: an unknown end does not affect months before the recorded start, and a recorded end before the month makes an unknown start irrelevant.
- **Hand-over CLI**: `npm run auth:map-oidc-identity -- --hand-over --from-account-id <uuid> --to-account-id <uuid> [--apply]`, documented in `docs/migration/HUB-IMPL-003-identity-mapping-cli.md`. Works in both directions (`FOUNDATION_BOARD` ↔ `EMPLOYEE`). The audit row has the new account as `account_id`, the old one as `related_account_id`, and `operator-cli:map-oidc-identity` as user agent.
- **Web**: the `/board` guard uses `canAccessBoard`; the employee shell shows "Panel Organ Yayasan" under "Tugas" when `/auth/me` lists `board.read`; `/board` offers "Beranda HCIS" back to `/app` for an Employee.
- **Tests**: `apps/api/test/governance-summary.test.ts` (ranking, trend, contract, token verifier, configuration), `apps/api/test/org010-board-governance.postgres.test.ts` (board access, role grant, live endpoint, audit, log capture, hand-over, OIDC login after hand-over), and updates to the AUTH-011 suites and web tests.

Still to verify on Mi8VPS with owner approval (unchanged): the realm signing algorithm, `typ` and `azp` on an exchanged token, the `/api` prefix, the Hub registry key, and the employment-history mode.

## Acceptance criteria

- ORG-010-A: `/board` and `GET /board/dashboard` allow an active `FOUNDATION_BOARD` account, or an active `EMPLOYEE` with an active employee record and an effective organization-scope assignment carrying `board.read`; everyone else gets 403. (Amends ORG-003-A.)
- ORG-010-B: `board.read` is carried only by the board-view role, is outside every HC bundle and outside legacy Super Admin compatibility, and grants no mutation.
- ORG-010-C: only Super Admin can grant or remove the board-view role; every other actor gets `ROLE_GRANT_SUPER_ADMIN_ONLY` with nothing written. Grants require organization scope and a reason.
- ORG-010-D: `GET /governance/summary` accepts only a bearer token whose signature, issuer, expiry, `typ`, audience (HCIS client), and `azp` (SQ Hub) are valid, maps `iss + sub` like OIDC login, and requires board access.
- ORG-010-E: the exchanged token is refused by every other HCIS route, and the endpoint never authenticates by cookie or creates a session.
- ORG-010-F: the response follows HUB-IMPL-021 v1 with ORG-003 aggregates only, no actor data, no PII, and no attendance or payroll aggregates.
- ORG-010-G: the monthly active-headcount trend covers the last 12 completed months, appears only in employment-history `AUTHORITATIVE` mode, uses `null` for months that unknown dates make uncertain, and is omitted with fewer than 6 known points.
- ORG-010-H: the headcount-by-unit ranking has at most 8 items, largest first, with units under 3 active employees and any overflow folded into "Lainnya".
- ORG-010-I: the identity hand-over moves one Akun SQ identity from a `FOUNDATION_BOARD` account to an `EMPLOYEE` account in one audited transaction and deactivates the old account without deleting it.
- ORG-010-J: served and denied summary requests, role grants and removals, and hand-overs write audit events without tokens, claims, or response bodies.
- ORG-010-K: the endpoint is disabled by default and enabling it in production needs owner approval.
- ORG-010-L: `GET /board/dashboard` no longer returns `actor.email`.
- ORG-010-M: the summary endpoint re-checks SQ Hub Application Access on each request, and returns 503 when it or the signing keys are unavailable.

## Product Owner decisions (2026-10-17)

The owner approved every suggested answer on 2026-10-17: "Setuju semua 11 saran ORG-010." No open questions remain. The owner accepted the spec the same day: "Tandai ORG-010 sebagai ACCEPTED dan siapkan PR hcisysq 122 untuk direview."

| # | Question | Decision |
| --- | --- | --- |
| D1 | Who grants the board-view role? | Super Admin only, through the existing role-assignment routes. Holders of `access.governance.manage` cannot grant it; that permission stays for `FOUNDATION_BOARD` accounts. |
| D2 | Which employment category does a salaried Pengurus get, and do they count in "Pegawai aktif"? | Their real category, set by HC (usually Pegawai Tetap). They count in "Pegawai aktif" like any Employee. The `Pengurus Yayasan` workbook value stays excluded (EMP-005 D-02). |
| D3 | Re-check SQ Hub Application Access on each summary request? | Yes, with the same client and rules as OIDC login. |
| D4 | Require proof of TOTP (`acr`) on the exchanged token? | Not in v1. Keycloak's required TOTP is relied on; an `acr` check can be added once the realm publishes a level for it. |
| D5 | Fold small units in the ranking? | Yes. Units with fewer than 3 active employees are folded into "Lainnya". `/board` keeps its full list. |
| D6 | Trend window? | The last 12 completed months; the current month is not included. |
| D7 | `actor.email` in `GET /board/dashboard`? | Removed. The response no longer carries the actor's e-mail. |
| D8 | Should the identity hand-over CLI also grant the board-view role? | No. The CLI moves the identity only; Super Admin grants the role as a separate audited step. |
| D9 | JWKS unreachable? | `503 JWKS_UNAVAILABLE`, so Hub shows "Tidak dapat dimuat" with retry. |
| D10 | Audit every `/board` page view? | No, not for now. Summary requests, role changes and hand-overs are audited. |
| D11 | Names? | Role `foundation_board_viewer`, label "Panel Organ Yayasan"; permission `board.read`. |

### To verify during implementation (not decisions)

These are facts to check, not product choices: the realm signing algorithm (`RS256` expected), the `typ` and `azp` claims on a Keycloak standard token exchange result (Mi8VPS probe), the `/api` prefix on the public URL, the Hub registry key for HCIS (likely `hcis`), and the current employment-history mode in production (read-only check).
