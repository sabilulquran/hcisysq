#!/usr/bin/env bash
# OPS-MI8-REL-001: release an HCIS bundle to Mi8VPS from an operator workstation.
# Spec/runbook: docs/development/mi8vps-hcis-release.md
#
#   scripts/mi8/release-mi8.sh <phase> --bundle <hcis-SHA8-DATE.tar.gz> --sha <40-hex>
#                              [--apply --confirm RELEASE_<sha8>]
#
# Phases: preflight upload backup migrate candidate cutover verify rollback all unlock
#
# One release operator at a time: --apply takes the device-wide lock
# /data/local/mi8vps/sq-core-release.lock (atomic mkdir) with a token unique to this
# checkout; preflight stops while another operator holds it. verify/rollback release it.
#
# Dry run is the default: read-only checks run against the device, every mutating
# step is printed instead of executed. --apply needs owner approval for the release.
set -euo pipefail

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2
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
LOCK_STALE_SECONDS=${MI8_LOCK_STALE_SECONDS:-21600}

die() { echo "STOP: $*" >&2; exit 1; }
say() { echo "[$(date '+%H:%M:%S')] $*"; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha must be a full 40-character lowercase SHA"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || die "--bundle must point at an existing hcis-<sha8>-<date>.tar.gz"
SHA8=${SHA:0:8}
NAME=$(basename "$BUNDLE" .tar.gz)
[[ "$NAME" =~ ^hcis-[0-9a-f]{8}-[0-9]{8}$ ]] || die "bundle name must be hcis-<sha8>-<yyyymmdd>.tar.gz"
[[ "$NAME" == "hcis-$SHA8-"* ]] || die "bundle $NAME does not match --sha $SHA"

# Per-checkout operator token: two sessions on one workstation use different worktrees, so
# they get different tokens and cannot both hold the release lock.
token_file="$(git rev-parse --git-dir)/mi8-release-operator"
if [[ ! -s "$token_file" ]]; then
  od -An -N12 -tx1 /dev/urandom | tr -d ' \n' >"$token_file"
fi
LOCK_TOKEN=$(tr -cd '0-9a-f' <"$token_file")
[[ ${#LOCK_TOKEN} -ge 16 ]] || die "could not create an operator token in $token_file"

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
LOCK_TOKEN='$LOCK_TOKEN'
LOCK_STALE_SECONDS=$LOCK_STALE_SECONDS
EOF
  cat <<'EOF'
# BEGIN release-lock
LOCK=/data/local/mi8vps/sq-core-release.lock
lock_field() { sed -n "s/^$1=//p" "$LOCK/owner" 2>/dev/null | head -n 1; }
# Fails unless the release lock is free or held by this operator.
lock_check() {
  [ -d "$LOCK" ] || return 0
  [ "$(lock_field token)" = "$LOCK_TOKEN" ] && return 0
  started=$(lock_field started); [ -n "$started" ] || started=0
  age=$(( $(date +%s) - started ))
  info="app=$(lock_field app) release=$(lock_field release) operator=$(lock_field operator) age=${age}s"
  [ "$age" -lt "$LOCK_STALE_SECONDS" ] || fail "stale release lock ($info); confirm nobody is releasing, then remove $LOCK by hand"
  fail "another operator holds the release lock ($info); wait for it to finish"
}
# END release-lock
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

# ------------------------------------------------- TRIP-002 uang saku gate (D-20)

# Migration 0172 seeds the six decree rates but, deliberately, no golongan mapping: deciding who
# counts as Pimpinan/Kepala Unit/Staf is the foundation's call, not a migration's guess. Until
# trip_per_diem_golongan_map resolves a golongan for the people who can actually ask for an
# advance, their per diem estimate, their new advance and their settlement all answer 409
# TRIP_PER_DIEM_GOLONGAN_UNMAPPED.
#
# D-22 (owner, 2026-11-24) decided where that check belongs: on the feature's own switch, not on
# the release. Migration 0183 ships uang saku OFF, the API refuses every attempt to switch it on
# whose readiness check fails (first time and every time after), and with it off nobody can reach
# the per diem path at all. So a release that does not touch uang saku — a leave fix, say — is no
# longer held behind a golongan map. Two gates remain here, and both are about this release:
#
#   * before migrate, that 0172 itself will not abort (DRAFT-zone rates), and
#   * after migrate, that a release does not walk away from a feature that IS switched on with
#     data that no longer resolves.
#
# There is no override. Everything the gate stops on is fixed by filling in data through the
# HCIS admin screens, in minutes, without a release; cutting over regardless only buys an
# outage (owner, 2026-11-20).
#
# The queries live in scripts/mi8/sql/ so that scripts/mi8/test-trip-002-gate.sh can drive the
# same text against a throwaway PostgreSQL instead of a second copy that drifts from this one.
TRIP_002_MIGRATION=0172_trip_per_diem_decree.sql
GATE_SQL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/sql" 2>/dev/null && pwd) || GATE_SQL_DIR=

# BEGIN trip-002-gate
# Everything between these markers is free of ssh and of this release's own state, so that
# scripts/mi8/test-trip-002-gate.sh can extract the block verbatim and run it against a real
# PostgreSQL. It reads $GATE_SQL_DIR, reports through say() and stops through die().

# Read one gate query and flatten it to a single line, so it can travel inside the nested double
# quotes of as_termux "psql ... \"...\"" on the device. Comments go first: once flattened, one
# of them would swallow the rest of the query.
gate_sql() {
  local file=$GATE_SQL_DIR/$1
  [[ -n "$GATE_SQL_DIR" && -f "$file" ]] || die "missing gate query scripts/mi8/sql/$1"
  local flat
  flat=$(sed -e 's/--.*$//' "$file" | tr '\n\r' '  ' | tr -s ' ')
  [[ -n "${flat// /}" ]] || die "gate query scripts/mi8/sql/$1 is empty after stripping comments"
  case "$flat" in
    *'"'*|*'\'*|*'$'*|*'`'*)
      die "scripts/mi8/sql/$1 must not contain a double quote, backslash, dollar sign or backtick: it travels inside nested double quotes" ;;
  esac
  printf '%s' "$flat"
}

# $1 = output of sql/trip-002-pre-migrate-gate.sql (one number).
#
# 0172 refuses to run while DRAFT-zone rates exist (they have no golongan and no one may guess
# one). Stop here instead of failing halfway through the release.
trip_002_pre_migrate_verdict() {
  local rates=${1//[[:space:]]/}
  [[ "$rates" =~ ^[0-9]+$ ]] || die "could not count trip_per_diem_rates (got: $1)"
  [[ "$rates" == 0 ]] \
    || die "trip_per_diem_rates holds $rates DRAFT-zone rate rows; migration $TRIP_002_MIGRATION will abort. Export them and empty the table first (TRIP-002 D-02)."
  say "trip-002 gate: trip_per_diem_rates is empty, $TRIP_002_MIGRATION may run"
}

# $1 = output of sql/trip-002-golongan-gate.sql, one SEVERITY|KIND|DETAIL row per line.
trip_002_mapped_verdict() {
  local fails warns junk
  # The sentinel first. psql writes its errors to stderr and prints NOTHING to stdout, which is
  # also exactly what a world with nothing to report looks like; without a row that is always
  # emitted, a query that never ran would be read as "everyone resolves" and the release would
  # cut over on no evidence at all. This is the same shape of defect the gate itself exists to
  # close, one layer up.
  printf '%s\n' "$1" | grep -qx 'OK|GATE|.*' \
    || die "trip-002 gate: the golongan query did not answer (no sentinel row). Treat this as a failed check, not a clean one; read the error above."
  fails=$(printf '%s\n' "$1" | grep '^FAIL|' || true)
  warns=$(printf '%s\n' "$1" | grep '^WARN|' || true)
  junk=$(printf '%s\n' "$1" | grep -v '^FAIL|' | grep -v '^WARN|' | grep -v '^OK|' \
    | grep -v '^[[:space:]]*$' || true)
  # An output shape this function no longer understands must stop the release too.
  [[ -z "$junk" ]] || die "trip-002 gate: unreadable answer from the golongan query: $junk"
  if [[ -n "$warns" ]]; then
    say "trip-002 gate: klasifikasi jabatan berjadwal yang belum dipetakan (belum menghentikan rilis):"
    printf '%s\n' "$warns" | sed 's/^WARN|/    /; s/|/ /'
  fi
  if [[ -z "$fails" ]]; then
    say "trip-002 gate: every eligible employee, every live advance and every classification in force today resolves to a golongan"
    return 0
  fi
  say "TRIP-002 GOLONGAN MAP INCOMPLETE - uang saku dinas is ON and answers 409 for these:"
  printf '%s\n' "$fails" | sed 's/^FAIL|/    /; s/|/ /'
  say "Fix: HC fills Admin -> Uang Muka Dinas -> \"Golongan uang saku per klasifikasi jabatan\", and the ORG-011 placement of anyone listed as EMPLOYEE_UNRESOLVED (TRIP-002 D-20)."
  die "golongan map incomplete while uang saku is ON; cutting over would leave it unusable. Fill it in, re-run this phase, and only then cut over. There is no override flag."
}

# $1 = output of sql/trip-002-tables-present.sql. Echoes "<map>|<switch>" on stdout, each
# ABSENT or PRESENT, and dies on anything it does not recognise.
trip_002_tables_present() {
  local answer=${1//[[:space:]]/}
  case "$answer" in
    'OK|TABLES|ABSENT|ABSENT') printf 'ABSENT|ABSENT' ;;
    'OK|TABLES|ABSENT|PRESENT') printf 'ABSENT|PRESENT' ;;
    'OK|TABLES|PRESENT|ABSENT') printf 'PRESENT|ABSENT' ;;
    'OK|TABLES|PRESENT|PRESENT') printf 'PRESENT|PRESENT' ;;
    *) die "trip-002 gate: could not tell which uang saku tables exist (got: $1). Treat this as a failed check, not a clean one." ;;
  esac
}

# $1 = the switch half of trip_002_tables_present, $2 = output of
# sql/trip-002-activation-state.sql (empty when the switch table is absent).
# Echoes ACTIVE or INACTIVE on stdout.
#
# D-22 (owner, 2026-11-24): the catalogue check belongs to the feature's own switch, not to the
# release. A release that does not turn uang saku on is not held up by an empty golongan map,
# because while the feature is off its two doors - the per diem estimate and a new advance -
# are shut, and the API refuses every attempt to open it whose readiness check fails, the first
# time and every time after.
trip_002_activation_state() {
  case "$1" in
    ABSENT)
      # 0183 has not run here yet, so there is no switch to read. On such a device the feature
      # was never lockable, so treat it as ON and ask the full question: that is exactly what
      # this gate did before the switch existed.
      printf 'ACTIVE' ;;
    PRESENT)
      local state=${2//[[:space:]]/}
      case "$state" in
        'OK|STATE|ACTIVE') printf 'ACTIVE' ;;
        'OK|STATE|INACTIVE') printf 'INACTIVE' ;;
        *) die "trip-002 gate: could not read the uang saku switch (got: $2). Treat this as a failed check, not a clean one." ;;
      esac ;;
    *) die "trip-002 gate: unreadable switch-table answer: $1" ;;
  esac
}

# $1 = ACTIVE or INACTIVE, $2 = output of sql/trip-002-golongan-gate.sql.
#
# The decision itself, kept free of ssh so the test can drive every branch.
#
# ON  - the whole question. Everyone who can ask for an advance must resolve to a golongan, and
#       so must every advance still in flight.
# OFF - only the advances still in flight. This is not symmetry for its own sake: switching the
#       feature off deliberately leaves approval, disbursement and settlement open, so money
#       that is already out can still be closed. POST /admin/trip-advances/:id/settle prices the
#       per diem from the map as it stands at settlement time, so an advance that stops
#       resolving is stranded with the money out whether the switch is on or off. Everything
#       else - an empty catalogue, an unmapped classification, an employee with no golongan -
#       breaks nobody while the doors are shut, and is exactly what HC fills in before opening
#       them.
trip_002_gate_verdict() {
  if [[ "$1" == ACTIVE ]]; then
    trip_002_mapped_verdict "$2"
    return
  fi
  # The sentinel still has to be there: an answer that never arrived must not read as "no
  # stranded advances", which is the same defect shape one layer up.
  printf '%s\n' "$2" | grep -qx 'OK|GATE|.*' \
    || die "trip-002 gate: the golongan query did not answer (no sentinel row). Treat this as a failed check, not a clean one; read the error above."
  local stranded
  stranded=$(printf '%s\n' "$2" | grep '^FAIL|ADVANCE_UNRESOLVED|' || true)
  if [[ -n "$stranded" ]]; then
    say "TRIP-002: uang saku is OFF, but these advances are already out and no longer resolve to a golongan:"
    printf '%s\n' "$stranded" | sed 's/^FAIL|/    /; s/|/ /'
    say "Settlement prices the per diem from the golongan map at settlement time, so each of these would answer 409 with the money already disbursed."
    die "live advances no longer resolve; fix the golongan map or the ORG-011 placement behind them, re-run this phase, and only then cut over. There is no override flag."
  fi
  say "trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded; the golongan map is checked in full when someone turns it on (TRIP-002 D-22)"
}
# END trip-002-gate

trip_002_in_bundle() {
  grep -qx "$TRIP_002_MIGRATION" <<<"$BUNDLE_MIGRATIONS"
}

# Run one gate query on the device. Read-only, so it runs in dry run too.
gate_query() {
  local sql script
  # gate_sql dies on a missing or unusable query file, but a die() inside a command
  # substitution only ends that subshell, and this function is always called on the left of a
  # `|| die`, where errexit does not apply either. So its status is looked at right here.
  sql=$(gate_sql "$1") || return 1
  script=$(printf 'as_termux "psql -U postgres -d $DB -Atc \\"%s\\""\n' "$sql")
  remote_ro <<<"$script" | tr -d '\r'
}

# Before migrate.
#
# The query's exit status is captured into a variable first, on purpose. Written as
# `verdict "$(gate_query ...)"` the substitution sits in an argument position, where bash does
# not apply errexit, so a failed query would arrive as an empty string and be judged on.
trip_002_gate_pre_migrate() {
  trip_002_in_bundle || return 0
  grep -qx "$TRIP_002_MIGRATION" <<<"$PENDING" || return 0
  local rates
  rates=$(gate_query trip-002-pre-migrate-gate.sql) \
    || die "trip-002 gate: could not read trip_per_diem_rates from the device; read the error above"
  trip_002_pre_migrate_verdict "$rates"
}

# After migrate, before cutover.
#
# This runs on every release, not only on the one carrying 0172, because the question is about
# the state of the feature on the device, not about this bundle. With uang saku off it costs two
# trivial queries and lets the release through — that is the normal case today, and it is why a
# leave fix no longer waits for a golongan map. With uang saku on, the full question is asked:
# it starts from the people who can actually submit a trip advance and from the advances already
# in flight, because that is what resolveGolongan() is asked about at runtime.
trip_002_gate_mapped() {
  local answer tables map switch state verdict report
  answer=$(gate_query trip-002-tables-present.sql) \
    || die "trip-002 gate: could not ask the device which uang saku tables exist; read the error above"
  # Each helper is called as an assignment, not inside an argument: a die() inside a command
  # substitution only ends that subshell, so its status has to be looked at here.
  tables=$(trip_002_tables_present "$answer") || exit 1
  map=${tables%%|*}
  switch=${tables##*|}
  if [[ "$map" != PRESENT ]]; then
    # 0172 has not run here yet, so there is no golongan map to ask about and no advance can
    # have been priced from one. A dry run taken before migrate lands here.
    say "trip-002 gate: trip_per_diem_golongan_map does not exist on the device yet ($TRIP_002_MIGRATION has not run), so there is nothing to check"
    return 0
  fi
  state=
  if [[ "$switch" == PRESENT ]]; then
    state=$(gate_query trip-002-activation-state.sql) \
      || die "trip-002 gate: could not read the uang saku switch from the device; read the error above"
  fi
  verdict=$(trip_002_activation_state "$switch" "$state") || exit 1
  report=$(gate_query trip-002-golongan-gate.sql) \
    || die "trip-002 gate: the golongan query failed on the device; read the error above. That is a failed check, not a clean one."
  trip_002_gate_verdict "$verdict" "$report"
}

# ---------------------------------------------------------------- release lock

lock_acquire() {
  [[ "$APPLY" == 1 ]] || return 0
  local operator
  operator=$(printf '%s' "${MI8_OPERATOR:-$(whoami)@$(hostname)}" | tr -cd 'A-Za-z0-9@._-')
  { prelude; cat <<EOF; } | ssh -o BatchMode=yes "$SSH_ROOT" /system/bin/sh -s
if mkdir "\$LOCK" 2>/dev/null; then
  printf 'app=hcis\nrelease=%s\ntoken=%s\noperator=%s\nstarted=%s\n' "\$NAME" "\$LOCK_TOKEN" '$operator' "\$(date +%s)" >"\$LOCK/owner"
fi
lock_check
[ "\$(lock_field token)" = "\$LOCK_TOKEN" ] || fail "release lock exists without a readable owner file; inspect \$LOCK"
echo "release_lock=held release=\$(lock_field release)"
EOF
}

lock_release() {
  [[ "$APPLY" == 1 ]] || { say "dry-run: would release the release lock"; return 0; }
  remote_ro <<'EOF'
if [ -d "$LOCK" ]; then
  [ "$(lock_field token)" = "$LOCK_TOKEN" ] || fail "release lock is held by another operator; not releasing it"
  rm -f "$LOCK/owner"; rmdir "$LOCK"
fi
echo "release_lock=released"
EOF
}

# ---------------------------------------------------------------- phases

phase_preflight() {
  check_main
  bundle_checks
  remote_ro <<'EOF'
lock_check
if [ -d "$LOCK" ]; then echo "release_lock=held_by_this_operator"; else echo "release_lock=free"; fi
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
  trip_002_gate_pre_migrate
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
  bundle_checks
  # Runs before cutover and stops the release, exactly like the HTTP checks below.
  trip_002_gate_mapped
  remote_rw "candidate gate: $NAME API on :$CAND_API_PORT and web on :$CAND_WEB_PORT, then stop both" <<'EOF'
[ -d "$R$REL/$NAME" ] || fail "$NAME is not uploaded"
[ "$(running_release node apps/api || true)" != "$NAME" ] || fail "$NAME already serves production"
LOG=/srv/hcis/logs/candidate-$NAME.log
nohup chroot "$R" /usr/sbin/runuser -u sqhcis -- /bin/sh -c "set -a; . /srv/hcis/shared/final.env; set +a; export HOST=127.0.0.1 PORT=$CAND_API_PORT MEETING_RUNNER_ENABLED=0; cd $REL/$NAME/apps/api; exec /usr/bin/node dist/server.js" </dev/null >>"$R$LOG" 2>&1 &
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
  upload) lock_acquire; phase_upload ;;
  backup) lock_acquire; phase_backup ;;
  migrate) lock_acquire; phase_migrate ;;
  candidate) lock_acquire; phase_candidate ;;
  cutover) lock_acquire; phase_cutover ;;
  verify) phase_verify; lock_release ;;
  rollback) lock_acquire; phase_rollback; lock_release ;;
  unlock) lock_release ;;
  all)
    phase_preflight
    lock_acquire
    phase_upload
    phase_backup
    phase_migrate
    phase_candidate
    phase_cutover
    if [[ "$APPLY" == 1 ]]; then phase_verify; lock_release; else say "dry-run: verify runs after cutover"; fi
    ;;
  *) usage ;;
esac
