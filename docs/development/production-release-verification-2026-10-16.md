# Production release verification — 2026-10-16 (Mi8VPS, first OPS-MI8-REL-001 release)

**Status:** RELEASED AND VERIFIED.
**Owner approval:** 2026-10-16, in chat: "Ya, saya setujui rilis hcis-3b670849-20261016 ke produksi sekarang dengan --apply --confirm RELEASE_3b670849. Rollback otomatis kalau ada cek yang gagal."
**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001)

## Release

| Item | Value |
|---|---|
| Target SHA | `3b670849ea2c7ff65ab8f871da89d5e4c3c1467f` (`origin/main`). The application content (`apps/`, `packages/`, `package*.json`) is identical to `7d6f46b`, which the owner asked for; main had since gained docs and `scripts/mi8` only. |
| Release name | `hcis-3b670849-20261016` |
| Build | `build-mi8-release.yml` run [38838781484](https://github.com/sabilulquran/hcisysq/actions/runs/38838781484), all steps green |
| Bundle sha256 | `bead83ffb7a08dc9f7fd4dda4ad2d8ada9676311c6f65c505a3ae3d37684fbf0` (16 600 545 B, 12 207 entries, 0 native `.node` addons, `linux/arm64`, Node v22.22.1) |
| Previous release | `hcis-1f482549-20261004` (kept in place for rollback) |
| Migrations | 55 in bundle, 55 applied, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-3b670849-20261016-20261016T030646Z.dump` (28 097 717 B, sha256 `01346d3e49bf8b2b470dd9682772634b36cd6a4361693a8e929a08992b14afcf`, `pg_restore --list` OK) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 09:10 | preflight (dry run) | Stopped by the 02 UTC backup-hour guard. That guard was stale; the backup hour is 19 UTC since OPS-MI8-BAK-001. All earlier checks passed. |
| 10:01 | `all` (dry run) | PASS. Every mutating step was printed, none was executed. |
| 10:04 | preflight | PASS. Release `hcis-1f482549-20261004` was running, the target was absent, `/data` had 31 GB free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 10:04 | upload (apply) | **FAIL, no production impact.** Chroot `tar` could not exec `gzip` because the remote `PATH` was Android-only. Fixed by appending `/usr/sbin:/usr/bin:/sbin:/bin`. |
| 10:05 | upload (apply) | **FAIL, no production impact.** Chroot GNU `tar` reported "Cannot open: Function not implemented" on the Android kernel. Python `tarfile` extraction was tested in `/tmp/xtest` (11 214 files, 7 symlinks), then removed. |
| 10:06 | upload (apply) | PASS: `/srv/hcis/releases/hcis-3b670849-20261016` installed, 127 MB, `sqhcis`-owned and read-only. |
| 10:06 | backup (apply) | PASS (see above) |
| 10:07 | migrate (apply) | no-op |
| 10:07 | candidate (apply) | PASS 7/7. Candidate API :3391 `/health` and `/ready`. Candidate web :3291: `/` 200 with `no-store`, `/login` 200, entry asset `immutable`, missing asset 404. Candidates were stopped afterwards. |
| 10:07:32 | cutover (apply) | PASS. Launcher `94c556e8…` → `eb0c2b99…` and worker `a4e2adb0…` → `bf530831…` (backups `*.pre-hcis-3b670849-20261016`). `current` points to the new release. Worker 31701 was replaced by 3066. `hcis`/`hcis-web` restarted at 10:07:37 and served the new release about 26 s later. |
| 10:08 | verify | PASS. Locally: API and web run from the new release, `/health`, `/ready`, web `no-store`, the `current` symlink, and a live worker. Publicly: `/api/health`, `/login` 200, missing asset 404. hub 200, aset 200, login 302. The public entry script changed from `index-B8VQPKZM.js` to `index-C6kYV1BL.js`. |
| 10:08 | browser | The deep link `/admin/attendance/devices` loads the new bundle and redirects an anonymous visitor to the landing page. The only console errors were the expected 401s from the unauthenticated session probe. |
| 10:18 | 10-minute watch | PASS (see the section below) |

HCIS web and API were interrupted for about 26 s during cutover. Hub, Aset and Keycloak were not restarted.

## 10-minute watch

PASS (10:08–10:18 WIB). After the cutover restarts, `sq-core-worker.log` shows exactly one `launch service=hcis` (10:07:51) and one `launch service=hcis-web` (10:08:07), and no repeated launches. The API (pid 3713) and web (pid 4019) run from `hcis-3b670849-20261016`. HCIS `/health` and web `/` return 200; Keycloak `/health/ready` and Hub `/health` return 200.

## Not verified by the operator

- Authenticated browser login and the new ADMS device pages need an owner or HC account. The operator has no credentials and did not test them.

## Rollback (if needed later)

`scripts/mi8/release-mi8.sh rollback --bundle hcis-3b670849-20261016.tar.gz --sha 3b670849ea2c7ff65ab8f871da89d5e4c3c1467f --apply --confirm RELEASE_3b670849` restores the `*.pre-hcis-3b670849-20261016` launcher and worker and returns to `hcis-1f482549-20261004`. The database is not touched; no migrations ran in this release.
