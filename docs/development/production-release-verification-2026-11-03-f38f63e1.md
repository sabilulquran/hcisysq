# Production release verification — hcis-f38f63e1-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (03:39–03:52 UTC, 10:39–10:52 WIB)
**Operator:** LEAVE-009 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes after the RPT-001 release said DONE; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `f38f63e17ddeb1b1ec0b1983b673faae78b81b42` (`origin/main`: merge of #280 plus the RPT-001 release note #286, documentation only) |
| Previous release | `hcis-1589be41-20261103` (RPT-001) |
| Adds since `hcis-1589be41-20261103` | LEAVE-009 masa kritis cuti (#280); RPT-001 release note #286 (documentation only) |
| Build | run [41573264791](https://github.com/sabilulquran/hcisysq/actions/runs/41573264791), bundle `hcis-f38f63e1-20261103.tar.gz` sha256 `a97ed3a7124f3a2a4717f4256b149f209593e9717c41cbdc80cb3dc9f9b035d7` |
| Migrations | 109 in bundle; pending and applied: `0128_leave_critical_periods.sql` (two new tables, additive, no permission grant) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-f38f63e1-20261103-20261103T034019Z.dump` (37 022 801 B, sha256 `24acbe951f7230d71b61a20fdd7cb7ecd6391498c90486fd02fd0cf8eeaddb4f`) |
| Launcher / worker | `e167b351ddc09d3f` → `b0df0b2a436d2365` / `d7e4aa1276629f0b` → `c2b103fdf4529bdd` |
| Worker | KILL-restarted: pid 10212 → 21468 |
| Rollback target | `hcis-1589be41-20261103`. The old build does not read the new tables, so an application rollback is safe without touching the database. While rolled back, a leave request with a waiting critical review would finish line approval without the HC review, and one with a pending review would stay in review; both tables were empty after the release. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 10:39 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-1589be41-20261103` running, 15 863 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0128. |
| 10:40 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 10:40 | migrate | `applied 0128_leave_critical_periods.sql`. |
| 10:41 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 10:41 | cutover | New release running after about 26 s. |
| 10:41 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
22327 node dist/server.js | /data/local/ubuntu26/srv/hcis/releases/hcis-f38f63e1-20261103/apps/api
```

**Database, read-only after the release:** `schema_migrations` holds `0128_leave_critical_periods.sql` (applied 10:40:45 WIB); `leave_critical_periods` and `leave_request_critical_reviews` exist and are empty.

**Public:** `/api/health` → `{"status":"ok"}`; `/api/admin/leave/critical-periods` and `/api/leave/hc/critical-reviews` without a session → 401 (the routes answer and demand a session); `/admin/leave/critical-periods` and `/app/hc/critical-leave` → 200 (SPA shell).

**Ten-minute watch (10:42–10:52 WIB):** no `launch service=hcis*` event after the cutover pair (worker log launch count 355 at 10:42 and at 10:52). The API still runs as pid 22327 from `hcis-f38f63e1-20261103` at the end of the window, and `/api/health` answers ok.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The workflow runs end to end against PostgreSQL in CI (`leave-critical-periods.postgres.test.ts`, LEAVE-009-A to J plus the self-review rule).

## What changes for users

HC Admin gets **Masa Kritis** under Cuti in the admin menu (`/admin/leave/critical-periods`) to set exam weeks, PPDB and similar periods for the whole foundation or one unit. Employees who request Cuti Tahunan or planned leave on those dates see a warning, can still submit, and after their line approval the request waits for an HC decision in **Cuti Masa Kritis** (`/app/hc/critical-leave`, HC holding the HC approval mandate). The calendar shows the periods. No period exists yet, so nothing changes until HC creates one; HCIS is not yet live to staff.

Not recorded here: `final.env` values, tokens, cookies or employee data.
