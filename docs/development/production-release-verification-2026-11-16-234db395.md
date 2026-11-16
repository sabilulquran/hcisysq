# Production release verification — hcis-234db395-20261116 (OPS-MI8-REL-001)

**Date:** 2026-11-16 17:48–17:51 UTC (2026-11-17 00:48–00:51 WIB)
**Operator:** Claude Code (session that merged #351–#353), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `234db3954d9f03020c89fb44244aa4aa6fec0721` (`origin/main`: merge of #353) |
| Previous release | `hcis-602fddd2-20261116` |
| Adds | #351 ATT-014 §6.5b: the employee's attendance history shows scans received for dates that are not calculated yet (*Belum dihitung*), from one range query; official minutes stay empty until HC runs Kalkulasi. #352 employee detail views open as pop-ups (`DetailDialog`). #353 admin detail views open as pop-ups. #352 was merged with main by hand in `EmployeeAttendancePage.tsx`: the history rows use `historyCells()` from #351, and clarification opens in the #352 pop-up |
| Configuration | No `final.env` change |
| Build | run [43921581542](https://github.com/sabilulquran/hcisysq/actions/runs/43921581542), bundle `hcis-234db395-20261116.tar.gz` sha256 `d2d712e4513de4f322fa291d45dfd83415a001a30b6fc6e762c7c750c255f2a3` |
| Migrations | 128 in bundle; none pending. The three PRs add no migration |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-234db395-20261116-20261116T174928Z.dump` (sha256 `03d189a2…de37c4770`, 40.5 MB) |
| Worker | restarted: pid 13065 → 9111 |
| Rollback target | `hcis-602fddd2-20261116`; no schema change, so the rollback is application-only |

## Result

Preflight and the `all` dry run passed (lock free, 22 GB free on `/data`, biometric OFF, database `sqcore_hcis`, no pending migrations). Under `--apply`:
- the candidate gate passed;
- after cutover (restart at 00:50:21 WIB, one `launch` per service), verify passed: release paths, API `/health` and `/ready`, web `/` no-store, current symlink, worker alive, public `/api/health`, `/login`, missing asset 404.

Read-only checks after verify: `/app/attendance` and `/admin/committees` return the SPA shell (200); `GET /api/attendance/me/schedule` without a session returns 401; `hub.sabilulquran.or.id` answers 200. The worker logged *Hub dependency gate: HCIS unavailable* only during the cutover seconds.

Not done by the operator: browser login and deep-link refresh. The agent never types credentials; HC or the owner checks this on the next sign-in.

## Not changed

No production data was edited and no account, invitation or notification was created. Attendance results are unchanged: #351 only reads `attendance_adms_events` for dates without a calculated result.
