# Production release verification — hcis-2fe79f4c-20261113 (OPS-MI8-REL-001)

**Date:** 2026-11-13 04:36–04:39 UTC (11:36–11:39 WIB)
**Operator:** Claude Code (DOC-003 / NOTIF-003 session), under the owner rule of 2026-10-27 (release without confirmation, keeping dry run, backup, candidate gate, rollback on failed verify, report afterwards, never at 19 UTC). Release lock free at preflight, taken and released by the script.

| Item | Value |
|---|---|
| Target SHA | `2fe79f4ca5ddf6406ab6fb9346c1ab7d5e304133` (`origin/main`: merge of #339) |
| Previous release | `hcis-b9687c61-20261113` |
| Adds | NOTIF-003 rule `employee.document_expiring` (#339, `docs/domain/reminders.md` §4): owners of EMP-011 documents are reminded at H-30 and H-7. Also ships what merged after `b9687c61`: ATT-011-6b-3 overtime rules and warnings (#327). |
| Build | run [43366338260](https://github.com/sabilulquran/hcisysq/actions/runs/43366338260), bundle sha256 `a227852e6c3e6ecfca37f02a46b3ca3666746cf4b4c4b9e0ecd280a85501895c` |
| Migrations | 124 in bundle; pending and applied: `0146_attendance_overtime_rules_and_warnings.sql` (#327; additive, no seed, no row changed). #339 has no migration. |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-2fe79f4c-20261113-20261113T043723Z.dump`, sha256 `8d4fe3e7a305c5e048b9e6a0e1feb230a61a17d4a9ccbca3069de81b248866ba` |
| Launcher | `1d27b2deb9cb12ac` → `b448734a24194a09` |
| Worker | `b947e549ffc4350f` → `5ab257e7240ec084`; pid 18256 → 19492 |
| Rollback target | `hcis-b9687c61-20261113` (application only; it ignores the new tables) |

Preflight, upload, backup, migrate, candidate gate (API `/health`, `/ready`; web `/`, no-store, `/login`, immutable asset, missing asset 404), cutover (about 28 s, one `launch` per service) and local and public verify all PASS.

After cutover the reminder engine ran all ten rules for 2026-11-13, `employee.document_expiring` included, with no error and nothing generated; `reminder_deliveries` is empty.

No account was activated, no invitation sent, and `WHATSAPP_RECIPIENT_MODE` (still `allowlist`) was not touched.
