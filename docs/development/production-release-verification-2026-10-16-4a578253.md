# Production release verification — 2026-10-16 (Mi8VPS, hcis-4a578253)

**Status:** RELEASED AND VERIFIED.

**Owner approval:** 2026-10-16, in chat: "Rilis semuanya sekarang, termasuk login Akun SQ dengan restart Keycloak." This approval covers this HCIS release together with the SQ Hub web, Aset SQ web, and Akun SQ login releases. The combined record is `sabilulquran/sq-core-ops` `runbooks/release-2026-10-16-design-c.md`.

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), `release-mi8.sh all --apply --confirm RELEASE_4a578253`.

## Release

| Item | Value |
|---|---|
| Target SHA | `4a5782532a353dee6371cefee734a4174ac3ac8e` (`origin/main`) |
| Contents | #99 greeting name, #101 "Akun SQ" wording, #105 SQ Core design direction C, #100 and #104 docs, #106 runtime dependency security update (fastify 5.12.7) |
| Release name | `hcis-4a578253-20261016` |
| Build | `build-mi8-release.yml` run [38865695073](https://github.com/sabilulquran/hcisysq/actions/runs/38865695073), green |
| Bundle sha256 | `16e267576e4a9167a38be8ed757b32f77c35b5f689eaa38bd1a371d91a6f1a4e` |
| Previous release | `hcis-3b670849-20261016`, kept in place for rollback |
| Migrations | 55 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-4a578253-20261016-20261016T071442Z.dump` (28 208 631 B, sha256 `4f7426d55acf30dcd4b4759c7aef596aff5dfbe42691dee63e421e6cb1319bbf`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 14:13 | preflight (dry run) | PASS. `hcis-3b670849` was running, the target was absent, 30.7 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 14:14 | upload, backup, migrate | PASS. Installed 128 MB, backup verified, migrate was a no-op. |
| 14:15 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 14:15 | cutover | Launcher `e2bdbb49…` → `bac21860…`, worker `03083fef…` → `6e00017c…`; worker 13077 → 19554; `hcis` and `hcis-web` restarted at 14:15:30. |
| 14:16 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. |

## Observation

Restarting the worker also stopped the SQ Hub and Aset web listeners that worker had launched. The new worker relaunched them, gated on HCIS: Hub web at 14:17:02 and Aset web at 14:18:06. The flow document says the worker restart leaves services running; on Mi8 today it does not. Follow-up is tracked in the sq-core-ops record.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 4a5782532a353dee6371cefee734a4174ac3ac8e --apply --confirm RELEASE_4a578253` returns to `hcis-3b670849-20261016`. Migrations are unchanged, so the database needs no action.
