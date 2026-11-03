# Production release verification — hcis-1589be41-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (03:13–03:27 UTC, 10:13–10:27 WIB)
**Operator:** RPT-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes; queued behind HELP-001 and ATT-015 and started only after both notes said DONE. The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `1589be411d260e2a36521d9e9bb64088388c82fe` (`origin/main`, merge of #281) |
| Previous release | `hcis-bdc8317f-20261103` (ATT-015) |
| Adds since `hcis-bdc8317f-20261103` | RPT-001 Package 1 (#281); HELP-001 release note #283 (documentation only) |
| Build | run [41570019234](https://github.com/sabilulquran/hcisysq/actions/runs/41570019234), bundle `hcis-1589be41-20261103.tar.gz` sha256 `27570cd2333b16439e5b6ba416bfd85515c616353d823f62d0bb15612e0621c3` |
| Migrations | 108 in bundle; pending and applied: `0126_hr_reports_roles.sql` (only `roles.description` of `finance` and `management`; no table, column or permission) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-1589be41-20261103-20261103T031433Z.dump` (37 017 395 B, sha256 `c0a6a68a06ef7bb309fa8dd6fb2a6c6dac4327d929530296a259c378583d14c9`) |
| Launcher / worker | `03076275e0caad68` → `192ec8effa4dd9c9` / `ef607558ccf2fb5f` → `d593819ad7994cbf` |
| Worker | KILL-restarted: pid 6060 → 26393 |
| Rollback target | `hcis-bdc8317f-20261103`. 0126 changes only role descriptions, so an application rollback needs nothing in the database; the old build simply shows the new wording. |

**Before the release (read-only):** production held no `finance` or `management` assignment in any scope, so widening both roles to unit scope (spec D-02) activated no existing grant. This answers finding 4 of the independent review.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 10:13 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-bdc8317f-20261103` running, 16 102 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0126. |
| 10:13–10:14 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 10:14 | migrate | `applied 0126_hr_reports_roles.sql`. |
| 10:15 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 10:15 | cutover | New release running after about 26 s. |
| 10:16 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
27156 /usr/bin/node dist/server.js                        | /data/local/ubuntu26/srv/hcis/releases/hcis-1589be41-20261103/apps/api
27733 /usr/bin/python3 /srv/hcis/shared/spa_static_server | /data/local/ubuntu26/srv/hcis/releases/hcis-1589be41-20261103/apps/web/dist
```

**Database, read-only after the release:** `schema_migrations` holds 0126; the two role descriptions now say what the roles open; no `reports.hr.exported` audit row exists yet.

**Public:** `/api/health` → 200 `{"status":"ok"}`; `/api/admin/reports/hr/access`, `/api/admin/reports/hr/employees` and `/api/admin/reports/hr/leave/export?format=csv` without a session → 401 (the routes answer and demand a session); `/admin/reports` → 200 SPA shell; `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` → 200.

**Ten-minute watch (10:16–10:27 WIB):** five checks about two minutes apart; the worker log held 353 `launch service=hcis*` events at every check (the cutover pair at 10:15:41/10:15:57 included), the API process stayed in `hcis-1589be41-20261103/apps/api`, and public `/api/health` answered ok each time.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator, and an authenticated report or export. Signing in needs a password, which this session never types (owner rule), and nobody holds a report role in production yet. Every report, the unit scope, export, audit and the absence of sensitive columns run against PostgreSQL in CI (`reports.postgres.test.ts`), and the screen was checked in a local browser with synthetic data (unit-scoped Pimpinan, read-only Pembaca, empty, forbidden and 375 px states).

## What changes for users

A **Laporan HR** entry appears under *Laporan* in the admin menu (`/admin/reports`) for accounts holding **Pembaca Laporan** (view) or **Pimpinan (Laporan)** (view and download CSV/XLSX), granted for the whole organization or one unit. No account holds either role today, and HCIS is not yet live to staff, so nothing changes until the Platform Administrator grants one. No national ID, bank, address, contact or money column is in any report.

Not recorded here: `final.env` values, tokens, cookies or employee data.
