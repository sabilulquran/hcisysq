# Production release verification — hcis-dbd16b63-20261027 (OPS-MI8-REL-001)

**Date:** 2026-10-27 (02:25–02:29 UTC, 09:25–09:29 WIB)
**Operator:** ORG session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `dbd16b635c33609c84c69838e483492c1ded8bb1` (`origin/main`, merge of #204) |
| Adds since `hcis-7fdb06dd-20261027` | ORG-008-11 primary seat command (#209), PAY-003 reports (#204), ATT-011-4a future shifts (#205), ORG-011/ORG-007 docs (#202), EMP decision document register (#183), release note (#207) |
| Build | run [40438113980](https://github.com/sabilulquran/hcisysq/actions/runs/40438113980), bundle `hcis-dbd16b63-20261027.tar.gz` sha256 `876932651f5151e5af37d6d523315e11348c21746adcd83190f8fa8c09d05e5b` |
| Migrations | 76 in bundle, **1 pending and applied**: `0091_payroll_profile_bank_name` (one nullable column, additive) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-dbd16b63-20261027-20261027T022734Z.dump` (33 540 405 B, sha256 `0651779b760f1abb004687df30a7766d929834ff332be4f73b5558a06288acb2`) |
| Launcher / worker | `21ba544530cd950e` → `565f8c46c3462b27` / `ded6c896d8d3daae` → `80cfb5446eaf2013` |
| Worker | KILL-restarted: pid 12549 → 4241 |
| Rollback target | `hcis-7fdb06dd-20261027`; the database is not rolled back and the migration can stay |

A first bundle for `ce98949a` (run 40437847290) was built but not released, because `main` moved to `dbd16b63` before preflight. Preflight refuses any target that is not the current `origin/main`.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 09:25 | preflight (dry run) | PASS. Lock free, `hcis-7fdb06dd-20261027` running, about 21.8 GB free, biometric OFF, 1 pending migration. |
| 09:27 | backup, migrate | Dump taken and listed; `0091` applied. |
| 09:28 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 09:28 | cutover | New release running after about 26 s. |
| 09:28 | verify | Local and public checks PASS. Lock released. |

After the release, `hub` and `aset` answer 200.

## What changes for users

- **Struktur Organisasi:** for an employee who holds two seats, "Jadikan jabatan utama" on their other seat chooses which seat their own approvals start from, inside a change set.

Not recorded here: `final.env` values, tokens, cookies or employee data.
