# Production release verification — 2026-10-23 (Mi8VPS, hcis-081ba89e)

**Status:** RELEASED AND VERIFIED, including the owner's browser check.

**Owner approval:** 2026-10-23, in chat: "Ya, saya setujui rilis hcis-081ba89e-20261022 ke produksi sekarang dengan --apply --confirm RELEASE_081ba89e. Tidak ada migrasi. Rollback aplikasi kalau ada cek yang gagal."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), dry run first, then `release-mi8.sh all --apply --confirm RELEASE_081ba89e`.

## Why

Ships SEC-05 and SEC-06 from the 2026-10-16 security review (#135): the Akun SQ login is bound to the browser that started it, and cookie-bearing mutations from other sites, including sibling SQ Core apps, are refused.

## Release

| Item | Value |
|---|---|
| Target SHA | `081ba89efda87d28de05d7661999e616cb98f301` (`origin/main`) |
| Contents since running release | #135 SEC-05 OIDC state cookie, SEC-06 cross-site mutation check |
| Release name | `hcis-081ba89e-20261022` (UTC build date) |
| Build | `build-mi8-release.yml` run [39866078840](https://github.com/sabilulquran/hcisysq/actions/runs/39866078840), green |
| Bundle sha256 | `d74e9d94b24ffe1dff3f7de5922f17152466381e376ffe83547543898322e6ab` |
| Previous release | `hcis-f2d0f8fb-20261022`, kept in place for rollback |
| Migrations | 60 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-081ba89e-20261022-20261022T224344Z.dump` (32 011 756 B, sha256 `7a31664a4650178bb8eea848206bc3fbc795284fb89ba67fdfa679ecc0a6aeeb`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 05:38 | `all` dry run | PASS. `hcis-f2d0f8fb-20261022` was running, the target was absent, the lock was free, about 23 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 05:43 | preflight, upload, backup, migrate | PASS. Lock taken, 128 MB installed, backup verified with `pg_restore --list`, migrate was a no-op. |
| 05:44 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 05:44 | cutover | Launcher `5f141d951c1fc7bb…` → `858a61b1061068aa…`, worker `4b7b145036a46c96…` → `37076b442f877fa0…` (sha256 prefixes). Worker 11933 → 29693. `hcis` and `hcis-web` restarted at 05:44:22 and ran the new release after about 24 s. |
| 05:44 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. Release lock released. |
| 05:45 | security checks (public) | PASS, see below. |
| 05:46–05:55 | 10-minute watch | PASS. Public `/api/health` returned 200 every minute. The worker log shows one `launch service=hcis` (05:44:36) and one `hcis-web` (05:44:52), with no later launches. The API and web processes run from `hcis-081ba89e-20261022`. `hub` and `aset` answer 200. |

## Security checks (public, synthetic requests only)

| Check | Result |
|---|---|
| SEC-07 API headers on `/api/health` | `content-security-policy: frame-ancestors 'none'`, `referrer-policy: no-referrer`, `strict-transport-security: max-age=31536000`, `x-content-type-options: nosniff`, `x-frame-options: DENY` |
| SEC-06 `POST /api/auth/logout` with `Sec-Fetch-Site: cross-site` / `same-site` | 403 `CROSS_SITE_REQUEST_REJECTED` |
| SEC-06 with `Origin: https://evil.example` and no `Sec-Fetch-Site` | 403 |
| SEC-06 with `Sec-Fetch-Site: same-origin` | 200 (no session, so nothing was logged out) |
| SEC-05 `GET /api/auth/oidc/start` | 302 to Akun SQ with `Set-Cookie: __Host-hcis_oidc_state_<hash>=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure` |
| SEC-05 `/auth/callback` with a synthetic state and no cookie | 302 to `/?authError=oidc_failed`; the state cookie is cleared |

The SEC-05 check created one unused OIDC transaction row that expires after 10 minutes.

## Notes

- **Release made outside this session.** Preflight found `hcis-f2d0f8fb-20261022` (main after #134: SEC-07 API headers, SEC-09/10/11/13/15, AUTH-012, the OpenAPI repair) already running. Its pre-release backup is `hcis-f2d0f8fb-20261022-20261022T222125Z.dump` (22:21 UTC on 2026-10-22). No verification note for it exists in the repository; this release builds on it and its contents are now verified through the checks above.
- The `Hub dependency gate: HCIS unavailable` / `HCIS web unavailable` worker lines at 05:44:36 and 05:44:52 came from the restart window. They did not repeat.
- A login that was in progress at 05:44 had no state cookie and fails once with `oidc_failed`; signing in again works.
- Browser check by the owner (2026-10-23, in chat): "Login Akun SQ, logout, dan refresh deep-link sudah saya cek di browser dan lancar."
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 081ba89efda87d28de05d7661999e616cb98f301 --apply --confirm RELEASE_081ba89e` returns to `hcis-f2d0f8fb-20261022`, which lacks SEC-05/06. Migrations are unchanged, so the database needs no action.
