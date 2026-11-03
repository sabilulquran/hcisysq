# Production release verification — hcis-7ef379cf-20261102 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (01:16–01:30 UTC, 08:16–08:30 WIB)
**Operator:** LOAN-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `7ef379cf5beab4dd89c6abe21749a5fcf7b0edce` (`origin/main`, merge of #272) |
| Previous release | `hcis-2a6ddce3-20261102` (TRAIN-001) |
| Adds since `hcis-2a6ddce3-20261102` | LOAN-001 Package 1 (#272); release note #274 (documentation only) |
| Build | run [41417169248](https://github.com/sabilulquran/hcisysq/actions/runs/41417169248), bundle `hcis-7ef379cf-20261102.tar.gz` sha256 `e43fce88e76b4b7cda90b21581808aa6145c8d8dd37b1b8eea14d30ba6fdea52` |
| Migrations | 101 in bundle; pending and applied: `0122_employee_loans.sql` (five new tables, additive), `0123_employee_loan_permissions.sql` (adds `loans.*` to existing roles, so released on its own per §4.5) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-7ef379cf-20261102-20261103T011740Z.dump` (36 878 179 B, sha256 `ee77e8181d07ef6ecde6c36794bef4273294412b4c1aa07764db28f401e38ba1`) |
| Launcher / worker | `e4090b98d57d96a9` → `c1692f1d4fc83fce` / `744e6a118e00cebf` → `f9bae039e63e3f36` |
| Worker | KILL-restarted: pid 8258 → 7818 |
| Rollback target | `hcis-2a6ddce3-20261102`. The old build does not read the new tables, so an application rollback is safe without touching the database; the `loans.*` grants would only make the old build refuse to (re)assign `finance_officer` and `human_capital_admin` until rolled forward again (§4.5). |

The release was merged and announced on 2026-11-02 around 09:00 UTC, but the operating session paused before upload. Nothing reached the device then (no lock, no upload); the run below is the whole release.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 08:16 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-2a6ddce3-20261102` running, 16 914 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0122 and 0123. |
| 08:17 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 08:18 | migrate | `applied 0122_employee_loans.sql`, `applied 0123_employee_loan_permissions.sql`. |
| 08:18 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 08:18–08:19 | cutover | New release running after about 28 s. |
| 08:19 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
8655 /usr/bin/node dist/server.js                        | /data/local/ubuntu26/srv/hcis/releases/hcis-7ef379cf-20261102/apps/api
9021 /usr/bin/python3 /srv/hcis/shared/spa_static_server | /data/local/ubuntu26/srv/hcis/releases/hcis-7ef379cf-20261102/apps/web/dist
```

**Database, read-only after the release:** `schema_migrations` holds 0122 and 0123; `role_permissions` holds exactly `finance_officer:loans.manage`, `finance_officer:loans.read`, `human_capital_admin:loans.read`; the three deferred money triggers `employee_loans_money`, `employee_loan_instalments_money`, `employee_loan_payments_money` exist; `employee_loans` is empty.

**Public:** `/api/health` → `{"status":"ok"}`; `/api/loans/me` and `/api/admin/loans` without a session → 401 (the routes answer and demand a session); `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` → 200.

**Ten-minute watch (08:19–08:29 WIB):** no `launch service=hcis*` event after the cutover pair at 08:18:45–08:19:01 (worker log launch count 344 before and after the window). The API still runs as pid 8655 from `hcis-7ef379cf-20261102` at the end of the window, and `/api/health` answers ok. The "Hub dependency gate: HCIS unavailable" lines at 08:18:45/08:19:01 are the expected gate messages during the HCIS restart.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator, and an authenticated loan flow. Signing in needs a password, which this session never types (owner rule), and staff accounts are still invited, so no approver chain can resolve in production yet (spec §5.1, `APPROVER_ACCOUNT_NOT_READY`). The full flow — submit, approve, disburse, pay, pay off, reverse, money invariants — runs against PostgreSQL in CI (`loans.postgres.test.ts`).

## What changes for users

Employees get **Pinjaman** under Keuangan Saya (`/app/loans`); approvers see a **Pinjaman** queue on the Persetujuan page; Finance (`Staf Keuangan (Kasbon)`) gets the **Pinjaman Pegawai** register (`/admin/loans`) with disbursement and repayment recording, and HC Admin can read it. No account holds `finance_officer` today unless the Super Admin grants it, and HCIS is not yet live to staff, so in practice nothing changes until activation. Payroll and the official slip path are untouched.

Not recorded here: `final.env` values, tokens, cookies, amounts or employee data.
