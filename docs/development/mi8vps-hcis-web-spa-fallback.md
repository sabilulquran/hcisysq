# Mi8VPS — HCIS web SPA fallback (change plan)

**Status:** APPLIED on production 2026-10-15 15:30 WIB (owner-approved).
**Prepared:** 2026-10-15

## Applied evidence (2026-10-15)

- Script installed at `/srv/hcis/shared/spa_static_server.py` (root:root 0644), sha256 `319b9a1a49629d72b1580317a28b3ec98aa24cba49c439d0e1da20f54b089395`, matching the repo file.
- Candidate gate on 127.0.0.1:3291 as `sqhcis`: all checks passed; candidate stopped and port closed.
- Launcher backup: `/data/local/mi8vps/sq-core-launch.sh.pre-spa-20261015` (sha256 `e9ee042c…d728`). New launcher sha256 `94c556e8…90e2`, one-line diff in `hcis-web` only; Hub/Aset lines unchanged.
- `sq-corectl.sh restart hcis-web` at 15:29:59. The worker relaunched it at 15:30:06; `/login` returned 200 after 9 s. The new process runs as uid 989 (`sqhcis`) with the same cwd.
- Public: `/`, `/login`, `/admin/attendance/devices` → 200 SPA shell with `no-store`; `/assets/does-not-exist.js` → 404; `/assets/` no listing; `/api/health` ok; `/auth/callback` → API 302; hub/aset/login unaffected. Browser deep link loads the app.
- Hashed assets leave Mi8 with `public, max-age=604800, immutable`, but Cloudflare rewrites browser caching to `max-age=14400` (zone Browser Cache TTL). That is harmless for hashed assets; changing it is a separate Cloudflare decision.
- 10-minute watch: exactly one `launch service=hcis-web`, the PID did not change, and no errors in `web.log`.
**Scope:** HCIS web static listener only (`hcis-web`, 127.0.0.1:3201). API, edge proxy, Hub, Aset, Keycloak, and other workloads stay untouched.

## Context

Production HCIS runs on Mi8VPS (the old paid VPS has been terminated). The SQ Core launcher
`/data/local/mi8vps/sq-core-launch.sh` starts HCIS web as:

```text
cd /srv/hcis/releases/hcis-1f482549-20261004/apps/web/dist; exec /usr/bin/python3 -m http.server 3201 --bind 127.0.0.1
```

`python3 -m http.server` only serves files that exist. Compared with the accepted
`apps/web/nginx.conf` contract, this causes:

| Issue | Observed on 2026-10-15 |
|---|---|
| SPA deep links fail | `https://hcis.sabilulquran.or.id/login` and `/admin/attendance/devices` return 404 "Error response" (refresh, bookmarks, notification links) |
| Directory listing exposed | `https://hcis.sabilulquran.or.id/assets/` returns "Directory listing for /assets/" |
| Cache policy missing | `index.html` has no `no-store`, so browsers may keep an old shell after a release; hashed assets have no `immutable` header |

The edge proxy (`/srv/sq-hub/shared/directory-proxy.mjs`, 127.0.0.1:3180) already sends
`/api/*`, `/auth/callback`, and `/internal/v1/organization-directory/*` to the API on 3301, and
everything else to 3201. It does not need to change.

## Change

Replace only the `hcis-web` command with `apps/web/deploy/mi8/spa_static_server.py`
(Python 3 stdlib, `ThreadingHTTPServer`). It reproduces the static part of `nginx.conf`:

- `/healthz` → `ok`;
- existing files → served; `.js .css .png .jpg .jpeg .gif .svg .webp .ico .woff .woff2` get `Cache-Control: public, max-age=604800, immutable`;
- missing asset-type files → 404;
- every other path → `index.html` with `Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`, `Expires: 0`;
- no directory listings; GET/HEAD only.

The process stays `python3` with cwd `.../apps/web/dist`, so the SQ Core worker's
`service_pid` detection and its `GET /` → 200 health check are unchanged. No supervisor, boot,
port, tunnel, or database change, so a reboot acceptance is not required.

Verified locally against a fresh `apps/web/dist` build: `/`, `/login`,
`/admin/attendance/devices?x=1` → 200 shell with no-store; hashed JS → 200 immutable;
`/assets/missing.js` → 404; `/assets/` → shell (no listing); `/../../etc/passwd` → shell;
`HEAD` → 200; `POST` → 501.

## Rollout (owner-approved window; expected HCIS web interruption ≤ 60 s, API unaffected)

Root steps run through `ssh mi8vps-root`. `R=/data/local/ubuntu26`, `S=/data/local/mi8vps`.

1. **Upload the script** (non-root):
   `scp apps/web/deploy/mi8/spa_static_server.py mi8vps:/tmp/spa_static_server.py`
2. **Install the script outside the release** (root):
   `install -o root -g root -m 0644 $R/tmp/spa_static_server.py $R/srv/hcis/shared/spa_static_server.py`
   and record `sha256sum` of the installed file.
3. **Candidate gate on a spare port** (root, port 3291 is unused):
   start `chroot $R /usr/sbin/runuser -u sqhcis -- /bin/sh -c 'cd /srv/hcis/releases/hcis-1f482549-20261004/apps/web/dist; exec /usr/bin/python3 /srv/hcis/shared/spa_static_server.py --bind 127.0.0.1 --port 3291'`
   in the background, run the verification checks below against 3291, then stop it.
   Stop here if any check fails.
4. **Back up the launcher**: `cp -p $S/sq-core-launch.sh $S/sq-core-launch.sh.pre-spa-20261015`.
5. **Edit only the `hcis-web` command** in `$S/sq-core-launch.sh` to:
   `cd /srv/hcis/releases/hcis-1f482549-20261004/apps/web/dist; exec /usr/bin/python3 /srv/hcis/shared/spa_static_server.py --bind 127.0.0.1 --port 3201`
   Confirm with `diff $S/sq-core-launch.sh.pre-spa-20261015 $S/sq-core-launch.sh` that exactly one line changed, and `sh -n $S/sq-core-launch.sh`.
6. **Restart hcis-web only**: `$S/sq-corectl.sh restart hcis-web`. The worker detects that
   `GET /` is no longer 200 and relaunches it through the launcher within its 15 s loop and backoff.
7. **Verify** (below), then watch `$S/sq-corectl.sh status` for 10 minutes: one
   `launch service=hcis-web` line and no repeated launches.

### Verification checks

Local (`curl` inside the chroot on 127.0.0.1:3201) and public (`https://hcis.sabilulquran.or.id`):

| Request | Expected |
|---|---|
| `/` | 200, `Cache-Control: no-store…` |
| `/login`, `/admin/attendance/devices` | 200, same shell, no-store |
| current `/assets/index-*.js` | 200, `immutable` |
| `/assets/does-not-exist.js` | 404 |
| `/assets/` | no "Directory listing" |
| `/api/health` (public) | `{"status":"ok"}` (API path unchanged) |
| `/auth/callback` route | still reaches the API (no change to edge) |
| Browser: log in, open a deep link, refresh | page loads |

## Rollback (≤ 2 minutes)

1. `cp -p $S/sq-core-launch.sh.pre-spa-20261015 $S/sq-core-launch.sh`
2. `$S/sq-corectl.sh restart hcis-web` — the worker relaunches `python3 -m http.server 3201`.
3. Check that `curl http://127.0.0.1:3201/` returns 200 and the public `/` loads.

`/srv/hcis/shared/spa_static_server.py` can stay in place; nothing uses it after rollback.
No data, database, or configuration secrets are involved.

## Follow-ups (not in this change)

- Hub (3202) and Aset (3203) use the same `python3 -m http.server`; `https://hub.sabilulquran.or.id/login` also returns 404. They need their own owner-approved change.
- `sq-core-logrotate.sh` uses `mv` while the process keeps its file descriptor open, so HCIS has kept writing to `api.log.1` (137 MB on 2026-10-15) and rotation never triggers again. Needs copy-truncate or a reopen signal.
- The next HCIS release must point both the `hcis` and `hcis-web` launcher entries and the worker `service_pid` patterns at the new release path. `deploy-production.yml` still targets the terminated VPS through Docker/GHCR and must be replaced with a Mi8 release flow.
- Update the Mi8VPS runbook (Google Doc) after the change is applied.
