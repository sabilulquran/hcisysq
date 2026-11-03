# Production release verification — hcis-0c424314-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (08:03–08:16 UTC, 15:03–15:16 WIB)
**Operator:** EMP-012 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes before merging #289; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `0c42431433228a57f005149cff6dccdfd218a0ba` (`origin/main`: merge of #289) |
| Previous release | `hcis-38dd032e-20261103` (HELP-001 gap articles) |
| Adds since `hcis-38dd032e-20261103` | EMP-012 Kartu Pegawai Package 1 (#289) |
| Build | run [41600171628](https://github.com/sabilulquran/hcisysq/actions/runs/41600171628), bundle `hcis-0c424314-20261103.tar.gz` sha256 `493d2355cbcbc9b36bf2df497f5c65d1b29b1832c2938eec0d738a3291d4c348` |
| Migrations | 115 in bundle; pending and applied: `0132_employee_cards.sql` (four new tables and a sequence, additive), `0133_employee_card_permissions.sql` (`employee_cards.manage` → `human_capital_admin`) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-0c424314-20261103-20261103T080432Z.dump` (37 111 996 B, sha256 `18f0e06f8d37b5db3853adb03114245f5bd9f538ac4c9f983419db735ee6890f`) |
| Shared SPA server | `/srv/hcis/shared/spa_static_server.py` replaced with the repository version (sha256 `df031aea…`; it masks `/cek/<code>` in the web log) before the candidate gate. The previous file is kept as `spa_static_server.py.pre-emp012` (sha256 `319b9a1a…`). |
| Worker | KILL-restarted: pid 31158 → 2821 |
| Rollback target | `hcis-38dd032e-20261103`, plus restoring `spa_static_server.py.pre-emp012`. The old build does not read the card tables, so an application rollback is safe without touching the database. |

0133 adds a permission to an existing role, so between migrate (15:04:54 WIB) and the new API launch (15:05:39 WIB) the old build could not delegate `human_capital_admin` (§4.5). No authorization widened, and no role change was attempted in that minute.

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 15:03 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-38dd032e-20261103` running, 15 180 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0132 and 0133. |
| 15:03–15:04 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 15:04–15:05 | migrate | `applied 0132_employee_cards.sql`, `0133_employee_card_permissions.sql`. |
| 15:05 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS (the candidate web ran the new shared SPA server). |
| 15:05 | cutover | New release running after about 28 s. |
| 15:06 | verify | Local and public checks PASS. Lock released. |

**Database, read-only after the release:** `schema_migrations` holds 0132 (15:04:53) and 0133 (15:04:54); `human_capital_admin` holds `employee_cards.manage`; `employee_cards` and `employee_card_photos` are empty; `employee_card_settings` holds the default (`Ketua Yayasan`, signer name not yet set, 24 months).

**Public:** `/cek/<code>` answers the SPA shell with no-store; `/api/public/employee-cards/<unknown code>` → 404 `EMPLOYEE_CARD_NOT_FOUND`, `Cache-Control: no-store`; requests above 30 per minute from one address → 429 `RATE_LIMITED`; `/api/me/employee-card` and `/api/admin/employee-cards` without a session → 401. The API log carries `/public/employee-cards/[code]` and the web log `/cek/[code]`; no raw code from the checks appears in either log.

**Running release, proved from the processes** (walking `/proc/*/cwd` on the device after the watch, independently of the release script):

```text
4039 node dist/server.js  | /data/local/ubuntu26/srv/hcis/releases/hcis-0c424314-20261103/apps/api
4554 spa_static_server.py | /data/local/ubuntu26/srv/hcis/releases/hcis-0c424314-20261103/apps/web/dist
```

**Ten-minute watch (15:06–15:17 WIB):** no `launch service=hcis*` event after the cutover pair (worker log launch count 361 at 15:06 and at 15:17). `/api/health` answers ok and `hub.sabilulquran.or.id` answers 200; the Hub dependency gate noted HCIS briefly unavailable only during the cutover (15:05:39–15:05:55).

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The card flow runs end to end against PostgreSQL in CI (`employee-cards.postgres.test.ts`, EMP-012-B to H).

## What changes for users

HC Admin gets **Kartu Pegawai** in the admin service catalog (`/admin/employee-cards`): upload a pas foto, issue a numbered card valid 24 months, reissue a lost or damaged card, revoke, print a 54 × 85,6 mm sheet, and set the signer. Before the first card, HC must fill the signer's name (and optionally upload the signature image) under Pengaturan. Employees get **Kartu Pegawai** in the navigation (`/app/employee-card`) with a large QR and "report lost". Anyone scanning a card's QR opens `/cek/<code>`. No card exists yet, and HCIS is not yet live to staff.

Not recorded here: `final.env` values, tokens, cookies or employee data.
