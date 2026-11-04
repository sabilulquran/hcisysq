# Production release verification — hcis-c9c03353-20261104 (OPS-MI8-REL-001)

**Date:** 2026-11-04 04:09–04:11 UTC (11:09–11:11 WIB). **Operator:** Claude Code (orchestrator session), owner rule of 2026-10-27 (release without asking; dry run, backup, candidate gate, rollback on failed verify, report afterwards, never at 19 UTC). Release lock free at preflight, taken and released by the script.

| Item | Value |
|---|---|
| Target SHA | `c9c03353952102e8d4a61991b6546c7ad6d846b0` (`origin/main`: merges of #310 and #311, legacy cleanup stage 1) |
| Previous release | `hcis-b28efeef-20261104` |
| Build | run [41771147345](https://github.com/sabilulquran/hcisysq/actions/runs/41771147345), bundle sha256 `aa78292a299e0985ffb29f53756efe3746d5db9eccf331e078566e4e35f5193a` |
| Migration | `0140_drop_attendance_daily_audit_events.sql` (table verified empty and owned by `sqcore_hcis_owner` before the run; no reference in the running release) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-c9c03353-20261104-20261104T040936Z.dump` |
| Launcher / worker | `9873f9d82bab80d4` → `a93fb26e2e97ba76` / `ac02d6bf2518a263` → `0cfc151aa513198a` |
| Rollback | application: `hcis-b28efeef-20261104`; table: recreate per the rollback notes in 0140 (identical to 0010) |

Preflight, upload, backup, migrate, candidate gate, cutover (about 28 s), local and public verify: all PASS.

## Legacy cleanup stage 1 on the device (owner-approved 2026-11-04, same day)

Done under the device-wide release lock (`operator=claude-orchestrator`, `release=retention-cleanup`), outside 19 UTC, before this release.

| Step | Result |
|---|---|
| HCIS release directories older than 7 days, not current, not referenced by launcher/worker, not running (§6 retention) | 25 removed; 53 → 28 directories, 6.7 GB → 3.5 GB |
| Karir SQ release and web-release directories, same rule | 18 removed; 2 + 2 remain; 1.5 GB → 349 MB; Karir answered 200 afterwards |
| Older `final.env.*` copies (keep the 2 newest) | archived into `shared/final.env-backups-archive-20261104.tar` (mode 0600): HCIS 7 files, Karir SQ 4 files |
| Open legacy local-password activation tokens (unusable in `AUTH_MODE=oidc`) | 1 revoked in one transaction with an `account.activation.revoked` audit event; 0 open afterwards |
