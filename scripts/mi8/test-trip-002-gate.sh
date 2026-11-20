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

expect_stop() { # expect_stop NAME <query> <verdict fn> <substring>...
  local name=$1 query=$2 verdict=$3; shift 3
  run_verdict "$query" "$verdict"
  if [[ "$VERDICT_STATUS" == 0 ]]; then
    report fail "$name" "gate passed but should have stopped the release; output: $VERDICT_OUTPUT"
    return
  fi
  if [[ "$VERDICT_STATUS" -gt 90 ]]; then
    report fail "$name" "$VERDICT_OUTPUT"
    return
  fi
  local missing=""
  for want in "$@"; do
    [[ "$VERDICT_OUTPUT" == *"$want"* ]] || missing="$missing [$want]"
  done
  if [[ -n "$missing" ]]; then
    report fail "$name" "stopped, but did not name:$missing; output: $VERDICT_OUTPUT"
  else
    report ok "$name" ""
    echo "ok   $name (stops, names what is missing)"
  fi
}

expect_pass() { # expect_pass NAME <query> <verdict fn> [substring]...
  local name=$1 query=$2 verdict=$3; shift 3
  run_verdict "$query" "$verdict"
  if [[ "$VERDICT_STATUS" != 0 ]]; then
    report fail "$name" "gate stopped the release but should have passed; output: $VERDICT_OUTPUT"
    return
  fi
  local missing=""
  for want in "$@"; do
    [[ "$VERDICT_OUTPUT" == *"$want"* ]] || missing="$missing [$want]"
  done
  if [[ -n "$missing" ]]; then
    report fail "$name" "passed, but did not report:$missing; output: $VERDICT_OUTPUT"
  else
    report ok "$name" ""
    echo "ok   $name (passes)"
  fi
}

# ------------------------------------------------------------------ fixture

FIXTURE_TABLES="employees, employments, employment_actions, employment_placements,
  job_classifications, trip_per_diem_golongan_map, trip_per_diem_rates, trip_advances,
  business_trip_requests, accounts, organization_change_sets, organization_positions,
  organization_nodes"

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
}

sql_do() { printf '%s\n%s\n' "$FIXTURE_PRELUDE" "$1" | psql_run || exit 1; }

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

# 5. Already covered: a live advance resolved on its own departure date, against a classification
#    that has since been closed and never mapped.
seed_complete
sql_do "UPDATE employment_placements SET job_classification_code = 'GURU_LAMA'
         WHERE id = '00000000-0000-4000-8000-0000000000d1';
        INSERT INTO job_classifications (id, code, name, family, effective_from, effective_to)
        VALUES ('00000000-0000-4000-8000-0000000000c5', 'GURU_LAMA', 'Guru (lama)', 'FUNCTIONAL',
                DATE '2020-01-01', current_date - 1);
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
expect_stop "live advance on a closed, unmapped classification stops the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "ADVANCE_UNRESOLVED" "STOP:"

# 6. Already covered: the pre-migrate gate must still abort on a non-empty rate table.
seed_complete
sql_do "INSERT INTO trip_per_diem_rates
          (id, golongan, wilayah, effective_from, daily_amount, created_by_account_id)
        VALUES ('00000000-0000-4000-8000-0000000000fa', 'STAF', 'DALAM_DAERAH',
                DATE '2026-07-10', 60000, '00000000-0000-4000-8000-00000000a001')"
expect_stop "pre-migrate gate aborts on a non-empty rate table" \
  trip-002-pre-migrate-gate.sql trip_002_pre_migrate_verdict "DRAFT-zone rate rows" "STOP:"

echo
echo "-- passing cases"

# 7. A complete catalogue and a complete mapping: the release may proceed.
seed_complete
expect_pass "complete catalogue and mapping let the release through" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "resolves to a golongan"

# 8. A future-dated, unmapped classification is reported but does not stop the release: it breaks
#    nothing today, and HC can map it before it takes effect.
seed_complete
sql_do "INSERT INTO job_classifications (id, code, name, family, effective_from)
        VALUES ('00000000-0000-4000-8000-0000000000c8', 'GURU_BESAR', 'Guru Besar', 'FUNCTIONAL',
                current_date + 30)"
expect_pass "future-dated unmapped classification warns without stopping" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "CLASSIFICATION_UNMAPPED_FUTURE" "GURU_BESAR"

# 9. An empty rate table lets the migration run.
seed_complete
expect_pass "pre-migrate gate passes on an empty rate table" \
  trip-002-pre-migrate-gate.sql trip_002_pre_migrate_verdict "may run"

# 10. People outside HCIS management are not part of any eligibility (EMP-005 S2B 8.7), so an
#     unclassified OUTSIDE_HCIS record must not stop a release.
seed_complete
sql_do "INSERT INTO employees (id, employee_number, full_name, status, management_scope,
          management_scope_reason, management_scope_note, management_scope_marked_at)
        VALUES ('00000000-0000-4000-8000-0000000000e9', 'E-009', 'Pengurus Yayasan', 'active',
                'OUTSIDE_HCIS', 'PENGURUS_YAYASAN', 'Pengurus yayasan, di luar pengelolaan HCIS',
                now())"
expect_pass "employee outside HCIS management does not stop the release" \
  trip-002-golongan-gate.sql trip_002_mapped_verdict "resolves to a golongan"

echo
echo "trip-002 gate tests: $passed passed, $failed failed"
[[ "$failed" == 0 ]]
