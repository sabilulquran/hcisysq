# Production release verification — 2026-10-23 (Mi8VPS, hcis-2b87b865)

**Status:** RELEASED AND VERIFIED. The operator's browser check of the new "Waktu & Kehadiran" menu with real data is not yet confirmed (see Notes).

**Owner approval:** 2026-10-23, in chat: "Ya, saya setujui rilis hcis-2b87b865-20261023 ke produksi sekarang dengan --apply --confirm RELEASE_2b87b865. Tidak ada migrasi. Rollback aplikasi kalau ada cek yang gagal."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), dry run first, then `release-mi8.sh all --apply --confirm RELEASE_2b87b865`. The SSH session dropped during cutover; `verify` was run separately (see Timeline).

## Why

Ships ATT-011-1 (#138): the "Waktu & Kehadiran" menu, ATT-011 §3 operator vocabulary, permission-gated attendance menus, redirects for the ten `/admin/attendance/workforce/*` routes, and full employee search for overtime. Frontend only: no API, migration or permission change.

## Release

| Item | Value |
|---|---|
| Target SHA | `2b87b865ff67b1e33f6aa9bf92d40b19693e99ba` (`origin/main`) |
| Contents since running release | #138 ATT-011-1 |
| Release name | `hcis-2b87b865-20261023` |
| Build | `build-mi8-release.yml` run [39922420607](https://github.com/sabilulquran/hcisysq/actions/runs/39922420607), green |
| Bundle sha256 | `493c2d7c3cf0c00a698394d4691b6b21dc40fe3d976616d106e6a84c39251f5b` |
| Previous release | `hcis-6a46880f-20261022`, kept in place for rollback |
| Migrations | 60 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-2b87b865-20261023-20261023T090616Z.dump` (32 196 820 B, sha256 `629c0320b0f303e81e3ff373a092ca76dc49e4131ba183aa41cbd9673fd1208a`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 15:14 | `all` dry run | PASS. `hcis-6a46880f-20261022` was running, the target was absent, the lock was free, about 22.6 GB was free, biometric collection was OFF, the DB was `sqcore_hcis`, and no migrations were pending. |
| 16:05 | preflight, upload, backup, migrate | PASS. Lock taken, 128 MB installed, backup verified with `pg_restore --list`, migrate was a no-op. |
| 16:06 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 16:06 | cutover | Launcher `304c13ca64a38dff…` → `18f34dce27dae25c…`, worker `ea42feef94cc8581…` → `a2a6ba894c1d51bf…` (sha256 prefixes). Worker 28465 → 18172. `hcis` and `hcis-web` restarted at 16:06:50. **The operator's SSH session then dropped** ("Connection reset by peer") while the script was waiting for the new release to become healthy, so the script stopped with exit 255 before `verify` and before releasing the lock. |
| 16:07 | (device, from the worker log) | `launch service=hcis` 16:07:04 and `launch service=hcis-web` 16:07:20 from the new release; no later HCIS launches. |
| 20:39 | read-only check, then `verify --apply` | Both processes ran from `hcis-2b87b865-20261023`; public `/api/health` and `/login` 200. `verify` PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. **Release lock released.** |
| 16:07–20:39 | watch | No HCIS relaunch in the worker log during about 4.5 hours, which covers the 10-minute watch. `hub` and `aset` answer 200. |
| 20:40 | ATT-011-1 checks (public) | The served entry bundle contains "Waktu & Kehadiran" and the new `/admin/attendance/settings/recalculate` route; the old deep link `/admin/attendance/workforce/reports` is served (200) and is redirected client-side. |

## Notes

- **Lock held about 4.5 hours.** After the SSH drop the device release lock stayed with this checkout until `verify` released it at 20:39. During that time any other operator's `preflight` would have stopped with "another operator holds the release lock". Production itself was healthy the whole time. Follow-up: when an `--apply` run ends without `verify`, check the device and run `verify` (or `unlock`) promptly.
- **Release made outside this session.** Preflight found `hcis-6a46880f-20261022` (main after #136 shared app launcher and #137) running; the worker log shows its launch at 15:19 WIB. No verification note for it exists in the repository.
- The `Hub dependency gate: HCIS unavailable` / `HCIS web unavailable` worker lines at 16:07:04 and 16:07:20 came from the restart window. They did not repeat.
- Still to confirm by the operator: open Waktu & Kehadiran with a real HC account (Ringkasan cards, Kehadiran Harian, Lembur employee search) and an old bookmark under `/admin/attendance/workforce/`.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 2b87b865ff67b1e33f6aa9bf92d40b19693e99ba --apply --confirm RELEASE_2b87b865` returns to `hcis-6a46880f-20261022` (the pre-ATT-011 attendance screens). Migrations are unchanged, so the database needs no action.
