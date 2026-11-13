# Production release verification — hcis-e54353aa-20261113 (OPS-MI8-REL-001)

**Date:** 2026-11-13 (01:11–01:14 UTC, 08:11–08:14 WIB)
**Operator:** ORG-013 / ORGAN-IMPL-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `e54353aad90cb907b1bdcd47e6007e64eec43a6d` (`origin/main`: merge of #335) |
| Previous release | `hcis-c78e8b6b-20261111` |
| Adds | ORG-010-N/O for the Portal Organ Yayasan: `sq-organ` accepted on `/governance/summary` through the allowlist, and the caller's own `decisions` block (#335). Also documentation (#330, #332–#334) and EMP-011 file-name date fix (#331) |
| Configuration | `final.env`: `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS=sq-hub,sq-organ` (backup `final.env.pre-organ-20261113T010201Z`) |
| Build | run [43341763188](https://github.com/sabilulquran/hcisysq/actions/runs/43341763188), bundle `hcis-e54353aa-20261113.tar.gz` sha256 `83b51ec17ebe9259d4f30ed02cb103ca3f9e542a3161ccba5c6cbb72d46ac3b7` |
| Migrations | 123 in bundle; none pending |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-e54353aa-20261113-20261113T011220Z.dump` |
| Worker | KILL-restarted: pid 14329 → 3177 |
| Rollback target | `hcis-c78e8b6b-20261111`; no schema change |

## Result

Preflight and the `all` dry run passed (lock free, 3.2 GB free on `/data`, biometric OFF, database `sqcore_hcis`, nothing pending). Under `--apply`:
- the candidate gate passed: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404;
- after cutover, verify passed: release paths, health, current symlink, worker alive, public `/api/health`, `/login`, missing asset.

The Portal Organ Yayasan was switched on in SQ Hub at 01:33 UTC (sq-core-ops `runbooks/release-2026-11-13-organ-r1.md`). The exchange with `azp = sq-organ` is proved at the owner's first sign-in as an organ member (one `governance.summary.served` audit row).
