# Production release verification — hcis-b9f9d375-20261027 (OPS-MI8-REL-001)

**Date:** 2026-10-27, 08:33–08:36 UTC (15:33–15:36 WIB).

**Operator:** the ATT session (Claude Code), under the owner rule of 2026-10-27. That rule allows a release without confirmation, provided the technical safeguards are kept:

- a dry run;
- a backup before migrations;
- the candidate gate;
- rollback if verification fails;
- a report afterwards;
- no release during the 19 UTC hour.

The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `b9f9d3758f999422e6ce59cd6afeaabcafc5da0e` (`origin/main`, merge of #230) |
| Adds since `hcis-aa1a5ded-20261027` | ATT-011-6b-1 supervisor overtime approval (#225), ATT-011-6b-2 Lembur Tim and order cards (#230), DOC-002 follow-up (#220), EMP-S5B action dialog (#222), EMP-S6 career actions (#223), PAY-003 follow-up (#227) |
| Build | run [40473956215](https://github.com/sabilulquran/hcisysq/actions/runs/40473956215), bundle `hcis-b9f9d375-20261027.tar.gz`, sha256 `2755ebad198a73119ac9f2e53a812564f0a5057b24c79d6c08fe10bb048456d7` |
| Migrations | 83 in bundle; **2 pending and applied**: `0102_hr_document_role_grants` and `0103_attendance_overtime_supervisor_approval` (additive) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-b9f9d375-20261027-20261027T083421Z.dump` (34 466 981 B, sha256 `0422ce696bdc658353c32767e7da4c71d456d56e765414f54a582c674a14bfb4`) |
| Rollback target | `hcis-aa1a5ded-20261027`. The database is not rolled back; both migrations can stay. |

**Permission-migration window (§ "Permission migrations open a window").** `0102` grants `documents.discipline.manage` to `human_capital_admin`. The running build `aa1a5ded` already listed both new permission keys in its allowlist, so it never refused to grant or revoke `human_capital_admin` between migrate and cutover.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 15:33 | preflight (dry run) | PASS. Lock free; `hcis-aa1a5ded-20261027` running; about 20.5 GB free; biometric OFF; 2 pending migrations. |
| 15:34 | backup, migrate | Dump taken and listed; `0102` and `0103` applied. |
| 15:34 | candidate | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404. |
| 15:35 | cutover | New release running after about 26 s. |
| 15:35 | verify | Local and public checks PASS. Lock released. |

After the release:

- `hub` and `aset` answer 200.
- Logged in as the owner, **Lembur** (HC) and **Lembur Tim** (`/app/attendance/team-overtime`) both load.

## What changes for users

- **Overtime is approved by the direct supervisor** (D-5, D-5a):
  - An employee's request goes to their direct supervisor.
  - A supervisor's order goes to the employee, who agrees or declines.
  - HC monitors, can cancel administratively, and can reassign the approver. HC decides only requests filed before this release.
- **Data readiness (owner action):** at release time, only 2 of 99 active employees have a direct manager recorded (ORG-002), and the OVERTIME workflow runs on that data (LEGACY). Everyone else gets "Atasan Anda belum tercatat. Hubungi HC." when submitting overtime. There are two ways to fix it:
  - fill in the direct manager on each employee; or
  - switch OVERTIME to the ORG-004 structure (rollout).

  No overtime request existed before the release, so no pending work was affected.

Not recorded here: `final.env` values, tokens, cookies or employee data.
