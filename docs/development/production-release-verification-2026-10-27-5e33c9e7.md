# Production release verification — 2026-10-27 (Mi8VPS, hcis-5e33c9e7)

**Status:** RELEASED AND VERIFIED by the script checks. The operator's browser login and deep-link
refresh are not yet confirmed (the operator session in the browser pane is logged out).

**Authority:** owner rule of 2026-10-27 (releases without a per-release confirmation; dry run, backup
before migrations, candidate gate, rollback on failed verification, report afterwards; never in the
19 UTC backup hour). Announced in the shared operator notes first.

## Release

| Item | Value |
|---|---|
| Target SHA | `5e33c9e7b215b138047fcf8eaf131cf4b1ff6a88` (`origin/main`) |
| Contents since running release | ATT-014-R2b (#186), ATT-014-R2d (#188), ATT-011-7 (#191), ATT-011-3 (#194), ATT-011-6a (#196), the a55ad2eb note (#189), and other sessions' merges up to `5e33c9e` (ORG-008, PAY-003 schema) |
| Release name | `hcis-5e33c9e7-20261026` (UTC build date) |
| Build | `build-mi8-release.yml` run [40390500463](https://github.com/sabilulquran/hcisysq/actions/runs/40390500463), green |
| Bundle sha256 | `1a101ec3c47c553ff4b1072d5ba244081804f9a4e47a8c4a2a3790a72eb024cd` |
| Previous release | `hcis-a55ad2eb-20261026`, kept for rollback |
| Migrations | 71 in bundle, **4 pending and applied**: `0068_organization_node_work_location`, `0069_payroll_foundation`, `0070_payroll_period_transitions`, `0071_attendance_result_day_type` |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-5e33c9e7-20261026-20261027T011429Z.dump` (33 469 457 B, sha256 `dc72e49ba4cac7585a8e67992646359735823a7da97005f140bb38b3b57ee5ad`) |
| Launcher | `sq-core-launch.sh` `c7593ecd6eab5077` → `9bb4798ec66f891c` |
| Worker | `sq-core-worker.sh` `d76661db95dec062` → `4423f5c4d5154b38` |

All four migrations are additive (new tables, one nullable column pair, an index, new permissions and
roles). `0069` declares `CREATE EXTENSION IF NOT EXISTS btree_gist`; the extension was already installed,
checked read-only before the release.

## Timeline (WIB, 27 Oct)

| Time | Phase | Result |
|---|---|---|
| 08:12 | preflight dry run | PASS. Lock free, `hcis-a55ad2eb-20261026` running, about 22.3 GB free, biometric OFF, 4 pending migrations. |
| 08:13–08:14 | preflight, upload, backup | PASS, backup verified. |
| 08:14 | migrate | PASS, four files applied. |
| 08:14–08:15 | candidate | PASS. |
| 08:15 | cutover | PASS. Worker restarted with KILL; `hcis` and `hcis-web` launched once each; running from the new release after about 26 s. |
| 08:15 | verify | PASS (local health/ready, web no-store, symlink, worker, public `/api/health`, `/login`, asset 404). Lock released. |
| 08:20 | watch | No further HCIS launches after cutover. |

## Notes for operators

- ATT-011-6a puts the kind of day into the result inputs: the first Kalkulasi over a range writes **one new
  version per employee-day** (carrying `day_type`), then the results are stable again. Expect a burst of
  rows on the first wide Kalkulasi.
- Rollback: `release-mi8.sh rollback --sha 5e33c9e7b215b138047fcf8eaf131cf4b1ff6a88 --bundle <bundle>` returns to
  `hcis-a55ad2eb-20261026`; the database is not rolled back and the migrations can stay.
