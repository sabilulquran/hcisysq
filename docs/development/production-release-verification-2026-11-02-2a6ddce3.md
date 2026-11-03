# Production release verification — hcis-2a6ddce3-20261102 (OPS-MI8-REL-001)

**Date:** 2026-11-02 (08:50–08:54 UTC, 15:50–15:54 WIB); re-checked 2026-11-03 01:14 UTC
**Operator:** TRAIN-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced beforehand in the shared operator notes. The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `2a6ddce33f58cee84984961bf9287d22594177c8` (`origin/main`, merge of #273) |
| Previous release | `hcis-78eadd09-20261102` (CAL-001) |
| Adds since `hcis-78eadd09-20261102` | TRAIN-001 Package 1, training record keeping (#273) |
| Build | run [41415705007](https://github.com/sabilulquran/hcisysq/actions/runs/41415705007), bundle `hcis-2a6ddce3-20261102.tar.gz` sha256 `41fd934d0618169ca4baccff55d41a7852d13bfc33202a0318a05502e8c29870` |
| Migrations | 99 in bundle; **two pending**: `0118_training_records.sql` (seven new tables and one view, additive) and `0119_training_permissions.sql` (`training.read`, `training.manage` → `human_capital_admin`). 0119 adds permissions to an existing role, so it was released on its own (§4.5, D-17); the delegation window lasted only from migrate (15:53:02) to cutover (15:53:47). |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-2a6ddce3-20261102-20261102T085231Z.dump` (36 602 144 B, sha256 `24777e87d43c4e16a4c37f2e286b576a3f2febed3dae8b942354776a8f3f445a`) |
| Launcher / worker | `2b6ad53b3d66bd60` → `e4090b98d57d96a9` / `56ad106f462f1516` → `744e6a118e00cebf` |
| Worker | KILL-restarted: pid 24394 → 8258 |
| Rollback target | `hcis-78eadd09-20261102`. Code rollback is safe: the old release does not read the `training_*` tables, and the two extra permission rows are unknown to it only for role delegation (§4.5). Dropping the tables or rows (the `-- Down:` in 0118/0119) is a separate decision and is not needed for a rollback. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 15:50 | preflight (dry run) | PASS. Lock free, `hcis-78eadd09-20261102` running, 17 339 MB free, biometric OFF, database `sqcore_hcis`, pending 0118 + 0119. |
| 15:51–15:52 | preflight under `--apply`, upload, backup | PASS; bundle checksum verified on the device; dump taken and listed. |
| 15:53 | migrate | `applied 0118_training_records.sql`, `applied 0119_training_permissions.sql`. |
| 15:53 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 15:53 | cutover | New release running after about 28 s. |
| 15:54 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device, independently of the release script; same pids at 15:54 WIB and at 08:14 WIB the next day):

```text
10193 /usr/bin/node dist/server.js           | /data/local/ubuntu26/srv/hcis/releases/hcis-2a6ddce3-20261102/apps/api
10561 /usr/bin/python3 spa_static_server.py  | /data/local/ubuntu26/srv/hcis/releases/hcis-2a6ddce3-20261102/apps/web/dist
```

Public after the release: `https://hcis.sabilulquran.or.id/api/health` → `{"status":"ok"}`; `/admin/training` → 200 shell; `/api/training/me/summary` and `/api/admin/training/programs` without a session → 401 (the new routes answer and demand a session). `hub.sabilulquran.or.id` → 200.

**Watch:** `sq-core-worker.log` has no `launch service=hcis*` event after the cutover pair (15:53:36 `hcis`, 15:53:52 `hcis-web`) through 2026-11-03 08:14 WIB; the 02:00 WIB scheduled backup and off-host copy completed in between.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The API behaviour is covered by `training.postgres.test.ts` in CI (9 tests on a real PostgreSQL: participants and outsiders, conflict blocking against training, meetings, leave and trips, capacity, attendance, closing with hours, external records and certificates).

## What changes for users

Human Capital gets **Pelatihan** in the admin service catalog: programs with scheduled sessions, participants added by name search, per-session attendance, closing a program (which writes each participant's training record and hours), verification of external trainings, certificates, and a yearly hours summary per employee. A session is refused when a participant or internal speaker is already in another training session, a meeting, approved leave or an approved business trip. Employees get **Pelatihan** under Layanan Pegawai: their schedule and attendance, training history, hours this year, and a form to record an external training with its certificate. HCIS is not yet live to staff, so in practice nothing reaches employees until accounts are activated.

Not recorded here: `final.env` values, tokens, cookies or employee data.
