# Production release verification — 2026-10-16 (Mi8VPS, hcis-6066d5b0)

**Status:** RELEASED AND VERIFIED.

**Owner approval:** 2026-10-16, in chat: "Ya, merge PR #110 lalu rilis main terbaru ke production (termasuk tampilan baru #112), dengan backup dan verifikasi seperti biasa." The owner repeated it in the release session: "silakan merge & deploy".

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), `release-mi8.sh all --apply --confirm RELEASE_6066d5b0`.

## Release

| Item | Value |
|---|---|
| Target SHA | `6066d5b06c915f49dd5452d4f5ed116007d673d8` (`origin/main`) |
| Contents since running release | #110 ATT-006 mobile evidence filter placeholders; #107 AUTH-011 role grants Super Admin only (SEC-02, SEC-03) plus route-coverage tests; #111 Mi8 worker restart with KILL; #103, #108, #109 docs |
| Release name | `hcis-6066d5b0-20261016` |
| Build | `build-mi8-release.yml` run [38922461833](https://github.com/sabilulquran/hcisysq/actions/runs/38922461833), green |
| Bundle sha256 | `3a4eadfc18a2b573348c595af5c90db634ec68633a10bce2318b608496fb4137` |
| Previous release | `hcis-4aab3d14-20261016` (main `4aab3d1`, #112 app shell), kept in place for rollback |
| Migrations | 55 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-6066d5b0-20261016-20261016T151942Z.dump` (28 427 884 B, sha256 `2b04ebfe3e7aa3c4ff0dbcc80d66955c3b1f01d31b1d6e4c4ec94db035c6a98d`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 22:18 | preflight (dry run, then apply) | PASS. `hcis-4aab3d14` was running, the target was absent, about 30.4 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 22:19 | upload, backup, migrate | PASS. Installed 128 MB, backup verified, migrate was a no-op. |
| 22:20 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 22:20 | cutover | Launcher `06c122f5…` → `76a30e12…`, worker `fac2b1db…` → `f90e254a…`; worker 17859 → 550 (KILL); `hcis` and `hcis-web` restarted at 22:20:24 and ran the new release after about 26 s. |
| 22:21 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` returned 200. |
| 22:21–22:31 | 10-minute watch | PASS with one event: one unplanned `hcis` relaunch at 22:27:29 (see Notes). Afterwards both processes ran from `hcis-6066d5b0`, worker 550 was alive, and public `/api/health` was `{"status":"ok"}`. |

## Notes

- At 22:27:28 the API process (pid 1510, started 22:20:40) stopped without an error, fatal or shutdown line in `api.log`. Its last request completed at 22:27:28 with 200. The worker relaunched it at 22:27:29 (`launch service=hcis attempt=1`). The new pid 9217 was listening at 22:27:33 on the same release. `hcis-web` was not affected, and the API was unavailable for about 5 s. Cause: **external SIGTERM, initiator unconfirmed**. `dmesg` shows `init: Untracked pid 1510 received signal 15`. The lowmemorykiller killed only Android apps, and an OOM kill would have been SIGKILL. The worker log has no `stop service=hcis` line, so the worker did not stop it. It was not a crash and not OOM. The most likely source is a `sq-corectl.sh restart hcis` or a script run by another operator or session at about 22:27, but none has confirmed it. Watch for another occurrence.
- Two operators overlapped: the readiness-gates session started the same release in parallel. Its `--apply` stopped at upload ("already exists; not overwriting") before backup or cutover, so all production changes in this window came from this run. PR #115 adds a release lock.
- The previous release `hcis-4aab3d14-20261016` was running without a verification note in this directory.
- The browser login and deep-link refresh by the operator are still to do.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 6066d5b06c915f49dd5452d4f5ed116007d673d8 --apply --confirm RELEASE_6066d5b0` returns to `hcis-4aab3d14-20261016`. Migrations are unchanged, so the database needs no action.
