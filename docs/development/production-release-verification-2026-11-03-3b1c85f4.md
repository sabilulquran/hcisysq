# Production release verification — hcis-3b1c85f4-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (01:39–01:54 UTC, 08:39–08:54 WIB)
**Operator:** PERF-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced beforehand in the shared operator notes; TRAIN-001 cancelled its own `3b1c85f4` release before any device change so this one carried it. The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `3b1c85f4f847e082e8cee0aff4d3cbcdf2255a92` (`origin/main`) |
| Previous release | `hcis-7ef379cf-20261102` (LOAN-001) |
| Adds since `hcis-7ef379cf-20261102` | PERF-001 Package 1, performance review (#270); CAL-001 meetings blocked by TRAIN-001 sessions (#275); docs only (#276) |
| Build | run [41560351969](https://github.com/sabilulquran/hcisysq/actions/runs/41560351969), bundle `hcis-3b1c85f4-20261103.tar.gz` sha256 `1bbf37904fb1ed5f65fb5f5cf3d918585b03cd3d99430f9f3794e4106b5f78b4` |
| Migrations | 103 in bundle; **two pending**: `0120_performance_reviews.sql` (three new tables, additive) and `0121_performance_review_permissions.sql` (`performance.read`, `performance.manage` → `human_capital_admin`). 0121 adds permissions to an existing role, so the release carried no other permission migration (§4.5, D-17). |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-3b1c85f4-20261103-20261103T014147Z.dump` (36 912 316 B, sha256 `39eb500fa37ae869384defe7f8fa1a3a81c2bf7368ba367e542c5b073bf1f14a`) |
| Launcher / worker | `69b259250cc99058` → `b360fbd1048e2d74` / `2838f806c48829c6` → `008fdc3e3cbaf242` |
| Worker | KILL-restarted: pid 23512 → 323 |
| Rollback target | `hcis-7ef379cf-20261102`. Code rollback is safe: the old release does not read the `performance_*` tables, and the two extra permission rows are unknown to it only for role delegation (§4.5). |

## Result (UTC)

| Time | Phase | Result |
|---|---|---|
| 01:39 | preflight + every phase as dry run | PASS. Lock free, `hcis-7ef379cf-20261102` running, 16 659 MB free, biometric OFF, database `sqcore_hcis`, pending 0120 + 0121. |
| 01:40–01:42 | preflight under `--apply`, upload, backup | PASS; checksum verified on the device; dump taken and listed. |
| 01:42:15 | migrate | `applied 0120_performance_reviews.sql`, `applied 0121_performance_review_permissions.sql`. |
| 01:42:31 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 01:42:31 | cutover (first attempt) | **STOP before any change**: `running hcis API not found`. See incident below. |
| 01:43:09 | cutover (second attempt) | New release running after about 30 s. |
| 01:43:53 | verify | Local and public checks PASS. Lock released. |
| 01:44–01:54 | watch | See below. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device, independently of the release script):

```text
1966 node  | /srv/hcis/releases/hcis-3b1c85f4-20261103/apps/api
2492 python3 spa_static_server.py | /srv/hcis/releases/hcis-3b1c85f4-20261103/apps/web/dist
```

Public after the release: `https://hcis.sabilulquran.or.id/api/health` → `{"status":"ok"}`; `/admin/performance` → 200 shell; `/api/performance/me` without a session → 401 (the new routes answer and demand a session).

**Watch (01:45–01:54 UTC, once a minute):** `/health` 200 and web 200 every time; `sq-core-worker.log` has no `launch service=hcis*` event after the cutover pair (08:43:30 `hcis`, 08:43:46 `hcis-web` WIB); the same pids 1966 (API) and 2492 (web) ran from `hcis-3b1c85f4-20261103` at the end.

## Incident during the candidate gate

Between 01:42:24 and 01:42:41 UTC the worker relaunched **Aset** and then **HCIS API** (`launch service=aset`, `launch service=hcis attempt=1`) while the candidate API and web were running next to production. `dmesg` shows Android's low-memory killer active at that time. Production HCIS answered `/health` with 000 at 01:42:41 and 200 again at 01:42:52, still on `hcis-7ef379cf-20261102` (the launcher had not been touched), so the outage was roughly 20–30 s. The cutover phase saw no running API at that moment and stopped before editing anything, as designed; it was re-run alone after the service was back, with migrations and the candidate gate already passed under the same lock.

Follow-up (outside this release): the candidate gate briefly doubles HCIS memory on the phone. Consider stopping the candidate before Aset/HCIS feel it (shorter gate), or checking free memory before starting it.

## Not done

The browser login and deep-link refresh that §4.8 asks of the operator: signing in needs a password, which this session never types (owner rule). API behaviour is covered by `performance.postgres.test.ts` in CI on a real PostgreSQL (migration grant, full cycle, rater snapshot, employee privacy, no self-validation, return, rater assignment, remove and re-add, closing, duplicate periods, frozen rubric, adding every active employee).

## What changes for users

Human Capital gets **Kinerja / KPI** in the admin service catalog: monthly or academic-year cycles with an editable rubric while in draft, participants (one by name search or every active employee), the rater taken from the line manager in the structure, a recap by status and predicate, validation or return of each rating, rater assignment, and per-employee history. Employees get **Penilaian Kinerja**: a self-assessment, the result after HC validation, and a "read" acknowledgement; raters get the team queue. Results do not touch payroll. HCIS is not yet live to staff, so nothing reaches employees until accounts are activated.

Not recorded here: `final.env` values, tokens, cookies or employee data.
