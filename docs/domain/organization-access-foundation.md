# Organization and Access Administration Foundation

> AUTH-011 supersedes principal-only administrative eligibility in this document.
> See [HCIS authorization modernization](hcis-authorization-modernization.md) for
> domain/platform boundaries, granular permissions and transitional legacy compatibility.

**Status:** VERIFIED MVP BASELINE  
**Specifications:** ORG-001, AUTH-010, SEC-001

This milestone connects employee master to organization structure and access administration without collapsing employee records, accounts, roles, and reporting lines into one object.

## Scope

### Employee detail

Super Admin can open an employee detail surface that shows:

- NIP and employment status;
- unit and position;
- allowlisted contact/profile fields already present in employee master;
- direct manager;
- linked employee account state;
- additional role assignments.

Employee master remains primarily import-driven in this phase. The only mutable employee relationship introduced here is `direct_manager_employee_id`.

## Direct manager

`employees.direct_manager_employee_id` is a self-reference separate from unit and position.

Rules:

- an employee cannot manage themself;
- proposed manager must be an active employee;
- assigning a manager must not create a reporting-line cycle;
- clearing a manager is allowed;
- every change is audited;
- reporting line is input to the approval resolver, not an approval snapshot itself.

The approval engine resolves and persists its chain at submission time. It must not dynamically follow the current manager on every approval read.

### Bulk direct-manager assignment (DRAFT, 2026-11-20)

Status: `DRAFT`. Decided while filling the reporting line for the first time; revisit once HC has run it.

Reason this exists: every ORG-004 `LEGACY` approval chain starts from `direct_manager_employee_id`,
and nearly every active employee still has none. One-at-a-time editing of the whole workforce is
slow and easy to abandon halfway, so HC gets a bulk path with a mandatory dry-run.

**Correction, 2026-11-20.** The emptiness is in the legacy column only. The published organization
chart already resolves a manager for nearly all of those employees. So this is **not** the only way
to fill the reporting line, and it is not a blank sheet for HC to invent one on: it is the fallback
path for workflows still running in `LEGACY` mode, and it must show what the chart already says
before HC writes anything.

Accordingly the dry-run also reports, per row, the manager the ORG-004 resolver derives from the
published chart, and whether HC's file agrees with it:

- resolution goes through the existing resolver via `buildOrganizationPeopleView`. There is no
  second resolution path here and no job title text is ever read; this code only translates the
  resolver's answer into the NIP-and-name shape the preview speaks;
- each row carries `chartManager`, `chartSource` (which rule the resolver used), `chartIssue` (why
  the chart could not answer) and `chartAgrees` (true, false, or null when there is nothing to
  compare). `differsFromChartCount` counts the disagreements — on this screen that is the most
  valuable number, because those are the people HCIS would route differently from the chart;
- the suggestion is advice, never a decision. It is computed only during the dry-run, never during
  apply, and it is deliberately **not** part of the preview token, so a chart published between
  dry-run and confirm cannot invalidate HC's preview and cannot change what is written;
- an empty `NIP ATASAN` cell is still refused. A suggestion the chart makes is applied only once HC
  has written it into the file and confirmed that file. The screen offers the suggestions as a
  downloadable CSV instead of filling the preview table in place: the file that gets applied is
  then always a file HC uploaded and confirmed, and the chart's advice travels the same
  upload-dry-run-read-confirm path as anything else rather than a shorter one.

Rules, deliberately identical to the single route (shared code in
`apps/api/src/modules/employees/manager-assignment.ts`; the single route evaluates a batch of one):

- an employee cannot manage themself;
- the named manager must exist and be an active employee;
- the assignment must not create a reporting-line cycle;
- neither side may be a record marked outside HCIS management (EMP-005 S2B §8.7);
- a cycle that only the batch creates — `A -> B` and `B -> A` in one file, neither wrong alone —
  is refused as well. The whole current reporting line is read once and the batch applied over it
  in memory, rather than one recursive query per row.

Input and flow:

- CSV UTF-8 keyed by NIP, never by name: columns `NIP` and `NIP ATASAN`, comma or semicolon,
  header found within the first ten records — the same source shape as the employee import
  (EMP-004), because HC works from the same spreadsheet;
- an empty `NIP ATASAN` cell is an error, not an instruction to clear. Clearing is written
  explicitly as `-`, borrowing the import's meaning of `-` but deliberately stricter than the
  import about blanks. An unfinished file must not silently remove anyone's manager, and the
  dry-run counts the clearing rows separately so a file that accidentally carries `-` everywhere
  is visible from the summary;
- a duplicate NIP in one file blocks the file, as it does in the employee import;
- dry-run (`POST /admin/employees/manager-assignments/preview`) writes nothing and reports every
  row as unchanged, will change (old manager and new manager both named), or refused with a code;
- apply (`POST /admin/employees/manager-assignments/apply`) re-reads the file, locks the employee
  rows named by it, re-evaluates every rule inside the transaction and writes all rows or none.
  One invalid row refuses the batch; there is no partial application;
- apply carries the dry-run's `previewToken` in `X-Preview-Token`. The token is a SHA-256 over the
  file's rows plus the current state (id, status, management scope, current manager) of every
  employee the file names. If either the file or that state moved after the dry-run, the token no
  longer matches and apply is refused with `MANAGER_ASSIGNMENT_PREVIEW_STALE`, which is checked
  before the per-row outcomes so a swapped file is reported as a stale preview rather than as bad
  rows. Other people's reporting lines are deliberately outside the token: they must not invalidate
  HC's preview;
- the file is bounded at 2000 rows, like the employee import, and raw upload bytes are not stored.

What the token does *not* cover, stated plainly rather than reassuringly. Apply does re-evaluate
every rule inside the transaction, but it reads the reporting line **without a lock**; `FOR UPDATE`
holds only the employee rows the file names. That re-evaluation closes the window up to its own
read, not up to commit. A concurrent write about an employee outside the file can still produce a
cycle neither writer sees — and the single route holds no lock at all, so a decision it made before
ours can commit after ours. Closing that means locking the whole reporting line, or taking one
advisory lock for every direct-manager write; it is a separate decision and is not claimed here.

For the same reason the mandatory dry-run is an interface discipline, not a security control: the
token proves HC confirmed a preview of a particular file against a particular state, and nothing
more. What actually protects the data is that apply re-evaluates every rule itself and writes all
rows or none.

Known follow-ups, not addressed here:

- the dry-run table can mis-attribute a row when a file repeats a row number, which only a
  hand-edited file produces today;
- the unlocked reporting-line read described above;
- the empty-cell rule is *stricter* than EMP-004's, not the same: the employee import treats a blank
  optional cell as "no value", while a blank `NIP ATASAN` here is a blocking error. Only the meaning
  of `-` is shared.

ENG-LIST-001 exception, written down on purpose: the dry-run table is not paged. It is not a stored
list but one request's answer about one file, bounded at 2000 rows, and HC confirms the whole file
at once — paging would hide part of what the confirm button applies. The employee import pages its
preview because that preview is persisted as a job and read back later; this one is neither.

Permission: `approvals.policy.manage`, the same one the single route uses. No new permission.

Audit: one `employee.manager.updated` event per employee, carrying `managerEmployeeId`,
`previousManagerEmployeeId`, `source` and the `batchId`, plus one `employee.manager.batch_applied`
event on `employee_manager_batch` carrying the source filename, checksum, counts, preview token and
the employee numbers written. The single route now records `previousManagerEmployeeId` and
`source` too, so "who set this person's manager, when, and from what to what" is answerable for
both paths.

Screen: a tab on `/admin/organization` (Struktur Organisasi), not a new navigation entry. That page
is where reporting-line coverage is read and where ORG-004 resolution is explained, and the role
that holds `approvals.policy.manage` (Kepala HC) holds `organization.manage` but not
`employees.manage`, so Daftar Pegawai would be closed to exactly the person doing this work.

## Organization reference administration

Unit and position records are normalized references produced by employee import. The admin organization page is read-only for those reference names in the verified MVP and shows:

- unit employee counts;
- position employee counts;
- active employee counts;
- reporting-line coverage for active employees.

Manual organization hierarchy editing remains deferred until hierarchy requirements are explicitly specified.

## Account preparation and activation boundary

Employee accounts are separate from employee records.

Super Admin may prepare one `EMPLOYEE` account for an active employee when a valid email is available.

Prepared accounts use:

```text
principal_type = EMPLOYEE
status = invited
password_hash = NULL
```

This ORG-001 foundation step itself does not activate credentials or send invitation email. An account without an authentication method must not be switched to `active`.

The later AUTH-002 activation flow is now implemented separately and preserves the same account row/audit history. Its existence does not collapse account preparation into employee import or organization administration.

## Base access vs additional roles

Base employee self-service is not represented by a manually assigned `pegawai` role.

Additional roles use:

```text
account
  -> account_role_assignment
      -> role
          -> permission(s)
      -> scope
```

System roles seeded as an initial target vocabulary:

- Unit Manager;
- Human Capital;
- Finance;
- Management;
- Special Approver.

These are not legacy-role copies. They implement the accepted additive role model.

## Scope

Supported baseline scope values:

- `own`;
- `unit`;
- `organization`.

A `unit` scope requires exactly one organizational unit. Non-unit scopes must not carry a unit identifier.

Assignments may also record:

- start date;
- end date;
- reason/mandate;
- administrator that created the assignment.

Role and scope remain separate authorization dimensions. An employee having `human_capital` with unit scope does not gain organization-wide HC authority merely because the role key matches.

## Audit

The following mutations create `access_audit_events`:

- direct manager update (single and bulk);
- bulk direct-manager batch application;
- employee account preparation;
- account-state change;
- role assignment creation;
- role assignment removal.

Audit payloads store identifiers, state, scope, dates, and reasons needed for accountability. They must not contain passwords, session tokens, MFA secrets, workbook contents, or raw sensitive employee documents.

## Security invariants

- All admin routes require a valid `SUPER_ADMIN` server-side session.
- Frontend navigation is not an authorization boundary.
- Super Admin itself cannot be disabled through employee access administration.
- Foundation Board cannot receive operational employee roles through this milestone.
- Only `EMPLOYEE` accounts receive additive operational role assignments here.
- An account with no authentication method cannot be activated.
- Employee import never creates accounts automatically.
- Direct-manager changes never rewrite historical approval snapshots.
- Same role with a narrower scope does not imply broader organization access.

## Admin routes

```text
GET    /api/admin/organization
GET    /api/admin/employees/:employeeId
PATCH  /api/admin/employees/:employeeId/manager
POST   /api/admin/employees/manager-assignments/preview
POST   /api/admin/employees/manager-assignments/apply

GET    /api/admin/access
POST   /api/admin/access/employee-accounts
PATCH  /api/admin/access/accounts/:accountId/status
POST   /api/admin/access/accounts/:accountId/role-assignments
DELETE /api/admin/access/role-assignments/:assignmentId
```

## UI routes

```text
/admin/organization
/admin/access
/admin/employees/:employeeId
```

## Verification

MVP verification covered:

- Super Admin organization/access surfaces in real browser UAT;
- cross-principal denial for Employee/Foundation Board against `/admin`;
- synthetic organization-scoped HC positive access;
- synthetic and production/pre-release unit-scoped HC denial for global HC workspaces;
- automated role/scope effective-date authorization tests;
- approval snapshot behavior that remains independent from later reporting-line changes.

## Acceptance criteria

- ORG-001-A: Super Admin can review normalized unit and position references with employee counts.
- ORG-001-B: direct manager can be assigned or cleared without allowing self-management or cycles.
- ORG-001-C: reporting-line coverage is visible and provides authoritative input to approval-chain resolution.
- ORG-001-D (DRAFT): direct managers can be assigned in bulk from a NIP-keyed CSV, only after a dry-run, all rows or none, under the same rules and the same permission as the single route.
- AUTH-010-A: active employee base access remains conceptually automatic and is not stored as a `pegawai` role.
- AUTH-010-B: additional role assignment persists role + scope independently.
- AUTH-010-C: unit scope requires a unit and organization/own scope rejects a unit.
- AUTH-010-D: prepared employee account is linked one-to-one to an employee and starts as `invited`.
- AUTH-010-E: account without an authentication method cannot become `active`.
- AUTH-010-F: organization-wide capability must not be inferred from a matching role label when the effective assignment is only unit-scoped.
- SEC-001-A: every privileged organization/access mutation is audited.
- SEC-001-B: direct URL/API access without a Super Admin session is rejected.
