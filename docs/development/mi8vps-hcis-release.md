# Mi8VPS HCIS release flow (OPS-MI8-REL-001)

**Status:** ACTIVE — the scripts are dry-run by default. The first `--apply` release
(`hcis-3b670849-20261016`, main `3b67084`) was cut on 2026-10-16 with owner approval; evidence is in
`production-release-verification-2026-10-16.md`. Every later `--apply` run still needs explicit owner
approval and a dated verification note.
**Prepared:** 2026-10-15
**Supersedes for production:** `vps-deployment.md`, `github-vps-production-deployment.md`,
`.github/workflows/deploy-production.yml` (all old-VPS Docker/GHCR, now retired).
**Operational runbook of record:** Google Doc "Mi8VPS Platform Runbook". This file is the repository
specification for the HCIS part of it.

## 1. Context

The old paid VPS (Docker Compose, GHCR images, `scripts/deploy-vps.sh`) is terminated. HCIS
production runs on Mi8VPS: an Android phone with an Ubuntu chroot at `/data/local/ubuntu26`, no
Docker and no systemd. Observed read-only on 2026-10-15:

| Item | Value |
|---|---|
| Release root | `/srv/hcis/releases/hcis-<sha8>-<yyyymmdd>` (inside the chroot), owned by `sqhcis` (uid 989), read-only modes (`0550` dirs, `0440` files) |
| Current release | `hcis-1f482549-20261004` (main `1f48254`); `/srv/hcis/current` symlink points at it but nothing reads the symlink |
| Release layout | `package.json`, `package-lock.json`, `node_modules/` (production deps only), `apps/api/{package.json,dist,migrations}`, `apps/web/dist` |
| Runtime | `/usr/bin/node` v22.22.1, `/usr/bin/python3` 3.14, chroot arch `aarch64` |
| Secrets | `/srv/hcis/shared/final.env` (`root:sqhcis 0640`); never copied, printed or shipped |
| API | `hcis` service, `node dist/server.js`, `127.0.0.1:3301`, health `GET /health` |
| Web | `hcis-web` service, `/srv/hcis/shared/spa_static_server.py` on `127.0.0.1:3201` (see `mi8vps-hcis-web-spa-fallback.md`) |
| Edge | `/srv/sq-hub/shared/directory-proxy.mjs` on 3180 → Cloudflare Tunnel; unchanged by releases |
| Database | Termux PostgreSQL on `127.0.0.1:5432`, database `sqcore_hcis` (from `DATABASE_URL`, ~330 MB); `pg_dump`/`psql` run as the Termux user over the local socket |
| Launcher | `/data/local/mi8vps/sq-core-launch.sh` — the `hcis` and `hcis-web` entries hardcode the release path in `workdir` and `command` (4 lines) |
| Supervisor | `/data/local/mi8vps/sq-core-worker.sh` — a long-running loop; `service_pid` hardcodes the release path for `hcis` and `hcis-web` (2 lines) and finds a process by `cwd` prefix |
| Control | `/data/local/mi8vps/sq-corectl.sh restart <svc>` sends TERM to the PID in `sq-core-pids/<svc>.pid`; the worker relaunches through the launcher within its 15 s loop |
| Migrations | Not run at API start on Mi8 (the Docker image ran `migrate.js` first; the launcher does not) |
| Access | `ssh mi8vps` (Ubuntu, non-root, Tailscale) and `ssh mi8vps-root` (Android root). GitHub-hosted runners cannot reach the device |

Two consequences drive the design:

1. **GitHub Actions cannot deploy.** The device is reachable only from the operator's machine. CI
   builds the release bundle; an operator runs the release from a workstation.
2. **The worker keeps the old `service_pid` patterns in memory.** Editing `sq-core-worker.sh` does
   not change the running loop. Unless the worker is restarted, it cannot find the new process when
   it becomes unhealthy and would launch a second copy that fails to bind. The worker must be
   restarted after its file changes. Stop it with **KILL**, not TERM: see §4.7 step 4.

## 2. Actors and permissions

| Actor | May do |
|---|---|
| Owner | Approves each production release (SHA, window, whether migrations are pending) |
| Operator (workstation with `ssh mi8vps`/`mi8vps-root`) | Runs `scripts/mi8/release-mi8.sh`; `--apply` only after owner approval |
| GitHub Actions | Builds and checksums the bundle (`build-mi8-release.yml`). No SSH, no secrets, no production access |
| `sqhcis` (uid 989) | Owns release files; runs API, web, candidates and migrations |
| root on Mi8 | Installs releases, edits launcher/worker, restarts services, takes database backups |

## 3. Preconditions

- Target is the exact current `origin/main` SHA and PR validation is green for it.
- The bundle came from `build-mi8-release.yml` for that SHA (or `scripts/mi8/build-release.sh` on
  an arm64/Docker host) and its `RELEASE.json` names the same SHA.
- Owner approval for the release, including the migration list printed by `preflight`.
- `sq-core-launch.sh` and `sq-core-worker.sh` reference exactly one HCIS release — the one the
  running `hcis` process uses — on exactly 4 and 2 lines. Anything else is drift: stop.
- `BIOMETRIC_COLLECTION_ENABLED` in `final.env` is absent or `0`.
- Ports 3391 (candidate API) and 3291 (candidate web) are free; at least 1 GiB free on `/data`.
- **One release operator per window.** No other operator is changing Mi8 (any SQ Core app, the
  launcher, the worker, or `start-services.sh`). Before `--apply`, announce the release (app,
  SHA, window, session) in the shared operator notes. The script enforces this with the
  device-wide release lock (§4.10); the announcement covers releases of other apps whose
  tooling does not take the lock yet.
- Pending migrations are additive/backward compatible with the running release (the old release
  runs on the new schema between `migrate` and `cutover`, and again after a rollback). A
  non-additive migration needs its own reviewed recovery plan before this flow is used.

## 4. Flow

```text
build (CI, linux/arm64) → preflight → upload → backup → migrate → candidate → cutover → verify
                                                                      └─ on failure: rollback
```

`scripts/mi8/release-mi8.sh <phase> --bundle <tar.gz> --sha <40-hex> [--apply --confirm RELEASE_<sha8>]`.
Without `--apply` every phase is a dry run: read-only checks still run against the device and
each mutating command is printed, not executed. `all` runs the phases in order and stops at the
first failure.

### 4.1 build (off-device)

`.github/workflows/build-mi8-release.yml` (manual dispatch, `target_sha` must equal `origin/main`):

1. checks out the exact SHA; runs `npm ci`, `npm run build:api`, `npm run build:web` on the amd64
   runner (TypeScript/Vite output is architecture-independent);
2. installs production `node_modules` inside `node:22.22.1-bookworm` with `--platform linux/arm64`
   (QEMU), matching the device's Node 22 and aarch64;
3. refuses the bundle if any native `*.node` addon is present (the current dependency set is pure
   JavaScript; a native addon needs an explicit review of its ABI against the chroot);
4. writes `RELEASE.json` (sha, release name, build time, node/npm versions, platform, migration
   files) and packs `hcis-<sha8>-<yyyymmdd>.tar.gz` plus `.sha256`;
5. uploads both as a workflow artifact (30-day retention). It never contacts production, so a green
   run means only "bundle built".

The release date is the UTC build date. The operator downloads the artifact with
`gh run download <run-id> -n hcis-mi8-<sha8>`.

### 4.2 preflight (read-only)

Local: SHA format, `origin/main` equality, bundle checksum, `RELEASE.json` sha and name.
Remote: the running `hcis` process's release (from its `cwd`), that the launcher and worker
reference only that release on 4 and 2 lines, the target release directory does not exist yet,
free space, candidate ports free, biometric gate, the database name in `DATABASE_URL` equals the
configured one, and the list of **pending migrations** (bundle files not in `schema_migrations`).
It stops first if another operator holds the release lock (§4.10).

### 4.3 upload

`scp` the bundle to `mi8vps:/tmp/`, then as root: verify sha256, extract into
`releases/<name>.partial`, check `RELEASE.json`, `chown -R 989:989`, set read-only modes, rename to
`releases/<name>`. Refuses to overwrite an existing release directory. Upload does not affect the
running services.

### 4.4 backup (always, before migrate)

`pg_dump -Fc` of the HCIS database as the Termux user, copied to
`/srv/hcis/backups/pre-release/<name>-<stamp>.dump` (`root:root 0600`) with a `.sha256` file, then
`pg_restore --list` to prove the archive is readable. A marker records the dump for the release;
`migrate` refuses to run without a marker younger than 6 hours. The daily production set from
OPS-MI8-BAK-001 (19 UTC, 14 sets plus an encrypted off-host copy) is not relied on for a release:
the release backup must be taken right before migrations and kept outside the daily rotation.

### 4.5 migrate

If `preflight` found pending migrations, runs `node dist/db/migrate.js` from the **new** release
as `sqhcis` with `final.env`, then re-lists `schema_migrations`. Each migration file runs in its own
transaction (`apps/api/src/db/migrate.ts`); a failure stops the flow with the earlier files
committed. With nothing pending the phase is a no-op.

**Permission migrations open a window.** `migrate` runs before `cutover`, so between the two the
*old* build is still serving while the database already carries the new rows. A migration that adds
a permission key to an existing role is visible to that old build as a role holding a permission its
`HCIS_PERMISSIONS` allowlist does not contain, and `canDelegateRole` then refuses to grant or revoke
that role until cutover finishes. Observed on the `hcis-fcec4e6a-20261027` release for
`human_capital_admin` (DOC-001/DOC-002 §3 D-17); it lasted only as long as the gate plus cutover.

Nothing is lost and no authorization widens, but a permission migration should either be released on
its own, or split so that the build which knows the key ships one release before the grant. Adding a
*new* permission key without attaching it to a role does not open this window.

### 4.6 candidate gate

Starts the new release next to production, as `sqhcis`:

- API on `127.0.0.1:3391` (`final.env` with `PORT=3391`): `/health` and `/ready` must return 200
  within 90 s. The candidate starts with `MEETING_RUNNER_ENABLED=0`, so the CAL-001 reminder and
  WhatsApp runner (the API's only background timer) never runs in it; a candidate serves only gate requests.
- Web on `127.0.0.1:3291` with `spa_static_server.py`: `/` and `/login` 200 with `no-store`, the
  hashed entry script from `index.html` 200 with `immutable`, `/assets/does-not-exist.js` 404.

Both candidates are stopped and the ports must be closed again before the phase passes.
Logs go to `/srv/hcis/logs/candidate-<name>.log`.

### 4.7 cutover (HCIS API + web interruption, typically 15–45 s)

1. Back up `sq-core-launch.sh` and `sq-core-worker.sh` to `*.pre-<name>` (`cp -p`).
2. Generate new files by replacing the previous release name with the new one **only** in lines
   containing `/srv/hcis/releases/`. Check with `diff` that exactly 4 launcher lines and 2 worker
   lines changed, that the new files contain no other HCIS release, `sh -n` both, then install them
   atomically (`mv` of a new file, so the running worker keeps its open copy intact).
3. Point `/srv/hcis/current` at the new release (bookkeeping; the backup set records it).
4. Restart the worker: send **KILL** to the PID in `sq-core-worker.pid`, wait for it to exit, and
   start `setsid nohup /system/bin/sh sq-core-worker.sh`. Services keep running, and the new worker
   finds them healthy.
   **Do not use TERM** (OPS-MI8-SUP-001, `sq-core-ops/runbooks/ops-mi8-sup-001-worker-restart-isolation.md`).
   A worker started with `setsid` leads its own process group. When Android mksh leads a group and
   dies from an untrapped TERM, it runs `kill(0, TERM)`. That stops every service the worker
   launched into its group. On 2026-10-16 this caused 1–2.5 minute outages of HCIS, HCIS web, Hub
   web and Aset web. Keycloak is in that group now too, and it takes about 6 minutes to start. KILL
   runs no shell code, so nothing reaches the group. An earlier version of this step said TERM
   leaves the services running. That was true only while the worker was not a group leader.
5. `sq-corectl.sh restart hcis` and `sq-corectl.sh restart hcis-web`. The worker finds them
   unhealthy, cannot find a process under the new path, and launches the new release.
6. Wait up to 180 s for `:3301/health` and `:3201/` and for both processes' `cwd` to be inside the
   new release.

If step 6 fails, run `rollback`.

### 4.8 verify

Local: `:3301/health`, `:3301/ready`, `:3201/` no-store, process `cwd` inside the new release,
one `launch service=hcis*` per restart in `sq-core-worker.log`. Public
(`https://hcis.sabilulquran.or.id`): `/api/health` → `{"status":"ok"}`, `/login` 200 shell,
`/assets/does-not-exist.js` 404. Then a 10-minute watch of `sq-corectl.sh status` with no repeated
launches, and a browser login + deep-link refresh by the operator. Hub and Aset are not restarted;
confirm `hub.sabilulquran.or.id` and `aset` still answer, since Hub's worker gate depends on HCIS.

### 4.9 rollback (application only, ≤ 2 minutes)

`release-mi8.sh rollback --sha <target> --bundle <tar.gz>` restores `*.pre-<name>` launcher and
worker files, points `current` back, restarts the worker and `hcis`/`hcis-web`, and checks that the
processes run from the previous release. The previous release directory is never modified, so it is
always available. **The database is not rolled back.** Restoring the pre-release dump is a
separate owner decision (it discards data written since the backup) and follows the Mi8VPS
runbook's PostgreSQL restore procedure.

### 4.10 release lock (one operator at a time)

Added after 2026-10-16, when two sessions released `hcis-6066d5b0-20261016` in the same minute
and, earlier that day, a Hub/Aset web release restarted the worker during HCIS work. Neither
caused data loss, but two operators editing the same launcher/worker files is unsafe.

| Item | Behaviour |
|---|---|
| Lock | Directory `/data/local/mi8vps/sq-core-release.lock` with an `owner` file (`app`, `release`, `token`, `operator`, `started`). `mkdir` is atomic, so when two operators race, exactly one gets it. |
| Token | Random, stored per checkout in `$(git rev-parse --git-dir)/mi8-release-operator`. Two sessions on one workstation use different worktrees and therefore different tokens. |
| Acquire | Every `--apply` phase that changes the device (`upload`, `backup`, `migrate`, `candidate`, `cutover`, `rollback`, and `all` right after preflight) takes the lock, or continues if it already holds it. |
| Check | `preflight` (also in dry run) stops with the holder's app, release, operator and age when someone else holds the lock. |
| Release | After `verify` passes, and after a successful `rollback`. `unlock` releases a lock this checkout holds (for example after a release abandoned before verify). |
| Stale lock | A lock older than 6 h (`MI8_LOCK_STALE_SECONDS`) is reported as stale but still stops the run. Remove it by hand only after confirming that nobody is releasing: `rm -f /data/local/mi8vps/sq-core-release.lock/owner && rmdir /data/local/mi8vps/sq-core-release.lock`. |
| Test | `sh scripts/mi8/test-release-lock.sh` (offline; never contacts the device). |

Follow-up (`TBD`, outside this repository): the Hub/Aset release tooling (`sq-core-ops`) must take
and honour the same lock. Until it does, the announcement rule in §3 is the only guard for
cross-app releases.

## 5. Traps in any Android-side script (OPS-MI8-REL-001 §5)

Found on 2026-11-01 and 2026-11-02, in review and first runs of the AUTH-014 ignition scripts.
None is specific to those scripts: any script that runs on the Android side and touches a
chrooted service meets them. Expect this list to grow; the chroot boundary is the common cause,
and each entry below is a different way of getting the wrong side of it.

### 5.1 There is no `/tmp` on the Android side

`/tmp` exists only inside the chroot (`/data/local/ubuntu26/tmp`). On Android, `ls -d /tmp` answers
`No such file or directory`.

This bites in a way that reads as a different problem entirely. A line such as

```sh
chroot "$R" /usr/bin/wc -c < /tmp/secret.file     # WRONG
```

looks like it reads a file inside the chroot, but **the redirection is performed by the calling
shell, before `chroot` runs**, so it opens `/tmp/secret.file` on the *Android* side and fails. The
script then reports whatever its guard says for an empty read — in the case found, "secret could
not be read from Keycloak", which sends the operator to look at Keycloak for a fault that is in the
script.

Rule: keep two names for every shared temporary file, the chroot path and the Android path
(`$R$chroot_path`), and use the Android one for every redirection, `cp`, `chmod` and `ls` that the
Android shell performs. Pass the chroot path only to commands that actually run inside the chroot.

### 5.2 `sq-corectl.sh restart` does not wait, and the old process still answers

`restart` is one line: `kill -TERM` to the pid in `sq-core-pids/<svc>.pid`. It returns immediately.
The worker relaunches the service within its 15 s loop.

So a script that restarts a service and then polls `/health` can be answered **by the process it
just asked to stop**, which is still listening while it shuts down. The poll passes, the script
reports success, and the service has not yet read the configuration the script just wrote. A
configuration change verified this way is not verified at all — and the failure is silent, because
everything it printed was true.

Rule: wait for the **pid to change** in `sq-core-pids/<svc>.pid`, and only then poll `/health`.
Apply the same waiting function to the automatic rollback path, which has exactly the same race.

### 5.3 `chroot ... /bin/sh -c` keeps the Android `PATH`

A shell started inside the chroot inherits the caller's environment, and the Android `PATH` names
only Android directories:

```text
/sbin:/system/sbin:/product/bin:/apex/com.android.runtime/bin:/system/bin:/system/xbin:...
```

None of them exists inside the chroot, so `grep`, `cat`, `sed` and every other GNU tool are not
found. Observed 2026-11-02, when a release-adjacent script stopped with
`/bin/sh: 3: grep: not found` in the middle of rewriting a configuration file.

```sh
chroot "$R" /bin/sh -c 'grep -v "^KEY" file > new'                      # WRONG
chroot "$R" /bin/sh -c 'PATH=/usr/bin:/bin; export PATH; grep -v ...'   # right
```

What makes this one hard to see is that a script usually gets it right *somewhere*. The script in
question already wrapped `kcadm` in `/usr/bin/env PATH=...` — the same fix, two screens higher —
so the author had already met the problem and solved it without noticing it was general. Set
`PATH` in **every** chroot invocation, not only the ones that failed loudly the first time.

This trap is why §5.1 is worth stating separately: the two look alike (both are about which side
of the chroot boundary a thing is resolved on) but fail in opposite directions. §5.1 resolves a
path too early, on the Android side; this one resolves a command too late, with the wrong
environment. Fixing one does nothing for the other.

### 5.4 An environment switch is a configuration change; validate it before restarting

Setting one key is rarely setting one key. `HCIS_ROLE_ADMIN_ENABLED=1` makes four other keys
mandatory (`apps/api/src/config/env.ts`), and the API refuses to start without them. Observed
2026-11-02 05:52 UTC: the switch was flipped alone, HCIS would not come up, and automatic rollback
restored the file — about 2.5 minutes of downtime for something a check would have caught in a
second.

The fix is not a list of which keys go together; that list grows. Before restarting anything,
load the proposed environment through the **running release's own** `loadConfig()`:

```sh
runuser -u <svc-user> -- /bin/sh -c 'set -a; . /path/to/candidate.env; set +a;   cd <release>/apps/api && node -e "require(\"./dist/config/env.js\").loadConfig(process.env)"'
```

It touches no service, costs nothing, and answers exactly the question the restart would have
answered expensively. Treat a configuration edit the way §4.6 treats a new build: gate it before
it reaches production, not by watching production react to it.

### 5.5 Proving a service actually loaded a value

Neither the file nor a healthy `/health` proves the running process read it. `/proc/<pid>/environ`
of the service's own `node` process does, and it can be read without printing any value:

```sh
tr '\0' '\n' < /proc/<node-pid>/environ | grep -cE '^(KEY_A|KEY_B|KEY_C)='
```

Count only. For a secret, the count is the evidence and the value never leaves the device; for a
switch such as `HCIS_ROLE_ADMIN_ENABLED=1`, the whole assignment is safe to print and is the only
proof of the switch obtainable without logging in.

## 6. Retention

Keep the current release and at least the previous one. Older release directories (~135 MB each)
may be deleted by hand once the new release has run for 7 days without rollback. Keep
`pre-release` dumps for 30 days. The `.pre-<name>` launcher/worker copies stay as audit evidence.

## 7. Failure behaviour

| Phase | On failure | Production impact |
|---|---|---|
| preflight | stop (including "another operator holds the release lock") | none |
| upload | remove `<name>.partial`; stop | none |
| backup | stop; no migration | none |
| migrate | stop; old release keeps running on the partly migrated schema; decide restore vs fix-forward | depends on migration |
| candidate | stop candidates; stop | none |
| cutover | `rollback` | HCIS down until rollback (≤ 2 min) |
| verify | `rollback` unless the owner accepts | as observed |

## 8. Audit and evidence

Each `--apply` run writes a local log `mi8-release-<name>-<stamp>.log` (in the current directory,
not committed). Record in a dated note under `docs/development/` (as with
`production-release-verification-*.md`): SHA, release name, bundle sha256, workflow run id,
migration names applied, backup path and sha256, launcher/worker before/after sha256, timestamps,
health results. Never record `final.env` values, tokens, cookies or employee data.

## 9. Known limits and follow-ups

- Resolved 2026-10-15/16 by OPS-MI8-BAK-001 (`mi8vps-sq-core-production-backup-plan.md`):
  `sqcore_hcis` and the other SQ Core production databases are backed up daily at 19 UTC (02:00 WIB)
  with an encrypted Google Drive copy and a weekly restore check. Releases must not run during the
  19 UTC hour; `preflight` and `cutover` refuse it.
- First `--apply` run findings (fixed in the script): the remote `PATH` lacked the chroot's
  `/usr/bin`, so chroot `tar` could not exec `gzip`; and chroot GNU `tar` fails on the Android kernel
  with "Function not implemented", so extraction now uses Python `tarfile` with the `data` filter.

- A one-time change could make the launcher and worker read `/srv/hcis/current` (launcher `cd`
  through the symlink, worker pattern from `readlink`), so a release would flip a symlink instead of
  editing two root scripts. That is an owner-approved supervisor change of its own; until then this
  flow edits the paths.
- `sq-core-logrotate.sh` moves logs while the process keeps writing to the moved file (see the SPA
  fallback note). Restarting `hcis` during cutover reopens `api.log`, which temporarily hides this.
- `activate-mobile-attendance.yml` and `uat-account-hygiene.yml` still SSH to the terminated VPS.
  They fail at SSH rather than reporting success, but need their own Mi8 replacement or retirement.
- `publish-staging-images.yml` still publishes amd64 GHCR images on every `main` push. Nothing
  consumes them on Mi8.
- `migrate` runs before `cutover`, so a migration that grants a new permission key to an existing
  role briefly blocks role assignment for that role in the old build (§4.5). A durable fix would
  derive the role-assignment allowlist from the `permissions` table instead of a compiled constant;
  that is an AUTH-011 change of its own.
