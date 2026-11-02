# Production release verification — hcis-51fa6fcf-20261102 (OPS-MI8-REL-001)

**Date:** 2026-11-02 (07:54–07:57 UTC, 14:54–14:57 WIB)
**Operator:** TRIP-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes beforehand. The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `51fa6fcfcd5e1d97160ffab29e847e41dbb8a141` (`origin/main`) |
| Previous release | `hcis-aa724851-20261102` |
| Adds since `hcis-aa724851-20261102` | TRIP-001 Perjalanan Dinas Package 1 (#260, merge `69e1525f`); documentation only: #261 (WORK-001 dropped), #262/#265/#266 (CAL-001 spec), #264 (release note) |
| Build | run [41408931069](https://github.com/sabilulquran/hcisysq/actions/runs/41408931069), bundle `hcis-51fa6fcf-20261102.tar.gz` sha256 `097c5771e7f5642c86180770e5e26c796bb55b387662702be38eb76fce614e36` |
| Migrations | 96 in bundle; pending and applied: `0115_business_trips.sql` (additive), `0116_business_trip_permissions.sql` (`trips.read`, `trips.manage` → `human_capital_admin`) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-51fa6fcf-20261102-20261102T075534Z.dump` (36 555 200 B, sha256 `a2fa187e7f6730ea5bdc2f79dbb71c460766e37f3d37ff60deb8a271ac3a9266`) |
| Launcher / worker | `0d391d4781d4dc04` → `63de7ce9cf3a21e3` / `8ea054b9afdf24db` → `4ffabab888d0875f` |
| Worker | KILL-restarted: pid 2337 → 9852 |
| Rollback target | `hcis-aa724851-20261102`. The old build ignores the three new tables and the two new permission keys; a code rollback needs no database decision. Undoing 0116 is the `-- Down:` line in the file. |

Two earlier attempts stopped at preflight, before touching the device, because documentation PRs (#265, #266) moved `origin/main` while the bundle was building. The script requires the exact `origin/main` SHA, so the bundle was rebuilt each time.

## D-17 permission window

0116 adds two keys to an existing role. Between `migrate` (14:55:57) and cutover (14:56:19) the old build saw `human_capital_admin` holding keys outside its allowlist, so it would have refused to grant or revoke that role for about 22 s. This release carried no other behaviour change (DOC-001 D-17, §4.5).

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 14:54 | preflight | PASS. Lock free, `hcis-aa724851-20261102` running, 17 846 MB free, biometric OFF, database `sqcore_hcis`, pending 0115 + 0116. |
| 14:55 | upload, backup | Bundle checksum verified on the device; dump taken. |
| 14:55–14:56 | migrate | `applied 0115_business_trips.sql`, `applied 0116_business_trip_permissions.sql`. |
| 14:56 | candidate | API `/health`, `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 14:56 | cutover | New release running after about 28 s. |
| 14:57 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (`/proc/*/cwd` on the device after verify, independently of the release script):

```text
11247 /usr/bin/node dist/server.js           | /data/local/ubuntu26/srv/hcis/releases/hcis-51fa6fcf-20261102/apps/api
11612 /usr/bin/python3 spa_static_server.py  | /data/local/ubuntu26/srv/hcis/releases/hcis-51fa6fcf-20261102/apps/web/dist
```

**Public:** `/api/health` 200; `/api/trips/me` and `/api/admin/trips` without a session → 401 (the routes exist and still demand a session); `/app/trips` and `/admin/trips` → 200 shell; `hub.sabilulquran.or.id` → 200.

**Database, read-only transaction:** `schema_migrations` holds both files; `role_permissions` has `human_capital_admin:trips.read` and `human_capital_admin:trips.manage`; `hr_issued_documents_document_kind_check` accepts `ASSIGNMENT`; the three trip tables are empty (0/0/0).

**Ten-minute watch:** see the end of this note.

**Not done:** browser login and an end-to-end trip. Signing in needs a password, which this session never types (owner rule). In production a submission also stops at `APPROVER_ACCOUNT_NOT_READY` until leaders' accounts are active, which is the intended APR-001-E behaviour (TRIP-001 §5.1). The full flow is covered by `trips.postgres.test.ts` (14 tests) in CI run [41406604916](https://github.com/sabilulquran/hcisysq/actions/runs/41406604916).

## What changes for users

Employees see **Perjalanan Dinas** under Layanan Pegawai (`/app/trips`). Approvers see a Perjalanan Dinas section on **Persetujuan**. Human Capital admins see the **Perjalanan Dinas** register (`/admin/trips`) and issue numbered assignment letters. Approved trips appear read-only in the Pengecualian tab of the attendance report. HCIS is not yet live to staff, so nothing changes for anyone until accounts are activated.

Not recorded here: `final.env` values, tokens, cookies or employee data.
