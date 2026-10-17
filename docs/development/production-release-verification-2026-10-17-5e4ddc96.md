# Production release verification — 2026-10-17 (Mi8VPS, hcis-5e4ddc96)

**Status:** RELEASED AND VERIFIED.
**Owner approval:** 2026-10-17, in chat: "Ya, saya setujui rilis hcis-5e4ddc96-20261017 ke produksi sekarang, termasuk migrasi 0056 dan 0058, dengan --apply --confirm RELEASE_5e4ddc96. Rollback aplikasi otomatis kalau ada cek yang gagal."
**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), with the release lock (§4.10)

## Release

| Item | Value |
|---|---|
| Target SHA | `5e4ddc968a7b1babc78c18f0449e44ffa69a4e8c` (`origin/main`) |
| Contents since the previous release | Employment administration Package 1, steps S1–S3: #102 spec, #113 schema/domain, #117 baseline backfill CLI, read API and permissions, #120 read screens |
| Release name | `hcis-5e4ddc96-20261017` |
| Build | `build-mi8-release.yml` run [38986249158](https://github.com/sabilulquran/hcisysq/actions/runs/38986249158), success |
| Bundle sha256 | `2d9d2d816b68bc040bbd1ae72c3d0ed2bc46c133bc7edb904b6e70565faa9361` (58 migrations in bundle) |
| Previous release | `hcis-8f607478-20261016` (kept in place for rollback) |
| Migrations applied | `0056_employment_history_foundation.sql`, `0058_employment_permissions.sql` (`0057` had been applied earlier) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-5e4ddc96-20261017-20261017T003322Z.dump` (28 666 634 B, sha256 `11470604db88ebb3947ca33df8425d274c772e21a52fc661bb2723fd8dd1e63c`) |

### Migration safety review (before approval)

- Both migrations are additive. 0056 creates new `employment_*` tables, triggers and functions and changes no existing table. 0058 inserts three `employment.*` permissions and grants `employment.read` and `employment.manage` to `human_capital_admin`. `employment.correct` is not bundled (D-16).
- `btree_gist` 1.8 was already installed in `sqcore_hcis`.
- The baseline backfill is the manual CLI `employment:baseline` and does not run at release. After the release the employment tables are empty and the rollout mode is OFF (no `employment_rollout_settings` row).
- The previous release keeps working on the new schema. This was verified: `:3301/health` returned 200 right after `migrate`, while `hcis-8f607478` was still serving.

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 07:27 | `all` (dry run) | PASS. Lock free, two pending migrations listed. |
| 07:32 | preflight | PASS (release `hcis-8f607478-20261016` running, target absent, 30 GB free, biometric OFF, DB `sqcore_hcis`) |
| 07:32 | upload (apply) | The first attempt from a non-git directory stopped at `git` before touching the device. Rerun from the repository: PASS. Installed 128 MB, lock held. |
| 07:33 | backup (apply) | PASS (see above) |
| 07:33 | migrate (apply) | PASS: `applied 0056…`, `applied 0058…`, all bundle migrations applied. The old release stayed healthy. |
| 07:34 | candidate (apply) | PASS 7/7 (API `/health` and `/ready`; web `no-store`, `/login`, immutable entry asset, missing asset 404) |
| 07:34:21 | cutover (apply) | PASS. Launcher `5b5f0809…` → `f50edb94…`, worker `56d3d9bb…` → `bd19a04a…`. Worker 15928 was replaced by 27230. Services restarted at 07:34:26 and the new release served after about 26 s. |
| 07:35 | verify (dry run) | PASS 10/10, local and public. hub 200, aset 200, login 302. Employment tables: 0 rows, rollout settings 0 rows. HC admin has `employment.read` and `employment.manage`. |
| 07:35 | browser | The deep link `/admin/employees` loads the new bundle `index-E4MRZ89I.js` and redirects an anonymous visitor to the landing page. Only the expected 401s appear. |
| 07:35–07:45 | 10-minute watch | PASS. Exactly one `launch service=hcis` (07:34:40) and one `launch service=hcis-web` (07:34:56). API pid 27754 and web pid 28084 run from the new release. HCIS, Keycloak and Hub health return 200. The release lock was held during the watch. |
| 07:45 | verify (apply) | PASS, `release_lock=released` |

HCIS was interrupted for about 26 s during cutover. Hub, Aset and Keycloak were not restarted.

## Not verified by the operator

- An authenticated HC login and the new Riwayat Kepegawaian / Kecocokan Data screens need an owner or HC account. Until the baseline backfill runs, the screens show empty history.

## Next owner decisions

- Running the baseline backfill (`employment:baseline`) and moving the rollout mode from OFF to SHADOW are separate, owner-approved steps (spec §12).

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle hcis-5e4ddc96-20261017.tar.gz --sha 5e4ddc968a7b1babc78c18f0449e44ffa69a4e8c --apply --confirm RELEASE_5e4ddc96` returns to `hcis-8f607478-20261016`. The database is not rolled back: the new tables and permissions stay and are harmless to the previous release. The 0056 recovery plan is in the migration header.
