# Production release verification — hcis-8a293215-20261027 (OPS-MI8-REL-001)

**Date:** 2026-10-27, 03:18–03:20 UTC (10:18–10:20 WIB).

**Operator:** ATT session (Claude Code). The owner rule of 2026-10-27 allows releasing without confirmation, provided the technical safeguards stay in place:

- a dry run first;
- a backup before migrations;
- the candidate gate;
- rollback if verification fails;
- a report afterwards;
- never during the 19 UTC hour.

The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `8a29321525b096a3167e798ffa6cfd8753a08e46` (`origin/main`, merge of #208) |
| Changes since `hcis-dbd16b63-20261027` | ATT-011-4b schedule change sets (#210), ATT-011-4c revert (#213), ATT-011-5 Jadwal planner UI (#215), PAG-4 import paging (#214), EMP-S5 contract actions (#208) |
| Build | run [40443125602](https://github.com/sabilulquran/hcisysq/actions/runs/40443125602), bundle `hcis-8a293215-20261027.tar.gz`, sha256 `2de361a7ebe5cba0ef8cff8ff771cc26ee179cf20f20830e1715bcadc3ac92e8` |
| Migrations | 77 in the bundle; **1 pending and applied**: `0092_attendance_schedule_change_sets`. It is additive: two new tables plus a nullable `change_set_id` column on assignments and rosters. |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-8a293215-20261027-20261027T031905Z.dump` (34 348 968 B, sha256 `fa586afa51f051202f09fad335e5675fabf2dfbadb98cee3b460b511bbf1ea3f`) |
| Launcher | `8538f405a40c48b0` → `b3ce6ef4c6741c9b` |
| Worker | `3c9c73fd7d25259d` → `adfc57549f4d9342`; restarted, pid 32526 → 15478 |
| Rollback target | `hcis-dbd16b63-20261027`. The database is not rolled back; the migration can stay. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 10:18 | preflight (dry run) | PASS. Lock free; `hcis-dbd16b63-20261027` running; about 21.5 GB free; biometric OFF; 1 pending migration. |
| 10:19 | backup, migrate | Dump taken and listed; `0092` applied. |
| 10:19 | candidate | PASS on all checks: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset returns 404. |
| 10:19 | cutover | New release running after about 26 s. |
| 10:20 | verify | Local and public checks PASS; lock released. |

After the release:

- `hub` and `aset` answer 200.
- Logged in as the owner, **Jadwal → Kalender** loads with real data: 50 employees per page, shifts resolved per date. At phone width it shows the D-8 message.

## What changes for users

- **Jadwal → Kalender** is the new main schedule screen:
  - **Atur jadwal**, **Ganti jadwal** and **Salin jadwal** always show **Lihat dampak** before **Terapkan**.
  - **Riwayat perubahan** includes **Kembalikan seperti sebelumnya**.
  - Accounts with `attendance.reports.read` see the calendar read-only.
- **Pola jadwal** and **Jadwal per tanggal** stay available until the ATT-011-8 UAT.
- Import history, the import preview and payslip batch review page on the server (PAG-4).

Not recorded here: `final.env` values, tokens, cookies or employee data.
