# Production release verification — hcis-84d366c1-20261104 (OPS-MI8-REL-001)

**Date:** 2026-11-04 04:21–04:23 UTC (11:21–11:23 WIB). **Operator:** Claude Code (AUTH-015 session), under the owner rule of 2026-10-27: release without asking, with a dry run, backup, candidate gate and rollback on a failed verify; report afterwards; never release at 19 UTC. The release lock was free at preflight, and the script took it and released it.

| Item | Value |
|---|---|
| Target SHA | `84d366c10f50ec639e09c5484cac9a9256143f53` (`origin/main`: merge of #312 AUTH-015 at `c4d11afd`, plus the docs-only #313) |
| Previous release | `hcis-c9c03353-20261104` |
| Build | run [41772420003](https://github.com/sabilulquran/hcisysq/actions/runs/41772420003), bundle sha256 `2349a60a4b9974d360230b3379e76e74ab8fa3f53a88149ab954effddd0df1c8` |
| Migration | `0139_role_follows_seat.sql`: link table key `(role_key, position_key)`, plus `hcis_seat_role_holders` and `hcis_seat_permissions`. Production held 0 links before and after, so nobody's permissions changed. |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-84d366c1-20261104-20261104T042156Z.dump` (sha256 `fc8e1188…aa6e015f`) |
| Launcher / worker | `a93fb26e2e97ba76` → `a2319d6c78bbc9ba` / `0cfc151aa513198a` → `9ae5fa637c5bcce2` |
| Rollback | Application: `hcis-c9c03353-20261104`. Schema: rollback notes in 0139. The old build works against the new schema while no link exists. |

Preflight, upload, backup, migrate, candidate gate, cutover (about 28 s), and the local and public verify all passed. After cutover:
- Both functions exist.
- `hcis_seat_permissions(current_date)` returns 0 rows.
- `/api/health` and Hub return 200.

Not done by the operator: a browser login. The agent never enters credentials.
