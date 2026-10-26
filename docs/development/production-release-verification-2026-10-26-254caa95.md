# Production release verification — 2026-10-26 (Mi8VPS, hcis-254caa95)

**Status:** RELEASED AND VERIFIED. The operator's browser check of the Kalkulasi screen with a real HC account is not yet confirmed (see Notes).

**Owner approval:** 2026-10-26, in chat: "Ya, saya setujui rilis hcis-254caa95-20261026 ke produksi sekarang dengan --apply --confirm RELEASE_254caa95, termasuk migrasi 0061 dan izin baru attendance.calculation.run. Rollback aplikasi kalau ada cek yang gagal."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), dry run first, then `release-mi8.sh all --apply --confirm RELEASE_254caa95`.

## Why

Ships ATT-014-2 Kalkulasi (#164): Human Capital runs an attendance calculation for a chosen scope and date range instead of pressing Finalisasi per date. The release adds migration `0061_attendance_calculation_runs.sql`.

## Release

| Item | Value |
|---|---|
| Target SHA | `254caa95f2155c431307c649d6d8d95045b818b2` (`origin/main`) |
| Contents since running release | #164 ATT-014-2 Kalkulasi, plus the #160 release note |
| Release name | `hcis-254caa95-20261026` |
| Build | `build-mi8-release.yml` run [40254526031](https://github.com/sabilulquran/hcisysq/actions/runs/40254526031), green |
| Bundle sha256 | `67cbf3fe8ad863fff784cb9f01f5ade2564297ee584ae5a3f7027b34fa7d6506` |
| Previous release | `hcis-c54b0b97-20261024`, kept in place for rollback |
| Migrations | 61 in bundle, **1 pending and applied**: `0061_attendance_calculation_runs.sql` |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-254caa95-20261026-20261026T020745Z.dump` (33 090 897 B, sha256 `ac3de006fc5df229380e9ba44392b0b3eb2d72dc244cafaae8084cacee05b316`) |

## Migration 0061 — what it changes

Additive only, confirmed by reading the file before approval:

- new permission `attendance.calculation.run`, granted to roles `human_capital_admin` and `human_capital`;
- new table `attendance_calculation_runs` (run history; at most one run `running` server-wide; range capped at 93 days) with three indexes.

No existing table, row or permission is modified or removed. The previous release ignores both the table and the permission, so it keeps working on the new schema. Rollback statements are in the migration header; the table holds run history only, so dropping it loses no attendance data.

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 08:32 | `all` dry run | PASS. `hcis-c54b0b97-20261024` was running, the target was absent, the lock was free, about 23.7 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`. One pending migration reported. |
| 09:07 | preflight, upload, backup | PASS. Lock taken, 128 MB installed, backup verified with `pg_restore --list`. |
| 09:08 | migrate | PASS. `applied 0061_attendance_calculation_runs.sql`; all bundle migrations present afterwards. |
| 09:08 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 09:08 | cutover | Launcher `28af42f6d7376d93…` → `3cdba9fd20291bb7…`, worker `c51374965a2948b4…` → `2d51c7fde677a071…` (sha256 prefixes). Worker 26264 → 12411. `hcis` and `hcis-web` restarted at 09:08:28 and ran the new release after about 26 s. |
| 09:09 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. Release lock released. |
| 09:09 | post-release checks | The served entry bundle contains "Kalkulasi" and the route `/admin/attendance/calculation`; Pantauan Hari Ini is still there. Read-only DB check: permission row present, granted to `human_capital` and `human_capital_admin`, `attendance_calculation_runs` empty. |
| 09:10–09:19 | 10-minute watch | PASS. Public `/api/health` returned 200 every minute. The worker log shows one `launch service=hcis` (09:08:42) and one `hcis-web` (09:08:58), with no later launches. Both processes run from `hcis-254caa95-20261026`. `hub` and `aset` answer 200. |

## Notes

- The release ran end to end without the SSH interruption seen on 2026-10-23; the lock was released by `verify` in the same run.
- Operators holding `human_capital` or `human_capital_admin` can now run a calculation that writes attendance result versions. This was part of the owner's approval.
- Still to confirm by the operator: open Waktu & Kehadiran → Kalkulasi with a real HC account and run one calculation on a small scope.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 254caa95f2155c431307c649d6d8d95045b818b2 --apply --confirm RELEASE_254caa95` returns to `hcis-c54b0b97-20261024`. The database is not rolled back: `0061` is additive and the previous release ignores it, so no database action is needed. Removing the table and permission is optional and documented in the migration header.
