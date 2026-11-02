# Production release verification — hcis-aa724851-20261102 (OPS-MI8-REL-001)

**Date:** 2026-11-02 (07:25–07:28 UTC, 14:25–14:28 WIB)
**Operator:** DOC-002-F session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The release was announced in the shared operator notes beforehand. The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `aa7248516dbb1136e271350e329b3e1fe12b6b48` (`origin/main`, merge of #259) |
| Previous release | `hcis-d7b2e580-20261101` |
| Adds since `hcis-d7b2e580-20261101` | Release and AUTH-014 notes (#254–#257, documentation only); ASSET-001 study (#258, documentation only); DOC-002-F screen path to revoke a warning letter (#259) |
| Build | run [41405850947](https://github.com/sabilulquran/hcisysq/actions/runs/41405850947), bundle `hcis-aa724851-20261102.tar.gz` sha256 `10042bf45352054a2b59f1f17d67ed0bae54079b8a52a92a8a336fa0723cd094` |
| Migrations | 94 in bundle, **none pending**; `migrate` was a no-op, so the permission-migration window of §4.5 did not open |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-aa724851-20261102-20261102T072611Z.dump` (36 546 976 B, sha256 `76942e68ba7206f29e413ce235ad0e50dfd1a61036efb1c0d017a1364fe6fbf6`) |
| Launcher / worker | `114f160d9c710c91` → `6bd4d3d70ac368b5` / `4624d37eac11f56d` → `9f77d899ca3db2a7` |
| Worker | KILL-restarted: pid 3135 → 7220 |
| Rollback target | `hcis-d7b2e580-20261101`; no migration ran, so a rollback needs no database decision |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 14:25 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-d7b2e580-20261101` running, 18 168 MB free, biometric OFF, database `sqcore_hcis`, no pending migrations. |
| 14:26 | upload, backup | Bundle checksum verified on the device; dump taken. |
| 14:26 | migrate | No-op; nothing pending. |
| 14:26 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 14:26–14:27 | cutover | New release running after about 28 s. |
| 14:27 | verify | Local and public checks PASS. Lock released. |

A first `--apply` attempt at 14:25 stopped on its first line, before any device contact, because it was started from a directory outside the git checkout (`git rev-parse` needs the checkout for the operator token). Run the script from the checkout.

**Running release, proved from the process, not from the repository or the workflow** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
7934 /usr/bin/node dist/server.js           | /data/local/ubuntu26/srv/hcis/releases/hcis-aa724851-20261102/apps/api
8321 /usr/bin/python3 spa_static_server.py  | /data/local/ubuntu26/srv/hcis/releases/hcis-aa724851-20261102/apps/web/dist
```

Public after the release: `https://hcis.sabilulquran.or.id/api/health` → `{"status":"ok"}`; deep link `/admin/documents?registerKind=DISCIPLINARY` → 200 shell; `/api/admin/documents/register?kind=DISCIPLINARY` without a session → 401 (the route answers and still demands a session); the served entry script `index-Dus5uVn9.js` contains the new revoke dialog text; `hub.sabilulquran.or.id` → 200.

The worker log shows `launch service=hcis attempt=1` and `launch service=hcis-web attempt=2` at 14:27:09–14:27:25, the expected relaunch pair seen at every cutover. The `attempt=2…5` lines at 12:52–12:55 WIB precede this release; they are the AUTH-014 switch incident recorded in OPS-MI8-REL-001 §5.4.

**Ten-minute watch (14:27–14:38 WIB):** no `launch service=hcis*` event after the cutover pair at 14:27:25. Both processes still run from `hcis-aa724851-20261102` with the same pids (7934 API, 8321 web), re-read at the end of the window, and the public `/api/health` still answers `{"status":"ok"}`.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator, and an authenticated revocation. Signing in needs a password, which this session never types (owner rule), and no account holds `document_corrector` yet (hr-documents.md §11 no. 5). The screen path was exercised before merge against a synthetic API (dialog, 409, paging, Back, 375 px), and the API behaviour by the Postgres suite in CI (`hr-documents.postgres.test.ts`, 20 tests).

## What changes for users

Human Capital's **Dokumen Kepegawaian** screen gets a register of warning letters next to the certificate register, with a **Batalkan** button and a dialog that requires a reason. Only an account holding the `document_corrector` role sees the button. That role is granted by the Super Admin. A read-only count on the production database after the release found 0 active `document_corrector` assignments and no issued letters at all (`hr_issued_documents` empty), so in practice nothing changes until the owner decides who holds the role. HCIS is not yet live to staff.

Not recorded here: `final.env` values, tokens, cookies or employee data.
