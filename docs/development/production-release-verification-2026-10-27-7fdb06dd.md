# Production release verification — hcis-7fdb06dd-20261027 (OPS-MI8-REL-001)

**Date:** 2026-10-27 (01:58–02:00 UTC, 08:58–09:00 WIB)
**Operator:** ORG session (Claude Code), owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards — dry run first, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never during the 19 UTC backup hour.
**Coordination:** the ATT session was told before the release; the device-wide release lock was free at preflight, held by this checkout during the run, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `7fdb06dd0e3cd98d3531bcdee62bcc892e319a3b` (`origin/main`, merge of #203) |
| Adds since `hcis-0cd5b032-20261027` | ORG-005-2 device work location (#203), ORG-008 status docs (#190), PAY-003 attendance inputs (#200), ATT-013 spec alignment (#201), ATT-013 multi-block schedule (#151), ATT-011 schedule intake tolerance (#152), PAY-003 admin (#198) |
| Build | run [40435360743](https://github.com/sabilulquran/hcisysq/actions/runs/40435360743), bundle `hcis-7fdb06dd-20261027.tar.gz` sha256 `a44a18da69b713c979bf3247209866ede6dfc4fd122c1f957112039a8cf94d00` |
| Migrations | 75 in bundle, **3 pending and applied**: `0080_payroll_result_profile_evidence`, `0081_attendance_block_workday_weight`, `0090_adms_device_work_location`. All additive (nullable columns and partial indexes), so the previous release runs on the new schema. |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-7fdb06dd-20261027-20261027T015901Z.dump` (33 531 656 B, sha256 `41a2c298b3aa5ddbc5d1b2af2cb8bf24dea931b5f89027171a2563c6d16c7e34`, `root:root 0600`) |
| Launcher / worker | `9ad540881a2781cb` → `21ba544530cd950e` / `436687ac188ac275` → `ded6c896d8d3daae` |
| Worker | KILL-restarted: pid 13973 → 12549 |
| Rollback target | `hcis-0cd5b032-20261027` (`release-mi8.sh rollback`); the database is not rolled back and the migrations can stay |

## Timeline (WIB)

| Time | Phase | Result |
|---|---|---|
| 08:57 | `all` dry run, then `preflight` | PASS. Lock free, `hcis-0cd5b032-20261027` running, about 22 GB free, biometric OFF, 3 pending migrations. |
| 08:58 | upload | Bundle checksum verified on device, installed read-only and `sqhcis`-owned. |
| 08:59 | backup | `pg_dump -Fc` taken and listed (see above). |
| 08:59 | migrate | The three migrations applied. |
| 08:59 | candidate | API `:3391` `/health` and `/ready` 200; web `:3291` `/` and `/login` 200 no-store, entry asset immutable, missing asset 404. |
| 08:59–09:00 | cutover | Services restarted; new release running after about 26 s. |
| 09:00 | verify | API release and web release, `/health`, `/ready`, web no-store, `current` symlink, worker alive; public `/api/health`, `/login`, missing asset 404 — all PASS. Lock released. |

After the release: `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` answer 200. The worker log shows one launch each for `hcis` and `hcis-web` at the restart and no repeated launches since.

## What changes for users

- **Mesin absensi** (Konfigurasi → Identitas & lokasi): "Lokasi kerja" is chosen from the organisation's list of work locations. The old free text stays as "Catatan lokasi (lama)".
- **Lokasi kerja**: a location still used by a unit of the published structure, or by a machine that is not retired, cannot be switched off. The refusal names what still uses it.
- After this release Super Admin still needs to choose the Kepala HC reference seat once on the Akses screen (ORG-008-9). Until then the panel says it has not been set.

Not recorded here: `final.env` values, tokens, cookies or employee data.
