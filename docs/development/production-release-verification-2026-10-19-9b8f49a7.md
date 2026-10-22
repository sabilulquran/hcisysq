# Production release verification — 2026-10-19 (Mi8VPS, hcis-9b8f49a7)

**Status:** RELEASED AND VERIFIED. The operator's deep-link refresh is not yet confirmed (see Notes).

**Owner approval:** 2026-10-19, in chat: "Ya, merge PR #128 lalu rilis ke production lewat release-mi8.sh dengan backup dan verifikasi seperti biasa."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), `release-mi8.sh all --apply --confirm RELEASE_9b8f49a7`.

## Why

From release `hcis-d2bfe1bb-20261019` (#126) until this release, every Akun SQ login to HCIS ended in "HCIS belum dapat memverifikasi hak akses Anda". #126 added `idToken` to the OIDC identity. HCIS forwarded that identity to the SQ Hub access check. Hub's strict `{ issuer, subject }` schema rejected it with 400, and HCIS mapped the 400 to `APPLICATION_ACCESS_UNAVAILABLE`. The Hub API log shows 400 for the three owner attempts at 03:47 UTC. #128 sends Hub only `issuer` and `subject`.

## Release

| Item | Value |
|---|---|
| Target SHA | `9b8f49a7a6910543a32e83da4d3093a99377278e` (`origin/main`) |
| Contents since running release | #128 SQ Hub access check sends only `issuer` and `subject` |
| Release name | `hcis-9b8f49a7-20261019` |
| Build | `build-mi8-release.yml` run [39196880310](https://github.com/sabilulquran/hcisysq/actions/runs/39196880310), green |
| Bundle sha256 | `81c0d6a31b8c6236b899112df37f4dc5f207ba05044a45c1a00e8b22277f425d` |
| Previous release | `hcis-d2bfe1bb-20261019`, kept in place for rollback |
| Migrations | 59 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-9b8f49a7-20261019-20261019T035725Z.dump` (29 580 836 B, sha256 `e649875fc2e00ce3c62763fa92b443aff27947a994f3c045d029f9b86977bcfe`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 10:56 | preflight (dry run) | PASS. `hcis-d2bfe1bb` was running, the target was absent, the lock was free, about 27 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 10:57 | preflight, upload, backup, migrate | PASS. Installed 128 MB, backup verified, migrate was a no-op. A first `--apply` attempt at 10:56 stopped before preflight, because it was started outside the git checkout. It made no device change, and no lock or target directory was created. |
| 10:57 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 10:58 | cutover | Launcher `1d102128a408c308…` → `9c9062e4a0208b6a…`, worker `94f7d6a11e3c3dcf…` → `ca259eadbe0c307a…` (sha256 prefixes). Worker 982 → 29431. `hcis` and `hcis-web` restarted at 10:58:01 and ran the new release after about 24 s. |
| 10:58 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. Release lock released. |
| 10:58–11:08 | 10-minute watch | PASS. Both processes ran from `hcis-9b8f49a7-20261019`. The worker log shows one `launch service=hcis` (10:58:15) and one `hcis-web` (10:58:31), with no later launches. Public `/api/health` returned 200. |
| 11:00 | login | PASS. The SQ Hub access check at 11:00:07 returned 200, where it had returned 400 before. HCIS `/auth/me` then returned 200. |

## Notes

- The two `Hub dependency gate: HCIS unavailable` worker lines at 10:58:15 and 10:58:31 came from the restart window itself. They did not repeat.
- The deep-link refresh by the operator is not yet confirmed.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 9b8f49a7a6910543a32e83da4d3093a99377278e --apply --confirm RELEASE_9b8f49a7` returns to `hcis-d2bfe1bb-20261019`, which has the login defect. Migrations are unchanged, so the database needs no action.
