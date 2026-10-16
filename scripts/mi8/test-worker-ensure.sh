#!/system/bin/sh
# Offline test for the ensure logic in sq-core-worker.sh (OPS-MI8-KC-001 part B).
# It extracts only the "BEGIN ensure".."END ensure" block and runs it against
# stubs: it never probes, stops or launches a real service. Run it with the
# device shell (/system/bin/sh) from any scratch directory:
#   sh test-worker-ensure.sh [path/to/sq-core-worker.sh]
set -u

WORKER=${1:-$(dirname "$0")/sq-core-worker.sh}
block=$(sed -n '/^# BEGIN ensure/,/^# END ensure/p' "$WORKER")
[ -n "$block" ] || { echo "FAIL ensure block not found in $WORKER"; exit 1; }
eval "$block"

# Stubs. ready/service_pid read READY/ALIVE; stop and launch record events.
NOW=1000
date() { if [ "${1:-}" = +%s ]; then echo "$NOW"; else command date "$@"; fi; }
log() { :; }
ready() { [ "$READY" = 1 ]; }
service_pid() { [ "$ALIVE" = 1 ] && echo 4242; }
stop_service() { EVENTS="$EVENTS stop"; ALIVE=0; }
fake_launch() { EVENTS="$EVENTS launch"; ALIVE=1; }
LAUNCH=fake_launch

reset() {
  NOW=1000; EVENTS=""; READY=0; ALIVE=0; attempts=0; next_start=0
  for s in keycloak hub-web; do svc_set fails "$s" 0; svc_set starting "$s" 0; done
}
# probe SVC N: N worker loop iterations (15 s apart) that each run ensure SVC.
probe() { i=0; while [ "$i" -lt "$2" ]; do ensure "$1"; NOW=$((NOW + 15)); i=$((i + 1)); done; }

failed=0
expect() {
  if [ "$EVENTS" = "$2" ]; then echo "PASS $1"; else echo "FAIL $1: events='$EVENTS' want='$2'"; failed=1; fi
}

reset; ALIVE=1; READY=1; probe keycloak 1; READY=0; probe keycloak 7
expect "healthy keycloak survives 7 consecutive failed probes" ""
probe keycloak 1
expect "keycloak stopped and relaunched on the 8th failed probe" " stop launch"

reset; ALIVE=1; READY=0; probe keycloak 7; READY=1; probe keycloak 1; READY=0; probe keycloak 7
expect "one ready probe resets the failure count" ""

reset; ALIVE=1; READY=1; probe keycloak 1; NOW=$((NOW + 7200)); READY=0; probe keycloak 1; READY=1; probe keycloak 1
expect "wall-clock jump after suspend plus one failed probe does not stop" ""

reset; READY=0; probe keycloak 1
expect "missing keycloak is launched on the first failed probe" " launch"
probe keycloak 11
expect "slow keycloak start gets 11 more probes of grace" " launch"
probe keycloak 1
expect "startup grace exhausted on the 12th probe after launch" " launch stop launch"

reset; READY=0; probe keycloak 1; probe keycloak 9; READY=1; probe keycloak 1; READY=0; probe keycloak 7
expect "after the first ready, normal fail limit applies, not grace" " launch"

reset; ALIVE=1; READY=1; probe keycloak 1; ALIVE=0; READY=0; probe keycloak 1
expect "crashed keycloak is relaunched without waiting" " launch"

reset; ALIVE=1; READY=0; probe hub-web 5
expect "hub-web survives 5 failed probes" ""
probe hub-web 1
expect "hub-web stopped and relaunched on the 6th failed probe" " stop launch"

reset; ALIVE=1; READY=0; probe keycloak 7; probe hub-web 1
expect "counters are per service (hyphenated names too)" ""
[ "$(svc_count fails keycloak)" = 7 ] && [ "$(svc_count fails hub-web)" = 1 ] \
  && echo "PASS per-service counters keycloak=7 hub-web=1" \
  || { echo "FAIL per-service counters"; failed=1; }

reset; READY=0; next_start=$((NOW + 60)); probe keycloak 1
expect "launch backoff still respected" ""

[ "$failed" = 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
