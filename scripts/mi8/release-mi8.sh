#!/usr/bin/env bash
# OPS-MI8-REL-001: release an HCIS bundle to Mi8VPS from an operator workstation.
# Spec/runbook: docs/development/mi8vps-hcis-release.md
#
#   scripts/mi8/release-mi8.sh <phase> --bundle <hcis-SHA8-DATE.tar.gz> --sha <40-hex>
#                              [--apply --confirm RELEASE_<sha8>]
#
# Phases: preflight upload backup migrate candidate cutover verify rollback all
#
# Dry run is the default: read-only checks run against the device, every mutating
# step is printed instead of executed. --apply needs owner approval for the release.
set -euo pipefail

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

PHASE=${1:-}
[[ -n "$PHASE" ]] || usage
shift
BUNDLE=
SHA=
APPLY=0
CONFIRM=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE=${2:-}; shift 2 ;;
    --sha) SHA=${2:-}; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --confirm) CONFIRM=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

SSH_ROOT=${MI8_SSH_ROOT:-mi8vps-root}
SSH_USER=${MI8_SSH_USER:-mi8vps}
HCIS_DB=${MI8_HCIS_DB:-sqcore_hcis}
PUBLIC_URL=${MI8_PUBLIC_URL:-https://hcis.sabilulquran.or.id}
CAND_API_PORT=3391
CAND_WEB_PORT=3291

die() { echo "STOP: $*" >&2; exit 1; }
say() { echo "[$(date '+%H:%M:%S')] $*"; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha must be a full 40-character lowercase SHA"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || die "--bundle must point at an existing hcis-<sha8>-<date>.tar.gz"
SHA8=${SHA:0:8}
NAME=$(basename "$BUNDLE" .tar.gz)
[[ "$NAME" =~ ^hcis-[0-9a-f]{8}-[0-9]{8}$ ]] || die "bundle name must be hcis-<sha8>-<yyyymmdd>.tar.gz"
[[ "$NAME" == "hcis-$SHA8-"* ]] || die "bundle $NAME does not match --sha $SHA"

if [[ "$APPLY" == 1 ]]; then
  [[ "$CONFIRM" == "RELEASE_$SHA8" ]] || die "--apply requires --confirm RELEASE_$SHA8 (owner-approved release)"
  LOG="mi8-release-$NAME-$(date -u +%Y%m%dT%H%M%SZ)-$PHASE.log"
  exec > >(tee -a "$LOG") 2>&1
  say "apply mode; local log $LOG"
else
  say "DRY RUN (no production change). Add --apply --confirm RELEASE_$SHA8 after owner approval."
fi

# ---------------------------------------------------------------- remote helpers

# Shared prelude for every remote script (runs as root under /system/bin/sh).
prelude() {
  cat <<EOF
set -eu
PATH=/system/bin:/system/xbin:\$PATH:/usr/sbin:/usr/bin:/sbin:/bin
R=/data/local/ubuntu26
S=/data/local/mi8vps
REL=/srv/hcis/releases
NAME='$NAME'
SHA='$SHA'
DB='$HCIS_DB'
CAND_API_PORT=$CAND_API_PORT
CAND_WEB_PORT=$CAND_WEB_PORT
EOF
  cat <<'EOF'
TUID=$(stat -c %u /data/data/com.termux)
TGID=$(stat -c %g /data/data/com.termux)
TENV="HOME=/data/data/com.termux/files/home PREFIX=/data/data/com.termux/files/usr TMPDIR=/data/data/com.termux/files/usr/tmp PATH=/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin"
fail() { echo "STOP: $*" >&2; exit 1; }
as_termux() { su -g "$TGID" -G 3003 "$TUID" -c "$TENV $1"; }
as_sqhcis() { chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "$1"; }
http_code() { chroot "$R" /usr/bin/curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$1" 2>/dev/null || true; }
http_headers() { chroot "$R" /usr/bin/curl -sS -D - -o /dev/null --connect-timeout 3 --max-time 8 "$1" 2>/dev/null | tr -d '\r' || true; }
# Release name used by the running process of <bin> whose cwd ends in <subdir>.
running_release() {
  for p in $(pidof "$1" 2>/dev/null || true); do
    cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
    case "$cwd" in "$R$REL/"*"/$2") r=${cwd#"$R$REL/"}; echo "${r%%/*}"; return 0 ;; esac
  done
  return 1
}
# Count references to a release in a root script.
refs() { grep -c "/srv/hcis/releases/$2/" "$1" || true; }
other_refs() { grep -o '/srv/hcis/releases/[^/]*/' "$1" | grep -v "/srv/hcis/releases/$2/" | sort -u || true; }
wait_worker_gone() {
  i=0; while [ "$i" -lt 20 ] && [ -d "/proc/$1" ]; do sleep 1; i=$((i+1)); done
  [ -d "/proc/$1" ] && kill -KILL "$1" 2>/dev/null || true
}
# OPS-MI8-SUP-001: stop the worker with KILL, never TERM. A worker started with
# setsid leads its process group, and Android mksh answers an untrapped TERM
# with kill(0, TERM), which stops every service the worker launched into that
# group (2026-10-16: 1-2.5 min web outages). KILL runs no shell code. The
# services keep running and the new worker finds them by cwd.
restart_worker() {
  wp=$(cat "$S/sq-core-worker.pid" 2>/dev/null || true)
  if [ -n "$wp" ] && tr '\000' ' ' <"/proc/$wp/cmdline" 2>/dev/null | grep -q sq-core-worker.sh; then
    echo "worker_stop pid=$wp"; kill -KILL "$wp" 2>/dev/null || true; wait_worker_gone "$wp"
  fi
  rm -f "$S/sq-core-worker.pid"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup /system/bin/sh "$S/sq-core-worker.sh" </dev/null >/dev/null 2>&1 &
  else
    nohup /system/bin/sh "$S/sq-core-worker.sh" </dev/null >/dev/null 2>&1 &
  fi
  sleep 3
  wp=$(cat "$S/sq-core-worker.pid" 2>/dev/null || true)
  [ -n "$wp" ] && tr '\000' ' ' <"/proc/$wp/cmdline" 2>/dev/null | grep -q sq-core-worker.sh || fail "worker did not restart"
  echo "worker_start pid=$wp"
}
wait_release() {
  want=$1; i=0
  while [ "$i" -lt 90 ]; do
    a=$(running_release node apps/api || true); w=$(running_release python3 apps/web/dist || true)
    if [ "$a" = "$want" ] && [ "$w" = "$want" ] \
      && [ "$(http_code http://127.0.0.1:3301/health)" = 200 ] && [ "$(http_code http://127.0.0.1:3201/)" = 200 ]; then
      echo "running_release=$want after ~$((i*2))s"; return 0
    fi
    sleep 2; i=$((i+1))
  done
  echo "api_release=${a:-none} web_release=${w:-none}" >&2
  return 1
}
EOF
}

# Read-only: always executed, also in dry run.
remote_ro() { { prelude; cat; } | ssh -o BatchMode=yes "$SSH_ROOT" /system/bin/sh -s; }

# Mutating: executed only with --apply; otherwise printed.
remote_rw() {
  local what=$1
  local body
  body=$(cat)
  if [[ "$APPLY" == 1 ]]; then
    say "apply: $what"
    { prelude; printf '%s\n' "$body"; } | ssh -o BatchMode=yes "$SSH_ROOT" /system/bin/sh -s
  else
    say "dry-run: would run on $SSH_ROOT — $what"
    printf '%s\n' "$body" | sed 's/^/    | /'
  fi
}

local_rw() {
  if [[ "$APPLY" == 1 ]]; then say "apply: $*"; "$@"; else say "dry-run: would run: $*"; fi
}

# ---------------------------------------------------------------- local facts

bundle_checks() {
  local sumfile="$BUNDLE.sha256"
  [[ -f "$sumfile" ]] || die "missing $sumfile"
  (cd "$(dirname "$BUNDLE")" && sha256sum -c "$(basename "$sumfile")" >/dev/null) || die "bundle checksum mismatch"
  BUNDLE_SHA256=$(cut -d' ' -f1 <"$sumfile")
  local manifest
  # tar runs on the basename: GNU tar treats "C:/..." as a remote host on Windows.
  manifest=$(cd "$(dirname "$BUNDLE")" && tar -xzOf "$NAME.tar.gz" "$NAME/RELEASE.json") || die "bundle has no $NAME/RELEASE.json"
  grep -q "\"sha\": \"$SHA\"" <<<"$manifest" || die "RELEASE.json sha does not match $SHA"
  grep -q "\"release\": \"$NAME\"" <<<"$manifest" || die "RELEASE.json release does not match $NAME"
  grep -q '"platform": "linux/arm64"' <<<"$manifest" || die "bundle is not linux/arm64"
  BUNDLE_MIGRATIONS=$(cd "$(dirname "$BUNDLE")" && tar -tzf "$NAME.tar.gz" | sed -n "s#^$NAME/apps/api/migrations/\([^/]*\.sql\)\$#\1#p" | sort)
  say "bundle ok: $NAME sha256=$BUNDLE_SHA256 migrations=$(wc -l <<<"$BUNDLE_MIGRATIONS")"
}

check_main() {
  git fetch -q origin main
  local main
  main=$(git rev-parse origin/main)
  [[ "$main" == "$SHA" ]] || die "target $SHA is not current origin/main ($main)"
  say "target is current origin/main"
}

applied_migrations() {
  remote_ro <<'EOF' | tr -d '\r' | sort
as_termux "psql -U postgres -d $DB -Atc 'select name from schema_migrations order by 1'"
EOF
}

pending_migrations() {
  local applied
  applied=$(applied_migrations)
  [[ -n "$applied" ]] || die "could not read schema_migrations from $HCIS_DB"
  local unknown
  unknown=$(comm -13 <(printf '%s\n' "$BUNDLE_MIGRATIONS") <(printf '%s\n' "$applied") | grep -v '^$' || true)
  [[ -z "$unknown" ]] || die "database has migrations this bundle does not contain (bundle older than DB?): $unknown"
  PENDING=$(comm -23 <(printf '%s\n' "$BUNDLE_MIGRATIONS") <(printf '%s\n' "$applied") | grep -v '^$' || true)
}

# ---------------------------------------------------------------- phases

phase_preflight() {
  check_main
  bundle_checks
  remote_ro <<'EOF'
cur=$(running_release node apps/api) || fail "running hcis API process not found"
web=$(running_release python3 apps/web/dist) || fail "running hcis-web process not found"
[ "$cur" = "$web" ] || fail "API runs $cur but web runs $web"
echo "current_release=$cur"
[ "$(refs "$S/sq-core-launch.sh" "$cur")" = 4 ] || fail "launcher does not reference $cur on exactly 4 lines"
[ "$(refs "$S/sq-core-worker.sh" "$cur")" = 2 ] || fail "worker does not reference $cur on exactly 2 lines"
[ -z "$(other_refs "$S/sq-core-launch.sh" "$cur")$(other_refs "$S/sq-core-worker.sh" "$cur")" ] || fail "launcher/worker reference another HCIS release"
[ "$cur" != "$NAME" ] || fail "$NAME is already running"
if [ -e "$R$REL/$NAME" ]; then
  grep -q "\"sha\": \"$SHA\"" "$R$REL/$NAME/RELEASE.json" || fail "$REL/$NAME exists with a different SHA"
  echo "target_release=already_uploaded"
else
  echo "target_release=absent"
fi
free_kb=$(df -k /data | tail -n 1 | tr -s ' ' | cut -d' ' -f4)
[ "$free_kb" -ge 1048576 ] || fail "less than 1 GiB free on /data"
echo "free_data_mb=$((free_kb / 1024))"
for port in $CAND_API_PORT $CAND_WEB_PORT; do
  [ "$(http_code "http://127.0.0.1:$port/")" = 000 ] || fail "candidate port $port is in use"
done
env=$R/srv/hcis/shared/final.env
if grep -q '^BIOMETRIC_COLLECTION_ENABLED=' "$env" && ! grep -q '^BIOMETRIC_COLLECTION_ENABLED=0[[:space:]]*$' "$env"; then
  fail "BIOMETRIC_COLLECTION_ENABLED is not 0"
fi
echo "biometric_collection=OFF"
[ "$(grep -Ec "^DATABASE_URL=.*/$DB([?'\"].*)?\$" "$env")" = 1 ] || fail "DATABASE_URL does not name $DB"
echo "database=$DB"
[ -f "$R/srv/hcis/shared/spa_static_server.py" ] || fail "spa_static_server.py missing"
h=$(date -u +%H); [ "$h" != 19 ] || fail "19 UTC (02:00 WIB) is the SQ Core backup hour (OPS-MI8-BAK-001); release outside it"
echo "worker_pid=$(cat "$S/sq-core-worker.pid")"
EOF
  pending_migrations
  if [[ -n "$PENDING" ]]; then
    say "PENDING MIGRATIONS (owner must approve; must be backward compatible with the running release):"
    printf '    %s\n' $PENDING
  else
    say "pending migrations: none"
  fi
  say "preflight OK"
}

phase_upload() {
  bundle_checks
  local_rw scp "$BUNDLE" "$BUNDLE.sha256" "$SSH_USER:/tmp/"
  remote_rw "install $NAME into /srv/hcis/releases (read-only, sqhcis-owned)" <<'EOF'
cd "$R/tmp"
sha256sum -c "$NAME.tar.gz.sha256" >/dev/null || fail "uploaded bundle checksum mismatch"
[ ! -e "$R$REL/$NAME" ] || fail "$REL/$NAME already exists; not overwriting"
IN="$REL/.incoming-$NAME"
rm -rf "$R$IN"; mkdir -p "$R$IN"
# GNU tar in the chroot needs syscalls the Android kernel lacks ("Function not
# implemented"); Python tarfile uses plain open/mkdir and its "data" filter
# rejects absolute paths and links that escape the target.
chroot "$R" /usr/bin/python3 -c "import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')" "/tmp/$NAME.tar.gz" "$IN"
grep -q "\"sha\": \"$SHA\"" "$R$IN/$NAME/RELEASE.json" || { rm -rf "$R$IN"; fail "RELEASE.json mismatch after extract"; }
chroot "$R" /bin/chown -R -h 989:989 "$IN/$NAME"
chroot "$R" /usr/bin/find "$IN/$NAME" -type d -exec /bin/chmod 0550 {} +
chroot "$R" /usr/bin/find "$IN/$NAME" -type f -exec /bin/chmod 0440 {} +
mv "$R$IN/$NAME" "$R$REL/$NAME"
rmdir "$R$IN"
rm -f "$R/tmp/$NAME.tar.gz" "$R/tmp/$NAME.tar.gz.sha256"
echo "installed=$REL/$NAME"
du -sh "$R$REL/$NAME"
EOF
}

phase_backup() {
  remote_rw "pg_dump -Fc $HCIS_DB to /srv/hcis/backups/pre-release before migrations" <<'EOF'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
D="$R/srv/hcis/backups/pre-release"
mkdir -p "$D"; chown root:root "$D"; chmod 0700 "$D"
TMP="/data/data/com.termux/files/home/hcis-pre-$NAME-$STAMP.dump"
as_termux "pg_dump -U postgres -Fc -f $TMP $DB"
as_termux "pg_restore --list $TMP" >/dev/null || { rm -f "$TMP"; fail "dump is not readable by pg_restore"; }
F="$NAME-$STAMP.dump"
cp "$TMP" "$D/$F"; rm -f "$TMP"
chown root:root "$D/$F"; chmod 0600 "$D/$F"
(cd "$D" && sha256sum "$F" >"$F.sha256" && chmod 0600 "$F.sha256")
echo "$(date +%s) $F" >"$D/$NAME.marker"; chmod 0600 "$D/$NAME.marker"
echo "backup=/srv/hcis/backups/pre-release/$F"
cat "$D/$F.sha256"
ls -la "$D/$F"
EOF
}

phase_migrate() {
  bundle_checks
  pending_migrations
  if [[ -z "$PENDING" ]]; then
    say "no pending migrations; migrate is a no-op"
    return 0
  fi
  say "pending: $(tr '\n' ' ' <<<"$PENDING")"
  remote_rw "apply pending migrations from $NAME as sqhcis (requires a fresh pre-release backup)" <<'EOF'
M="$R/srv/hcis/backups/pre-release/$NAME.marker"
[ -f "$M" ] || fail "no pre-release backup marker for $NAME; run the backup phase first"
age=$(( $(date +%s) - $(cut -d' ' -f1 "$M") ))
[ "$age" -lt 21600 ] || fail "pre-release backup is older than 6 hours; take a new one"
[ -d "$R$REL/$NAME" ] || fail "$NAME is not uploaded"
as_sqhcis "set -a; . /srv/hcis/shared/final.env; set +a; cd $REL/$NAME/apps/api; exec /usr/bin/node dist/db/migrate.js"
echo "migrate=done"
EOF
  if [[ "$APPLY" == 1 ]]; then
    pending_migrations
    [[ -z "$PENDING" ]] || die "still pending after migrate: $PENDING"
    say "all bundle migrations applied"
  fi
}

phase_candidate() {
  remote_rw "candidate gate: $NAME API on :$CAND_API_PORT and web on :$CAND_WEB_PORT, then stop both" <<'EOF'
[ -d "$R$REL/$NAME" ] || fail "$NAME is not uploaded"
[ "$(running_release node apps/api || true)" != "$NAME" ] || fail "$NAME already serves production"
LOG=/srv/hcis/logs/candidate-$NAME.log
nohup chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "set -a; . /srv/hcis/shared/final.env; set +a; export HOST=127.0.0.1 PORT=$CAND_API_PORT; cd $REL/$NAME/apps/api; exec /usr/bin/node dist/server.js" </dev/null >>"$R$LOG" 2>&1 &
APID=$!
nohup chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "cd $REL/$NAME/apps/web/dist; exec /usr/bin/python3 /srv/hcis/shared/spa_static_server.py --bind 127.0.0.1 --port $CAND_WEB_PORT" </dev/null >>"$R$LOG" 2>&1 &
WPID=$!
stop_candidates() {
  kill -TERM "$APID" "$WPID" 2>/dev/null || true
  sleep 3
  for p in $(pidof node python3 2>/dev/null || true); do
    case "$(readlink "/proc/$p/cwd" 2>/dev/null || true)" in "$R$REL/$NAME/"*) kill -TERM "$p" 2>/dev/null || true ;; esac
  done
  sleep 2
  for port in $CAND_API_PORT $CAND_WEB_PORT; do
    [ "$(http_code "http://127.0.0.1:$port/")" = 000 ] || echo "WARN: candidate port $port still open" >&2
  done
}
trap stop_candidates EXIT
i=0
while [ "$i" -lt 45 ] && [ "$(http_code "http://127.0.0.1:$CAND_API_PORT/health")" != 200 ]; do sleep 2; i=$((i+1)); done
ok=1
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2, want $3)"; ok=0; fi; }
check "api /health" "$(http_code "http://127.0.0.1:$CAND_API_PORT/health")" 200
check "api /ready" "$(http_code "http://127.0.0.1:$CAND_API_PORT/ready")" 200
root=$(http_headers "http://127.0.0.1:$CAND_WEB_PORT/")
check "web / status" "$(echo "$root" | head -n 1 | cut -d' ' -f2)" 200
check "web / no-store" "$(echo "$root" | grep -ci '^cache-control:.*no-store')" 1
check "web /login" "$(http_code "http://127.0.0.1:$CAND_WEB_PORT/login")" 200
asset=$(grep -o '/assets/[^"]*\.js' "$R$REL/$NAME/apps/web/dist/index.html" | head -1)
check "web entry asset immutable" "$(http_headers "http://127.0.0.1:$CAND_WEB_PORT$asset" | grep -ci '^cache-control:.*immutable')" 1
check "web missing asset 404" "$(http_code "http://127.0.0.1:$CAND_WEB_PORT/assets/does-not-exist.js")" 404
[ "$ok" = 1 ] || { tail -n 40 "$R$LOG" >&2; fail "candidate gate failed"; }
echo "candidate_gate=PASS"
EOF
}

phase_cutover() {
  bundle_checks
  remote_rw "cut over hcis + hcis-web to $NAME (launcher/worker path edit, worker restart, service restart)" <<'EOF'
[ "$(date -u +%H)" != 19 ] || fail "19 UTC (02:00 WIB) is the SQ Core backup hour (OPS-MI8-BAK-001)"
[ -f "$R$REL/$NAME/RELEASE.json" ] || fail "$NAME is not uploaded"
grep -q "\"sha\": \"$SHA\"" "$R$REL/$NAME/RELEASE.json" || fail "$NAME RELEASE.json SHA mismatch"
PREV=$(running_release node apps/api) || fail "running hcis API not found"
[ "$PREV" != "$NAME" ] || fail "$NAME already running"
echo "previous_release=$PREV"
for f in sq-core-launch.sh:4 sq-core-worker.sh:2; do
  file=$S/${f%%:*}; want=${f##*:}
  [ "$(refs "$file" "$PREV")" = "$want" ] || fail "$file does not reference $PREV on $want lines"
  [ -z "$(other_refs "$file" "$PREV")" ] || fail "$file references another HCIS release"
  bak=$file.pre-$NAME
  if [ -e "$bak" ]; then
    cmp -s "$bak" "$file" || fail "$bak exists and differs from $file; resolve the earlier attempt first"
  else
    cp -p "$file" "$bak"
  fi
  new=$file.new-$NAME
  # GNU sed from the chroot; only lines naming an HCIS release are touched.
  chroot "$R" /bin/sed "\#/srv/hcis/releases/#s#/srv/hcis/releases/$PREV/#/srv/hcis/releases/$NAME/#g" <"$file" >"$new"
  [ "$(refs "$new" "$NAME")" = "$want" ] || fail "$new: expected $want lines for $NAME"
  [ "$(refs "$new" "$PREV")" = 0 ] || fail "$new still references $PREV"
  [ "$(grep -v /srv/hcis/releases/ "$file" | sha256sum)" = "$(grep -v /srv/hcis/releases/ "$new" | sha256sum)" ] || fail "$new changed lines outside HCIS release paths"
  [ "$(wc -l <"$file")" = "$(wc -l <"$new")" ] || fail "$new line count changed"
  /system/bin/sh -n "$new" || fail "$new syntax check failed"
  chown root:root "$new"; chmod 0755 "$new"
  echo "$file: $(sha256sum "$file" | cut -c1-16) -> $(sha256sum "$new" | cut -c1-16)"
done
mv -f "$S/sq-core-launch.sh.new-$NAME" "$S/sq-core-launch.sh"
mv -f "$S/sq-core-worker.sh.new-$NAME" "$S/sq-core-worker.sh"
chroot "$R" /bin/ln -sfn "releases/$NAME" /srv/hcis/current
echo "current -> $(readlink "$R/srv/hcis/current")"
restart_worker
"$S/sq-corectl.sh" restart hcis
"$S/sq-corectl.sh" restart hcis-web
echo "restarted hcis hcis-web at $(date '+%F %T')"
wait_release "$NAME" || fail "new release not healthy within 180s; run the rollback phase"
EOF
}

phase_verify() {
  remote_ro <<'EOF'
ok=1
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2, want $3)"; ok=0; fi; }
check "api release" "$(running_release node apps/api || echo none)" "$NAME"
check "web release" "$(running_release python3 apps/web/dist || echo none)" "$NAME"
check "api /health" "$(http_code http://127.0.0.1:3301/health)" 200
check "api /ready" "$(http_code http://127.0.0.1:3301/ready)" 200
check "web / no-store" "$(http_headers http://127.0.0.1:3201/ | grep -ci '^cache-control:.*no-store')" 1
check "current symlink" "$(readlink "$R/srv/hcis/current")" "releases/$NAME"
wp=$(cat "$S/sq-core-worker.pid" 2>/dev/null || true)
check "worker alive" "$(tr '\000' ' ' <"/proc/$wp/cmdline" 2>/dev/null | grep -c sq-core-worker.sh)" 1
echo "--- recent HCIS worker events"
grep -E 'hcis|worker started' "$S/sq-core-worker.log" | tail -n 8
[ "$ok" = 1 ] || fail "verification failed"
EOF
  local fail=0
  pub() {
    local got
    got=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL$1" || true)
    if [[ "$got" == "$2" ]]; then echo "PASS public $1"; else echo "FAIL public $1 (got $got, want $2)"; fail=1; fi
  }
  pub /api/health 200
  pub /login 200
  pub /assets/does-not-exist.js 404
  [[ "$fail" == 0 ]] || die "public verification failed"
  say "verify OK. Next: browser login + deep-link refresh, and watch 'sq-corectl.sh status' for 10 minutes."
}

phase_rollback() {
  remote_rw "roll back hcis + hcis-web from $NAME to the release recorded in *.pre-$NAME (database untouched)" <<'EOF'
LB="$S/sq-core-launch.sh.pre-$NAME"; WB="$S/sq-core-worker.sh.pre-$NAME"
[ -f "$LB" ] && [ -f "$WB" ] || fail "no .pre-$NAME launcher/worker backups; nothing to roll back to"
PREV=$(grep -o '/srv/hcis/releases/[^/]*/' "$LB" | sort -u | cut -d/ -f5)
[ "$(echo "$PREV" | wc -l)" = 1 ] && [ -d "$R$REL/$PREV" ] || fail "cannot determine previous release from $LB"
echo "rollback_to=$PREV"
/system/bin/sh -n "$LB" && /system/bin/sh -n "$WB" || fail "backup syntax check failed"
cp -p "$LB" "$S/sq-core-launch.sh.rb-$NAME" && mv -f "$S/sq-core-launch.sh.rb-$NAME" "$S/sq-core-launch.sh"
cp -p "$WB" "$S/sq-core-worker.sh.rb-$NAME" && mv -f "$S/sq-core-worker.sh.rb-$NAME" "$S/sq-core-worker.sh"
chroot "$R" /bin/ln -sfn "releases/$PREV" /srv/hcis/current
restart_worker
"$S/sq-corectl.sh" restart hcis
"$S/sq-corectl.sh" restart hcis-web
wait_release "$PREV" || fail "previous release not healthy; escalate (runbook)"
echo "rollback=done; database NOT rolled back; $NAME left in place for analysis"
EOF
}

case "$PHASE" in
  preflight) phase_preflight ;;
  upload) phase_upload ;;
  backup) phase_backup ;;
  migrate) phase_migrate ;;
  candidate) phase_candidate ;;
  cutover) phase_cutover ;;
  verify) phase_verify ;;
  rollback) phase_rollback ;;
  all)
    phase_preflight
    phase_upload
    phase_backup
    phase_migrate
    phase_candidate
    phase_cutover
    if [[ "$APPLY" == 1 ]]; then phase_verify; else say "dry-run: verify runs after cutover"; fi
    ;;
  *) usage ;;
esac
