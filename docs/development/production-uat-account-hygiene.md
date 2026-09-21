# Production UAT Account Hygiene

**Status:** IMPLEMENTED TOOLING — EXECUTION REQUIRES REVIEWED EXACT IDS  
**Safety boundary:** no broad delete, no employee deletion, no immutable-history deletion.

## Purpose

Remove UAT login/access clutter without pretending historical workflow evidence never happened.

The workflow `.github/workflows/uat-account-hygiene.yml` has three explicit modes:

1. `scan` — read-only candidate scan using conservative synthetic hints already used by tests/docs;
2. `preview` — read-only impact preview for exact account UUIDs;
3. `disable` — set only the exact selected non-Super-Admin accounts to `inactive`, revoke active sessions and outstanding activation tokens, and append an access audit event.

The workflow uses the protected `production` environment and the same `hcis-production` concurrency group as deployment so a cleanup cannot overlap a deploy.

## What it does not do

It does not:
- delete accounts;
- delete employee rows;
- change employee status;
- delete role-assignment history;
- delete attendance events, photos, results, leave, approvals, shift swaps, payslips, or access audit;
- target by display name/email substring in disable mode;
- touch Super Admin;
- accept more than 20 exact accounts in one run.

A synthetic-looking candidate returned by `scan` is not an approval to disable it.

## Required operator sequence

### A. Scan

Run from current `main`:

- mode: `scan`
- account_ids: empty
- confirmation: `SCAN_UAT_CANDIDATES`

The output intentionally prints identifiers/status/dependency counts, not names or email addresses.

### B. Owner review

Compare exact account UUIDs with the UAT accounts visible in HCIS and confirm which are genuinely synthetic. A real employee who participated in UAT is **not** a UAT account.

### C. Preview exact IDs

- mode: `preview`
- account_ids: comma-separated exact UUIDs
- confirmation: `PREVIEW_UAT_ACCOUNTS`

Review active sessions, activation tokens, role assignments, and historical domain-row counts.

### D. Disable

Only after exact-ID approval:

- mode: `disable`
- same account_ids
- confirmation: `DISABLE_UAT_ACCOUNTS`

Postcondition:
- selected accounts are `inactive`;
- active sessions = 0;
- outstanding activation tokens = 0;
- linked employee status is unchanged;
- historical domain evidence remains;
- an `uat.account.disabled` audit event exists for each exact account.

## Admin UI behavior

Changing any account to a non-active status through HCIS now revokes active sessions and outstanding activation tokens in the same transaction. Inactive accounts are hidden by default in Account & Access but can be shown for history/review.

## Further cleanup

If a genuine synthetic employee row itself should become inactive, handle that separately after checking reporting-line, approval, payroll, attendance, leave, device mapping, and other dependencies. Do not add employee mutation to this workflow merely to make a screen look cleaner.
