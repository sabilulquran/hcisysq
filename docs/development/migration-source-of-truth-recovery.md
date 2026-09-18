# Migration Source-of-Truth Recovery

**Status:** ACTIVE SOURCE-OF-TRUTH RULE
**Updated:** 2026-09-18
**Related:** MIG-001, ORG-004

## Purpose

The canonical repository must contain every migration filename that an accepted production history records. The HCIS migration runner uses the **full SQL filename** as migration identity through `schema_migrations.name`; the numeric prefix is ordering metadata only.

A deployed migration must therefore never be renamed, renumbered, silently edited, or collapsed into an older migration.

## Recovered production history

Read-only production evidence supplied for this recovery records these migration names in `schema_migrations` even though they were missing from canonical `main`:

| Filename | Accepted Git blob | SHA-256 |
| --- | --- | --- |
| `0020_organization_revisions_and_account_holders.sql` | `a4228312396a28ebe7cbba51a6a7cddff64d6031` | `4ed6015f373b0f254af091a4387f6ebb7ddc1dd539dee854e9bfa15bd80cdd7c` |
| `0021_multiple_structural_positions.sql` | `578604ec00baef7ed0c1f0bfac92bc8111e0480c` | `d87b2eeada82999137c881426911f8ee188a65026176f4bc1b7b7ac6a8a57b25` |
| `0022_employee_master_lifecycle_and_source_snapshots.sql` | `9e8c513e2d0a8abe594a555532d130a08c3e11f7` | `54dc786f9087371dbfd7ec00687d384909d86923f9ff89832992e223d64d35b2` |
| `0023_leave_approval_principals.sql` | `033c160d055975b1079b52c89c925f4878fb9154` | `a663deab2d7de1b23202029a13f67d6562f72304e302c58040719d1e7517c22d` |

The accepted source commit is `3de832a0cf098dc86f11e28b1b8c938827ef36a7` on historical branch `agent/organization-direct-cutover`. Recovery copies the exact historical blobs only; it does not cherry-pick the branch.

## Historical duplicate prefixes

Production already contains different full filenames sharing prefixes 0020-0023. They are retained deliberately:

```text
0019_dynamic_organization.sql
0020_hub_oidc_identity_mapping.sql
0020_organization_revisions_and_account_holders.sql
0021_attendance_adms_ingress.sql
0021_multiple_structural_positions.sql
0022_attendance_adms_projection.sql
0022_employee_master_lifecycle_and_source_snapshots.sql
0023_attendance_adms_admin.sql
0023_leave_approval_principals.sql
0024_attendance_adms_transport_recovery.sql
```

The runner sorts lexically by full filename. The organization and attendance migrations in each collision pair are independent at the point they execute:

- 0020 OIDC identity mapping and organization revision/account-holder schema both depend on earlier account/organization foundations, not on each other;
- 0021 ADMS ingress and multiple structural positions are independent;
- 0022 ADMS projection and employee lifecycle/source snapshots are independent;
- 0023 ADMS admin and Leave approval-principal migration are independent.

Do not create another duplicate numeric prefix unless the production-history manifest explicitly allowlists the exact filenames and records why the collision is historical and unavoidable.

## Final organization revision schema

`0019_dynamic_organization.sql` originally creates the unique index:

`organization_change_sets_one_published_date_idx`

The recovered 0020 organization revision migration removes that restriction and creates:

`organization_change_sets_effective_revision_idx`

The final contract permits multiple `PUBLISHED` organization revisions with the same `effective_on` date. Effective revision selection is ordered by:

1. `effective_on DESC`;
2. `published_at DESC`;
3. `created_at DESC`;
4. `id DESC`.

A clean install, disposable restore, and an upgraded database must converge on that final schema. The obsolete one-published-date unique index must not remain.

## CI guard

`apps/api/migrations/production-history-manifest.json` records:

- deployed protected migration filenames;
- SHA-256 checksums;
- accepted Git blob SHAs;
- source commit;
- the exact historical duplicate-prefix allowlist.

`apps/api/scripts/check-migration-source-of-truth.mjs` fails when:

- a protected deployed migration disappears or is renamed;
- protected content changes;
- accepted Git blob identity no longer matches;
- a new duplicate prefix appears without explicit allowlist;
- an allowlisted collision changes membership;
- the manifest is internally inconsistent.

The guard protects source history; it does not inspect production and contains no environment details, DSN, credentials, employee identifiers, or production data.

## Recovery rehearsal

`apps/api/scripts/rehearse-organization-migration-recovery.mjs` uses synthetic data and isolated schemas to prove:

1. a fresh full migration reaches the revision-index final state and permits same-effective-date published revisions;
2. a pre-recovery canonical migration set can apply the four recovered files without losing organization relationships or rewriting an existing employee Leave approval snapshot;
3. a history-shaped migration table that already records the recovered filenames causes the runner to skip them on rerun;
4. rerun/idempotence leaves row counts and recorded migration timestamps unchanged;
5. rollout remains empty/LEGACY during recovery.

## Current production evidence boundary

Read-only evidence supplied for 2026-09-18 reports production containers using application image SHA `ca38db08e85f064ffe5513f32ae0b75c11a3cf56` and records:

- organization revision index present;
- obsolete one-published-date index absent;
- 25 organization change sets: 15 `PUBLISHED`, 7 `DRAFT`, 3 `VALIDATED`;
- latest inspected published revision passed stored validation with zero issues;
- organization structure records exist;
- `organization_rollout_settings`: 0;
- SHADOW: 0;
- STRUCTURE: 0.

No employee names or identifiers belong in repository evidence.

Use this claim boundary:

```text
structure records exist
!= Human Capital acceptance complete
!= SHADOW validated
!= STRUCTURE activated
!= production pilot accepted
```

This recovery does not configure organization data and does not authorize rollout.

## Current source compatibility audit

The canonical source understands same-day revision selection after restoring deterministic `effective_on / published_at / created_at / id` ordering.

Other schema capabilities recovered from production history are **not automatically activated by this recovery**. Current `main` does not yet model all historical direct-cutover behavior, including the complete account-held incumbency, primary-structural-position, employee-removal lifecycle, and account-based Leave approval-principal paths found on the historical branch.

Those are separate compatibility/product changes because adopting them can affect authority, access, or approval behavior. Do not cherry-pick them as part of migration source recovery. Review them in a separately scoped change before any workflow activation that depends on those fields.

## If production history and repository diverge again

1. Stop and treat the missing migration as a source-of-truth incident.
2. Read `schema_migrations` and schema metadata only through an authorized read-only process.
3. Locate the exact migration in trusted Git history.
4. Verify full filename, Git blob, and content checksum.
5. Restore the historical filename/content unchanged.
6. Update the manifest only with reviewed evidence.
7. Run the guard, clean migration, recovery rehearsal, normal migration rehearsals, tests, build, and restore/recovery checks.
8. Do not rename a deployed migration to make numbering look cleaner.
9. Do not run recovered historical SQL against production merely because it was restored to Git; production with the filename already recorded must skip it.

## Rollback of this repository recovery

Before merge, rollback is simply reverting the recovery PR. After merge, do not delete/rename the restored deployed migration filenames as a routine rollback. If a defect is later found in historical schema evolution, preserve history and add a separately reviewed forward compatibility migration.
