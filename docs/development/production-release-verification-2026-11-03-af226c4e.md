# Production release verification — hcis-af226c4e-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (16:38–16:41 UTC, 23:38–23:41 WIB)
**Operator:** ORG-013 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `af226c4e76ad7c409c9c4a4fcad8876c6b0ab0ed` (`origin/main`: merge of #301) |
| Previous release | `hcis-6b861cec-20261103` |
| Adds since `hcis-6b861cec-20261103` | ORG-013 follow-ups (#301): the SQ Hub role channel describes Foundation Board accounts (`principalType`; `/catalog` adds `targetPrincipalTypes` and `endDateRequired`), and an unresolved oversight writes `leave.oversight.unresolved`; release note for 6b861cec (#302, documentation) |
| Build | run [41675420734](https://github.com/sabilulquran/hcisysq/actions/runs/41675420734), bundle `hcis-af226c4e-20261103.tar.gz` sha256 `d7e7d372e36536bbaf84ea22bb5cc553309c07977437749c5aded5473f0bf80a` |
| Migrations | 115 in bundle; none pending |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-af226c4e-20261103-20261103T164005Z.dump` (37 309 674 B, sha256 `e6bc199560208c0cb2b116af8e44555dda35597127853c7f828b5f93325922df`) |
| Worker | KILL-restarted: pid 27095 → 13270 |
| Rollback target | `hcis-6b861cec-20261103`. No schema change, so an application rollback is safe. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 23:38 | preflight (dry run) and `all` dry run | PASS. Lock free, `hcis-6b861cec-20261103` running, 14 186 MB free, biometric OFF, database `sqcore_hcis`, no pending migrations. |
| 23:39–23:40 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 23:40 | migrate | No-op. |
| 23:40 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 23:40–23:41 | cutover, verify | Release paths, health, current symlink, worker alive, public `/api/health`, `/login`, missing asset — all PASS. Lock released. |

**Running release, proved from the processes:** the `hcis` API process `cwd` is `/srv/hcis/releases/hcis-af226c4e-20261103/apps/api`.

**Post-release checks without a session:** `GET https://hcis.sabilulquran.or.id/board` 200; `GET /api/leave/approvals` 403.

**Not verified:** a real SQ Hub lookup of an organ account, and the `/board` approvals section with a real organ session; both need an owner login. SQ Hub is not released with this change: its matching screen (SQ-Hub#176) waits for the next Hub release, and the running Hub already works against this HCIS because it ignores the new fields.
