# Production release verification — hcis-a51a12f8-20261103 (OPS-MI8-REL-001)

**Date:** 2026-11-03 (02:32–02:45 UTC, 09:32–09:45 WIB)
**Operator:** HELP-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced in the shared operator notes; the device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `a51a12f86b45e71228848c49da70ee9dbcac401c` (`origin/main`, merge of #279) |
| Previous release | `hcis-3b1c85f4-20261103` (PERF-001) |
| Adds since `hcis-3b1c85f4-20261103` | HELP-001 Package 1 (#279); PERF-001 release note #278 (documentation only) |
| Build | run [41565970726](https://github.com/sabilulquran/hcisysq/actions/runs/41565970726), bundle `hcis-a51a12f8-20261103.tar.gz` sha256 `55d42e5c0daf26ec6d9daf385e62170d29809ca333f0054d0a39e69b4ce65c82` |
| Migrations | 105 in bundle; pending and applied: `0130_help_center.sql` (four new tables and 83 draft articles, additive), `0131_help_center_permissions.sql` (adds `help.manage` to an existing role, so released on its own per §4.5) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-a51a12f8-20261103-20261103T023349Z.dump` (36 938 171 B, sha256 `cd8afc4d99c98d5940ff839941da9e8fc411f7c5f5317bb23a54a7969c5b745f`) |
| Launcher / worker | `b360fbd1048e2d74` → `c1e55367dbbc9419` / `008fdc3e3cbaf242` → `9cfa4b5d4a01f8f6` |
| Worker | KILL-restarted: pid 323 → 16392 |
| Rollback target | `hcis-3b1c85f4-20261103`. The old build does not read the new tables, so an application rollback is safe without touching the database; the `help.manage` grant would only make the old build refuse to (re)assign `human_capital_admin` until rolled forward again (§4.5). |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 09:32 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-3b1c85f4-20261103` running, 16 465 MB free, biometric OFF, database `sqcore_hcis`, pending exactly 0130 and 0131. |
| 09:33 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 09:34 | migrate | `applied 0130_help_center.sql`, `applied 0131_help_center_permissions.sql`. |
| 09:34 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 09:34–09:35 | cutover | New release running after about 28 s. |
| 09:35 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
17363 /usr/bin/node dist/server.js                        | /data/local/ubuntu26/srv/hcis/releases/hcis-a51a12f8-20261103/apps/api
17749 /usr/bin/python3 /srv/hcis/shared/spa_static_server | /data/local/ubuntu26/srv/hcis/releases/hcis-a51a12f8-20261103/apps/web/dist
```

**Database, read-only after the release:** `schema_migrations` holds 0130 and 0131; `role_permissions` holds exactly `human_capital_admin:help.manage` for the new key; `help_articles` holds 83 rows, all `DRAFT` with origin `SEED` (13 guides, one per topic, and 70 FAQs); 83 revisions (version 1) and 83 `help.article.created` audit events; `help_contacts` is empty.

**Public:** `/api/health` → `{"status":"ok"}`; `/api/help/overview`, `/api/help/articles` and `/api/admin/help/articles` without a session → 401 (the routes answer and demand a session); `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` → 200.

**Ten-minute watch (09:35–09:46 WIB):** no `launch service=hcis*` event after the cutover pair at 09:34:56–09:35:12 (worker log launch count 349 at 09:36 and at 09:46). The API still runs as pid 17363 and the web as pid 17749 from `hcis-a51a12f8-20261103` at the end of the window, and `/api/health` answers ok. The "Hub dependency gate: HCIS unavailable" lines at 09:34:57/09:35:12 are the expected gate messages during the HCIS restart.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The screens were checked before merge against a local build with synthetic data (desktop and phone width, employee and admin), and the full article lifecycle runs against PostgreSQL in CI (`help.postgres.test.ts`).

## What changes for users

Employees get **Bantuan** in the navigation and **Pusat Bantuan** in Semua Layanan (`/app/help`). Until HC publishes articles it shows "Panduan sedang disiapkan" and, with no contact entered, advises asking the direct manager or the HC room. HC Admin gets **Pusat Bantuan** in the admin services (`/admin/help`): 83 draft articles marked "Draf awal — perlu ditinjau" to review and publish, the HC contact list (empty), and the change history. HCIS is not yet live to staff, so nothing changes for them until activation.

Not recorded here: `final.env` values, tokens, cookies or employee data.
