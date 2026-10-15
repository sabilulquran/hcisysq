# Mi8VPS Keycloak readiness restarts (OPS-MI8-KC-001)

**Spec ID:** OPS-MI8-KC-001
**Status:** PLAN, awaiting owner approval. Nothing on production has been changed.
**Prepared:** 2026-10-16 (read-only investigation over `ssh mi8vps-root`)
**Related:** OPS-MI8-REL-001 (`mi8vps-hcis-release.md`, the worker/launcher path rules), OPS-MI8-BAK-001
(`mi8vps-sq-core-production-backup-plan.md`, backup before the change)
**Scope:** Keycloak (Akun SQ, `login.sabilulquran.or.id`) for HCIS, SQ Hub and Aset, plus the readiness rule in
`/data/local/mi8vps/sq-core-worker.sh`. Auth change, so it needs extra review and explicit owner approval.

## 1. Symptom

On 9, 14 and 15 Oct 2026 the SQ Core worker restarted Keycloak 3 to 6 times a day, in bursts
(13:44–15:48 WIB on 9 Oct; 21:31–22:31 on 14 Oct; 20:54–21:28 on 15 Oct). Each burst starts right
after this Keycloak warning:

```
WARN [org.keycloak.infinispan.health.impl.JdbcPingClusterHealthImpl] Unable to check the cluster health because no coordinator has been found.
```

Shutdowns are graceful (`Keycloak stopped in 1.3–2.7s`), except one TERM timeout and KILL at
2026-10-14 21:36:49. No JVM OOM was found.

## 2. Observed configuration (2026-10-16)

| Item | Value |
|---|---|
| Release | `/srv/keycloak/releases/keycloak-26.7.2-3a2238fc-20261004` (read-only; `current` symlink points at it) |
| Start | `shared/start-final.sh` → `kc.sh start --optimized`, env from `shared/final.env` |
| Persisted build options | `kc.db=postgres`, `kc.health-enabled=true`, `kc.metrics-enabled=true`, provider `sq-trusted-device.jar`. `kc.cache` not set, so the build uses the default `ispn` |
| Runtime cache env | `KC_CACHE=ispn`, `KC_CACHE_EMBEDDED_NETWORK_BIND_ADDRESS=127.0.0.1`, `..._PORT=7800` |
| JGroups | stack `jdbc-ping`, single member, table `jgroups_ping` in database `sqcore_keycloak` (one row, `coord=t`, timestamp refreshed) |
| Readiness | `GET 127.0.0.1:9000/health/ready` includes the check **"Keycloak cluster health check"** |
| JVM | RSS about 490 MB, swap about 38 MB |
| Host | 3.7 GB RAM; MemAvailable was 1.07 GB at the time of the check (lower values were reported earlier); 2.3 GB swap, 0.87 GB used |

## 3. Root cause

Three facts together cause the restarts.

### 3.1 The warning makes readiness fail (confirmed from the 26.7.2 bytecode)

`JdbcPingClusterHealthImpl.checkHealth()` calls `KEYCLOAK_JDBC_PING2.healthStatus()`, which reads the
`jgroups_ping` rows for the cluster and looks for a row with `coord=true` that matches the local view.
If no such row exists, it logs the warning above and sets the cluster health to **unhealthy**.
That makes `/health/ready` return non-200 while Keycloak goes on serving logins normally.
`KEYCLOAK_JDBC_PING2` also deletes stale rows (`removeStaleEntries`, `getStalenessCutoff`) by
wall-clock timestamp, and its info writer refreshes the row on a timer.

With `cache=local` the same class logs `Cluster health check disabled. Local mode` and the check
does not run at all.

### 3.2 The worker kills on the first failed probe, not after 90 s of failure (confirmed from the script)

```sh
ensure() {
  if ready "$svc"; then return 0; fi
  ...
  existing=$(service_pid "$svc" || true)
  if [ -n "$existing" ]; then
    age=$(( now - mtime(/proc/$existing) ))
    if [ "$age" -lt 90 ]; then return 1; fi
    stop_service "$svc"
```

The 90 s is a **startup grace by process age**, not a failure window. A Keycloak that has been up
for days is stopped on the first probe that is not 200 (curl `--max-time 8`). Probes run every 15 s.
The grace is measured by wall clock, so a host freeze during startup also kills a Keycloak that is
still starting. That happened at 21:31:43 → 21:33:45 and 21:33:51 → 21:36:02 on 14 Oct.

### 3.3 The phone suspends, which freezes processes and makes wall clock jump (strong inference)

- `/sys/power/wake_lock` is empty, `dumpsys power` shows `mWakefulness=Asleep`, and `Wake Locks: size=0`.
  Doze is enabled (`mDeepEnabled=true`).
- `/sys/power/suspend_stats`: 58,847 successful suspends since boot (and 108,353 failed attempts).
- Boot clock 941,587 s against monotonic clock 908,964 s: about **9.1 h spent suspended** in 10.9 days of uptime.
- The worker and Keycloak logs show wall-clock gaps that only a frozen host explains. For example,
  the worker's 15 s loop stopped a launch after 11 min (13:44:52 → 13:55:42 on 9 Oct). Keycloak
  reported `started in 20.9s` while its own log lines for that start spanned 21:19:36 → 21:28:30 on
  15 Oct. Quarkus measures with the monotonic clock, which stops during suspend.

JDBC_PING2 timestamps and the staleness cutoff use wall-clock time, but JGroups timers run on
monotonic time. After a resume, the coordinator row is older than the cutoff before the info writer
has refreshed it. The row is then missing or treated as stale, the health check sees no coordinator,
readiness fails, and §3.2 kills Keycloak. Restarts after the first one are slow because the host is
still waking up and swapping, so the startup grace kills them too. This is why the restarts come in
bursts.

The exact interleaving inside JGroups was not reproduced. §3.1 and §3.2 are confirmed, and §3.3 is
consistent with every burst. The single-node cluster health check protects against split brain
between several Keycloak nodes, which cannot happen with one node, so this check has no value here.

## 4. Proposed change

Two independent parts. A removes the trigger and B makes the supervisor tolerant. Each part needs its
own approval and can roll back on its own. The recommended order is A, then B.

### A. Keycloak single-node local cache (`cache=local`)

`cache` is a **build-time** option, and the release starts with `--optimized`. Setting `KC_CACHE=local`
in `final.env` alone is not applied until a `kc.sh build` runs. The current release directory is
read-only and is the rollback target, so the build goes into a new release directory.

Effects:

- No JGroups channel, no port 7800, and no `jdbc-ping` cluster health check in readiness.
- Somewhat less memory and fewer threads.
- Sessions: Keycloak 26 keeps user and offline sessions in the database (persistent user sessions),
  so a restart does not log users out. Step A4 checks this before the change.
- The `jgroups_ping` table becomes unused. It is left as it is.

Steps (operator, after owner approval, outside working hours):

1. **Backup.** Run the OPS-MI8-BAK-001 backup on demand (`/data/local/mi8vps/sq-core-backup.sh`) and confirm
   `result=OK` and a `keycloak` dump of `sqcore_keycloak` in the new set.
2. **Build the new release.**
   `cp -a releases/keycloak-26.7.2-3a2238fc-20261004 releases/keycloak-26.7.2-3a2238fc-local-<yyyymmdd>`. Make the copy
   writable for `sqkeycloak`, then as `sqkeycloak` with the same `JAVA_HOME` run:
   `bin/kc.sh build --db=postgres --health-enabled=true --metrics-enabled=true --cache=local`.
   The command must name every current build option, because the build replaces the persisted set.
   Check that `META-INF/keycloak-persisted.properties` in `lib/quarkus/generated-bytecode.jar` now contains
   `kc.cache=local` plus the same db, health, metrics and provider entries. Return the copy to read-only modes.
3. **Candidate test, without touching production traffic.** Restore the backup's `keycloak` dump into a scratch
   database `sqcore_keycloak_kccand`. Start the new release as `sqkeycloak` with a copy of `final.env`
   where only these differ: `KC_DB_URL` names the scratch database, `KC_HTTP_PORT=18080`,
   `KC_HTTP_MANAGEMENT_PORT=19000`, `KC_CACHE=local`, the two `KC_CACHE_EMBEDDED_NETWORK_*` lines are
   removed, and `-Xmx384m` is set for the short test. Pass when all of these hold:
   - startup log shows Keycloak 26.7.2 with no `Starting JGroups channel` line;
   - `GET 127.0.0.1:19000/health/ready` returns 200 with no "cluster health check" entry;
   - `GET 127.0.0.1:18080/realms/sq-staff/.well-known/openid-configuration` returns 200, and its issuer is
     `https://login.sabilulquran.or.id/realms/sq-staff`;
   - the SQ trusted-device provider is listed as loaded, with no provider errors;
   - nothing listens on 7800 from the candidate.
   Then stop the candidate and drop `sqcore_keycloak_kccand`. The restore also serves as a restore test.
4. **Session persistence check (read-only).** Confirm that the `persistent-user-sessions` feature is
   not disabled in the build or env. On 2026-10-16 neither `final.env` nor the persisted build
   options set `features`/`features-disabled`, so the 26.x default (enabled) applies. Re-check on
   the day. If it is disabled, stop here and re-plan, because the switch would
   log users out.
5. **Switch (login outage starts).** Edit 4 places: `shared/start-final.sh` (`exec` path),
   `sq-core-launch.sh` keycloak `workdir` and `command`, and `sq-core-worker.sh` keycloak
   `service_pid` pattern. In `final.env` set `KC_CACHE=local` and remove the two
   `KC_CACHE_EMBEDDED_NETWORK_*` lines. Keep `.pre-ops-mi8-kc-001` copies of all four files.
   Restart the worker so it picks up the new pattern (see OPS-MI8-REL-001 §1); this leaves services
   running. Then `sq-corectl.sh restart keycloak`.
6. **Verify.**
   - `/health/ready` returns 200, and the startup log has no JGroups lines.
   - The well-known endpoint returns 200 through `https://login.sabilulquran.or.id`.
   - One synthetic or UAT login works for each of HCIS, SQ Hub and Aset (no real user data is
     recorded in evidence), and the existing app sessions still refresh.
   - `/health` returns 200 for `hcis`, `hub` and `aset`.
   - Watch for 48 h: no Keycloak `stop`/`launch` lines in `sq-core-worker.log` and no
     `JdbcPingClusterHealthImpl` warnings.

### B. Worker readiness tolerance (all SQ Core services)

Replace the "first failed probe after 90 s of age" rule with a count of consecutive failed probes.
`sleep` and the loop run on monotonic time, so iterations measure awake time and a suspend does not
count. Proposed rule:

- Per service, keep `fail_<svc>` as the number of consecutive failed `ready` probes, reset to 0 on success.
- A running process is stopped only when `fail_<svc> >= 6` (about 90 s of awake time at 15 s per loop),
  for `keycloak` `>= 8`.
- The startup grace also counts loop iterations since launch (keycloak 12, about 180 s of awake time;
  others 6), not wall-clock age from `/proc/<pid>`.
- Log `unready service=<svc> fails=<n>` on each failure, so the next incident is visible before a kill.

This changes the supervisor for every SQ Core service, so it gets its own approval. It needs a worker
restart, which leaves services running, and it can roll back on its own (restore
`sq-core-worker.sh.pre-ops-mi8-kc-001` and restart the worker). Test: run a copy of the new `ensure`
logic against a stub `ready` in a shell on the device and check the counters before the swap. After
the swap, confirm a `sq-corectl.sh restart hub-web` (static site, smallest impact) still relaunches.

### Not in scope (owner decision, separate follow-up)

The device suspending (§3.3) slows **all** Mi8 services, not only Keycloak. Holding a partial wakelock
(for example `echo sq-core > /sys/power/wake_lock` at boot) or disabling Doze would stop it, but these
are host power settings with battery and thermal effects. They need their own owner decision and are
not part of this change.

## 5. User-facing impact

- **During A step 5:** Akun SQ login and token refresh are unavailable for about 30–60 s (Keycloak start was
  17–33 s on this host, plus readiness). HCIS, SQ Hub and Aset keep serving users whose access tokens are
  still valid. A refresh that falls inside the window fails, and the user may be asked to log in again.
  Schedule the window outside working hours, after the 02:00 WIB backup, and announce it to admins.
- **After A:** no change to login screens, realms, clients or sessions. The repeated 1–2 min outages on
  bad days, caused by restart loops, should stop.
- **B:** no outage. The worker restart leaves services running.

## 6. Rollback

- **A:** point the 4 places back at `keycloak-26.7.2-3a2238fc-20261004` (restore the
  `.pre-ops-mi8-kc-001` copies, including `final.env`), restart the worker, then `sq-corectl.sh restart keycloak`.
  This takes about 1 min and causes the same short login outage. The cache mode does not change the
  database schema or data, so no database restore is needed. The OPS-MI8-BAK-001 set from step A1 is a safety net only.
- **B:** restore `sq-core-worker.sh.pre-ops-mi8-kc-001` and restart the worker.

## 7. Audit and evidence

Record in a dated verification note or in the Mi8VPS Platform Runbook: the approval (who, when, A
and/or B), the backup set name, the candidate results, the switch time, the verify results, and the
48 h observation. Evidence holds no user identifiers, IPs or secrets; quote only log categories and
counts.
