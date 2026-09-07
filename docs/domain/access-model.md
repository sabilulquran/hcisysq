# Access Model

> AUTH-011 supersedes principal-only administrative eligibility in this document.
> See [HCIS authorization modernization](hcis-authorization-modernization.md) for
> domain/platform boundaries, granular permissions and transitional legacy compatibility.

**Status:** ACCEPTED — ORG-004 STRUCTURAL AUTHORITY EXTENSION PLANNED  
**Specifications:** AUTH-001, AUTH-010, SEC-001  
**Related:** ORG-001, ORG-002, ORG-004

This document defines the target access model for HCIS YSQ. Legacy HCIS role names are discovery evidence only and must not be copied automatically into the new implementation.

## Core decisions

- One login page serves all users.
- No public registration and no role/account-type selector on the login page.
- Google sign-in is the target primary route; email + password may remain a fallback.
- After authentication, the backend determines account type, permissions, scopes, capabilities, and landing area.
- Account type, organizational structure, role, permission, and scope are separate concepts.
- Organization structure may help resolve operational authority, but it does not replace backend RBAC.

## Account types

### `EMPLOYEE`

An account linked to an active employee.

Every active employee receives **base employee self-service access** for their own data in modules that exist, such as profile, attendance, leave, reimbursement, payslip, loan, and personal documents.

An employee may receive additional access through role assignment or a documented structure-to-authority binding.

Example:

```text
Ahmad
Account type: EMPLOYEE

Base employee access
+ Unit Manager / scope SMP
+ Reimbursement Approver / scope SMP
```

### `FOUNDATION_BOARD`

An account for a Foundation governance principal that is not represented as a fake employee.

Default access is aggregate-first and read-only, for example:

- executive/governance dashboard;
- workforce statistics;
- organization reports;
- explicitly authorized financial summaries;
- report export when permission exists.

This account type does **not** automatically allow employee mutation, operational approval, payroll mutation, role management, or system configuration.

Individual sensitive data is available only through explicit authorization.

### `SUPER_ADMIN`

A technical system-administration account.

Super Admin is not the representation of the highest organizational position. Foundation leadership does not automatically become Super Admin.

Primary responsibilities include:

- role and permission administration;
- role assignment;
- system configuration;
- integrations;
- audit log;
- documented administrative recovery/reassignment.

Privileged access must be audited and MFA is mandatory for the implemented production-style Super Admin authentication path.

## Landing area

After successful login:

```text
EMPLOYEE         -> /app
FOUNDATION_BOARD -> /board
SUPER_ADMIN      -> /admin
```

This is navigation behavior, not authorization. Every backend route still performs its own authorization check.

## Employee access: base plus additional authority

Base employee access comes from active employee/account state, not from a manually attached `employee` role.

Additional authority uses:

```text
ROLE + SCOPE
```

Examples:

- Unit Manager;
- Human Capital;
- Finance;
- Management;
- Special Approver.

A role is a permission bundle. Do not create combination roles such as `employee-unit-head-finance` to encode multiple concerns in one name.

## Scope

Scope answers **for whom / where does this authority apply?**

Baseline scope:

- `own` — the principal's own data;
- `unit` — one assigned organizational unit;
- `organization` — the whole organization;
- explicit/custom scope only when a real requirement exists.

Example:

```text
Role: Unit Manager
Scope: SMP

employees.read.unit
leave.approve
attendance.read.unit
```

Role answers *what may this actor do?* Scope answers *to whom / in which area?*

## Assignment sources

Additional authority may come from:

1. manual role assignment by an authorized administrator; or
2. a documented structural responsibility that is explicitly bound to a role/capability model.

A structure-derived assignment must not be implicit magic. The relationship between the position/responsibility and its permissions must be explicit, testable, and auditable.

Manual assignments may have start date, end date, and reason, especially for temporary authority.

## ORG-004 structural authority boundary

`docs/domain/dynamic-organization-structure.md` defines the accepted post-MVP direction for dynamic organization structure.

ORG-004 introduces concepts such as:

- organizational nodes/teams;
- authority-bearing positions/seats;
- effective incumbencies;
- acting assignments;
- supervisory and governance relationships;
- authority bindings;
- vacancy policies;
- employee reporting overrides.

These concepts may be used to **resolve which employee should receive an operational authority**, but they must not bypass the access model.

Example target flow:

```text
Position: Head of SDIT
  -> structural responsibility: unit_approver for SDIT
  -> documented capability binding: leave.approve for SDIT
  -> effective incumbent: Hasan
  -> Hasan receives effective approval capability for the relevant context
```

This is different from:

```text
Has job title containing "Head"
  -> automatically receives every manager permission
```

The second pattern is forbidden.

### Position is not an account type

`Director`, `Secretary`, `Head of SDIT`, or `Curriculum Vice Principal` are organizational responsibilities/positions, not login account types.

A person occupying such a position normally authenticates through their `EMPLOYEE` account and receives additional capabilities according to explicit authority bindings.

### Governance approval vs Foundation Board account

The accepted ORG-004 planning rule for Director leave is:

```text
Director employee
-> Secretary employee approves
-> Chair is notified after final approval
```

This operational approval relationship must not be confused with `FOUNDATION_BOARD` account type.

If a governance actor must perform an operational approval, HCIS requires an explicitly modeled authorized principal/capability for that workflow. The system must not silently grant mutation capability to every Foundation Board account merely because a similarly named governance position exists.

The exact principal/account mapping for governance positions must be verified during ORG-004 implementation before real activation.

## Temporary and acting authority

ORG-004 may represent an acting position assignment with effective dates.

An acting assignment grants operational authority only when:

- the assignment is effective;
- the structural responsibility explicitly carries the relevant authority/capability binding;
- the employee/account is active;
- the requested action is within the permitted scope;
- backend authorization validates the effective authority.

Acting assignment must never create `SUPER_ADMIN` implicitly.

## Account state

Use simple account states:

```text
invited
active
suspended
inactive
```

- `invited`: activation not completed where activation flow applies;
- `active`: may authenticate according to available methods and permissions;
- `suspended`: access temporarily closed without changing employment status;
- `inactive`: login disabled because the account/mandate ended.

Employee status and account status are validated independently.

## Login behavior

Target flow:

```text
/login
  -> Google or email/password
  -> identity verified
  -> active account found
  -> load account type + permissions + scopes + structural capabilities
  -> redirect to landing area
```

The login page must not ask the user to choose `Employee / Admin / Leadership`.

## Permission naming

Use:

```text
<resource>.<action>[.<scope>]
```

Examples:

```text
employees.read.own
employees.read.unit
employees.read.all
leave.submit
leave.approve
reports.read.organization
reports.export.organization
roles.manage
approvals.reassign
```

## Backend authority remains final

A structural resolver can help identify a candidate authority, but authorization still checks the effective principal and capability server-side.

Example:

```text
Organization resolver says:
Hasan is current Head of SDIT

Backend still verifies:
- Hasan employee active
- Hasan account active
- position assignment effective
- authority binding effective
- permission/capability valid
- requested object is within scope
```

A stale frontend chart or client-side navigation state must never be an authorization source.

## Security invariants

- Backend owns authorization; frontend only renders UI from backend-provided effective capabilities.
- Organization-wide Human Capital navigation requires effective role/capability with organization scope and valid assignment dates; a unit-scoped HC role is insufficient.
- Manually typing a URL cannot bypass authorization.
- Same role in another unit does not create cross-unit access.
- Foundation Board remains read-only unless a future target specification explicitly grants a narrow operational capability.
- Super Admin does not automatically receive employee self-service.
- Role, scope, account-state, permission, structural authority-binding, acting assignment, and other sensitive changes produce audit events.
- Free-text job titles never grant authority.
- Numeric organization level never grants authority by itself.
- Structural vacancy fallback never grants a capability to an arbitrary employee.
- Organization structure must never silently create or elevate `SUPER_ADMIN`.

## Acceptance criteria

- AUTH-010-A: active employees receive base self-service without a manual `employee` role assignment.
- AUTH-010-B: additional roles are additive and can carry scope.
- AUTH-010-C: Foundation Board can read explicitly authorized governance reports but cannot perform operational mutation by default.
- AUTH-010-D: Super Admin manages system access but is not treated as an organizational leader.
- AUTH-010-E: one login page serves all account types without a role selector.
- AUTH-010-F: backend rejects principals without permission even when a client can reach the URL/UI.
- AUTH-010-G: temporary assignments store effective period and reason when used.
- AUTH-010-H: organization-wide admin navigation/capability cannot be derived from `role_key` alone; scope and effective dates must be considered.
- AUTH-010-I: when ORG-004 is implemented, structural position/incumbency alone does not bypass explicit permission/capability binding.
- AUTH-010-J: acting structural authority is effective-dated, auditable, scope-bound, and never implies Super Admin access.
- AUTH-010-K: job-title text and numeric organization level are never authorization inputs by themselves.
- AUTH-010-L: governance organizational positions and `FOUNDATION_BOARD` account type remain distinct concepts unless an explicit mapping specification is approved.
