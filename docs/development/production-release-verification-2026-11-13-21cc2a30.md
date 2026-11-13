# Production release verification — hcis-21cc2a30-20261113 (OPS-MI8-REL-001)

**Date:** 2026-11-13 (07:05–07:07 UTC, 14:05–14:07 WIB)
**Operator:** REIMB-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `21cc2a3034bfd7255e1235844c01c832fe687a10` (`origin/main`: merge of #349) |
| Previous release | `hcis-76f76907-20261113` |
| Adds | REIMB-001 Package 1 reimbursement (#349): drafts with encrypted receipts, APR-001 approval, Finance verification and payment outside payroll, register, summary, CSV export, NOTIF-003 Finance digest, help topic Reimbursement |
| Configuration | No `final.env` change. `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED` is absent (default `0`); `WHATSAPP_RECIPIENT_MODE=allowlist` unchanged |
| Build | run [43382845016](https://github.com/sabilulquran/hcisysq/actions/runs/43382845016), bundle `hcis-21cc2a30-20261113.tar.gz` sha256 `f4122d609ff21aef8ac01bb7a46b873d9918542e976c14f53f20812befd9c3f0` |
| Migrations | 128 in bundle; three pending and applied: `0148_reimbursements.sql` (new tables and triggers), `0149_reimbursement_permissions.sql` (`reimbursements.read/manage` on `finance_officer`, `.read` on `human_capital_admin`), `0150_help_center_reimbursement_articles.sql` (topic CHECK widened, four DRAFT seed articles, two TRIPS seed drafts corrected in place). All additive and backward compatible with the previous release |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-21cc2a30-20261113-20261113T070557Z.dump` (sha256 `1a675c47…ae3eedf`) |
| Worker | restarted: pid 13101 → 22543 |
| Rollback target | `hcis-76f76907-20261113`; 0148–0150 can stay (the old build reads none of the new tables and ignores the extra help topic) |

## Result

Preflight and the `all` dry run passed (lock free, 2.4 GB free on `/data`, biometric OFF, database `sqcore_hcis`). Under `--apply`:
- the candidate gate passed: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404;
- after cutover (running after ~28 s), verify passed: release paths, health, ready, current symlink, worker alive, public `/api/health`, `/login`, missing asset 404.

Read-only checks after verify: `/app/reimbursements` and `/admin/reimbursements` return the SPA shell (200); `GET /api/reimbursements/me` without a session returns 401; `reimbursement_claims` is empty; the three role grants are present; the two TRIPS help articles are still `DRAFT` version 1 with `help.article.seed_corrected` audit events, and the four Reimbursement articles are `DRAFT` (HC publishes them).

## Not changed

No production payroll, attendance, structure or account data was edited. PAY-001/PAY-002 stay the official payslip path; no `payroll_*` table is read or written by REIMB-001. No staff account was activated and no invitation was sent. Approvals stop at `APPROVER_ACCOUNT_NOT_READY` until leader accounts are active (APR-001-E), as for leave, trips and loans.
