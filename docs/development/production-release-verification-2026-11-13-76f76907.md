# Production release verification — hcis-76f76907-20261113 (OPS-MI8-REL-001)

**Date:** 2026-11-13 (06:01–06:03 UTC, 13:01–13:03 WIB)
**Operator:** attendance & organization PRD close-out session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `76f7690769e8fa2458fbd0c977f37978c5438e62` (`origin/main`: merge of #341) |
| Previous release | `hcis-2fe79f4c-20261113` (already carried the ATT-011-6b-3 API, #327, and migration 0146) |
| Adds | ATT-011-6b-3 screens: Pengaturan → Aturan lembur, PP 35/2021 warnings, Lembur Tim only for supervisors (#340); ORG-008-12 warning when a structure change moves a seat named by an overtime rule (#344); EMP-005 S2B-b leave records outside HCIS management (#319); PAY-003 PPh21 TER report (#323); EMP-010 PK/SK links to employment actions (#341); parity and REWARD-001 documentation (#343, #346) |
| Configuration | No `final.env` change |
| Build | run [43375423854](https://github.com/sabilulquran/hcisysq/actions/runs/43375423854), bundle `hcis-76f76907-20261113.tar.gz` sha256 `c96186bdfd9aca96a84b93a7ccf7c2225301981028077af41b0d5ea3a6e14a30` |
| Migrations | 125 in bundle; one pending and applied: `0147_payroll_profile_pph21_report_exclusion.sql` (additive column with default, backward compatible with the previous release) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-76f76907-20261113-20261113T060134Z.dump` (sha256 `70a29c93…ddd6b3`) |
| Worker | KILL-restarted: pid 19492 → 26677 |
| Rollback target | `hcis-2fe79f4c-20261113`; 0147 can stay (the old build ignores the columns) |

## Result

Preflight and the `all` dry run passed (lock free, 2.6 GB free on `/data`, biometric OFF, database `sqcore_hcis`). Two earlier bundles (`abb20924`, `7aa078bd`) were built but not released because `origin/main` moved before preflight; the script refuses any target other than the current `origin/main`. Under `--apply`:
- the candidate gate passed: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404;
- after cutover (running after ~28 s), verify passed: release paths, health, ready, current symlink, worker alive, public `/api/health`, `/login`, missing asset 404.

After verify: the deep link `/admin/attendance/settings/overtime-rules` returns the SPA shell (200), `GET /api/admin/attendance/overtime-policy` without a session returns 401, and SQ Hub and Aset SQ answer 200.

## Not changed

No production attendance, structure or account data was edited. No overtime rule exists yet: HC must add the Direktur position rule in Pengaturan → Aturan lembur before go-live (ATT-011 §10.12, DRAFT). WhatsApp stays in allowlist mode. No staff account was activated and no invitation was sent.
