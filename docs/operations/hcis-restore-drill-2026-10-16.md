# HCIS isolated restore drill — 2026-10-16 evidence

**Spec ID:** OPS-MI8-DRILL-001 (runbook: `hcis-isolated-restore-drill.md`)
**Result:** **PASS**
**Owner approval:** 2026-10-16, in chat, granting all requested approvals including the restore drill: "silakan. granted semua".
**Operator:** Claude Code session via `ssh mi8vps-root`, 13:58–13:59 WIB (06:58–06:59 UTC).

## Inputs

| Item | Value |
|---|---|
| Backup set | `set-20261016T002118Z` (newest `result=OK scope=production`; manual set taken before OPS-MI8-KC-001, about 6.6 h old) |
| Dump | `hcis/database.dump`, 28 027 687 B; `SHA256SUMS` verified OK |
| Release used | `hcis-3b670849-20261016` (same release as production) |
| Disposable DB | `sqcore_drill_hcis_20261016`, owner `sqcore_hcis_owner` |
| Drill ports | API `127.0.0.1:3392`, web `127.0.0.1:3292` (no edge route) |

## Timings

| Step | Seconds from start |
|---|---|
| Restore complete | 34 |
| App ready (`/health` 200) | 43 |
| Teardown complete | 48 |

## Schema and reconciliation (counts only)

| Check | Live | Drill | Verdict |
|---|---|---|---|
| Public base tables | 92 | 92 | equal |
| `schema_migrations` rows | 55 | 55 | equal; last name equal |
| employees | 329 | 329 | equal |
| accounts | 81 | 81 | equal |
| account_role_assignments | 2 | 2 | equal |
| organization_nodes | 1 060 | 1 060 | equal |
| organization_positions | 445 | 445 | equal |
| leave_requests / approval steps | 0 / 0 | 0 / 0 | equal |
| attendance_events | 3 | 3 | equal |
| attendance_adms_events | 3 010 | 2 995 | drill ≤ live; +15 device punches since the set (expected) |
| payslip_import_batches | 1 | 1 | equal |
| payslips | 5 202 | 5 202 | equal |
| access_audit_events | 300 | 300 | equal |
| auth_audit_events | 113 | 110 | drill ≤ live; +3 login events since the set (expected) |

## Health and smoke

The drill API held one connection to `sqcore_drill_hcis_20261016`, which proves it ran against the copy and not production.

```text
PASS api /health
PASS api /ready
PASS api /auth/me unauthenticated (401)
PASS api admin unauthenticated (401)
PASS web /
PASS web /login
log_error_lines=0
smoke=PASS
```

## Teardown proof

Both drill processes were stopped and ports 3392/3292 returned `000`. The DB `sqcore_drill_hcis_20261016` was dropped (`drill_dbs_left=0`), and the temporary dump copy was removed. After the drill, production API `/health` returned 200 and production web `/` returned 200. A follow-up scan found no process with `PORT=3392` or `--port 3292`. The drill log `/srv/hcis/logs/drill-20261016T065851Z.log` (2.6 KB, request lines only) is kept as evidence.

## Deviation

The first attempt (06:58:32 UTC) stopped before any write. The runbook looked for the dump at `<set>/*hcis*.dump`, but the set stores it at `<set>/hcis/database.dump`. The runbook is corrected. The teardown trap ran and confirmed no DB was created and production stayed at 200.

## What this does and does not prove

- **Proves:** a production backup set restores completely and the current HCIS release starts on it and serves health, readiness and authorization checks. Recovery of the database on the same host takes under a minute of work for the HCIS database.
- **Does not prove:** recovery after **loss of the phone** (Drive copy → another host, plus the secret bundle that backups exclude). That is the follow-up drill (`TBD`, needs a target host). RPO/RTO remain owner decisions; this run measured 48 s for restore + start on the same host.
