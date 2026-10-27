# Production release verification — 2026-10-27 (Mi8VPS, hcis-a55ad2eb)

**Status:** RELEASED AND VERIFIED by the script checks. The browser login and deep-link refresh by an
operator are not yet confirmed (the operator session in the browser pane was logged out).

**Authority:** owner rule of 2026-10-27, relayed by the coordinating session: releases run without a
per-release confirmation, with a dry run first, a backup before migrations, the candidate gate, rollback
on failed verification, and a report afterwards; never during the 19 UTC backup hour.

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001): preflight dry run, then
`release-mi8.sh all --apply --confirm RELEASE_a55ad2eb`. Announced in the shared operator notes first.

## Why

Ships ADMS-R2c (#180): PIN mappings start at the employee's TMT, "Sesuaikan dengan TMT" with dry run,
apply and revert. It is needed for the one-time correction of the 46 PIN mappings created on
19 Oct 2026 (ATT-014 §20.5).

## Release

| Item | Value |
|---|---|
| Target SHA | `a55ad2eb738e3bde2dd107fbf61a11ce1d9a27c2` (`origin/main`) |
| Contents since running release | #180 ADMS-R2c, #181 ORG-008-9, #184 ORG-008-10 (DRAFT), #147 PAY-003 docs, #182 PAY-003 engine |
| Release name | `hcis-a55ad2eb-20261026` (UTC build date) |
| Build | `build-mi8-release.yml` run [40377451384](https://github.com/sabilulquran/hcisysq/actions/runs/40377451384), green |
| Bundle sha256 | `7cc17836dd3cf627e8f70408bf93fb0dcdc7afc07c927708cdb33809b2205c84` |
| Previous release | `hcis-5cd6c423-20261026`, kept in place for rollback |
| Migrations | 67 in bundle, **2 pending and applied**: `0066_access_role_position_links.sql`, `0067_adms_mapping_aligned_to_start_date.sql` |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-a55ad2eb-20261026-20261026T182914Z.dump` (33 360 261 B, sha256 `a542e800caa665a06c363697f9b595aa5c9d81756dfaac91b85ece7070666f0e`) |
| Launcher | `sq-core-launch.sh` `37d71a7f50779fff` → `c7593ecd6eab5077` |
| Worker | `sq-core-worker.sh` `2f5e416b793a2a9d` → `d76661db95dec062` |

Both migrations are additive: `0066` creates one table, `0067` adds two values to the ADMS admin audit
action CHECK. The previous release writes neither, so it runs unchanged on the new schema.

## Timeline (WIB, UTC+7, 27 Oct)

| Time | Phase | Result |
|---|---|---|
| 01:28 | preflight dry run | PASS. Lock free, `hcis-5cd6c423-20261026` running, target absent, about 22.7 GB free, biometric collection OFF, DB `sqcore_hcis`, 2 pending migrations. |
| 01:28–01:29 | preflight, upload, backup | PASS. Backup verified with `pg_restore --list`. |
| 01:29 | migrate | PASS, both files applied. |
| 01:29 | candidate | PASS (API `/health` `/ready`, web shell and assets). |
| 01:29–01:30 | cutover | PASS. Worker restarted with KILL, `hcis` and `hcis-web` relaunched once each, running from the new release after about 26 s. |
| 01:30 | verify | PASS: local health/ready, web no-store, `current` symlink, worker alive, public `/api/health`, `/login`, `/assets/does-not-exist.js` 404. Lock released. |
| 01:38 | watch | No further launches in `sq-core-worker.log` after cutover. |

## Rollback

Application: `release-mi8.sh rollback --sha a55ad2eb738e3bde2dd107fbf61a11ce1d9a27c2 --bundle <bundle>`
returns to `hcis-5cd6c423-20261026`. The database is not rolled back; both migrations are additive and can
stay.
