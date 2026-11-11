# Production release verification — hcis-fdc67807-20261111 (OPS-MI8-REL-001)

**Date:** 2026-11-11 02:09–02:12 UTC (09:09–09:12 WIB)
**Operator:** Claude Code (LEAVE-008 session), under the owner rule of 2026-10-27 (release without confirmation, keeping dry run, backup, candidate gate, rollback on failed verify, report afterwards, never at 19 UTC). Release lock free at preflight, taken and released by the script.

| Item | Value |
|---|---|
| Target SHA | `fdc67807a93cd4ca8d365f159536aee5517d17c0` (`origin/main`: merge of #318) |
| Previous release | `hcis-808c0e8e-20261110` |
| Adds | LEAVE-008 leave postponement with proposed alternative dates (`docs/domain/leave-postponement.md`); also ships what merged after `808c0e8e` (ATT-012 operator UX leftovers #316, ATT-005 ledger docs #317). |
| Build | run [42943692862](https://github.com/sabilulquran/hcisysq/actions/runs/42943692862), bundle sha256 `8a9cc555514b0260b8010289d9d0a05c4b157aedf9a2c30e899c6e29043f4b58` |
| Migrations | 119 in bundle; pending and applied: `0141_leave_postponement.sql` (additive: two request statuses, one step status, `leave_requests.replaces_request_id`, table `leave_postponement_proposals`; no row changed, no permission granted) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-fdc67807-20261111-20261111T021040Z.dump`, sha256 `d4332b9d87bacb01d069d5358168a3933abfa0570ff2090aa03ae3844fc7ec7a` |
| Launcher | `f5063634d6f610da` → `40f423cf3941350e` |
| Worker | `33956ede25463a4f` → `9bb48e3f51fc3940`; pid 23246 → 24125 |
| Rollback target | `hcis-808c0e8e-20261110` (application only; it treats the new statuses as "not open") |

Preflight, upload, backup, migrate, candidate gate (API `/health`, `/ready`; web `/`, no-store, `/login`, immutable asset, missing asset 404), cutover (about 28 s, one `launch` per service) and local and public verify all PASS. Public `POST /api/leave/me/postponements/{id}/accept` without a session answers 401 `UNAUTHENTICATED`. Hub and Aset answer 200.

No account was activated, no invitation sent, and `WHATSAPP_RECIPIENT_MODE` was not touched.
