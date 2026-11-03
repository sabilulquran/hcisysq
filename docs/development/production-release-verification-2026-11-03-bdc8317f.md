# Production release verification — hcis-bdc8317f-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (02:50–03:04 UTC, 09:50–10:04 WIB)
**Operator:** ATT-015 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes after HELP-001 reported DONE; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `bdc8317f6da94651f9244ed7a1a79957204db3fd` (`origin/main`, merge of #282) |
| Previous release | `hcis-a51a12f8-20261103` (HELP-001) |
| Adds since `hcis-a51a12f8-20261103` | ATT-015 Package 1 (#282): tugas luar, WFH/WFA and schedule change requests |
| Build | run [41568281681](https://github.com/sabilulquran/hcisysq/actions/runs/41568281681), bundle `hcis-bdc8317f-20261103.tar.gz` sha256 `7db4bcb63c5d777c5595cd5fc66295a2dbaa648d83412a7e3af2fbb00effc818` |
| Migrations | 107 in bundle; pending and applied: `0124_attendance_work_arrangements.sql` (three new tables, a nullable source column on `attendance_result_versions`, the result status CHECK widened with `field_assignment` and `remote_work`; additive), `0125_attendance_work_arrangement_permissions.sql` (adds `attendance.arrangements.*` to `human_capital_admin`, so released on its own per §4.5) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-bdc8317f-20261103-20261103T025150Z.dump` (36 994 637 B, sha256 `544c5ffb3286c2064c3d60e127019cb43776840de3139b698e4a50421d057cb2`) |
| Launcher / worker | `c1e55367dbbc9419` → `03076275e0caad68` / `9cfa4b5d4a01f8f6` → `ef607558ccf2fb5f` |
| Worker | KILL-restarted: pid 16392 → 6060 |
| Rollback target | `hcis-a51a12f8-20261103`. The old build does not read the new tables and never writes the new statuses, so an application rollback is safe without touching the database; result versions written with a new status would read as "·" in the old build. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 09:50 | dry run (`all`), then preflight | PASS. Lock free, `hcis-a51a12f8-20261103` running, 16 290 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0124 and 0125. |
| 09:51 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 09:52 | migrate | `applied 0124_attendance_work_arrangements.sql`, `applied 0125_attendance_work_arrangement_permissions.sql`. |
| 09:52 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 09:52–09:53 | cutover | New release running after about 28 s. |
| 09:53 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (`/proc/<pid>/cwd` on the device after verify, independently of the release script):

```text
6999 node dist/server.js        | /data/local/ubuntu26/srv/hcis/releases/hcis-bdc8317f-20261103/apps/api
7364 spa_static_server (web)    | /data/local/ubuntu26/srv/hcis/releases/hcis-bdc8317f-20261103/apps/web/dist
```

**Database, read-only after the release:** `schema_migrations` holds 0124 and 0125; `role_permissions` holds exactly `human_capital_admin:attendance.arrangements.read` and `human_capital_admin:attendance.arrangements.manage`; `attendance_result_versions_status_check` is validated; `attendance_result_versions.source_work_arrangement_id` exists; `attendance_work_arrangement_requests` is empty.

**Public:** `/api/health` → `{"status":"ok"}`; `/api/attendance/arrangements/me` without a session → 401 (the route answers and demands a session); `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` → 200.

**Ten-minute watch (09:54–10:04 WIB):** the API stayed pid 6999 and the web pid 7364, both from `hcis-bdc8317f-20261103`, on every check; the worker log launch count stayed 351 after the cutover pair; `/api/health` answered ok each minute.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator, and an authenticated arrangement flow. Signing in needs a password, which this session never types (owner rule), and staff accounts are still invited, so no approver chain can resolve in production yet (spec §5.1, `APPROVER_ACCOUNT_NOT_READY`). The full flow — submit, approve, the engine disposition without punches, the justified late punch, HC cancellation and recalculation, leave precedence, schedule change application and the stale refusal — runs against PostgreSQL in CI (`work-arrangements.postgres.test.ts`).

## What changes for users

Employees get **Tugas Luar & WFH** under Waktu & Kehadiran (`/app/attendance/arrangements`); approvers see a **Tugas Luar, WFH & Ubah Jadwal** queue on the Persetujuan page; HC Admin gets the register at `/admin/attendance/arrangements` with **Terapkan ke jadwal** for approved schedule changes. Attendance reports gain the statuses Tugas luar (`DL`) and WFH/WFA (`W`). No result changes until an arrangement is approved, and HCIS is not yet live to staff, so in practice nothing changes until activation. Payroll is untouched.
