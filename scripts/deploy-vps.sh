#!/usr/bin/env bash
set -euo pipefail

# RETIRED 2026-10-15 (OPS-MI8-REL-001): this script targets the terminated Docker/GHCR VPS.
# HCIS production runs on Mi8VPS; use scripts/mi8/release-mi8.sh
# (docs/development/mi8vps-hcis-release.md). Kept for history and for its tests only.
if [[ "${HCIS_ALLOW_RETIRED_DOCKER_VPS:-0}" != "1" ]]; then
  echo "STOP: $(basename "$0") is retired with the old Docker VPS; see docs/development/mi8vps-hcis-release.md" >&2
  exit 3
fi

EXPECTED_SHA=${1:-}
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "usage: $0 <expected-main-sha>" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$ROOT" ]]; then
  echo "STOP: jalankan dari working tree HCIS" >&2
  exit 1
fi
cd "$ROOT"

ENV_FILE=${HCIS_VPS_ENV_FILE:-infra/.env.vps}
COMPOSE_FILE=${HCIS_VPS_COMPOSE_FILE:-infra/docker-compose.vps.yml}
BACKUP_ROOT=${HCIS_BACKUP_ROOT:-backups/deploy}
AUTO_ROLLBACK_APP=${AUTO_ROLLBACK_APP:-1}
DEPLOY_IMAGE_MODE=${HCIS_DEPLOY_IMAGE_MODE:-ghcr}
GHCR_API_REPO=${HCIS_GHCR_API_REPO:-ghcr.io/imadjinasi/hcisysq-api}
GHCR_WEB_REPO=${HCIS_GHCR_WEB_REPO:-ghcr.io/imadjinasi/hcisysq-web}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "STOP: env file tidak ditemukan: $ENV_FILE" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "STOP: working tree tidak bersih" >&2
  git status --short
  exit 1
fi

if ! grep -Eq '^BIOMETRIC_COLLECTION_ENABLED=0[[:space:]]*$' "$ENV_FILE"; then
  echo "STOP: BIOMETRIC_COLLECTION_ENABLED harus tetap 0" >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
PREVIOUS_SHA=$(git rev-parse HEAD)
if [[ "$PREVIOUS_SHA" == "$EXPECTED_SHA" ]]; then
  echo "STOP: working tree sudah berada di target SHA." >&2
  echo "Deploy harus dimulai dari SHA production sebelumnya agar rollback application memiliki baseline yang benar." >&2
  echo "Jika runtime target sudah benar-benar terdeploy, gunakan scripts/verify-vps.sh saja." >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SHORT_SHA=$(printf '%s' "$EXPECTED_SHA" | cut -c1-12)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP-$SHORT_SHA"
DEPLOY_LOG="$BACKUP_DIR/deploy.log"
ROLLBACK_NEEDED=0

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$DEPLOY_LOG") 2>&1

wait_service_healthy() {
  local service=$1
  local timeout_seconds=$2
  local elapsed=0
  while (( elapsed < timeout_seconds )); do
    if "${COMPOSE[@]}" ps "$service" 2>/dev/null | grep -q '(healthy)'; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "STOP: service $service tidak healthy dalam ${timeout_seconds}s" >&2
  "${COMPOSE[@]}" ps "$service" || true
  "${COMPOSE[@]}" logs --tail=120 "$service" || true
  return 1
}

set_target_images() {
  local sha=$1
  export HCIS_API_IMAGE="$GHCR_API_REPO:sha-$sha"
  export HCIS_WEB_IMAGE="$GHCR_WEB_REPO:sha-$sha"
}

prepare_application_images() {
  local sha=$1
  if [[ "$DEPLOY_IMAGE_MODE" == "ghcr" ]]; then
    set_target_images "$sha"
    echo "api_image=$HCIS_API_IMAGE"
    echo "web_image=$HCIS_WEB_IMAGE"
    "${COMPOSE[@]}" pull api web
  elif [[ "$DEPLOY_IMAGE_MODE" == "local" ]]; then
    unset HCIS_API_IMAGE HCIS_WEB_IMAGE
    export COMPOSE_PARALLEL_LIMIT=1
    echo "WARN: HCIS_DEPLOY_IMAGE_MODE=local; building sequentially on VPS"
    "${COMPOSE[@]}" build api
    "${COMPOSE[@]}" build web
  else
    echo "STOP: HCIS_DEPLOY_IMAGE_MODE harus ghcr atau local" >&2
    return 1
  fi
}

rollback_app() {
  if [[ "$ROLLBACK_NEEDED" -ne 1 || "$AUTO_ROLLBACK_APP" != "1" ]]; then
    return 0
  fi

  echo
  echo "=== APPLICATION ROLLBACK GUARD ==="
  echo "Target gagal sehat. Database TIDAK di-rollback otomatis."
  echo "Mengembalikan application image ke commit sebelumnya: $PREVIOUS_SHA"
  git checkout --detach "$PREVIOUS_SHA"
  if [[ "$DEPLOY_IMAGE_MODE" == "ghcr" ]]; then
    set_target_images "$PREVIOUS_SHA"
    "${COMPOSE[@]}" pull api web || true
  else
    unset HCIS_API_IMAGE HCIS_WEB_IMAGE
    export COMPOSE_PARALLEL_LIMIT=1
    "${COMPOSE[@]}" build api || true
    "${COMPOSE[@]}" build web || true
  fi
  "${COMPOSE[@]}" up -d --no-deps api
  wait_service_healthy api 120 || true
  "${COMPOSE[@]}" up -d --no-deps web
  wait_service_healthy web 120 || true
  echo "Application rollback attempted. Working tree sengaja ditinggalkan detached di $PREVIOUS_SHA."
  echo "Periksa kompatibilitas schema sebelum mencoba cutover lain."
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$code" -ne 0 ]]; then
    rollback_app || true
    echo "DEPLOY FAILED (exit $code). Evidence: $BACKUP_DIR" >&2
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "=== HCIS VPS DEPLOY ==="
echo "previous_sha=$PREVIOUS_SHA"
echo "expected_sha=$EXPECTED_SHA"
echo "image_mode=$DEPLOY_IMAGE_MODE"
echo "timestamp_utc=$TIMESTAMP"
echo "backup_dir=$BACKUP_DIR"

printf '%s\n' \
  "previous_sha=$PREVIOUS_SHA" \
  "expected_sha=$EXPECTED_SHA" \
  "image_mode=$DEPLOY_IMAGE_MODE" \
  "timestamp_utc=$TIMESTAMP" \
  "auto_rollback_app=$AUTO_ROLLBACK_APP" \
  > "$BACKUP_DIR/metadata.txt"

echo
echo "=== PRECHECK REMOTE ==="
git fetch origin main
REMOTE_SHA=$(git rev-parse origin/main)
if [[ "$REMOTE_SHA" != "$EXPECTED_SHA" ]]; then
  echo "STOP: origin/main sudah bergerak" >&2
  echo "Expected: $EXPECTED_SHA" >&2
  echo "Actual:   $REMOTE_SHA" >&2
  exit 1
fi

echo
echo "=== PRE-MIGRATION DATABASE BACKUP ==="
"${COMPOSE[@]}" exec -T postgres sh -lc '
  set -eu
  pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' > "$BACKUP_DIR/postgres-before.dump"
if [[ ! -s "$BACKUP_DIR/postgres-before.dump" ]]; then
  echo "STOP: database backup kosong" >&2
  exit 1
fi
sha256sum "$BACKUP_DIR/postgres-before.dump" > "$BACKUP_DIR/postgres-before.dump.sha256"
ls -lh "$BACKUP_DIR/postgres-before.dump"

echo
echo "=== PREPARE TARGET ==="
git switch main
git pull --ff-only origin main
if [[ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ]]; then
  echo "STOP: local main tidak berada di expected SHA" >&2
  exit 1
fi
prepare_application_images "$EXPECTED_SHA"
ROLLBACK_NEEDED=1

echo
echo "=== API CUTOVER + MIGRATION ==="
"${COMPOSE[@]}" up -d --no-deps api
wait_service_healthy api 180
"${COMPOSE[@]}" logs --tail=100 api

echo
echo "=== API DIRECT HEALTH ==="
"${COMPOSE[@]}" exec -T api node -e "Promise.all([fetch('http://127.0.0.1:3001/health'),fetch('http://127.0.0.1:3001/ready')]).then(async ([h,r])=>{console.log(await h.text());console.log(await r.text());if(!h.ok||!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

echo
echo "=== WEB CUTOVER ==="
"${COMPOSE[@]}" up -d --no-deps web
wait_service_healthy web 180

echo
echo "=== EDGE-LOCAL SMOKE ==="
curl -fsS http://127.0.0.1:18080/healthz
printf '\n'
curl -fsS http://127.0.0.1:18080/api/health
printf '\n'
curl -fsS http://127.0.0.1:18080/api/ready
printf '\n'

echo
echo "=== MIGRATION SNAPSHOT ==="
"${COMPOSE[@]}" exec -T postgres sh -lc '
  psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
    SELECT name, applied_at
    FROM schema_migrations
    ORDER BY name DESC
    LIMIT 12;
  "
' | tee "$BACKUP_DIR/migrations-after.txt"

echo
echo "=== SAFETY BOUNDARIES ==="
"${COMPOSE[@]}" exec -T postgres sh -lc '
  psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
    SELECT tgname
    FROM pg_trigger
    WHERE tgname = '\''attendance_adms_reject_retired_userinfo_reads'\''
      AND NOT tgisinternal;
  "
'

if ! grep -Eq '^BIOMETRIC_COLLECTION_ENABLED=0[[:space:]]*$' "$ENV_FILE"; then
  echo "STOP: biometric gate berubah selama deploy" >&2
  exit 1
fi

"${COMPOSE[@]}" ps | tee "$BACKUP_DIR/compose-after.txt"
printf '%s\n' "deployed_sha=$(git rev-parse HEAD)" >> "$BACKUP_DIR/metadata.txt"
if [[ "$DEPLOY_IMAGE_MODE" == "ghcr" ]]; then
  printf '%s\n' "api_image=$HCIS_API_IMAGE" "web_image=$HCIS_WEB_IMAGE" >> "$BACKUP_DIR/metadata.txt"
fi
ROLLBACK_NEEDED=0
trap - EXIT INT TERM

echo
echo "=== DEPLOY SUCCESS ==="
echo "HEAD=$(git rev-parse HEAD)"
echo "Evidence: $BACKUP_DIR"
