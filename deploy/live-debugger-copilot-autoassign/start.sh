#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Live Debugger — Copilot Auto-Assign example start script
#
# Usage:
#   bash start.sh                          # uses env vars already set
#   GITHUB_TOKEN=ghp_... GITHUB_REPO=https://github.com/org/repo bash start.sh
#
# The script will:
#   1. Verify required tools are installed
#   2. Start the dummy server (if not already running)
#   3. Compile + run the example TypeScript entry point
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DUMMY_COMPOSE="${REPO_ROOT}/deploy/live-debugger-dummy-server/docker-compose.yml"
CONTAINER_NAME="fusion-live-debugger-dummy"

# ── Dependency checks ─────────────────────────────────────────────────────────

for cmd in node npm docker; do
  if ! command -v "${cmd}" &>/dev/null; then
    echo "❌  '${cmd}' is required but not found in PATH." >&2
    exit 1
  fi
done

if ! npm list -g ts-node &>/dev/null && ! npx --yes ts-node --version &>/dev/null; then
  echo "⚠  ts-node not found. Installing locally via npx (first run may be slow)…"
fi

# ── Environment checks ────────────────────────────────────────────────────────

: "${AI_PROVIDER:=openai}"
: "${AI_MODEL:=gpt-4o}"
: "${WEB_PORT:=3000}"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "⚠  GITHUB_TOKEN is not set — Copilot auto-assign will be skipped."
fi
if [[ -z "${GITHUB_REPO:-}" ]]; then
  echo "⚠  GITHUB_REPO is not set — Copilot auto-assign will be skipped."
fi

# ── Start dummy server if not running ────────────────────────────────────────

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "✅  Dummy server container '${CONTAINER_NAME}' is already running."
else
  echo "▶  Starting dummy server…"
  docker compose -f "${DUMMY_COMPOSE}" up --build -d live-debugger-dummy
  echo "⏳  Waiting for dummy server to be healthy…"
  for i in $(seq 1 20); do
    if curl -sf http://localhost:8080/health &>/dev/null; then
      echo "✅  Dummy server is up."
      break
    fi
    sleep 1
    if [[ "${i}" -eq 20 ]]; then
      echo "⚠  Dummy server did not become healthy after 20 s — continuing anyway."
    fi
  done
fi

# ── Install project dependencies if needed ────────────────────────────────────

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "📦  Installing project dependencies…"
  (cd "${REPO_ROOT}" && npm ci)
fi

# Build the project so the local import resolves
echo "🔨  Building fusion-agent…"
(cd "${REPO_ROOT}" && npm run build --if-present)

# ── Run the example ───────────────────────────────────────────────────────────

echo ""
echo "🚀  Starting Live Debugger (Copilot auto-assign example)…"
echo "    Web UI → http://localhost:${WEB_PORT}"
echo ""

cd "${SCRIPT_DIR}"
npx ts-node \
  --project "${REPO_ROOT}/tsconfig.json" \
  --transpile-only \
  index.ts
