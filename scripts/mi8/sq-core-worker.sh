#!/system/bin/sh
# Additive SQ Core supervisor. It never supervises PostgreSQL or existing apps.
set -u

STATE=/data/local/mi8vps
ROOT=/data/local/ubuntu26
PIDFILE="$STATE/sq-core-worker.pid"
LOG="$STATE/sq-core-worker.log"
LAUNCH="$STATE/sq-core-launch.sh"
ROTATE="$STATE/sq-core-logrotate.sh"
BACKUP="$STATE/sq-core-backup.sh"
RESTORE_CHECK="$STATE/sq-core-restore-check.sh"
# OPS-MI8-BAK-001: 19 UTC = 02:00 WIB, outside working hours.
BACKUP_HOUR_UTC=19
# Sunday 20 UTC = Monday 03:00 WIB, after that night's set exists.
RESTORE_CHECK_DOW_UTC=7
RESTORE_CHECK_HOUR_UTC=20
PIDDIR="$STATE/sq-core-pids"
mkdir -p "$PIDDIR"

if [ -s "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$old" ] && [ -r "/proc/$old/cmdline" ] && tr '\000' ' ' <"/proc/$old/cmdline" 2>/dev/null | grep -q 'sq-core-worker.sh'; then
    exit 0
  fi
fi
echo $$ >"$PIDFILE"
exec >>"$LOG" 2>&1
echo "SQ Core worker started $(date), pid=$$"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
http_code() { chroot "$ROOT" /usr/bin/curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$1" 2>/dev/null || true; }
https_code_insecure() { chroot "$ROOT" /usr/bin/curl -ksS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$1" 2>/dev/null || true; }
pg_ready() {
  tuid=$(stat -c %u /data/data/com.termux)
  tgid=$(stat -c %g /data/data/com.termux)
  su -g "$tgid" -G 3003 "$tuid" -c 'HOME=/data/data/com.termux/files/home PREFIX=/data/data/com.termux/files/usr TMPDIR=/data/data/com.termux/files/usr/tmp PATH=/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin /data/data/com.termux/files/usr/bin/pg_isready -h 127.0.0.1 -p 5432' >/dev/null 2>&1
}

ready() {
  case "$1" in
    directory-proxy) [ "$(https_code_insecure https://127.0.0.1/health)" = 200 ] ;;
    keycloak) [ "$(http_code http://127.0.0.1:9000/health/ready)" = 200 ] ;;
    hcis) [ "$(http_code http://127.0.0.1:3301/health)" = 200 ] ;;
    hcis-web) [ "$(http_code http://127.0.0.1:3201/)" = 200 ] ;;
    hub) [ "$(http_code http://127.0.0.1:3302/health)" = 200 ] ;;
    hub-web) [ "$(http_code http://127.0.0.1:3202/)" = 200 ] ;;
    aset) [ "$(http_code http://127.0.0.1:3303/healthz)" = 200 ] ;;
    aset-web) [ "$(http_code http://127.0.0.1:3203/)" = 200 ] ;;
    *) return 2 ;;
  esac
}

service_pid() {
  svc=$1
  case "$svc" in
    directory-proxy) pattern="$ROOT/srv/sq-hub/shared"; bins='node' ;;
    keycloak) pattern="$ROOT/srv/keycloak/releases/keycloak-26.7.2-3a2238fc-20261004"; bins='java' ;;
    hcis) pattern="$ROOT/srv/hcis/releases/hcis-1f482549-20261004/apps/api"; bins='node' ;;
    hcis-web) pattern="$ROOT/srv/hcis/releases/hcis-1f482549-20261004/apps/web/dist"; bins='python3 python' ;;
    hub) pattern="$ROOT/srv/sq-hub/releases/hub-6c894188-phase3-bind-20261004/apps/api"; bins='node' ;;
    hub-web) pattern="$ROOT/srv/sq-hub/releases/hub-6c894188-phase3-bind-20261004/apps/web/dist"; bins='python3 python' ;;
    aset) pattern="$ROOT/srv/aset-sq/releases/aset-56416810-f8547fa-20261004/apps/api"; bins='node' ;;
    aset-web) pattern="$ROOT/srv/aset-sq/releases/aset-56416810-f8547fa-20261004/apps/web/dist"; bins='python3 python' ;;
  esac
  for bin in $bins; do
    for p in $(pidof "$bin" 2>/dev/null || true); do
      cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
      case "$cwd" in "$pattern"*) echo "$p"; return 0;; esac
    done
  done
  return 1
}

stop_service() {
  svc=$1
  p=$(service_pid "$svc" || true)
  [ -n "$p" ] || return 0
  log "stop service=$svc pid=$p"
  kill -TERM "$p" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ] && [ -d "/proc/$p" ]; do sleep 1; i=$((i+1)); done
  if [ -d "/proc/$p" ]; then
    log "TERM timeout service=$svc pid=$p; sending KILL"
    kill -KILL "$p" 2>/dev/null || true
  fi
}

# BEGIN ensure (OPS-MI8-KC-001 part B)
# Health is judged by consecutive failed probes, not by wall-clock process age.
# The loop sleeps on the monotonic clock, which stops while the phone is
# suspended, so N probes are N loop iterations of awake time and a resume
# (wall clock jumps) never counts as failure time.
attempts=0
next_start=0
# Consecutive failed probes before a running process is stopped (~15 s each).
fail_limit() { case "$1" in keycloak) echo 8 ;; *) echo 6 ;; esac; }
# Failed probes allowed after this worker launches a process that has not yet
# been ready once.
start_grace() { case "$1" in keycloak) echo 12 ;; *) echo 6 ;; esac; }
svc_count() { eval "echo \${$1_$(echo "$2" | tr '-' '_'):-0}"; }
svc_set() { eval "$1_$(echo "$2" | tr '-' '_')=$3"; }

ensure() {
  svc=$1
  if ready "$svc"; then
    svc_set fails "$svc" 0
    svc_set starting "$svc" 0
    return 0
  fi
  fails=$(($(svc_count fails "$svc") + 1))
  svc_set fails "$svc" "$fails"
  existing=$(service_pid "$svc" || true)
  if [ -n "$existing" ]; then
    if [ "$(svc_count starting "$svc")" = 1 ]; then
      [ "$fails" -lt "$(start_grace "$svc")" ] && return 1
      log "startup grace exhausted service=$svc pid=$existing probes=$fails"
    else
      log "unready service=$svc pid=$existing fails=$fails"
      [ "$fails" -lt "$(fail_limit "$svc")" ] && return 1
    fi
  fi
  now=$(date +%s)
  [ "$now" -ge "$next_start" ] || return 1
  [ -n "$existing" ] && stop_service "$svc"
  attempts=$((attempts + 1))
  delay=$((attempts * 15))
  [ "$delay" -gt 120 ] && delay=120
  next_start=$((now + delay))
  log "launch service=$svc attempt=$attempts backoff=${delay}s"
  "$LAUNCH" "$svc" || log "launch command failed service=$svc"
  svc_set fails "$svc" 0
  svc_set starting "$svc" 1
  return 1
}
# END ensure

last_rotate=0
last_backup_day=
last_restore_check_day=
offhost_copy() {
  # Encrypted Drive copy of the newest production set; it runs in the chroot,
  # where rclone, flock and the 15 GB quota guard live.
  chroot "$ROOT" /usr/bin/env -i HOME=/root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/timeout 1800 /usr/local/sbin/sq-core-offhost-daily \
    >>"$STATE/sq-core-offhost.log" 2>&1
}
while :; do
  now=$(date +%s)
  if [ $((now - last_rotate)) -ge 900 ]; then
    "$ROTATE" || log 'log rotation failed'
    last_rotate=$now
  fi
  day=$(date -u +%F)
  hour=$(date -u +%H)
  if [ "$hour" = "$BACKUP_HOUR_UTC" ] && [ "$day" != "$last_backup_day" ]; then
    if "$BACKUP"; then
      log "scheduled backup completed"
      if offhost_copy; then
        log "scheduled off-host copy completed"
      else
        log "scheduled off-host copy FAILED exit=$?"
      fi
    else
      log "scheduled backup FAILED exit=$?"
    fi
    last_backup_day=$day
  fi
  if [ "$(date -u +%u)" = "$RESTORE_CHECK_DOW_UTC" ] && [ "$hour" = "$RESTORE_CHECK_HOUR_UTC" ] \
    && [ "$day" != "$last_restore_check_day" ]; then
    if "$RESTORE_CHECK" >>"$STATE/sq-core-restore-check.log" 2>&1; then
      log "weekly restore check passed"
    else
      log "weekly restore check FAILED exit=$?"
    fi
    last_restore_check_day=$day
  fi
  if ! pg_ready; then
    log 'PostgreSQL not ready; SQ Core waits without touching host PostgreSQL'
    sleep 15
    continue
  fi
  ensure keycloak || { sleep 15; continue; }
  ensure hcis || { log 'Hub dependency gate: HCIS unavailable'; sleep 15; continue; }
  ensure hcis-web || { log 'Hub dependency gate: HCIS web unavailable'; sleep 15; continue; }
  ensure directory-proxy || { log 'Hub dependency gate: Directory TLS proxy unavailable'; sleep 15; continue; }
  ensure hub || { sleep 15; continue; }
  ensure hub-web || { sleep 15; continue; }
  if ready hcis && ready hub; then
    ensure aset; ensure aset-web
  else
    log 'Aset dependency gate: HCIS or Hub unavailable'
  fi
  attempts=0
  sleep 15
done
