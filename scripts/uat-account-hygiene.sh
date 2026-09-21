#!/usr/bin/env bash
set -euo pipefail

MODE=${1:-}
ACCOUNT_IDS_RAW=${2:-}
CONFIRMATION=${3:-}

case "$MODE" in
  scan)
    [[ "$CONFIRMATION" == "SCAN_UAT_CANDIDATES" ]] || { echo "STOP: confirmation must be SCAN_UAT_CANDIDATES" >&2; exit 2; }
    ;;
  preview)
    [[ "$CONFIRMATION" == "PREVIEW_UAT_ACCOUNTS" ]] || { echo "STOP: confirmation must be PREVIEW_UAT_ACCOUNTS" >&2; exit 2; }
    ;;
  disable)
    [[ "$CONFIRMATION" == "DISABLE_UAT_ACCOUNTS" ]] || { echo "STOP: confirmation must be DISABLE_UAT_ACCOUNTS" >&2; exit 2; }
    ;;
  *)
    echo "usage: $0 <scan|preview|disable> <comma-separated-account-uuids> <confirmation>" >&2
    exit 2
    ;;
esac

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[[ -n "$ROOT" ]] || { echo "STOP: run inside HCIS working tree" >&2; exit 1; }
cd "$ROOT"
ENV_FILE=${HCIS_VPS_ENV_FILE:-infra/.env.vps}
COMPOSE_FILE=${HCIS_VPS_COMPOSE_FILE:-infra/docker-compose.vps.yml}
[[ -f "$ENV_FILE" ]] || { echo "STOP: env file not found" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "STOP: compose file not found" >&2; exit 1; }
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

psql_stdin() {
  "${COMPOSE[@]}" exec -T postgres sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}
psql_scalar() {
  local sql=$1
  "${COMPOSE[@]}" exec -T postgres sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"' sh "$sql"
}

if [[ "$MODE" == "scan" ]]; then
  echo "=== UAT CANDIDATE SCAN (READ ONLY) ==="
  psql_stdin <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH candidates AS (
  SELECT account.id AS account_id, account.employee_id, account.principal_type,
         account.status AS account_status,
         CASE
           WHEN lower(account.email) LIKE '%@example.invalid' THEN 'synthetic_email_domain'
           WHEN employee.employee_number LIKE 'UAT-%' THEN 'uat_employee_prefix'
           WHEN employee.employee_number LIKE 'AUTH011-%' THEN 'auth_fixture_prefix'
           WHEN employee.employee_number LIKE 'YSQ-DEMO-%' THEN 'demo_employee_prefix'
           WHEN employee.employee_number LIKE 'MOBILE-TEST-%' THEN 'mobile_fixture_prefix'
           WHEN employee.employee_number LIKE 'NOTIF-%' THEN 'notification_fixture_prefix'
           ELSE 'unknown'
         END AS candidate_reason
  FROM accounts account
  LEFT JOIN employees employee ON employee.id = account.employee_id
  WHERE lower(account.email) LIKE '%@example.invalid'
     OR employee.employee_number LIKE 'UAT-%'
     OR employee.employee_number LIKE 'AUTH011-%'
     OR employee.employee_number LIKE 'YSQ-DEMO-%'
     OR employee.employee_number LIKE 'MOBILE-TEST-%'
     OR employee.employee_number LIKE 'NOTIF-%'
)
SELECT account_id, employee_id, principal_type, account_status, candidate_reason,
       (SELECT count(*) FROM auth_sessions s WHERE s.account_id = candidates.account_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
       (SELECT count(*) FROM account_role_assignments a WHERE a.account_id = candidates.account_id) AS role_assignments,
       (SELECT count(*) FROM attendance_events e WHERE e.employee_id = candidates.employee_id) AS attendance_events,
       (SELECT count(*) FROM leave_requests l WHERE l.employee_id = candidates.employee_id) AS leave_requests,
       (SELECT count(*) FROM attendance_shift_swap_requests sw WHERE sw.requester_employee_id = candidates.employee_id OR sw.counterpart_employee_id = candidates.employee_id) AS shift_swaps,
       (SELECT count(*) FROM payslips p WHERE p.employee_id = candidates.employee_id) AS payslips
FROM candidates
ORDER BY account_id;
ROLLBACK;
SQL
  echo "scan_result=read_only"
  exit 0
fi

IFS=',' read -r -a RAW_IDS <<< "$ACCOUNT_IDS_RAW"
IDS=()
for raw in "${RAW_IDS[@]}"; do
  id=$(printf '%s' "$raw" | tr -d '[:space:]')
  [[ -n "$id" ]] || continue
  [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
    echo "STOP: invalid account UUID: $id" >&2
    exit 2
  }
  IDS+=("$id")
done
[[ ${#IDS[@]} -gt 0 ]] || { echo "STOP: at least one exact account UUID is required" >&2; exit 2; }
[[ ${#IDS[@]} -le 20 ]] || { echo "STOP: at most 20 accounts per run" >&2; exit 2; }

SQL_IDS=""
for id in "${IDS[@]}"; do
  [[ -z "$SQL_IDS" ]] || SQL_IDS+=","
  SQL_IDS+="'$id'::uuid"
done
EXPECTED=${#IDS[@]}

FOUND=$(psql_scalar "SELECT count(*) FROM accounts WHERE id IN ($SQL_IDS)")
[[ "$FOUND" == "$EXPECTED" ]] || {
  echo "STOP: expected $EXPECTED exact accounts but found $FOUND" >&2
  exit 1
}
PROTECTED=$(psql_scalar "SELECT count(*) FROM accounts WHERE id IN ($SQL_IDS) AND principal_type = 'SUPER_ADMIN'")
[[ "$PROTECTED" == "0" ]] || {
  echo "STOP: SUPER_ADMIN target is protected" >&2
  exit 1
}

echo "=== EXACT TARGET PREVIEW ==="
psql_stdin <<SQL
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH selected AS (
  SELECT id AS account_id, employee_id, principal_type, status AS account_status
  FROM accounts
  WHERE id IN ($SQL_IDS)
)
SELECT account_id, employee_id, principal_type, account_status,
       (SELECT count(*) FROM auth_sessions s WHERE s.account_id = selected.account_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
       (SELECT count(*) FROM account_activation_tokens t WHERE t.account_id = selected.account_id AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()) AS active_activation_tokens,
       (SELECT count(*) FROM account_role_assignments a WHERE a.account_id = selected.account_id) AS role_assignments,
       (SELECT count(*) FROM attendance_events e WHERE e.employee_id = selected.employee_id) AS attendance_events,
       (SELECT count(*) FROM leave_requests l WHERE l.employee_id = selected.employee_id) AS leave_requests,
       (SELECT count(*) FROM attendance_shift_swap_requests sw WHERE sw.requester_employee_id = selected.employee_id OR sw.counterpart_employee_id = selected.employee_id) AS shift_swaps,
       (SELECT count(*) FROM payslips p WHERE p.employee_id = selected.employee_id) AS payslips
FROM selected
ORDER BY account_id;
ROLLBACK;
SQL

if [[ "$MODE" == "preview" ]]; then
  echo "preview_result=read_only"
  exit 0
fi

echo "=== DISABLE EXACT ACCOUNTS ==="
psql_stdin <<SQL
BEGIN;
SET LOCAL statement_timeout = '15s';

UPDATE accounts
SET status = 'inactive', updated_at = now()
WHERE id IN ($SQL_IDS)
  AND principal_type <> 'SUPER_ADMIN';

UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now())
WHERE account_id IN ($SQL_IDS)
  AND revoked_at IS NULL;

UPDATE account_activation_tokens
SET revoked_at = coalesce(revoked_at, now())
WHERE account_id IN ($SQL_IDS)
  AND consumed_at IS NULL
  AND revoked_at IS NULL;

INSERT INTO access_audit_events (
  id, actor_account_id, action, entity_type, entity_id, payload
)
SELECT gen_random_uuid(), NULL, 'uat.account.disabled', 'account', id,
       jsonb_build_object(
         'source', 'github-production-hygiene',
         'historyPreserved', true,
         'employeeStatusChanged', false
       )
FROM accounts
WHERE id IN ($SQL_IDS);

COMMIT;
SQL

ACTIVE=$(psql_scalar "SELECT count(*) FROM accounts WHERE id IN ($SQL_IDS) AND status <> 'inactive'")
SESSIONS=$(psql_scalar "SELECT count(*) FROM auth_sessions WHERE account_id IN ($SQL_IDS) AND revoked_at IS NULL AND expires_at > now()")
TOKENS=$(psql_scalar "SELECT count(*) FROM account_activation_tokens WHERE account_id IN ($SQL_IDS) AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()")
[[ "$ACTIVE" == "0" && "$SESSIONS" == "0" && "$TOKENS" == "0" ]] || {
  echo "FAIL: post-disable verification did not converge" >&2
  exit 1
}
echo "disable_result=success"
echo "history_preserved=true"
echo "employee_status_changed=false"
