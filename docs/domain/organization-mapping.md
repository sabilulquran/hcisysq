# Organization Mapping and Approval Context

**Status:** VERIFIED MVP BASELINE — ORG-004 CODE/SCHEMA DEPLOYED, LEGACY WORKFLOW AUTHORITY PRESERVED
**Specification:** ORG-002  
**Related:** ORG-001, ORG-004, APR-001, AUTH-010, EMP-001, LEAVE-001

## Purpose

Keep the verified MVP organization administration simple while protecting approval routing.

Imported `UNIT`, `JABATAN`, `JABATAN FUNGSIONAL`, and `JABATAN STRUKTURAL` values are starting master data only. They are useful for setup, but they are **not approval rules** and HCIS must never infer hierarchy from title text.

## Current implementation boundary

ORG-002 documents the **current verified MVP model**. At the verified MVP runtime, current reporting and unit approval are represented explicitly:

```text
Employee
  -> current Unit
  -> current Position / Job label
  -> current Direct Manager

Unit
  -> current Unit Approver
```

This model remains the authoritative description of HCIS approval routing while ORG-004 rollout resolves to `LEGACY`. ORG-004 code/schema are deployed, but deployment alone does not make the structural resolver authoritative.

The deployed code/schema successor is `docs/domain/dynamic-organization-structure.md` (ORG-004). ORG-004 provides effective-dated organizational nodes, authority-bearing positions, incumbencies, acting assignments, structural vacancy fallback, and a visual Organization Designer.

**Do not confuse deployment with operational activation.** ORG-004 code/schema are deployed, while the current production rollout evidence remains `LEGACY` because no rollout configuration is active. The real YSQ structure, accepted SHADOW comparison, STRUCTURE activation, and production pilot remain pending. Activation is explicit and must not rewrite existing approval snapshots.

```text
code/schema deployed
!= real YSQ structure configured
!= SHADOW validated
!= STRUCTURE activated
!= production pilot validated
```

## Current-state organization model

For the first usable HCIS release, organization data represents the structure that is valid **now**.

```text
Employee
  -> current Unit
  -> current Position / Job label
  -> current Direct Manager

Unit
  -> current Unit Approver
```

Rules:

1. Unit names may be renamed in place when the same unit changes nomenclature.
2. Units or job labels that are no longer used may be marked inactive or cleaned up once no active employee depends on them.
3. Historical aliases, effective-dated organization versions, seat registries, and automatic restructuring engines were not prerequisites for the MVP Leave release.
4. Job Profile and formal Position registries may be introduced later for HCM/JD/grading needs without changing the approval snapshot contract.
5. Raw import labels must never automatically create a reporting line.

ORG-004 now defines the accepted direction for those later position/structure capabilities.

## Direct Manager

`employees.direct_manager_employee_id` is the explicit current reporting relationship used by line approval in the MVP implementation.

Examples:

```text
Classroom Teacher
  -> Curriculum Vice Principal
  -> Head of SDIT
```

A role at a similar level may legitimately report directly to the unit head:

```text
Certain Teacher / Staff
  -> Head of SDIT
```

HCIS does not hardcode either path from the employee's job title. Human Capital / Super Admin configures the actual direct manager.

Direct-manager assignment must reject:

- self-manager;
- inactive manager;
- reporting-line cycle.

### ORG-004 successor behavior under structural rollout

Under ORG-004, repetitive employee-by-employee manager setup should become the exception rather than the normal mechanism.

The target is:

```text
Employee membership
  -> organizational team/node
  -> structural leader position
  -> effective incumbent
  -> concrete Direct Manager
```

A documented employee reporting override remains available for legitimate exceptions.

Vacant supervisory positions may be skipped according to an explicit vacancy policy. Example:

```text
Director
  -> Head of Social Division [VACANT]
  -> Social Staff
```

Under an accepted `STRUCTURE` rollout, structural resolution may resolve Social Staff directly to the Director without deleting the vacant Head of Social Division position. This behavior belongs to ORG-004 and is not implied by the MVP `direct_manager_employee_id` field while rollout remains `LEGACY`.

## Unit Approver

Each active unit used by approval workflows has one explicit **current Unit Approver** in the verified MVP.

The Unit Approver is normally the unit head, but it is a configuration value, not a title-derived rule.

This intentionally handles vacancies without a complex acting-position engine in the MVP.

Examples:

```text
Unit Head filled
  Unit Approver = Unit Head

Unit Head vacant, authority temporarily at Head of Division
  Unit Approver = Head of Division

Unit Head and Head of Division vacant, authority temporarily at Director
  Unit Approver = Director
```

HCIS must **not** automatically climb to the next visible hierarchy in the MVP implementation. An administrator explicitly chooses the responsible employee.

When responsibility changes, the Unit Approver value is updated for future submissions.

### Planned successor behavior

ORG-004 changes the administration model, not the approval-snapshot invariant.

The target configuration is position-based:

```text
SDIT
unit_approver -> Head of SDIT position
```

The effective incumbent of that position becomes the concrete approver for new transactions. Vacancy behavior can be configured as climb, require acting authority, or block depending on workflow risk.

## Standard line approval resolver

For ordinary line-approved workflows in the verified MVP, including Cuti Tahunan, the resolver is:

```text
DIRECT_MANAGER
  -> UNIT_APPROVER
```

Resolution rules:

1. resolve the requester's active Direct Manager;
2. resolve the requester's unit's current Unit Approver;
3. remove self-approval;
4. deduplicate the same employee appearing in both steps;
5. reject inactive approvers;
6. fail submission when a mandatory relationship is not configured;
7. snapshot the resolved people at submission according to APR-001.

Examples:

```text
Classroom Teacher
  Direct Manager = Curriculum Vice Principal
  Unit Approver  = Head of SDIT

Resolved:
  Curriculum Vice Principal -> Head of SDIT
```

```text
Teacher reporting directly to Head of SDIT
  Direct Manager = Head of SDIT
  Unit Approver  = Head of SDIT

Resolved:
  Head of SDIT
```

```text
Head of SDIT submits
  Direct Manager = Head of Education Affairs
  Unit Approver  = self

Resolved:
  Head of Education Affairs
```

## ORG-004 governance and post-approval rule

The accepted ORG-004 planning direction adds structural governance resolution and a post-final-approval information rule.

For Director leave:

```text
Director
  -> Secretary of the Foundation APPROVES
  -> overall request APPROVED
  -> Chair of the Foundation NOTIFIED
```

Pembina/Foundation Supervisor is not notified by this rule.

For every leave workflow that contains a line/governance approval stage, once the **overall request reaches final approved**, the system should notify one structural layer above the **final line/governance approver**.

This distinction matters when HC validation or HC actual approval occurs after line approval. HC does not automatically become the structural oversight reference.

This notification is informational only and must not create another approval step. Existing HC notification requirements remain separate and additive.

This rule is implemented in ORG-004 software but is **not current authoritative production behavior while rollout remains `LEGACY`**. Detailed resolution is defined by ORG-004 and must be activated through reviewed structure/authority configuration rather than title-specific source code.

## Vacancy rule

### Verified MVP

Vacancy is solved by explicit current configuration, not automatic hierarchy search.

If a unit head is vacant, the Unit Approver must be intentionally pointed to the employee currently authorized to approve. This can be a Head of Division, Director, or another authorized employee.

If no Unit Approver is configured, approval-dependent submission fails with an actionable configuration error. The system must not guess.

### ORG-004 target

ORG-004 introduces explicit structural vacancy policies.

For supervisory Direct Manager resolution, climbing past one or more vacant positions is an accepted target behavior. Acting assignments must take effect when explicitly configured for the relevant period.

Higher-risk authority relationships may instead require acting authority or fail closed.

## Approval history

Organization administration is current-state and intentionally simple in the MVP, but submitted approvals preserve history through approval snapshots.

Changing Direct Manager or Unit Approver affects **new** submissions only. Existing submitted requests retain the approvers resolved when they were submitted.

ORG-004 must preserve this boundary. A future restructure, new position layer, changed incumbent, vacancy, or acting appointment must never rewrite an existing approval snapshot.

## Admin surface

The verified MVP admin experience prioritizes setup speed and visibility:

- list current units and active employee counts;
- rename/clean up current unit and job labels where supported;
- assign Direct Manager on active employees;
- assign one Unit Approver per active unit;
- show missing Direct Manager count;
- show missing Unit Approver count;
- preview the resolved approval chain where supported;
- warn on self-manager, cycles, inactive approvers, and incomplete configuration.

ORG-004 provides a visual Organization Designer for structural nodes, positions, memberships, incumbencies, acting assignments, effective dates, vacancy policies, draft/publish restructure, and impact preview. Those deployed capabilities do not prove that the real YSQ structure has been configured or accepted.

## Audit

Audit at minimum:

- Direct Manager changed;
- Unit Approver changed;
- employee unit changed;
- current unit renamed/deactivated when those operations are introduced.

Audit payloads use identifiers and normalized metadata only; do not copy raw employee workbook rows.

ORG-004 adds audit requirements for structure publication, position/incumbent changes, acting assignments, authority bindings, and employee reporting overrides.

## Acceptance criteria

- ORG-002-A: imported unit/job text never automatically creates approval hierarchy.
- ORG-002-B: each active employee can have an explicit current Direct Manager in the MVP model.
- ORG-002-C: each approval-relevant unit can have one explicit current Unit Approver in the MVP model.
- ORG-002-D: `DIRECT_MANAGER -> UNIT_APPROVER` removes self-approval and duplicates.
- ORG-002-E: MVP vacancy never causes automatic hierarchy fallback; the responsible Unit Approver is configured explicitly.
- ORG-002-F: missing mandatory approval configuration blocks submission instead of guessing.
- ORG-002-G: changes affect future submissions only; submitted approval snapshots remain unchanged.
- ORG-002-H: the verified MVP did not depend on organization versioning, alias history, or a formal Position registry.
- ORG-002-I: agents must treat ORG-004 as the deployed software/schema successor but must not treat structure-driven approval as authoritative until real structure configuration, SHADOW validation, explicit `STRUCTURE` activation, and the required pilot evidence are complete.
