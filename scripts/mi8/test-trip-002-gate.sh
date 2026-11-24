#!/usr/bin/env bash
# PostgreSQL-backed test for the TRIP-002 uang saku release gate in release-mi8.sh
# (OPS-MI8-REL-001, spec docs/domain/trip-advance-per-diem.md D-02/D-20).
#
# It exercises the real thing, not a copy:
#   * the queries in scripts/mi8/sql/, read through the script's own gate_sql() flattening, and
#   * the "BEGIN trip-002-gate".."END trip-002-gate" block extracted from release-mi8.sh,
# the same way scripts/mi8/test-release-lock.sh extracts the release-lock block. Only ssh is
# left out: the device is never contacted.
#
# It needs an EMPTY loopback PostgreSQL database it may create and drop schemas in; it migrates
# apps/api/migrations into a disposable schema, so the schema under test is the production one.
#
#   HCIS_GATE_TEST_DATABASE_URL=postgres://hcis@127.0.0.1:5432/hcis_mi8_gate_test \
#     bash scripts/mi8/test-trip-002-gate.sh [path/to/release-mi8.sh]
set -uo pipefail

SCRIPT=${1:-$(dirname "$0")/release-mi8.sh}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
GATE_SQL_DIR=$(cd "$(dirname "$SCRIPT")/sql" && pwd) || { echo "FAIL scripts/mi8/sql not found"; exit 1; }
MIGRATIONS=$ROOT/apps/api/migrations

URL=${HCIS_GATE_TEST_DATABASE_URL:-}
if [[ -z "$URL" ]]; then
  echo "FAIL set HCIS_GATE_TEST_DATABASE_URL to an empty loopback database, e.g." >&2
  echo "       HCIS_GATE_TEST_DATABASE_URL=postgres://hcis@127.0.0.1:5432/hcis_mi8_gate_test" >&2
  exit 2
fi
# Never point this at production or at a database someone is using: it creates schemas, runs
# every migration and truncates the fixture tables between cases.
[[ "$URL" =~ ^postgres(ql)?://[^/]*@?(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/ ]] \
  || { echo "FAIL HCIS_GATE_TEST_DATABASE_URL must be a loopback URL" >&2; exit 2; }

# The release script's own helpers, extracted verbatim.
block=$(sed -n '/^# BEGIN trip-002-gate/,/^# END trip-002-gate/p' "$SCRIPT")
[[ -n "$block" ]] || { echo "FAIL trip-002-gate block not found in $SCRIPT"; exit 1; }
# shellcheck disable=SC2086
eval "$block"

# Stand-ins for the release script's reporting; die() must stop, exactly as it does in a release.
say() { echo "    [gate] $*"; }
die() { echo "STOP: $*" >&2; exit 1; }
TRIP_002_MIGRATION=0172_trip_per_diem_decree.sql

SCHEMA=trip002_gate_$$
export PGOPTIONS="-c search_path=$SCHEMA,public"
psql_run() { psql -d "$URL" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() { PGOPTIONS= psql -d "$URL" -q -c "DROP SCHEMA IF EXISTS $SCHEMA CASCADE" >/dev/null 2>&1; }
trap cleanup EXIT

# public must be empty of HCIS tables, or "CREATE TABLE IF NOT EXISTS" in the migrations would
# find them there and the fixture would silently run against someone else's data.
occupied=$(PGOPTIONS= psql -d "$URL" -At -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('employees','job_classifications','trip_advances')") || exit 1
[[ "$occupied" == 0 ]] || { echo "FAIL $URL already holds HCIS tables in public; use an empty database" >&2; exit 2; }

echo "migrating apps/api/migrations into schema $SCHEMA ..."
PGOPTIONS= psql -d "$URL" -v ON_ERROR_STOP=1 -q -c "CREATE SCHEMA $SCHEMA" || exit 1
for file in "$MIGRATIONS"/*.sql; do
  psql_run --single-transaction -c "SET client_min_messages = warning" -f "$file" \
    || { echo "FAIL migration $(basename "$file")" >&2; exit 1; }
done
echo "migrated $(ls "$MIGRATIONS"/*.sql | wc -l | tr -d ' ') files"

passed=0; failed=0
report() { # report ok|fail NAME MESSAGE
  if [[ "$1" == ok ]]; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $2: $3"; fi
}

# Run one gate query through the script's own flattening, then its verdict, in a subshell so
# that die() stops only the verdict. Sets VERDICT_STATUS and VERDICT_OUTPUT.
run_verdict() { # run_verdict <query file> <verdict function>
  local sql out
  sql=$(gate_sql "$1") || { VERDICT_STATUS=97; VERDICT_OUTPUT="gate_sql failed"; return; }
  out=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$sql" 2>&1) || {
    VERDICT_STATUS=98; VERDICT_OUTPUT="psql failed: $out"; return
  }
  VERDICT_OUTPUT=$( ( "$2" "$out" ) 2>&1 )
  VERDICT_STATUS=$?
}

# Drive a verdict with a literal answer, for the answer shapes a query can produce that are not
# rows at all: nothing (psql writes its errors to stderr) and text this gate does not understand.
drive_verdict() { # drive_verdict <verdict fn> <answer>
  VERDICT_OUTPUT=$( ( "$1" "$2" ) 2>&1 )
  VERDICT_STATUS=$?
}

# Substrings the output must contain; one prefixed with ! must NOT appear.
check_wanted() { # check_wanted NAME <substring>...
  local name=$1 wrong="" ; shift
  for want in "$@"; do
    if [[ "$want" == '!'* ]]; then
      [[ "$VERDICT_OUTPUT" != *"${want#!}"* ]] || wrong="$wrong [unwanted: ${want#!}]"
    else
      [[ "$VERDICT_OUTPUT" == *"$want"* ]] || wrong="$wrong [missing: $want]"
    fi
  done
  printf '%s' "$wrong"
}

check_stop() { # check_stop NAME <substring>...
  local name=$1; shift
  if [[ "$VERDICT_STATUS" == 0 ]]; then
    report fail "$name" "gate passed but should have stopped the release; output: $VERDICT_OUTPUT"
    return
  fi
  if [[ "$VERDICT_STATUS" -gt 90 ]]; then report fail "$name" "$VERDICT_OUTPUT"; return; fi
  local wrong; wrong=$(check_wanted "$name" "$@")
  if [[ -n "$wrong" ]]; then
    report fail "$name" "stopped, but:$wrong; output: $VERDICT_OUTPUT"
  else
    report ok "$name" ""
    echo "ok   $name (stops, names what is missing)"
  fi
}

check_pass() { # check_pass NAME <substring>...
  local name=$1; shift
  if [[ "$VERDICT_STATUS" != 0 ]]; then
    report fail "$name" "gate stopped the release but should have passed; output: $VERDICT_OUTPUT"
    return
  fi
  local wrong; wrong=$(check_wanted "$name" "$@")
  if [[ -n "$wrong" ]]; then
    report fail "$name" "passed, but:$wrong; output: $VERDICT_OUTPUT"
  else
    report ok "$name" ""
    echo "ok   $name (passes)"
  fi
}

expect_stop() { # expect_stop NAME <query> <verdict fn> <substring>...
  local name=$1 query=$2 verdict=$3; shift 3
  run_verdict "$query" "$verdict"
  check_stop "$name" "$@"
}

expect_pass() { # expect_pass NAME <query> <verdict fn> [substring]...
  local name=$1 query=$2 verdict=$3; shift 3
  run_verdict "$query" "$verdict"
  check_pass "$name" "$@"
}

# ------------------------------------------------------------------ fixture

FIXTURE_TABLES="employees, employments, employment_actions, employment_placements,
  job_classifications, trip_per_diem_golongan_map, trip_per_diem_rates, trip_advances,
  business_trip_requests, accounts, organization_change_sets, organization_positions,
  organization_nodes, trip_per_diem_activation"

# employments, placements and trip advances are append-only in production: triggers refuse
# DELETE and TRUNCATE. A fixture must still be able to reset between cases, so the writes below
# run as a replica session, which is also the only thing that lets the fixture speak in rows.
FIXTURE_PRELUDE="SET client_min_messages = warning;
SET session_replication_role = 'replica';"

# A complete, healthy world: one classification in force, mapped, bound to one eligible employee.
seed_complete() {
  psql_run <<SQL || exit 1
$FIXTURE_PRELUDE
TRUNCATE $FIXTURE_TABLES RESTART IDENTITY CASCADE;

INSERT INTO accounts (id, email, principal_type, status,
  mfa_enabled_at, mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag)
VALUES ('00000000-0000-4000-8000-00000000a001', 'hc@example.invalid', 'SUPER_ADMIN', 'active',
        now(), 'synthetic', 'synthetic', 'synthetic');

INSERT INTO employees (id, employee_number, full_name, status, management_scope)
VALUES ('00000000-0000-4000-8000-0000000000e1', 'E-001', 'Pegawai Satu', 'active', 'MANAGED');

INSERT INTO employments (id, employee_id, started_on, start_basis, source, opened_by_action_id)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000e1',
        DATE '2020-01-01', 'RECORDED', 'BASELINE_FROM_MASTER',
        '00000000-0000-4000-8000-0000000000ad');

INSERT INTO employment_actions (id, employee_id, employment_id, action_type)
VALUES ('00000000-0000-4000-8000-0000000000ad', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000b1', 'BASELINE');

INSERT INTO employment_placements
  (id, employment_id, kind, org_node_key, job_title_label, job_classification_code,
   effective_from, effective_from_basis, opened_by_action_id)
VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1',
        'PRIMARY', '00000000-0000-4000-8000-0000000000f1', 'Guru Kelas', 'GURU',
        DATE '2020-01-01', 'RECORDED', '00000000-0000-4000-8000-0000000000ad');

INSERT INTO job_classifications (id, code, name, family, effective_from)
VALUES ('00000000-0000-4000-8000-0000000000c1', 'GURU', 'Guru', 'FUNCTIONAL', DATE '2020-01-01');

INSERT INTO trip_per_diem_golongan_map (job_classification_code, golongan, updated_by_account_id)
VALUES ('GURU', 'STAF', '00000000-0000-4000-8000-00000000a001');
SQL
  # A fixture that quietly did nothing would turn every case into a false pass.
  local landed
  landed=$(psql -d "$URL" -At -c "SELECT count(*) FROM employees, trip_per_diem_golongan_map") || exit 1
  [[ "$landed" == 1 ]] || { echo "FAIL the base fixture did not land (got $landed rows)" >&2; exit 1; }
}

# Per-case fixture edit. The command tag is checked as well as the exit status: a statement that
# never ran would leave the case testing the base fixture and quietly passing.
sql_do() {
  local out
  out=$(psql -d "$URL" -v ON_ERROR_STOP=1 -c "$FIXTURE_PRELUDE" -c "$1" 2>&1) \
    || { echo "FAIL fixture statement: $out" >&2; exit 1; }
  case "$out" in
    *INSERT*|*UPDATE*|*DELETE*) ;;
    *) echo "FAIL fixture statement reported no change: $out" >&2; exit 1 ;;
  esac
}

# ------------------------------------------------------------------ cases

echo
echo "-- failing cases"

# 1. DEFECT: an empty classification catalogue used to satisfy the catalogue-only check while
#    every employee still resolved to no golongan.
seed_complete
sql_do "DELETE FROM job_classifications"
expect_stop "empty classification catalogue stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "CATALOGUE_EMPTY" "STOP:"

# 2. DEFECT: an eligible employee with no classification binding at all is invisible to a check
#    that starts from classifications. E-002 is active and MANAGED but has no placement.
seed_complete
sql_do "INSERT INTO employees (id, employee_number, full_name, status, management_scope)
        VALUES ('00000000-0000-4000-8000-0000000000e2', 'E-002', 'Pegawai Dua', 'active', 'MANAGED')"
expect_stop "eligible employee without any classification stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "EMPLOYEE_UNRESOLVED" "E-002" "STOP:"

# 3. DEFECT (second half): a binding that maps to nothing. E-003 holds a classification that was
#    closed in the catalogue, so the catalogue-only check never sees it, while resolveGolongan
#    still refuses because the code has no mapping.
seed_complete
sql_do "INSERT INTO employees (id, employee_number, full_name, status, management_scope)
        VALUES ('00000000-0000-4000-8000-0000000000e3', 'E-003', 'Pegawai Tiga', 'active', 'MANAGED');
        INSERT INTO employments (id, employee_id, started_on, start_basis, source, opened_by_action_id)
        VALUES ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000e3',
                DATE '2020-01-01', 'RECORDED', 'BASELINE_FROM_MASTER',
                '00000000-0000-4000-8000-0000000000a3');
        INSERT INTO employment_actions (id, employee_id, employment_id, action_type)
        VALUES ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000e3',
                '00000000-0000-4000-8000-0000000000b3', 'BASELINE');
        INSERT INTO employment_placements
          (id, employment_id, kind, org_node_key, job_title_label, job_classification_code,
           effective_from, effective_from_basis, opened_by_action_id)
        VALUES ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000b3',
                'PRIMARY', '00000000-0000-4000-8000-0000000000f3', 'Penjaga', 'PENJAGA_LAMA',
                DATE '2020-01-01', 'RECORDED', '00000000-0000-4000-8000-0000000000a3');
        INSERT INTO job_classifications (id, code, name, family, effective_from, effective_to)
        VALUES ('00000000-0000-4000-8000-0000000000c3', 'PENJAGA_LAMA', 'Penjaga (ditutup)',
                'SUPPORT', DATE '2020-01-01', current_date - 1)"
expect_stop "unmapped binding outside today's catalogue stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "EMPLOYEE_UNRESOLVED" "E-003" "STOP:"

# 4. Already covered: a classification in force today that HC has not mapped. Nobody holds it
#    yet, so only the catalogue check can see it.
seed_complete
sql_do "INSERT INTO job_classifications (id, code, name, family, effective_from)
        VALUES ('00000000-0000-4000-8000-0000000000c4', 'KEPALA_UNIT_BARU', 'Kepala Unit Baru',
                'STRUCTURAL', DATE '2020-01-01')"
expect_stop "classification in force today without a mapping stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "CLASSIFICATION_UNMAPPED" "KEPALA_UNIT_BARU" "STOP:"

# 5. Already covered, and isolated to the departure-date arm: the employee resolves perfectly
#    TODAY on their current placement, but the advance departed ten days ago, when they held a
#    classification that has since been closed and was never mapped. Only ADVANCE_UNRESOLVED may
#    fire — if EMPLOYEE_UNRESOLVED fired too, this case would not be testing the date at all.
seed_complete
sql_do "UPDATE employment_placements SET effective_from = current_date - 5
         WHERE id = '00000000-0000-4000-8000-0000000000d1';
        INSERT INTO employment_placements
          (id, employment_id, kind, org_node_key, job_title_label, job_classification_code,
           effective_from, effective_to, effective_from_basis, opened_by_action_id)
        VALUES ('00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000b1',
                'PRIMARY', '00000000-0000-4000-8000-0000000000f1', 'Guru Kelas', 'GURU_LAMA',
                DATE '2020-01-01', current_date - 6, 'RECORDED',
                '00000000-0000-4000-8000-0000000000ad');
        INSERT INTO job_classifications (id, code, name, family, effective_from, effective_to)
        VALUES ('00000000-0000-4000-8000-0000000000c5', 'GURU_LAMA', 'Guru (lama)', 'FUNCTIONAL',
                DATE '2020-01-01', current_date - 6);
        INSERT INTO business_trip_requests
          (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
        VALUES ('00000000-0000-4000-8000-0000000000ba', '00000000-0000-4000-8000-0000000000e1',
                'Jakarta', 'Rapat koordinasi yayasan', current_date - 10, current_date - 9,
                'APPROVED', '00000000-0000-4000-8000-0000000000ca');
        INSERT INTO trip_advances
          (id, employee_id, business_trip_id, wilayah, amount, purpose, status, idempotency_key)
        VALUES ('00000000-0000-4000-8000-0000000000be', '00000000-0000-4000-8000-0000000000e1',
                '00000000-0000-4000-8000-0000000000ba', 'LUAR_DAERAH', 500000,
                'Uang muka rapat koordinasi', 'IN_REVIEW',
                '00000000-0000-4000-8000-0000000000cb')"
# The unwanted substring carries the employee number: the advice line names the EMPLOYEE_UNRESOLVED
# kind in prose whether or not that arm fired, and only a finding row is followed by one.
expect_stop "live advance unresolved on its own departure date stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict \
  "ADVANCE_UNRESOLVED" "STOP:" '!EMPLOYEE_UNRESOLVED E-'

# 6. Already covered: the pre-migrate gate must still abort on a non-empty rate table.
seed_complete
sql_do "INSERT INTO trip_per_diem_rates
          (id, golongan, wilayah, effective_from, daily_amount, created_by_account_id)
        VALUES ('00000000-0000-4000-8000-0000000000fa', 'STAF', 'DALAM_DAERAH',
                DATE '2026-07-10', 60000, '00000000-0000-4000-8000-00000000a001')"
expect_stop "pre-migrate gate aborts on a non-empty rate table" \
  trip-002-pre-migrate-gate.sql trip_002_pre_migrate_verdict "DRAFT-zone rate rows" "STOP:"

# 7. An employee outside HCIS management with no classification. The uang muka route does not
#    test management_scope at all, so such a person with an active account is refused 409 at
#    runtime; the gate must be a superset of the route, never narrower than it.
#    (The separate question of whether they should be able to travel is not settled here.)
seed_complete
sql_do "INSERT INTO employees (id, employee_number, full_name, status, management_scope,
          management_scope_reason, management_scope_note, management_scope_marked_at)
        VALUES ('00000000-0000-4000-8000-0000000000e9', 'E-009', 'Pengurus Yayasan', 'active',
                'OUTSIDE_HCIS', 'PENGURUS_YAYASAN', 'Pengurus yayasan, di luar pengelolaan HCIS',
                now())"
expect_stop "employee outside HCIS management without a golongan stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "EMPLOYEE_UNRESOLVED" "E-009" "STOP:"

# 8. The answer shapes that are not rows. psql writes its errors to stderr and prints nothing to
#    stdout, which is byte for byte what "nothing to report" looks like; without the sentinel
#    row the verdict would read a failed query as a clean one and let the cutover proceed on no
#    evidence at all. This is the defect the gate itself exists to close, one layer up, so it is
#    driven here directly rather than through psql, which this harness checks more carefully
#    than the release script can.
drive_verdict trip_002_mapped_verdict ""
check_stop "an empty answer stops the release instead of reading as clean" \
  "did not answer" "STOP:" '!resolves to a golongan'

drive_verdict trip_002_mapped_verdict "ERROR:  relation \"trip_per_diem_golongan_map\" does not exist"
check_stop "an answer the gate does not understand stops the release" \
  "STOP:" '!resolves to a golongan'

drive_verdict trip_002_pre_migrate_verdict ""
check_stop "an empty rate count stops the release" "could not count" "STOP:"

echo
echo "-- passing cases"

# 9. A complete catalogue and a complete mapping: the release may proceed.
seed_complete
expect_pass "complete catalogue and mapping let the release through" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "resolves to a golongan"

# 10. A future-dated, unmapped classification is reported but does not stop the release: it breaks
#    nothing today, and HC can map it before it takes effect.
seed_complete
sql_do "INSERT INTO job_classifications (id, code, name, family, effective_from)
        VALUES ('00000000-0000-4000-8000-0000000000c8', 'GURU_BESAR', 'Guru Besar', 'FUNCTIONAL',
                current_date + 30)"
expect_pass "future-dated unmapped classification warns without stopping" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "CLASSIFICATION_UNMAPPED_FUTURE" "GURU_BESAR"

# 11. An employee who left is not eligible and must not stop a release.
seed_complete
sql_do "INSERT INTO employees (id, employee_number, full_name, status, management_scope)
        VALUES ('00000000-0000-4000-8000-0000000000ea', 'E-010', 'Pegawai Resign', 'resigned',
                'MANAGED')"
expect_pass "an employee who is no longer active does not stop the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "resolves to a golongan"

# 12. An empty rate table lets the migration run.
seed_complete
expect_pass "pre-migrate gate passes on an empty rate table" \
  trip-002-pre-migrate-gate.sql trip_002_pre_migrate_verdict "may run"

# ------------------------------------------------- the switch itself (D-22)
#
# The owner's decision of 2026-11-24 moved the catalogue check off the release and onto the
# feature's own switch. Three things have to be true for that to be safe, and all three are
# asserted here: a release must sail past a broken golongan map while uang saku is OFF, it must
# still be stopped by the very same map while it is ON, and it must STILL be stopped while OFF
# by an advance that is already out and no longer resolves — because settlement stays open while
# the feature is off and prices the per diem at settlement time.

echo
echo "-- the uang saku switch"

# 13. Which tables exist. A device that has had neither migration, one that has 0172 only, and
#     one that has both.
VERDICT_OUTPUT=$( ( trip_002_tables_present "OK|TABLES|ABSENT|ABSENT" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "a device with neither table is read as neither" "ABSENT|ABSENT"
VERDICT_OUTPUT=$( ( trip_002_tables_present "OK|TABLES|PRESENT|ABSENT" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "a device with the map but no switch is read as such" "PRESENT|ABSENT"
VERDICT_OUTPUT=$( ( trip_002_tables_present "" ) 2>&1 ); VERDICT_STATUS=$?
check_stop "an empty answer about the tables stops the release" "could not tell" "STOP:"

# 14. The switch. No switch table means the feature was never lockable on that device, so the
#     full question is asked — exactly what this gate did before the switch existed.
VERDICT_OUTPUT=$( ( trip_002_activation_state "ABSENT" "" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "a device without the switch table is treated as ON, not as OFF" "ACTIVE"
VERDICT_OUTPUT=$( ( trip_002_activation_state "PRESENT" "OK|STATE|INACTIVE" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "a switch that is off reads as OFF" "INACTIVE"
VERDICT_OUTPUT=$( ( trip_002_activation_state "PRESENT" "OK|STATE|ACTIVE" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "a switch that is on reads as ON" "ACTIVE"

# 15. An answer that never arrived must not read as "off", which would be a silent pass - the
#     same defect shape the sentinel rows exist to close.
VERDICT_OUTPUT=$( ( trip_002_activation_state "PRESENT" "" ) 2>&1 ); VERDICT_STATUS=$?
check_stop "an empty answer about the switch state stops the release" "could not read" "STOP:"

# 16. THE DECISION. The identical empty-map report stops the release with the feature on and
#     lets it through with the feature off. This is what lets a leave release go out today.
seed_complete
sql_do "DELETE FROM trip_per_diem_golongan_map"
broken=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-golongan-gate.sql)") || exit 1
VERDICT_OUTPUT=$( ( trip_002_gate_verdict ACTIVE "$broken" ) 2>&1 ); VERDICT_STATUS=$?
check_stop "an empty golongan map stops the release while uang saku is ON" \
  "EMPLOYEE_UNRESOLVED" "STOP:"
VERDICT_OUTPUT=$( ( trip_002_gate_verdict INACTIVE "$broken" ) 2>&1 ); VERDICT_STATUS=$?
check_pass "the same empty golongan map lets the release through while uang saku is OFF" \
  "uang saku dinas is OFF" '!STOP:'

# 17. ...but not when somebody's money is already out. Same world as case 5 (an advance that
#     departed holding a classification since closed and never mapped), judged with the feature
#     OFF: settlement is not shut by the lock and prices the per diem at settlement time, so
#     this one must still stop the release.
seed_complete
sql_do "UPDATE employment_placements SET effective_from = current_date - 5
         WHERE id = '00000000-0000-4000-8000-0000000000d1';
        INSERT INTO employment_placements
          (id, employment_id, kind, org_node_key, job_title_label, job_classification_code,
           effective_from, effective_to, effective_from_basis, opened_by_action_id)
        VALUES ('00000000-0000-4000-8000-0000000000d7', '00000000-0000-4000-8000-0000000000b1',
                'PRIMARY', '00000000-0000-4000-8000-0000000000f1', 'Guru Kelas', 'GURU_LAMA',
                DATE '2020-01-01', current_date - 6, 'RECORDED',
                '00000000-0000-4000-8000-0000000000ad');
        INSERT INTO job_classifications (id, code, name, family, effective_from, effective_to)
        VALUES ('00000000-0000-4000-8000-0000000000c7', 'GURU_LAMA', 'Guru (lama)', 'FUNCTIONAL',
                DATE '2020-01-01', current_date - 6);
        INSERT INTO business_trip_requests
          (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
        VALUES ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000e1',
                'Jakarta', 'Rapat koordinasi yayasan', current_date - 10, current_date - 9,
                'APPROVED', '00000000-0000-4000-8000-0000000000cc');
        INSERT INTO trip_advances
          (id, employee_id, business_trip_id, wilayah, amount, purpose, status, idempotency_key,
           disbursed_at)
        VALUES ('00000000-0000-4000-8000-0000000000bf', '00000000-0000-4000-8000-0000000000e1',
                '00000000-0000-4000-8000-0000000000bb', 'LUAR_DAERAH', 500000,
                'Uang muka rapat koordinasi', 'DISBURSED',
                '00000000-0000-4000-8000-0000000000cd', now() - interval '8 days')"
stranded=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-golongan-gate.sql)") || exit 1
VERDICT_OUTPUT=$( ( trip_002_gate_verdict INACTIVE "$stranded" ) 2>&1 ); VERDICT_STATUS=$?
check_stop "an advance already out that stopped resolving stops the release even while OFF" \
  "ADVANCE_UNRESOLVED" "STOP:"

# 18. And the OFF branch keeps its own sentinel: an answer that never arrived must not read as
#     "no stranded advances".
VERDICT_OUTPUT=$( ( trip_002_gate_verdict INACTIVE "" ) 2>&1 ); VERDICT_STATUS=$?
check_stop "an empty answer stops the release while OFF too" "did not answer" "STOP:"

# 19. The switch queries themselves, against the real schema.
seed_complete
VERDICT_OUTPUT=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-tables-present.sql)" 2>&1); VERDICT_STATUS=$?
check_pass "both tables exist after the migrations" "OK|TABLES|PRESENT|PRESENT"
VERDICT_OUTPUT=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-activation-state.sql)" 2>&1); VERDICT_STATUS=$?
check_pass "an empty switch table reads as INACTIVE" "OK|STATE|INACTIVE"

# 20. The state in force is the LAST ROW WRITTEN, not the latest timestamp. Both rows are
#     written in one statement with the same changed_at on purpose: that is the case
#     recorded_seq exists for, and a query ordered by changed_at would answer it by coin toss.
#     ACTIVE is written second, so INACTIVE must not win.
sql_do "INSERT INTO trip_per_diem_activation (id, state, reason, changed_by_account_id, changed_at)
        VALUES ('00000000-0000-4000-8000-00000000aa01', 'INACTIVE', 'dimatikan',
                '00000000-0000-4000-8000-00000000a001', now()),
               ('00000000-0000-4000-8000-00000000aa02', 'ACTIVE', 'dinyalakan sesudahnya',
                '00000000-0000-4000-8000-00000000a001', now())"
VERDICT_OUTPUT=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-activation-state.sql)" 2>&1); VERDICT_STATUS=$?
check_pass "two decisions sharing one timestamp resolve by write order, not by timestamp" \
  "OK|STATE|ACTIVE"

sql_do "INSERT INTO trip_per_diem_activation (id, state, reason, changed_by_account_id, changed_at)
        VALUES ('00000000-0000-4000-8000-00000000aa03', 'INACTIVE', 'dimatikan lagi',
                '00000000-0000-4000-8000-00000000a001', now() - interval '2 hours')"
VERDICT_OUTPUT=$(psql -d "$URL" -v ON_ERROR_STOP=1 -At -c "$(gate_sql trip-002-activation-state.sql)" 2>&1); VERDICT_STATUS=$?
check_pass "a later decision bearing an earlier timestamp still wins" "OK|STATE|INACTIVE"

# 21. gate_sql must refuse a query file that is not there, and that refusal must reach the
#     caller as a failure rather than as an empty answer (gate_query returns 1 on it).
VERDICT_OUTPUT=$( ( gate_sql no-such-gate-query.sql ) 2>&1 ); VERDICT_STATUS=$?
check_stop "a missing gate query file stops the release" "missing gate query" "STOP:"

echo
echo "trip-002 gate tests: $passed passed, $failed failed"
[[ "$failed" == 0 ]]
