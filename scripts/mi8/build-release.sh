#!/usr/bin/env bash
# OPS-MI8-REL-001: build an HCIS release bundle for Mi8VPS (linux/arm64, Node 22).
# Runs off-device (GitHub Actions or a workstation with Docker). Never contacts production.
#
#   scripts/mi8/build-release.sh <expected-sha> <out-dir>
#
# Env:
#   MI8_DEPS_MODE   docker (default): install production node_modules in an arm64 container
#                   native: install on this host; only allowed when this host is linux/aarch64
#   MI8_NODE_IMAGE  default node:22.22.1-bookworm (matches /usr/bin/node v22.22.1 on Mi8)
#   MI8_RELEASE_DATE  default: current UTC date (yyyymmdd)
set -euo pipefail

EXPECTED_SHA=${1:-}
OUT_DIR=${2:-}
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ || -z "$OUT_DIR" ]]; then
  echo "usage: $0 <40-char-sha> <out-dir>" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

DEPS_MODE=${MI8_DEPS_MODE:-docker}
NODE_IMAGE=${MI8_NODE_IMAGE:-node:22.22.1-bookworm}
RELEASE_DATE=${MI8_RELEASE_DATE:-$(date -u +%Y%m%d)}
SHA8=${EXPECTED_SHA:0:8}
NAME="hcis-$SHA8-$RELEASE_DATE"

if [[ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ]]; then
  echo "STOP: HEAD is $(git rev-parse HEAD), expected $EXPECTED_SHA" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "STOP: tracked files are modified; build only from a clean exact-SHA checkout" >&2
  exit 1
fi

echo "=== compile (host) ==="
npm ci
npm run build:api
npm run build:web

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
STAGE="$OUT_DIR/stage"
rm -rf "$STAGE"
REL="$STAGE/$NAME"
mkdir -p "$REL/apps/api" "$REL/apps/web"

cp package.json package-lock.json "$REL/"
cp apps/api/package.json "$REL/apps/api/"
cp -R apps/api/dist "$REL/apps/api/dist"
cp -R apps/api/migrations "$REL/apps/api/migrations"
cp -R apps/web/dist "$REL/apps/web/dist"
# Present only so the workspace install resolves; the web runtime is static files.
cp apps/web/package.json "$REL/apps/web/"

echo "=== production dependencies (linux/arm64, mode=$DEPS_MODE) ==="
case "$DEPS_MODE" in
  docker)
    docker run --rm --platform linux/arm64 \
      -v "$REL:/release" -w /release \
      -e npm_config_update_notifier=false \
      "$NODE_IMAGE" \
      sh -c 'uname -m && node --version && npm ci --omit=dev --no-audit --no-fund && chown -R '"$(id -u):$(id -g)"' /release'
    NODE_VERSION=$(docker run --rm --platform linux/arm64 "$NODE_IMAGE" node --version)
    NPM_VERSION=$(docker run --rm --platform linux/arm64 "$NODE_IMAGE" npm --version)
    ;;
  native)
    if [[ "$(uname -s)/$(uname -m)" != "Linux/aarch64" ]]; then
      echo "STOP: MI8_DEPS_MODE=native requires a linux/aarch64 host" >&2
      exit 1
    fi
    (cd "$REL" && npm ci --omit=dev --no-audit --no-fund)
    NODE_VERSION=$(node --version)
    NPM_VERSION=$(npm --version)
    ;;
  *)
    echo "STOP: MI8_DEPS_MODE must be docker or native" >&2
    exit 1
    ;;
esac

rm -f "$REL/apps/web/package.json"
rm -rf "$REL/node_modules/@hcis"

native_addons=$(find "$REL/node_modules" -name '*.node' -type f | sed "s#^$REL/##" || true)
if [[ -n "$native_addons" ]]; then
  echo "STOP: native addons need an explicit ABI review for the Mi8 chroot:" >&2
  echo "$native_addons" >&2
  exit 1
fi
[[ -f "$REL/apps/api/dist/server.js" ]] || { echo "STOP: API build missing" >&2; exit 1; }
[[ -f "$REL/apps/api/dist/db/migrate.js" ]] || { echo "STOP: migrate.js missing" >&2; exit 1; }
[[ -f "$REL/apps/web/dist/index.html" ]] || { echo "STOP: web build missing" >&2; exit 1; }

migrations_json=$(cd "$REL/apps/api/migrations" && ls -1 ./*.sql | sed 's#^\./##' | sort | sed 's/.*/"&"/' | paste -sd, -)
cat >"$REL/RELEASE.json" <<JSON
{
  "spec": "OPS-MI8-REL-001",
  "sha": "$EXPECTED_SHA",
  "release": "$NAME",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "linux/arm64",
  "node": "$NODE_VERSION",
  "npm": "$NPM_VERSION",
  "migrations": [$migrations_json]
}
JSON

TARBALL="$OUT_DIR/$NAME.tar.gz"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$TARBALL" "$NAME"
(cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
rm -rf "$STAGE"

echo "release=$NAME"
echo "bundle=$TARBALL"
cat "$TARBALL.sha256"
