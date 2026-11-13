# Employment history pilot activation runbook (EMP-005 S8)

**Status:** ACCEPTED 2026-11-13 (documentation step S8 of `docs/domain/employment-administration-package1-implementation-plan.md`).
**Specifications:** EMP-005, EMP-006, EMP-010 (`docs/domain/employment-administration-package1.md` §8).
**Release path:** OPS-MI8-REL-001 (`docs/development/mi8vps-hcis-release.md`).

This runbook takes employment history from mode `OFF` to `SHADOW` and then to `AUTHORITATIVE` for the pilot. It contains no personal data. All outputs it asks for are counts.

## Where production stands (2026-11-13)

| Step | State |
|---|---|
| Release with S1–S7, S2B-a | Deployed through the regular OPS-MI8-REL-001 releases; S2B-b (#319), S4b (#341) and the PPh21 report (#323) follow in the next release |
| Baseline | Loaded 2026-11-03 17:02 UTC (cutoff 2026-11-04): 326 employments, 96 open. Evidence in `production-release-verification-2026-11-04-e402c38a.md` |
| Baseline corrections | 3 `KONTRAK` → `KONTRAK_HONORER` reclassified on 2026-11-04 (owner decision) |
| `employment_history_mode` | `OFF` (unchanged since the baseline) |
| Daily projection refresh | Not scheduled yet (step 6) |

While the mode is `OFF`, nothing in the employment screens or register is usable. The EMP-004 import keeps writing the employee columns, as before.

## Roles

| Role | Does |
|---|---|
| Operator (agent or owner) | Backups, CLI runs, worker entry, mode switches. Writes the verification note |
| Human Capital (Kepala HCM + HC Admin) | SHADOW review, consistency fixes, UAT, sign-off |
| Owner | Approves the AUTHORITATIVE switch (exit criterion 7) |

Changing the mode needs `access.governance.manage`. It is done with `PUT /admin/employment/rollout` and a written reason, and the change is audited.

## Steps

### 1. Backup

Make a fresh `pg_dump -Fc` of the HCIS database into the Termux home, mode 0600, as in the 2026-11-04 load. Never run it during 19:00–19:59 UTC, the nightly backup hour. Take `/data/local/mi8vps/sq-core-release.lock` before starting, so no release runs in parallel.

### 2. Baseline refresh for staff who joined after the cutoff

1. Re-import the current master with EMP-004, so every employee has a source snapshot.
2. Run `employment-baseline.js` dry-run with `--cutoff <today>`. It only creates employments for employees without one; existing baselines are untouched.
3. Record the counts per issue code, then run `--apply` only if the dry-run is clean.

To fix the category of a baseline, use `--reclassify <CATEGORY> --reason "<why>" --employee <uuid> --actor-account <uuid> [--apply]`. Do not use `--rerun` once payroll profiles point at the employment.

### 3. Switch to SHADOW

`PUT /admin/employment/rollout` with `{ "mode": "SHADOW", "reason": "..." }`. HC can then read:

- the Kepegawaian & Kontrak and Penempatan & Karier tabs;
- the **Kecocokan Data** report;
- the Perjanjian Kerja & SK register.

No action can be recorded yet. Rollback is the same call with `OFF`.

### 4. HC review in SHADOW

Work the consistency report down to the exit criteria:

- **`BASELINE_STATUS_CONFLICT`:** resolve each one. Correct the master and re-import, or record the real end date.
- **`BASELINE_END_UNKNOWN` (115 at load):** enter the end date for former staff. These also block payroll (`SERVICE_END_UNRESOLVED`, PAY-003 round 1).
- **BUMY and Pengurus Yayasan records:** mark them **Di luar pengelolaan HCIS** (S2B) and check `ACCOUNT_LINKED_TO_OUTSIDE_HCIS_RECORD` and `APPROVER_OUTSIDE_HCIS`.
- **`BELUM_DIKLASIFIKASIKAN`:** classify each one with `--reclassify`.
- **Fixed-term staff without a contract end (`BASELINE_CONTRACT_END_UNKNOWN`, 47 at load):** record the PK in the register with its dates, or write down an HC acknowledgement.
- **Register:** enter the current PK/SK. They can be linked to the baseline actions once the mode is AUTHORITATIVE (S4b).

### 5. Scratch-restore rehearsal

1. Restore the backup into a scratch database.
2. Switch it to `AUTHORITATIVE`.
3. Run `employment-refresh-projection.js --all` (dry-run) and confirm "would change: 0". The projection must equal the current `employees` columns.
4. Compare annual-leave eligibility, the Board aggregates and the ORG-006 directory snapshot before and after. Each must be unchanged. Record the counts.
5. Drop the scratch database.

### 6. Daily projection refresh (worker entry)

Mi8VPS has no cron or systemd. Add a daily entry to `sq-core-worker.sh` that runs `employment-refresh-projection.js --apply` once a day at 00:30 WIB (17:30 UTC), outside the backup hour. Put the entry in the worker's versioned copy and record it in the Mi8VPS Platform Runbook.

The job writes only when the mode is `AUTHORITATIVE`. In any other mode it refuses, so it can be added before the switch.

### 7. Switch to AUTHORITATIVE (pilot)

Exit criteria (plan §S8), all required:

1. Zero `BASELINE_STATUS_CONFLICT`. BUMY and Pengurus Yayasan reviewed and marked.
2. No `BELUM_DIKLASIFIKASIKAN` for an active employee.
3. Every active fixed-term employee has a contract end date or an HC acknowledgement.
4. The projection equals the current `employees` columns (step 5).
5. Leave eligibility, Board and ORG-006 are unchanged on the rehearsal (step 5).
6. S5A automatic deactivation is merged, with green auth tests. Done.
7. HC sign-off and owner approval are recorded in the verification note.

Then `PUT /admin/employment/rollout` with `{ "mode": "AUTHORITATIVE", "reason": "..." }`.

From that point:

- New hires use **Mulai hubungan kerja**.
- The EMP-004 import stops overwriting employment fields for baselined staff and reports them as ignored.
- A recorded termination deactivates the account automatically (D-15).

### 8. Verification note

Write `docs/development/production-release-verification-<date>-employment-<mode>.md` with:

- counts per issue code before and after;
- the rehearsal counts;
- the time of each switch;
- who signed off.

Counts only, never names or employee numbers (NIP).

## Rollback

| Situation | Action |
|---|---|
| SHADOW shows something wrong | Mode `OFF`. Nothing was written to `employees`. |
| AUTHORITATIVE, no real action yet | Mode `OFF`. The import writes again. |
| AUTHORITATIVE with real actions | Mode `OFF` keeps the history; the import writes the columns again. Reversals are recorded per action (S7). A wrongly terminated account is reopened through access administration, not through reversal (D-15). |
| Baseline must go | Spec §8.6: verified backup, then the purge transaction described in the `0056_employment_history_foundation.sql` header (per employee: `employment-baseline.js --rerun --employee <uuid>`). Only employments whose sole action is the baseline and which carry no linked PK/SK are removed; one that payroll profiles point at is refused by the database. |

## Constraints that stay in force

- No staff account is activated and no invitation is sent as part of this runbook. Account activation is a separate, final launch step.
- WhatsApp stays in allowlist mode.
- The mode switches are recorded and explained; they are never flipped silently.
