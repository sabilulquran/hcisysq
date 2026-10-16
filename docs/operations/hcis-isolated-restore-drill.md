# HCIS isolated restore drill — runbook

**Spec ID:** OPS-MI8-DRILL-001
**Status:** ACTIVE — first run PASS 2026-10-16 (`hcis-restore-drill-2026-10-16.md`). Each run needs owner approval.
**Prepared:** 2026-10-16
**Closes (when executed and PASS):** the "isolated restore drill" item in `docs/product/scope.md` → *Pilot ready* and *Production ready*.
**Related:** OPS-MI8-BAK-001 (`docs/development/mi8vps-sq-core-production-backup-plan.md`), OPS-MI8-REL-001 (`docs/development/mi8vps-hcis-release.md`), `docs/development/hcis-pilot-recovery-and-handoff.md` (generic drill rules this runbook makes concrete).

## 1. Purpose

OPS-MI8-BAK-001 already proves that each nightly dump *restores* (weekly table-count check). It does not prove that HCIS can **run** on a restored database. This drill proves the whole recovery chain on Mi8VPS, without touching production:

```text
newest production set → checksum → restore into a disposable DB → start the current HCIS release
against it on spare ports → health + smoke + reconciliation → stop → drop → evidence
```

It also gives a measured duration to inform the RTO decision (RTO and RPO remain owner decisions, `TBD`).

## 2. Actors, approvals and boundaries

| Actor | Role |
|---|---|
| Owner | Approves the drill window and this exact runbook. One approval covers steps 4–9 of one run. |
| Operator | Runs the commands from a workstation via `ssh mi8vps-root`; records the evidence. |

Approval phrase to record in the evidence note (example): *"Saya setujui restore drill OPS-MI8-DRILL-001 hari ini di Mi8VPS."*

What the drill **writes** on the device (that is why it needs approval):

- one disposable database `sqcore_drill_hcis_<yyyymmdd>` on the production PostgreSQL (about 350 MB while it exists);
- one copied dump under `/data/data/com.termux/files/home/` (≈ 28 MB, deleted at teardown);
- two temporary processes (API on `127.0.0.1:3392`, web on `127.0.0.1:3292`) and one log file `/srv/hcis/logs/drill-<stamp>.log`.

What it must **never** do:

- touch `sqcore_hcis` other than read-only `SELECT count(*)` queries;
- edit `final.env`, the launcher, the worker, Cloudflare or the edge proxy;
- expose the drill ports publicly (they bind to `127.0.0.1`; the edge proxy has no route to 3392/3292);
- run in hour 19 UTC (02:00 WIB backup) or Sunday 20 UTC (weekly restore check);
- print a credential, `DATABASE_URL`, row data or personal values. Evidence is counts, codes and durations only.

Side-effect review (repository fact, 2026-10-16): the HCIS API has **no background scheduler** (no `setInterval`/cron in `apps/api/src`). Outbound calls happen only inside a request (SQ Hub access check, organization-directory machine auth). Attendance devices poll `adms.sabilulquran.or.id` → `127.0.0.1:3301` (production), never the drill port, so queued device commands in the restored copy are never delivered. No email/WhatsApp adapter exists. The drill smoke test only calls unauthenticated endpoints, so no outbound call is triggered.

## 3. Preconditions (operator checks, read-only)

1. Not 19 UTC and not Sunday 20 UTC: `date -u`.
2. At least 2 GiB free on `/data`: `df -h /data`.
3. Ports 3392 and 3292 are free.
4. A production set exists whose `backup.log` ends `result=OK scope=production`, ideally less than 24 h old.
5. No database matching `sqcore_drill_hcis_*` exists (leftover from an earlier drill).
6. The running release is known (`cwd` of the `hcis` API process); the drill uses the same release.

## 4. Procedure

Every block below is pasted into **one** `ssh mi8vps-root` session (Termux shell as root). Blocks share variables, so keep the same session. The 2026-10-16 run concatenated §4.0–4.6 into one script piped to `ssh mi8vps-root '/system/bin/sh -s'`, with §4.7 registered as an `EXIT` trap so teardown runs even after a failure; that is the recommended way to run it. Record the start time before step 4.1.

### 4.0 Prelude (read-only)

```sh
set -eu
PATH=/system/bin:/system/xbin:$PATH:/usr/sbin:/usr/bin:/sbin:/bin
R=/data/local/ubuntu26
SETS=$R/srv/sq-core-backups/production-sets
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DRILL_DB=sqcore_drill_hcis_$(date -u +%Y%m%d)
API_PORT=3392; WEB_PORT=3292
TUID=$(stat -c %u /data/data/com.termux); TGID=$(stat -c %g /data/data/com.termux)
TENV="HOME=/data/data/com.termux/files/home PREFIX=/data/data/com.termux/files/usr TMPDIR=/data/data/com.termux/files/usr/tmp PATH=/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin"
as_termux() { su -g "$TGID" -G 3003 "$TUID" -c "$TENV $1"; }
http_code() { chroot "$R" /usr/bin/curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$1" 2>/dev/null || true; }
psql_c() { as_termux "psql -U postgres -d $1 -At -v ON_ERROR_STOP=1 -c \"$2\""; }

# Preconditions
[ "$(date -u +%H)" != 19 ] || { echo "STOP: backup hour"; exit 1; }
[ "$(date -u +%u%H)" != 720 ] || { echo "STOP: weekly restore check hour"; exit 1; }
df -h /data | tail -1
for p in $API_PORT $WEB_PORT; do [ "$(http_code http://127.0.0.1:$p/)" = 000 ] || { echo "STOP: port $p in use"; exit 1; }; done
[ -z "$(psql_c postgres "SELECT datname FROM pg_database WHERE datname LIKE 'sqcore_drill_hcis_%'")" ] || { echo "STOP: leftover drill DB"; exit 1; }

# Newest OK production set
SET=$(for d in $(ls -1d $SETS/set-* | sort -r); do tail -1 "$d/backup.log" | grep -q 'result=OK scope=production' && { echo "$d"; break; }; done)
[ -n "$SET" ] || { echo "STOP: no OK production set"; exit 1; }
echo "set=$(basename $SET)"; grep -E '^(scope|created)' "$SET/manifest.tsv" || true

# Running release (same release is used for the drill)
for p in $(pidof node); do c=$(readlink /proc/$p/cwd); case "$c" in "$R/srv/hcis/releases/"*"/apps/api") REL=${c#"$R"}; REL=${REL%/apps/api};; esac; done
[ -n "${REL:-}" ] || { echo "STOP: running HCIS release not found"; exit 1; }
echo "release=$REL"
```

PASS criteria: no `STOP`, a set name and a release path are printed.

### 4.1 Verify the set (read-only)

```sh
bad=$(cd "$SET" && sha256sum -c SHA256SUMS 2>&1 | grep -v ': OK$' || true)
[ -z "$bad" ] || { echo "STOP: checksum $bad"; exit 1; }
echo "checksums=OK"
DUMP=$(ls "$SET"/hcis/*.dump | head -1); [ -f "$DUMP" ] || { echo "STOP: no hcis dump"; exit 1; }; ls -la "$DUMP"
```

### 4.2 Create the disposable database (WRITE — approval required)

```sh
T0=$(date +%s)
TMP=/data/data/com.termux/files/home/drill-$STAMP.dump
cp "$DUMP" "$TMP"; chown "$TUID:$TGID" "$TMP"; chmod 0600 "$TMP"
as_termux "createdb -U postgres -O sqcore_hcis_owner $DRILL_DB"
echo "created=$DRILL_DB"
```

The name guard: `DRILL_DB` always starts with `sqcore_drill_hcis_`. Never substitute `sqcore_hcis`.

### 4.3 Restore (WRITE into the disposable DB only)

```sh
as_termux "pg_restore -U postgres --no-owner --no-acl --role=sqcore_hcis_owner --exit-on-error -d $DRILL_DB $TMP"
T1=$(date +%s); echo "restore_seconds=$((T1-T0))"
```

`--role=sqcore_hcis_owner` makes the restored objects owned by the application role, so the app can use them exactly as in production. A restore error stops the drill (go to §6).

### 4.4 Schema and reconciliation checks (read-only, counts only)

```sh
q_tables="SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
echo "tables live=$(psql_c sqcore_hcis "$q_tables") drill=$(psql_c $DRILL_DB "$q_tables")"
echo "migrations live=$(psql_c sqcore_hcis 'SELECT count(*) FROM schema_migrations') drill=$(psql_c $DRILL_DB 'SELECT count(*) FROM schema_migrations')"
echo "last_migration_equal=$( [ "$(psql_c sqcore_hcis 'SELECT max(name) FROM schema_migrations')" = "$(psql_c $DRILL_DB 'SELECT max(name) FROM schema_migrations')" ] && echo yes || echo NO)"
for t in employees accounts account_role_assignments organization_nodes organization_positions leave_requests leave_request_approval_steps attendance_events attendance_adms_events payslip_import_batches payslips access_audit_events auth_audit_events; do
  echo "$t live=$(psql_c sqcore_hcis "SELECT count(*) FROM $t") drill=$(psql_c $DRILL_DB "SELECT count(*) FROM $t")"
done
```

Expected:

- table count and migration count equal; the last migration name equal;
- for each business table, `drill <= live`, and `live - drill` is explained by activity since the set was taken (normally small; `attendance_adms_events` grows continuously). A drill count **greater** than live, or zero where live is large, is a FAIL.

### 4.5 Start HCIS against the disposable DB (spare ports, loopback only)

The API reuses production `final.env` (needed for `AUTH_ENCRYPTION_KEY` etc.) but overrides `DATABASE_URL`'s database name and the port. The URL is never printed; only the resolved database name is.

```sh
LOG=/srv/hcis/logs/drill-$STAMP.log
nohup chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "set -a; . /srv/hcis/shared/final.env; set +a; \
  DATABASE_URL=\$(printf %s \"\$DATABASE_URL\" | sed -E 's#/sqcore_hcis(\\?|\$)#/$DRILL_DB\\1#'); \
  case \"\$DATABASE_URL\" in */$DRILL_DB|*/$DRILL_DB\\?*) ;; *) echo 'STOP: drill DATABASE_URL rewrite failed' >&2; exit 1;; esac; \
  export DATABASE_URL HOST=127.0.0.1 PORT=$API_PORT; cd $REL/apps/api; exec /usr/bin/node dist/server.js" </dev/null >>"$R$LOG" 2>&1 &
nohup chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "cd $REL/apps/web/dist; exec /usr/bin/python3 /srv/hcis/shared/spa_static_server.py --bind 127.0.0.1 --port $WEB_PORT" </dev/null >>"$R$LOG" 2>&1 &
i=0; while [ $i -lt 45 ] && [ "$(http_code http://127.0.0.1:$API_PORT/health)" != 200 ]; do sleep 2; i=$((i+1)); done
T2=$(date +%s); echo "app_ready_seconds=$((T2-T0))"
# Prove the drill API is connected to the drill DB and not production
psql_c postgres "SELECT datname, count(*) FROM pg_stat_activity WHERE datname IN ('$DRILL_DB') GROUP BY 1"
```

The last query must show at least one connection to `$DRILL_DB`. If the rewrite guard printed `STOP`, the API never started (FAIL, go to §6).

### 4.6 Health and smoke checks (read-only HTTP)

```sh
ok=1; check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2 want $3)"; ok=0; fi; }
check "api /health"             "$(http_code http://127.0.0.1:$API_PORT/health)" 200
check "api /ready (DB reachable)" "$(http_code http://127.0.0.1:$API_PORT/ready)" 200
check "api /auth/me unauthenticated" "$(http_code http://127.0.0.1:$API_PORT/auth/me)" 401
check "api admin unauthenticated" "$(http_code http://127.0.0.1:$API_PORT/admin/employees)" 401
check "web /"                    "$(http_code http://127.0.0.1:$WEB_PORT/)" 200
check "web /login"               "$(http_code http://127.0.0.1:$WEB_PORT/login)" 200
grep -ciE 'error|fatal' "$R$LOG" || true
echo "smoke=$([ $ok = 1 ] && echo PASS || echo FAIL)"
```

Both protected endpoints answered 401 on production on 2026-10-16 (`/api/auth/me`, `/api/admin/employees`). What matters is that a DB-backed app answers 401, not 5xx.

Authenticated browser login is **not** part of this drill: the OIDC redirect URI points at production, and doing an interactive login against a copy of real data adds risk without proving more about recoverability. A later drill on a separate host may add it.

### 4.7 Teardown (always, also after a FAIL)

The drill processes run from the same release directory as production, so they are identified by their port (API: `PORT=3392` in the process environment; web: `--port 3292` on the command line), never by `cwd`:

```sh
for p in $(pidof node python3); do
  e=$(tr '\000' '\n' </proc/$p/environ 2>/dev/null | grep -c "^PORT=$API_PORT$" || true)
  c=$(tr '\000' ' ' </proc/$p/cmdline | grep -c -- "--port $WEB_PORT" || true)
  [ "$e" != 0 -o "$c" != 0 ] && { echo "stop pid=$p"; kill -TERM $p; }
done
sleep 3
for p in $API_PORT $WEB_PORT; do echo "port $p after stop: $(http_code http://127.0.0.1:$p/)"; done   # expect 000
case "$DRILL_DB" in sqcore_drill_hcis_*) as_termux "dropdb -U postgres --if-exists $DRILL_DB" ;; *) echo "STOP: refusing to drop $DRILL_DB" ;; esac
rm -f "$TMP"
T3=$(date +%s); echo "total_seconds=$((T3-T0))"
psql_c postgres "SELECT count(*) FROM pg_database WHERE datname LIKE 'sqcore_drill_hcis_%'"   # expect 0
# Production still healthy
echo "prod api=$(http_code http://127.0.0.1:3301/health) web=$(http_code http://127.0.0.1:3201/)"
```

Keep `drill-<stamp>.log` for evidence (it contains request lines only; check it with the same PII grep used in the security review before quoting any line).

## 5. Evidence to record

Create `docs/operations/hcis-restore-drill-<yyyy-mm-dd>.md` with: owner approval quote, set name and age, release name, `restore_seconds`, `app_ready_seconds`, `total_seconds`, table/migration equality, the reconciliation table (counts only), every PASS/FAIL line, the teardown proof (ports `000`, zero drill DBs, production 200), and any deviation. Update the gate table in `hcis-readiness-gates-2026-10-16.md`.

PASS requires: checksums OK, restore exit 0, table and migration counts equal, no impossible reconciliation counts, all six smoke checks PASS, teardown proof complete, production health unchanged.

## 6. Failure handling and rollback

The drill never changes production, so "rollback" is teardown:

1. Run §4.7 completely, even if an earlier step failed.
2. If `dropdb` fails because a session is still connected, list the PIDs with `pg_stat_activity` for `$DRILL_DB` only, terminate those with `pg_terminate_backend` limited to `datname = '$DRILL_DB'`, and drop again.
3. Never retry against `sqcore_hcis`. Never use `pg_restore --clean`.
4. Classify the failure: corrupt/incomplete dump (backup defect → OPS-MI8-BAK-001 incident), version mismatch, role/ownership, app config, or capacity. A failed drill is **NO-GO** for pilot until a repeat drill passes.
5. If production health checks are not 200 after teardown, stop and follow the incident path in the go-live decision record; the drill load (≈ 350 MB restore, one Node process) is the first suspect on this phone (load average ≈ 5 observed on 2026-10-16).

## 7. Known limits

- The drill runs on the same phone and PostgreSQL as production. It proves the data and app recovery path, not recovery from **loss of the phone**. A second drill from the Google Drive copy (`mi8_crypt:production/sq-core-daily/<set>`) onto another host is the follow-up for that (`TBD`, needs a host decision).
- Secrets are not in the backup sets (OPS-MI8-BAK-001 §9). The drill reuses the live `final.env`; a phone-loss recovery would need the secret bundle, whose off-host coverage is `DISCOVERY`.
- HCIS file storage outside PostgreSQL: `attendance_adms_attendance_photos` and `attendance_mobile_evidence` exist as tables; whether any binary evidence lives on disk outside the DB is `DISCOVERY` (OPS-MI8-BAK-001 §9 found no upload directory under `/srv/hcis`).
