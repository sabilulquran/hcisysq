#!/bin/sh
# Offline test for the release lock in release-mi8.sh (OPS-MI8-REL-001).
# It extracts only the "BEGIN release-lock".."END release-lock" block and runs it
# against a temporary lock directory; it never contacts Mi8VPS. Run it with any POSIX
# shell (the device shell is /system/bin/sh):
#   sh scripts/mi8/test-release-lock.sh [path/to/release-mi8.sh]
set -u

SCRIPT=${1:-$(dirname "$0")/release-mi8.sh}
block=$(sed -n '/^# BEGIN release-lock/,/^# END release-lock/p' "$SCRIPT")
[ -n "$block" ] || { echo "FAIL release-lock block not found in $SCRIPT"; exit 1; }
eval "$block"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOCK=$TMP/sq-core-release.lock
LOCK_STALE_SECONDS=21600
fail() { echo "STOP: $*"; exit 1; }
passed=0; failed=0
expect() { # expect NAME ok|stop TOKEN
  if out=$( LOCK_TOKEN=$3; lock_check ) ; then got=ok; else got=stop; fi
  if [ "$got" = "$2" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $1: got $got ($out)"; fi
}
hold() { # hold TOKEN STARTED
  mkdir -p "$LOCK"
  printf 'app=hcis\nrelease=hcis-0000000a-20261016\ntoken=%s\noperator=test@ws\nstarted=%s\n' "$1" "$2" >"$LOCK/owner"
}
now=$(date +%s)

rm -rf "$LOCK"; expect "free lock" ok aaaa1111aaaa1111
hold aaaa1111aaaa1111 "$now"; expect "own fresh lock" ok aaaa1111aaaa1111
expect "other operator, fresh lock" stop bbbb2222bbbb2222
hold aaaa1111aaaa1111 $((now - 30000)); expect "other operator, stale lock still stops" stop bbbb2222bbbb2222
rm -rf "$LOCK"; mkdir -p "$LOCK"; expect "lock dir without owner file stops" stop bbbb2222bbbb2222

# Two operators racing: mkdir is atomic, so only the first one gets the lock.
rm -rf "$LOCK"
mkdir "$LOCK" 2>/dev/null && first=yes || first=no
mkdir "$LOCK" 2>/dev/null && second=yes || second=no
if [ "$first/$second" = "yes/no" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL atomic mkdir race: $first/$second"; fi

echo "release-lock tests: $passed passed, $failed failed"
[ "$failed" = 0 ]
