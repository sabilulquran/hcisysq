# Production release verification — hcis-78eadd09-20261102 (OPS-MI8-REL-001)

**Date:** 2026-11-02 (08:40–08:54 UTC, 15:40–15:54 WIB)
**Operator:** CAL-001 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). Announced beforehand in the shared operator notes. The sessions with open HCIS PRs (#270, #272, #273) were asked not to merge during the window. The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `78eadd096ba66b4e46401cc124f311714364f010` (`origin/main`, merge of #271) |
| Previous release | `hcis-0fbc2133-20261102` |
| Adds since `hcis-0fbc2133-20261102` | CAL-001 Package 1, meeting calendar and invitations (#271); documentation only #266–#270 |
| Build | run [41414448216](https://github.com/sabilulquran/hcisysq/actions/runs/41414448216), bundle `hcis-78eadd09-20261102.tar.gz` sha256 `8403e0577071ea26158b670d386465a1863082221cfc8882eb851a8c536305f0` |
| Migrations | 97 in bundle; **one pending, `0117_meeting_calendar.sql`** (five new tables, additive, no permission and no role change, so the permission window of §4.5 did not open) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-78eadd09-20261102-20261102T084146Z.dump` (36 580 192 B, sha256 `50ad91c31e12c7c902af3264a92df850ffeb63b645925cbab3b52f07d14494a1`) |
| Launcher / worker | `c781fff412d4c604` → `2b6ad53b3d66bd60` / `bb60c3ee809274db` → `56ad106f462f1516` |
| Worker | KILL-restarted: pid 18219 → 24394 |
| Rollback target | `hcis-0fbc2133-20261102`. Code rollback is safe: the old release does not read the five new tables. Dropping them (the `-- Down:` in 0117) is a separate decision and is not needed for a rollback. |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 15:40 | preflight (dry run, then again under `--apply`) | PASS. Lock free, `hcis-0fbc2133-20261102` running, 17 490 MB free, biometric OFF, database `sqcore_hcis`, one pending migration (0117). |
| 15:41 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 15:42 | migrate | `applied 0117_meeting_calendar.sql`. |
| 15:42 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. The candidate API ran with `MEETING_RUNNER_ENABLED=0` (#271), so the new reminder runner never ran in it. |
| 15:42–15:43 | cutover | New release running after about 28 s. |
| 15:43 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process** (walking `/proc/*/cwd` on the device after verify, independently of the release script):

```text
25252 /usr/bin/node dist/server.js           | /data/local/ubuntu26/srv/hcis/releases/hcis-78eadd09-20261102/apps/api
25725 /usr/bin/python3 spa_static_server.py  | /data/local/ubuntu26/srv/hcis/releases/hcis-78eadd09-20261102/apps/web/dist
```

Public after the release: `https://hcis.sabilulquran.or.id/api/health` → `{"status":"ok"}`; deep link `/app/calendar` → 200 shell; `/api/me/calendar?from=2026-11-01&to=2026-11-30` without a session → 401 (the new route answers and demands a session).

**WhatsApp stays a dry run.** `final.env` has none of `WHATSAPP_ADAPTER`, `KIRIM_BASE_URL`, `KIRIM_CLIENT_ID`, `KIRIM_CLIENT_SECRET` (checked by key name only), so the API uses the `log` adapter. It sends nothing and records `DRY_RUN`. Switching to `kirim` needs the HCIS number paired in Kirim SQ and the client credentials installed by the operator (meeting-calendar.md §15). The reminder runner (`MEETING_RUNNER_ENABLED` absent → on) runs inside the API process. `api.log` shows no `meeting runner tick failed` and no error-level line since the cutover.

**Ten-minute watch (15:43–15:53 WIB):** no `launch service=hcis*` event after the cutover pair (15:42:51 `hcis`, 15:43:07 `hcis-web`). Both processes still ran from `hcis-78eadd09-20261102` with the same pids (25252 API, 25725 web) at 15:53:02, and `api.log` had no `meeting runner tick failed`.

## The release that followed

At 15:53:36 WIB the TRAIN-001 session released `hcis-2a6ddce3-20261102` (#273, migrations 0118 and 0119) through the same release lock, which was free after this release's verify. That produced the next expected cutover pair (15:53:36 `hcis`, 15:53:52 `hcis-web`) and one public `/api/health` 502 during the switch, sampled at about 15:53:30; it answered 200 three times at 15:53:43–15:53:53. `2a6ddce3` contains the CAL-001 merge `78eadd09`, so production keeps CAL-001 and migration 0117. The rollback target for CAL-001 code is now `hcis-0fbc2133-20261102`, behind the TRAIN-001 release; any rollback has to be decided together with that session's verification note.

**Not done:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The screens were exercised before merge against a local API and a real PostgreSQL 16 with synthetic employees. That run covered the month grid, creating a meeting, the red conflict panel, answering Hadir as the invitee, the 375 px layout and the not-found state; the runner handed both invitations over as `DRY_RUN` with masked numbers. The API behaviour is covered by `meetings.postgres.test.ts` in CI (17 tests, including two simultaneous invitations and two simultaneous runners).

## What changes for users

Every employee gets a **Kalender** menu: a month calendar showing every foundation meeting (confidential ones as "Sibuk"), their own leave and business trips, and non-working days. Any employee can invite colleagues to a meeting. HCIS refuses the invitation when a participant or the organizer is already in another meeting, on approved leave, or on an approved or issued business trip, and names who is busy and when. Participants answer Hadir or Berhalangan; the organizer can edit or cancel. In-app notifications and the 30-minute reminder work now. WhatsApp messages are only recorded (dry run). HCIS is not yet live to staff, so in practice nothing reaches employees until accounts are activated.

Not recorded here: `final.env` values, tokens, cookies or employee data.
