# Production release verification — hcis-c78e8b6b-20261111 (OPS-MI8-REL-001)

**Date:** 2026-11-11 02:57–02:59 UTC (09:57–09:59 WIB)
**Operator:** Claude Code (DOC-003 / NOTIF-003 session), under the owner rule of 2026-10-27 (release without confirmation, keeping dry run, backup, candidate gate, rollback on failed verify, report afterwards, never at 19 UTC). Release lock free at preflight, taken and released by the script.

| Item | Value |
|---|---|
| Target SHA | `c78e8b6b32641cf13adc121140cbbac73deeb34e` (`origin/main`: merge of #326) |
| Previous release | `hcis-4f6b80d1-20261111` |
| Adds | DOC-003 outgoing letter numbering register (#321, `docs/domain/outgoing-letter-register.md`); NOTIF-003 scheduled reminder engine and NOTIF-001 closure (#326, `docs/domain/reminders.md`). |
| Build | run [42949063893](https://github.com/sabilulquran/hcisysq/actions/runs/42949063893), bundle sha256 `f1a24178472336f42f801f8b12b483ddc8419c7c24412bbd0c9a764c547b0df8` |
| Migrations | 123 in bundle; pending and applied: `0144_outgoing_letter_register.sql` (six new tables, DRAFT letter types and issuer `YSQ`; no permission key), `0145_reminder_engine.sql` (five new tables; `in_app_notifications.href` may also start with `/admin/`). Both additive. |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-c78e8b6b-20261111-20261111T025751Z.dump`, sha256 `800bd7d67e3352b18aae030b42de795b7c8cdbd812ca7c29ad42a11cfbd1ffce` |
| Launcher | `a4a0fa2aa68f26ad` → `15184a1e8dd69814` |
| Worker | `dc313865e337ae66` → `e66eb10e5d05962a`; pid 9353 → 14329 |
| Rollback target | `hcis-4f6b80d1-20261111` (application only; it ignores the new tables) |

Preflight, upload, backup, migrate, candidate gate (API `/health`, `/ready`; web `/`, no-store, `/login`, immutable asset, missing asset 404; the candidate ran with `MEETING_RUNNER_ENABLED=0`, so the reminder engine never ran in it), cutover (about 14 s, one `launch` per service) and local and public verify all PASS.

After cutover the reminder engine ran all nine rules for 2026-11-11 with no error and generated nothing (no active staff accounts with matching data yet); `reminder_deliveries` is empty. No error-level line in the API log since cutover.

`final.env` (checked by key only): `WHATSAPP_ADAPTER=kirim`, `WHATSAPP_RECIPIENT_MODE=allowlist`; real WhatsApp therefore reaches only the allowlisted NIPs. No account was activated, no invitation sent, and no env value was changed.
