# Production release verification — hcis-e402c38a-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 16:59–17:01 UTC (2026-11-03 23:59 – 2026-11-04 00:01 WIB)
**Operator:** Claude Code (orchestrator session), under the owner rule of 2026-10-27 (release without confirmation, keeping dry run, backup, candidate gate, rollback on failed verify, report afterwards, never at 19 UTC). Release lock free at preflight, taken and released by the script.

| Item | Value |
|---|---|
| Target SHA | `e402c38a606b204ac175affecc07b6480850aeda` (`origin/main`: merge of #303) |
| Previous release | `hcis-af226c4e-20261103` |
| Adds | PAY-003-MIG payroll initial data load CLI (`apps/api/dist/modules/payroll/cli/payroll-initial-load.js`, §4.11); `SALARY_SCALE` accepts fractional amounts. No data was loaded by this release. |
| Build | run [41678922054](https://github.com/sabilulquran/hcisysq/actions/runs/41678922054), bundle sha256 `4b8a4e4e5483ef56b8b5d8f71b39cfde6747f4895cbd0c30d8d99388a77c8338` |
| Migrations | 115 in bundle, none pending |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-e402c38a-20261103-20261103T165933Z.dump` |
| Launcher | `95da21e01f14f9f7` → `4e3cb61121fc9eeb` |
| Worker | `86d5100643bc07a0` → `cc0df2365c570c84`; pid 13270 → 31093 |
| Rollback target | `hcis-af226c4e-20261103` (application only) |

Preflight, upload, backup, candidate gate (API `/health`, `/ready`; web `/`, no-store, `/login`, immutable asset, missing asset 404), cutover (about 26 s) and local and public verify all PASS. The running API process works from `/srv/hcis/releases/hcis-e402c38a-20261103/apps/api`.

## Configuration change before this release: mobile attendance re-enabled (ATT-006)

At 16:5x UTC, before the release, `MOBILE_ATTENDANCE_ENABLED=1` was added to `/srv/hcis/shared/final.env`. The owner decided on 2026-09-19 to enable mobile GPS + photo attendance in production (`docs/domain/attendance-engine-mobile.md`), but the setting was not carried over in the move to Mi8VPS, so Clock In/Out answered `runtime_disabled`. The restricted-media keyring (`BIOMETRIC_ACTIVE_KEY_ID`, `BIOMETRIC_ENCRYPTION_KEYS`) was already present; `BIOMETRIC_COLLECTION_ENABLED` stays unset (OFF).

Procedure (§5.3–5.5): backup `final.env.pre-mobile-<stamp>`, candidate file validated with `loadConfig()` of the running release (`CONFIG OK mobile=1`), HCIS restarted with a pid wait (14138 → 27613, `/health` 200), key read back from the new process environ. The release above kept it (`MOBILE_ATTENDANCE_ENABLED=1` in the new process). Rollback: restore the `pre-mobile` file and restart `hcis`.

Known gap, not changed here: no shift version has a work location yet, so mobile check-ins cannot be judged against a geofence until HC links shifts to the SDIT, Pesantren and (to be created) Taman Tahfizh locations.
