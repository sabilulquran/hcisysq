# AUTH-011 implementation verification

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
- Role assignments cannot target the actor. Normal role administrators can delegate only the accepted operational HC bundle; role IDs and permission contents are checked in the database. The admin bundle requires an explicit delegation operator and organization scope.
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
