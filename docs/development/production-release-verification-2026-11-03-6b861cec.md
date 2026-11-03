# Production release verification — hcis-6b861cec-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (16:21–16:23 UTC, 23:21–23:23 WIB)
**Operator:** Claude Code (orchestrator session), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Release lock free at preflight, taken by the script, released after verify.

| Item | Value |
|---|---|
| Target SHA | `6b861cecb9fb9efbf4b604887c74f6e0d8650827` (`origin/main`: merge of #300) |
| Previous release | `hcis-2c2f5597-20261103` |
| Adds | EMP-012: Kartu Pegawai in the Administrasi sidebar (#300). The owner could not find the admin screen, which shipped only as a Katalog Modul tile. Frontend only. |
| Build | run [41672499298](https://github.com/sabilulquran/hcisysq/actions/runs/41672499298), bundle sha256 `03c6d24042ad13f6a212ff6c9bf0f489489531e140aab8c10f1e2cd009fe4313` |
| Migrations | 115 in bundle, none pending |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-6b861cec-20261103-20261103T162146Z.dump` (37 251 322 B, sha256 `40c386a3ba82ab9e874bb57b277f00b4d6a965a54c68136fc05b19cbeda4be70`) |
| Launcher | `819cbb43afcc6f94` → `b66fe710074c64f4` |
| Worker | `81439dd12b0eba46` → `4d7d5f3675a740ed`; pid 23813 → 27095 |
| Rollback target | `hcis-2c2f5597-20261103` (application only; no schema change) |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 23:21 | preflight (dry run, then under `--apply`) | PASS: lock free, `hcis-2c2f5597-20261103` running, 14 372 MB free, biometric OFF, database `sqcore_hcis`, no pending migrations |
| 23:21–23:22 | upload, backup | checksum verified on the device; dump taken |
| 23:22 | candidate | API `/health`, `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS |
| 23:22 | cutover | new release running after about 26 s |
| 23:23 | verify | local and public checks PASS; lock released |

**Running release, proved from the processes** (`/proc/*/cwd` after verify): `node dist/server.js` and `spa_static_server.py` both in `/data/local/ubuntu26/srv/hcis/releases/hcis-6b861cec-20261103/`. The deployed web bundle carries the sidebar entry `{key: employee-cards, label: Kartu Pegawai, href: /admin/employee-cards}` in the Pegawai group.
