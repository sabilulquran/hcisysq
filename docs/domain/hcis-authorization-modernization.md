> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# AUTH-011 — HCIS permission-based domain administration

**Status:** ACCEPTED product decision; implementation pending independent review.

This specification supersedes principal-only admin eligibility in AUTH-010,
ORG-001 and the existing administrative module contracts for this transitional
release. Authentication and workflow decision contracts remain unchanged.

## Ownership and roles

SQ Platform Administrator belongs to SQ Hub. **Legacy SUPER_ADMIN is NOT SQ
Platform Administrator.** No HCIS principal or assignment grants cross-application
authority. Foundation Board retains its existing governance-only routes.

`human_capital` remains operational. `human_capital_admin` is the highest normal
HCIS domain-administrator bundle, explicitly assigned to an existing Employee
account with organization scope. Neither a job title nor a unit-scoped role
confers organization administration. No real identity is seeded.

## Permissions and scope

All administrative API guards check effective HCIS-local permissions, active
account/employee, organization scope and inclusive assignment dates. Unit/own
assignments cannot satisfy these global guards. Each route declares its required
permission; no unknown permission receives a compatibility bypass.

The new role contains the eight current operational HC permissions:
`employees.manage`, `employees.read.all`, `leave.validate`, `leave.evidence.read`,
`attendance.resolution.read`, `attendance.resolution.manage`, `payslips.import`,
`payslips.publish`. Payroll import/publication is retained from explicit HC intent.
It additionally contains `organization.manage`, `access.manage`,
`leave.configuration.manage`, `attendance.records.manage`. Migration 0045 also
granted `access.roles.assign`; migration 0057 removes it under the 2026-10-16 owner
decision below. The permission stays in the catalog and in the legacy Super Admin
compatibility set, which is now its only holder.

Separately grantable, excluded permissions are:

- `access.roles.delegate`: reviewed HCIS role delegation/bootstrap;
- `access.governance.manage`: preparing governance accounts;
- `board.read` (ORG-010, ACCEPTED 2026-10-17): read-only board view for an `EMPLOYEE`, carried only by the
  board-view role with organization scope; outside every HC bundle and outside legacy
  Super Admin compatibility. Granted only by Super Admin like every other role;
- `approvals.policy.manage`: changing direct managers, approvers, authority
  bindings, reporting overrides, incumbencies, publishing structure and changing
  resolver rollout. Draft editing stays available to HC administrators; publishing
  any draft requires this separate permission, since hierarchy itself affects
  approval resolution. This avoids indirect self-elevation via draft publication.
  **ORG-008-8 (decision O-1):** inside an unpublished change set, incumbencies,
  authority bindings and reporting overrides are draft editing and need only
  `organization.manage`; the permission now guards exactly what takes effect —
  publishing, rollout, live direct managers and live unit leave approvers. It is held
  by the **Kepala HC** role `human_capital_lead` (owner decision 2026-10-24), which
  carries `organization.manage` and this permission and nothing else, is granted only
  by Super Admin with organization scope and a mandate, and is outside every HC bundle;
- `attendance.devices.read`, `attendance.devices.configure`,
  `attendance.devices.operate`, `attendance.devices.export`,
  `attendance.devices.destructive`, `attendance.devices.firmware`,
  `attendance.devices.biometrics`: technical ADMS capabilities, with no default
  assignment. Destructive biometric actions require both biometric and destructive
  permission. Firmware is independently required for package and deployment APIs.

Actual leave decisions still require the snapshotted assigned employee and
workflow policy, or explicitly mandated `leave.hc.approve` for an HC approval
task. Validation permission is not actual approval. The new role receives neither
`leave.approve` nor `leave.hc.approve` nor approval-policy management.

## Delegation and account management

**Owner decision, 2026-10-16: only Super Admin grants or removes roles.** The Human
Capital role may not delegate its role or permissions to others. This applies to
`human_capital` and `human_capital_admin` at any scope, and to every other
Employee, including holders of `access.roles.assign` or `access.roles.delegate`.
They receive `403 ROLE_GRANT_SUPER_ADMIN_ONLY` on
`POST /admin/access/accounts/:accountId/role-assignments` and
`DELETE /admin/access/role-assignments/:assignmentId`. The check runs before input
validation and resource lookup, and nothing is committed: no assignment and no audit
event. `createRoleAssignment` and `removeRoleAssignment` repeat the check for
non-HTTP callers. This supersedes the earlier rule that let ordinary role
administrators assign `human_capital`. As a result, the bundle drift from
migrations 0046–0048 no longer affects who can delegate.

Stored grants match the decision. Migration
`0057_hc_admin_revoke_role_assign.sql` removes `access.roles.assign` from
`human_capital_admin`, so no seeded HCIS role holds it. Re-adding the grant is a
recovery step only; the migration header records it. Re-adding it would not let
HC grant roles, because the Super Admin check is independent of the permission.
The admin access page shows the role-assignment form and the per-assignment
"Cabut" control only when the backend authorization context reports a
`SUPER_ADMIN` principal that holds `access.roles.assign`. Other users see the
current assignments and a read-only notice. Hiding controls is not authorization:
the API still returns 403 to everyone else.

Super Admin grants are still bounded. Actors cannot create/delete their own role
assignments. Only known HCIS system roles whose permissions are within the HCIS
permission allowlist can be granted; unknown/external roles or permission keys fail
closed. Scope and dates must be valid. `human_capital_admin` requires organization
scope and a nonempty mandate/reason.

Normal account administrators cannot change their own account state or issue
activation for themselves, governance/legacy accounts, or accounts with privileged
assignments outside the operational HC bundle. Foundation Board account management
requires the separate effective organization permission `access.governance.manage`;
delegation permission alone is insufficient. Super Admin remains outside the normal
account-management path. This prevents taking over a more privileged invited account.
Existing legacy account protection remains in force.
Role mutation and its audit event are committed atomically; failure rolls back.
Assigning a role outside the operational HC bundle atomically revokes outstanding
activation tokens, so an earlier invitation cannot be used after elevation. The
operator must issue a fresh invitation through the reviewed privileged path.

## Transitional compatibility

`hasLegacySuperAdminCompatibility` is the single deprecated permission-grant
boundary. It permits only the enumerated preexisting administrative capabilities.
It does not cover employee self-service, governance routes or actual approval.
Existing schema/principal type, account IDs, credentials and MFA remain intact.
No account is migrated. Remove compatibility only after OIDC cutover acceptance,
explicit organization-scope admin assignment, successful positive/negative UAT,
reviewed technical operator grants and recovery rehearsal, in a separate release.

## Backend context and frontend

`/auth/me` and local login return `authorization.organizationPermissions` from
the backend. Admin route guards/navigation consume this context; API guards reload
local authorization for each request. Missing context fails closed. Employee
self-service and Foundation Board remain separate. Admin employees can navigate
between their employee workspace and the permitted administration surfaces.
Excluded actions may return 403 on shared pages; this is never an API bypass.

## Reviewed later operator assignment

After independent review and environment authorization, a Super Admin (the only
principal allowed to grant roles since the 2026-10-16 owner decision) uses existing
`GET /api/admin/access` to resolve the role and target account IDs, verifies the
existing account against authoritative organization data, then reviews a request:

```http
POST /api/admin/access/accounts/<existing-account-id>/role-assignments
Content-Type: application/json

{"roleId":"<human_capital_admin-role-id>","scopeType":"organization","organizationalUnitId":null,"reason":"<reviewed mandate>","startsOn":null,"endsOn":null}
```

The actor must be a different account. The API validates scope, mandate, role,
target and delegation and records `role.assignment.created`. A failed check writes
nothing. Verify `/auth/me` plus intended admin APIs and excluded technical/approval
APIs with the target's own session. Removal uses the existing assignment DELETE
route and records `role.assignment.removed`. No operator action is executed by
this repository change.

## Migration and recovery

0045 adds a role, permission keys and explicit role mappings only. It never
modifies account identity, OIDC issuer/subject, sessions or existing assignments.
Apply only on an isolated synthetic database for implementation verification.
Rollback application code first while retaining the additive schema and legacy
admin access. Preserve reviewed assignment/audit evidence; remove new assignments
through the reviewed operator route if necessary. Do not drop identity mappings,
credentials or audit records. Schema cleanup is a separate reviewed operation.

## Acceptance and verification

AUTH-011 requires API and frontend positive/negative tests for ordinary Employee,
unit HC, organization HC admin, ineffective assignments, Board, legacy admin,
sensitive capability separation, workflow decision denial, delegation scope and
self-elevation denial. Test existing OIDC account ID resolving local RBAC. Execute
typecheck, lint, API/frontend tests, integration verification and build; report any
unavailable gate honestly. Production/staging, Keycloak, SQ Hub and deployments
are outside this implementation scope.
