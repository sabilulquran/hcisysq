# Production release verification — 2026-10-24 (Mi8VPS, hcis-c54b0b97)

**Status:** RELEASED AND VERIFIED. Agent browser check done in the owner's logged-in session; the owner's own browser check is still open.

**Owner approval:** 2026-10-24, in chat: "Ya, rilis main c54b0b9 ke Mi8VPS sesuai prosedur OPS-MI8-REL-001. Saya setujui."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), dry run first, then `release-mi8.sh all --apply --confirm RELEASE_c54b0b97`.

## Why

Ships ATT-014-1 **Pantauan Hari Ini** (#156). The daily attendance screen judged employees from the schedule alone and ignored machine scans the engine had not processed, so anyone who scanned showed "Tidak hadir" after their shift. Batch-1 schedules went live the same day for 32 employees, so this would have hit every working day from Monday 2026-10-26. The screen now shows today's scan facts only, without verdicts.

## Release

| Item | Value |
|---|---|
| Target SHA | `c54b0b97e8f3f73f79ef782b727e594a3c4d8f0b` (`origin/main`; PR CI green) |
| Contents since running release | #143 and #154 (documentation only), #156 ATT-014-1 (`GET /admin/attendance/today`, Pantauan Hari Ini page, Ringkasan "Hari ini" cards) |
| Release name | `hcis-c54b0b97-20261024` (UTC build date) |
| Build | `build-mi8-release.yml` run [40098379370](https://github.com/sabilulquran/hcisysq/actions/runs/40098379370), green |
| Bundle sha256 | `2a0cff00f4c2834f963619a557eab04c13a95269ffef63501e85c3e148d00e24` |
| Previous release | `hcis-2b87b865-20261023`, kept in place for rollback |
| Migrations | 60 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-c54b0b97-20261024-20261024T133425Z.dump` (32 598 061 B, sha256 `a4b2ad48c988fdb00503500a8f512b5830fe00244f33a74891d3891e7cc69d90`) |
| Announcement | Shared session notes, `RELEASE-ANNOUNCEMENT-hcis-c54b0b97.md` (IN PROGRESS → DONE) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 20:29 | Precondition check | `origin/main` = `c54b0b9`; 13:29 UTC, outside the 19 UTC backup hour. |
| 20:31–20:32 | Build + download | Bundle built in CI, downloaded, `sha256sum -c` OK; `RELEASE.json` names the same SHA, `linux/arm64`, node v22.22.1. |
| 20:33 | `all` dry run | PASS. `hcis-2b87b865-20261023` running, target absent, lock free, 23.7 GB free, biometric collection OFF, DB `sqcore_hcis`, no pending migrations. |
| 20:33–20:34 | preflight, upload, backup, migrate | PASS. Lock taken, 128 MB installed, backup verified, migrate no-op. |
| 20:34 | candidate gate (:3391, :3291) | PASS 7/7: API `/health`, `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 20:35 | cutover | Launcher `18f34dce27dae25c…` → `28af42f6d7376d93…`, worker `a2a6ba894c1d51bf…` → `c51374965a2948b4…` (sha256 prefixes). Worker 18172 stopped with KILL, 26264 started. `hcis` and `hcis-web` restarted at 20:35:00 and ran the new release after about 24 s. |
| 20:35 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. Release lock released. |
| 20:35–20:45 | 10-minute watch | PASS. Public `/api/health`, `hub`, and `aset` returned 200 every minute (10/10). The worker log shows one `launch service=hcis` (20:35:15) and one `hcis-web` (20:35:31), with no later launches. API pid 26860 and web pid 27331 run from `hcis-c54b0b97-20261024`. |

## Feature checks

| Check | Result |
|---|---|
| `GET /api/admin/attendance/today` without a session | 401 (route exists; an unknown route answers 404) |
| Pantauan Hari Ini page in the owner's logged-in browser session (agent, read-only) | Renders with title, explanation, and fact cards; no "Tidak hadir", "Terlambat" or "Tidak lengkap" on the page |
| `GET /api/admin/attendance/today` in that session | 200, date 2026-10-24 (Saturday), 99 active employees: `off` 32, `unscheduled` 57, `unscheduled_with_scans` 10, all other cards 0 |

The 32 `off` are the batch-1 scheduled employees (no group works on Saturday). The 10 `unscheduled_with_scans` are employees without a schedule who scanned today; the old screen could not show them.

## Notes

- Hub, Aset and Keycloak were not restarted. The worker restart used KILL (OPS-MI8-SUP-001), and the watch shows Hub and Aset answering throughout.
- `npm run migrations:check` fails on the Windows operator checkout because `core.autocrlf=true` rewrites `0020_organization_revisions_and_account_holders.sql` with CRLF. The repository blob matches the pinned hash (`4ed6015f…`); CI on Linux passes. No migration changed in this release.
- Official verdicts still require **Pengaturan → Finalisasi ulang** per date until ATT-014-2 (Kalkulasi) ships.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha c54b0b97e8f3f73f79ef782b727e594a3c4d8f0b --apply --confirm RELEASE_c54b0b97` returns to `hcis-2b87b865-20261023`, which brings back the old daily screen. No migrations ran, so the database needs no action.
