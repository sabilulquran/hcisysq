# Production release verification — hcis-a1f8a8e7-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (07:01–07:14 UTC, 14:01–14:14 WIB)
**Operator:** ORG-012 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes before merging #295; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `a1f8a8e7e9efeb12218c8cbfc0148ab29aaebbef` (`origin/main`: merge of #295) |
| Previous release | `hcis-f38f63e1-20261103` (LEAVE-009) |
| Adds since `hcis-f38f63e1-20261103` | PAY-003 transport for field assignments (#285), CAL-001 WhatsApp option follows adapter status (#287), DOC-001 certificate PDF (#288), organ-approver spec now ORG-013 (#290, documentation), LEAVE-010 approver notification and employee cancellation (#291), LEAVE-009 release note (#292, documentation), ORG-012 Kepanitiaan Package 1 (#295) |
| Build | run [41592806809](https://github.com/sabilulquran/hcisysq/actions/runs/41592806809), bundle `hcis-a1f8a8e7-20261103.tar.gz` sha256 `a2cee90e73068e92f82ecf126b13662d2a15ee9746b9c837573e30872b9828e8` |
| Migrations | 112 in bundle; pending and applied: `0134_committees.sql` (three new tables, `hr_issued_documents.document_kind` CHECK widened with `COMMITTEE`, additive), `0135_committee_permissions.sql` (`committees.read`, `committees.manage` → `human_capital_admin`), `0136_leave_request_cancellation.sql` (status CHECKs accept `cancelled`, no permission) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-a1f8a8e7-20261103-20261103T070225Z.dump` (37 082 243 B, sha256 `6717155d9e3cda346804c94a163b901d9667ded58386b26ddde1d1b53e1afea5`) |
| Worker | KILL-restarted: pid 8272 → 8699 |
| Rollback target | `hcis-f38f63e1-20261103`. The old build does not read the committee tables and never writes `cancelled` leave steps, so an application rollback is safe without touching the database. |

0135 adds permissions to an existing role, so between migrate (14:02:48 WIB) and the new API launch (14:03:31 WIB) the old build could not delegate `human_capital_admin` (§4.5). No authorization widened, and no role change was attempted in that minute.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 14:01 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-f38f63e1-20261103` running, 15 620 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0134, 0135, 0136. |
| 14:01–14:02 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 14:02 | migrate | `applied 0134_committees.sql`, `0135_committee_permissions.sql`, `0136_leave_request_cancellation.sql`. |
| 14:02–14:03 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 14:03 | cutover | New release running after about 28 s. |
| 14:03 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the processes** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
9511 node dist/server.js  | /data/local/ubuntu26/srv/hcis/releases/hcis-a1f8a8e7-20261103/apps/api
9890 spa_static_server.py | /data/local/ubuntu26/srv/hcis/releases/hcis-a1f8a8e7-20261103/apps/web/dist
```

**Database, read-only after the release:** `schema_migrations` holds 0134 (14:02:47), 0135 and 0136 (14:02:48); `human_capital_admin` holds `committees.manage` and `committees.read`; `committees`, `committee_members` and `committee_audit_events` exist and are empty.

**Public:** `/api/health` → `{"status":"ok"}`; `/api/admin/committees` without a session → 401 (the route answers and demands a session).

**Ten-minute watch (14:04–14:14 WIB):** no `launch service=hcis*` event after the cutover pair (worker log launch count 357 at 14:04 and at 14:14). The API still runs from `hcis-a1f8a8e7-20261103` at the end of the window, `/api/health` answers ok, and `hub.sabilulquran.or.id` answers 200.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The committee flow runs end to end against PostgreSQL in CI (`committees.postgres.test.ts`, ORG-012-A to K).

## What changes for users

HC Admin gets **Kepanitiaan** under Organisasi in the admin menu (`/admin/committees`): record a committee, build its line-up from active employees, decree it with an SK numbered in the letter register (`…/SKP/YSQ/…`) or record an SK signed outside HCIS, complete or cancel it, and read the yearly participation recap. Employees get **Kepanitiaan Saya** under Semua Layanan (`/app/committees`) and an "Undang seluruh panitia" choice in the meeting form. Employees can also cancel their own leave while it is still in line approval (LEAVE-010). No committee exists yet, and HCIS is not yet live to staff.

Not recorded here: `final.env` values, tokens, cookies or employee data.
