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
`access.roles.assign`, `leave.configuration.manage`, `attendance.records.manage`.

Separately grantable, excluded permissions are:

- `access.roles.delegate`: reviewed HCIS role delegation/bootstrap;
- `access.governance.manage`: preparing governance accounts;
- `approvals.policy.manage`: changing direct managers, approvers, authority
  bindings, reporting overrides, incumbencies, publishing structure and changing
  resolver rollout. Draft editing stays available to HC administrators; publishing
  any draft requires this separate permission, since hierarchy itself affects
  approval resolution. This avoids indirect self-elevation via draft publication;
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

Actors cannot create/delete their own role assignments. Ordinary HCIS role
administrators may assign/remove only `human_capital` on another Employee, with
valid own/unit/organization scope and dates, and only while the role's permissions
remain within the accepted HC operational bundle. They cannot delegate the admin
role, approval, technical or external capabilities, even by modifying a different
account first. An explicit `access.roles.delegate` operator can manage the known
HCIS system roles, subject to the HCIS permission allowlist. Unknown/external
roles or permission keys fail closed. `human_capital_admin` requires organization
scope and a nonempty mandate/reason.

Normal account administrators cannot change their own account state or issue
activation for themselves, governance/legacy accounts, or accounts with privileged
assignments outside the operational HC bundle. This prevents taking over a more
privileged invited account. Existing legacy account protection remains in force.
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

After independent review and environment authorization, a legacy administrator or
separately provisioned HCIS delegation operator uses existing
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
