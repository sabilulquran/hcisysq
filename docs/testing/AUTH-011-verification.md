> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# AUTH-011 implementation verification

## Update 2026-10-16: route coverage and CI enforcement (SEC-02, SEC-03)

Follow-up to the 2026-10-16 HCIS security review (redacted summary in
`docs/operations/hcis-security-review-2026-10-16.md`). The inventory, tests and CI changed. The only production
change enforces the owner decision of 2026-10-16 that only Super Admin grants roles (see below).

**Manifest completeness (SEC-02).** [The route inventory](../domain/AUTH-011-admin-route-permissions.json) now
lists every route that `createApp` registers, except an explicit public allowlist: `/health`, `/ready`, `/auth/*`,
`/iclock/*` (device ingress) and `/internal/v1/*` (service token). It has 228 entries:

| `access` | Count | Guard | Persona expectation |
| --- | --- | --- | --- |
| absent (admin) | 174 | `requirePermissionsFromCookie` with every listed `permissions` key; legacy Super Admin compatibility applies | Allowed only when the persona's effective organization permissions include all keys |
| `hc-operational` | 12 | EMPLOYEE principal, then an organization-scoped permission (`leave.validate`, `leave.hc.approve`, `attendance.resolution.manage`) | Same, but legacy Super Admin and Foundation Board are always 403 |
| `super-admin` | 2 | Role-assignment create/remove: `access.roles.assign` **and** a Super Admin principal | Every other persona is 403, including HC and HC admins |
| `self-service` | 40 | Principal type only (`principals`) | Anonymous 401/403; principals not listed are 403 |

Earlier the inventory had 135 entries; 51 admin and HC routes plus 40 self-service routes were missing. Every
missing route was already guarded in code. The physical clear template entry became three concrete routes.
Re-auditing the existing entries against handlers found 27 that were *less* strict than the code, because
`attendance.devices.technical` was missing. 8 physical commands require it unless the body requests
`mode: "execute"`; this is now recorded as `executePermissions`. No entry was more permissive in code than in
the inventory.

**Tests.**

- `apps/api/test/auth011-route-coverage.test.ts` runs without a database in every `npm run test`. It records
  routes through a Fastify `onRoute` hook and fails on these conditions:
  - a registered non-public route that is missing from the inventory;
  - a stale, duplicate or public inventory entry;
  - any change to the pinned public route list;
  - an unknown permission key.
- `apps/api/test/auth011-postgres.integration.test.ts` takes each persona's real effective permissions:
  anonymous, employee, unit-scoped HC, unit-scoped HC admin, Foundation Board, organization HC admin and legacy.
  From those it computes the expected 401, 403 or allowed result for every inventory route. Routes that support
  `mode: "execute"` are checked in both modes.
  - Unit-scoped HC is denied on every route, because organization permissions ignore unit scope. This is expected.
  - HC operational handlers check request shape before the HC permission, so the matrix sends well-formed
    synthetic IDs and bodies to reach the permission branch. Elsewhere it sends a malformed ID to show that
    authorization runs before validation.

**CI (SEC-03).** `.github/workflows/pr-validation.yml` creates an empty `hcis_auth011_permissions_test`
database on the job's PostgreSQL service and sets `HCIS_AUTH011_TEST_DATABASE_URL` for the test step. A separate
step reruns both AUTH-011 files with the JSON reporter. It fails if any test failed, any test was skipped, or
fewer than 20 tests passed, so a silent `describe.skipIf` cannot pass the gate.

**Fixed rot found once the suite ran.** On `main` the suite had 4 failing tests and 1 failing suite. None was a
security regression:

1. The inventory was stale for technical-gated ADMS routes (see above).
2. `0023_leave_approval_principals.sql` is back in the main chain (PR #59), so the 0045 compatibility test no
   longer seeds that role itself. It now asserts that the migration seeded it.
3. The 0045 compatibility test now pins the bundle that 0045 grants. Migrations 0046–0050 extend it to
   `HC_ADMIN_PERMISSIONS`, which the main suite asserts.
4. HC admins could no longer delegate `human_capital` after migrations 0046–0048 widened that role (see the
   owner decision below). The rollback test then failed and left its synthetic trigger behind, which caused the
   invitation-revocation failure.

**Owner decision 2026-10-16: only Super Admin grants roles.** The owner ruled: "the Human Capital role may NOT
delegate its role or permissions to others; only Super Admin can grant roles." This is recorded in
[AUTH-011](../domain/hcis-authorization-modernization.md#delegation-and-account-management) and
[roles and permissions](../domain/roles-permissions.md).

- **Enforcement:** `assertRoleGrantor` runs in both role-assignment routes before input validation, and again in
  `createRoleAssignment` and `removeRoleAssignment`.
- **Denied actors:** all of the following get `403 ROLE_GRANT_SUPER_ADMIN_ONLY`:
  - organization-scoped and unit-scoped `human_capital`;
  - organization-scoped and unit-scoped `human_capital_admin`;
  - `access.roles.delegate` and `access.governance.manage` holders;
  - plain employees.
- **Test coverage:** the test tries every role, three scopes, and both a third-party and a self target. It also
  tries an empty body, removing an existing assignment, and direct service calls. It then asserts that the
  assignment count and the `role.assignment.*` audit count are unchanged.
- **Super Admin path:** Super Admin can still grant and remove roles, within the HCIS role/permission allowlist and
  scope rules.
- **Earlier open item:** the `human_capital` bundle drift from migrations 0046–0048 no longer decides who can
  delegate, so it is closed by this decision.
- **Follow-up, not done here:** `human_capital_admin` still holds `access.roles.assign`, which now grants nothing
  on its own. Removing it, and hiding the assignment controls in the web UI for non-Super-Admin users, needs a
  migration and a UI change.

Reproduce: run `apps/api/test/auth011-*.test.ts` with `HCIS_AUTH011_TEST_DATABASE_URL` pointing to an empty
loopback `hcis_auth011_permissions_test` database, as described below.

## Original verification (2026-09-07)

Date: 2026-09-07. Review target: local branch `refactor/hcis-human-capital-admin`.
Starting main was fetched and matched exactly `b17fd11a63152a5a021a8fd49f238bf3f84152ef` before any source write.

## Scope and authorization

See [the accepted specification](../domain/hcis-authorization-modernization.md) and
[the API permission inventory](../domain/AUTH-011-admin-route-permissions.json).

- New role: `human_capital_admin`, explicit organization scope and mandate, with no seeded account assignments.
- 132 previously exclusive legacy admin routes now declare server-side permission requirements; the five payslip routes share the same centralized effective-permission boundary.
- Source grant-site count: 24 backend sites before, zero scattered sites after plus one central compatibility predicate; frontend eligibility checks: 22 before, zero after. The 137 route-equivalent count includes helper reuse. Retained MFA and account-protection checks are not privilege-grant sites.
- A single deprecated `hasLegacySuperAdminCompatibility` boundary grants only enumerated HCIS administrative permissions. It grants no platform or workflow-approval authority.
- Operational HC remains separate. Global permissions require organization scope, inclusive effective dates, active account and active linked employee.
- Board governance APIs and employee self-service principal boundaries remain unchanged.
- Technical/device, biometric, destructive, firmware, policy/approval assignment and delegation permissions are separated from normal HC administration.
- Role assignments cannot target the actor. Normal role administrators can delegate only the accepted operational HC bundle; role IDs and permission contents are checked in the database. The admin bundle requires an explicit delegation operator and organization scope. *(Superseded 2026-10-16: only Super Admin grants roles; see the update above.)*
- Role changes and audit writes are atomic. Elevated role assignment revokes preexisting invitation tokens inside the same transaction. Account state and invitation authorization checks run while holding the target account lock; privileged invitations cannot be taken over through normal HC access management.
- Frontend routes, menus and landing use backend authorization context. Missing context fails closed. Desktop and compact admin menus have render tests.
- OIDC protocol, exact issuer/subject matching, original account ID, Application Access gate, cookie behavior and auth mode remain intact.

## Executed verification

| Gate | Result |
| --- | --- |
| Full API suite with PostgreSQL integration enabled | 377 passed; one preexisting Windows-only Bash skip |
| Full frontend suite | 45 passed |
| AUTH-011 real PostgreSQL coverage | Ten tests, including requests across all 137 admin routes |
| Additional account-activation service hardening | Full API suite rerun after invitation-revocation hardening: 377 passed |
| Typecheck | Web and API passed; API rerun after final service edit |
| Lint | Passed; three existing React fast-refresh warnings in unchanged device UI files |
| Build | Web/Vite and API/TypeScript passed; existing large-chunk warning remains |
| Bash syntax skipped by Windows Vitest | Both deployment and verification scripts checked separately with Git Bash `-n`; passed |
| Migration | All migrations through 0045 applied successfully to a new synthetic PostgreSQL 16 cluster; 0045 reapplication preserves assignment counts |
| Rollback behavior | Forced access-audit failure rolls back the role assignment; additive schema recovery procedure documented |

The route matrix checks authentication/authorization before malformed resource-ID validation. It also verifies intended admin read endpoints with real records/queries, excluded capability denial, scoped and expired grants, separately granted technical access, reviewed role assignment/removal, self-elevation denial, invitation takeover denial, and OIDC-resolved local RBAC. It does not claim every ADMS business operation or physical device command was exercised.

Only a newly initialized loopback PostgreSQL cluster was used. Existing API integration tests used `hcis_auth011_test`; AUTH-011 used a separate `hcis_auth011_permissions_test` database to avoid older tests' schema-unqualified catalog assertions. No real employee or account data was used. No production, staging, Keycloak, SQ Hub or deployment changes occurred. No runtime OIDC cutover, live browser UAT or live device UAT was attempted.

Reproduce with two empty, disposable loopback databases (the AUTH-011 database name and loopback host are enforced by the test):

```powershell
$env:DATABASE_URL = 'postgres://<local-test-user>@127.0.0.1:<port>/hcis_auth011_test'
$env:HCIS_AUTH011_TEST_DATABASE_URL = 'postgres://<local-test-user>@127.0.0.1:<port>/hcis_auth011_permissions_test'
node --import tsx apps/api/src/db/migrate.ts
npm run typecheck
npm run lint
npm run test
npm run build
```

## Open findings and review limits

1. **Preexisting ADMS export defect, outside AUTH-011 scope.** A valid GET to `/admin/attendance/adms/devices/:deviceId/work-codes/export.csv` reaches SQL selecting `t.last_command_id`, which does not exist in `attendance_adms_work_code_targets` after all repository migrations. This returns PostgreSQL 42703. The same query is present at the exact starting SHA. Its authorization was modernized; its business SQL was not changed. Track a separate repair.
2. The three lint warnings and Vite chunk-size warning remain. No test or security check was disabled to pass this change. The existing Windows Bash skip was independently covered.
3. Independent security review and later operator assignment/UAT remain required before rollout. No production identity has been provisioned or assigned a role. A custom technical operator role is deliberately not seeded: technical permissions remain available for a separately reviewed HCIS role configuration.

## Changed files

- `apps/api/src/modules/attendance/adms/admin-routes.ts`
- `apps/api/src/modules/attendance/adms/biometric-control-plane-routes.ts`
- `apps/api/src/modules/attendance/adms/physical-parity-extended-routes.ts`
- `apps/api/src/modules/attendance/adms/physical-parity-observability-routes.ts`
- `apps/api/src/modules/attendance/adms/physical-parity-registry-user-routes.ts`
- `apps/api/src/modules/attendance/adms/physical-parity-routes.ts`
- `apps/api/src/modules/attendance/adms/wave1-admin-routes.ts`
- `apps/api/src/modules/attendance/adms/wave1-ops-routes.ts`
- `apps/api/src/modules/attendance/adms/wave1-recovery-routes.ts`
- `apps/api/src/modules/attendance/adms/wave2-admin-routes.ts`
- `apps/api/src/modules/attendance/adms/wave2-mapping-assistant-routes.ts`
- `apps/api/src/modules/attendance/adms/wave2-user-correction-routes.ts`
- `apps/api/src/modules/attendance/adms/wave3-admin-routes.ts`
- `apps/api/src/modules/attendance/routes.ts`
- `apps/api/src/modules/auth/account-activation.ts`
- `apps/api/src/modules/auth/admin-account-activation-routes.ts`
- `apps/api/src/modules/auth/authorization.ts`
- `apps/api/src/modules/auth/routes.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/modules/employees/admin-employee-contact-routes.ts`
- `apps/api/src/modules/employees/admin-org-access-routes.ts`
- `apps/api/src/modules/employees/admin-routes.ts`
- `apps/api/src/modules/leave/admin-routes.ts`
- `apps/api/src/modules/leave/attendance-resolution-routes.ts`
- `apps/api/src/modules/leave/calendar-admin-routes.ts`
- `apps/api/src/modules/leave/planned-leave-routes.ts`
- `apps/api/src/modules/leave/special-leave-routes.ts`
- `apps/api/src/modules/organization/admin-routes.ts`
- `apps/api/src/modules/payslips/routes.ts`
- `apps/api/test/account-activation.test.ts`
- `apps/api/test/adms-admin-routes.test.ts`
- `apps/api/test/adms-biometric-control-plane-routes.test.ts`
- `apps/api/test/adms-full-wdms-route-safety.test.ts`
- `apps/api/test/adms-long-range-recovery.test.ts`
- `apps/api/test/adms-mapping-assistant-route.test.ts`
- `apps/api/test/adms-wave1-admin-routes.test.ts`
- `apps/api/test/adms-wave1-ops-routes.test.ts`
- `apps/api/test/adms-wave2-admin-routes.test.ts`
- `apps/api/test/adms-wave2-biometric-policy.test.ts`
- `apps/api/test/adms-wave3-operations-routes.test.ts`
- `apps/api/test/attendance-routes-regression.test.ts`
- `apps/api/test/hc-organization-scope.test.ts`
- `apps/api/test/organization-admin-authorization.test.ts`
- `apps/api/test/payslip.test.ts`
- `apps/web/src/components/hcis/LoginForm.tsx`
- `apps/web/src/layouts/AdminShell.tsx`
- `apps/web/src/layouts/AppShell.tsx`
- `apps/web/src/lib/auth.ts`
- `apps/web/src/pages/AdminAccessPage.tsx`
- `apps/web/src/pages/AdminPage.tsx`
- `apps/web/src/router.tsx`
- `apps/web/src/types/hcis.ts`
- `docs/api/openapi.yaml`
- `docs/domain/access-model.md`
- `docs/domain/organization-access-foundation.md`
- `docs/domain/roles-permissions.md`
- `apps/api/migrations/0045_hcis_human_capital_admin.sql`
- `apps/api/src/modules/auth/permissions.ts`
- `apps/api/src/modules/auth/role-assignment.ts`
- `apps/api/test/auth011-policy.test.ts`
- `apps/api/test/auth011-postgres.integration.test.ts`
- `apps/web/src/lib/authorization.test.tsx`
- `apps/web/src/lib/authorization.ts`
- `docs/domain/AUTH-011-admin-route-permissions.json`
- `docs/domain/hcis-authorization-modernization.md`
- `docs/testing/AUTH-011-verification.md` (this report)
