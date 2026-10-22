# Production release verification — 2026-10-16 (Mi8VPS, hcis-8f607478)

**Status:** RELEASED AND VERIFIED. The operator's browser checks are **NOT YET DONE** (see Notes).

**Owner approval:** 2026-10-16. The owner approved the release of PR #114 (AUTH-011) after it merged.

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), `release-mi8.sh all --apply --confirm RELEASE_8f607478`.

## Release

| Item | Value |
|---|---|
| Target SHA | `8f607478a2ab5d41366c748c43366508eb5102ff` (`origin/main`) |
| Contents since running release | #114 AUTH-011 (migration 0057 removes `access.roles.assign` from `human_capital_admin`); #115 Mi8 release lock |
| Release name | `hcis-8f607478-20261016` |
| Build | `build-mi8-release.yml` run [38924347682](https://github.com/sabilulquran/hcisysq/actions/runs/38924347682), green |
| Bundle sha256 | `467ae735b3ffe7f273e99c6317ada25663a8927a243ffd6aee8fae83395f27de` |
| Previous release | `hcis-6066d5b0-20261016`, kept in place for rollback |
| Migrations applied | `0057_hc_admin_revoke_role_assign.sql` |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-8f607478-20261016-20261016T153319Z.dump` (sha256 `9726783fae13470790212bd5a988725cd5325961c3e0ca122f51f0a3bb6e5beb`) |

## Timeline (UTC; WIB is UTC+7)

| Time | Phase | Result |
|---|---|---|
| 15:32 | preflight, release lock taken | PASS |
| 15:33 | upload, backup, migrate | PASS. Backup verified (see above) and `0057_hc_admin_revoke_role_assign.sql` applied. |
| 15:33–15:34 | candidate gate | PASS |
| 15:34 | cutover | Launcher `76a30e1232f4367a…` → `5b5f08091863e417…`, worker `f90e254a74e0d15f…` → `56d3d9bbfdafc019…` (sha256 prefixes). New release served after about 26 s. `sq-core-worker.log` shows one launch each: `launch service=hcis` at 22:34:10 WIB, `hcis-web` at 22:34:27 WIB. |
| 15:34 | verify | PASS, local and public. Release lock released. `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` returned 200. |
| 16:06 | read-only post-release check | PASS (see below). |

## Post-release check (16:06 UTC, read-only)

The check ran over `ssh mi8vps-root`, because non-root `ssh mi8vps` cannot see other users' processes. It used the same commands as the `verify` phase.

- The `hcis` API process (`node`) cwd is `/srv/hcis/releases/hcis-8f607478-20261016/apps/api`. It had been up for about 32 min.
- The `hcis-web` process (`python3`) cwd is `/srv/hcis/releases/hcis-8f607478-20261016/apps/web/dist`. It had been up for about 32 min.
- The worker is alive. `sq-core-worker.log` has no `hcis`/`hcis-web` launch after the 22:34 WIB cutover launches, so there were no repeated launches.
- Public: `hcis.sabilulquran.or.id/api/health` and `/login`, `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` returned 200.

## Notes

- **NOT YET DONE:** the operator has not yet done the browser login or the deep-link refresh.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha 8f607478a2ab5d41366c748c43366508eb5102ff --apply --confirm RELEASE_8f607478` returns the code to `hcis-6066d5b0-20261016`. That needs owner approval. Code rollback does not reverse migration 0057, which only removes the `access.roles.assign` grant from `human_capital_admin`. If the database must be restored, use the pre-release backup above.
