#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Fusion Agent — Vibe Coder demo launcher
#
# Usage:
#   ./start.sh                         # build image, start UI, open browser
#   ./start.sh start-only              # build + start, skip browser open
#   ./start.sh stop                    # stop and remove container
#
# Environment vars:
#   OPENAI_API_KEY      OpenAI key (optional — demo mode works without it)
#   ANTHROPIC_API_KEY   Anthropic key (optional)
#   GEMINI_API_KEY      Google Gemini key (optional)
#   UI_PORT             Port to expose the web UI on (default: 3000)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTAINER_NAME="fusion-agent-vibe-demo"
UI_PORT="${UI_PORT:-3000}"
MODE="${1:-demo}"

# ── Stop mode ────────────────────────────────────────────────────────────────
if [[ "${MODE}" == "stop" ]]; then
  echo "Stopping ${CONTAINER_NAME}..."
  docker compose -f "${COMPOSE_FILE}" down
  echo "Done."
  exit 0
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "[1/3] Building fusion-agent image (this may take a minute on first run)..."

# Build TypeScript before Docker so the image always has fresh dist/
if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  echo "  Running npm run build in repo root..."
  (cd "${REPO_ROOT}" && npm run build --silent)
fi

docker compose -f "${COMPOSE_FILE}" up --build -d

# ── Health check ─────────────────────────────────────────────────────────────
echo "[2/3] Waiting for Web UI to be ready on port ${UI_PORT}..."
health_ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://localhost:${UI_PORT}/api/sessions" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 1
done

if [[ "${health_ok}" -ne 1 ]]; then
  echo ""
  echo "Web UI did not become ready within 40 seconds."
  echo "Check container logs:"
  echo "  docker logs ${CONTAINER_NAME}"
  exit 1
fi

echo "  Web UI is ready."

# ── Open browser (unless start-only) ─────────────────────────────────────────
if [[ "${MODE}" == "start-only" ]]; then
  echo "[3/3] Container started in start-only mode."
  echo ""
  echo "  Open the Vibe Coder demo at: http://localhost:${UI_PORT}/#vibe-coder"
  echo "  Click the '▶ Demo' button to start the scripted walkthrough."
  echo ""
  echo "  To stop:  ./start.sh stop"
  exit 0
fi

echo "[3/3] Opening Vibe Coder demo in browser..."

DEMO_URL="http://localhost:${UI_PORT}/#vibe-coder"

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${DEMO_URL}" &
  elif command -v open >/dev/null 2>&1; then
    open "${DEMO_URL}"
  elif command -v wslview >/dev/null 2>&1; then
    wslview "${DEMO_URL}"
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -Command "Start-Process '${DEMO_URL}'"
  else
    echo "  Could not detect a browser opener. Visit manually:"
    echo "  ${DEMO_URL}"
  fi
}

open_browser

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Fusion Agent — Vibe Coder Demo"
echo ""
echo "  URL    : ${DEMO_URL}"
echo "  Click '▶ Demo' on the Vibe Coder page to start the demo."
echo ""
echo "  To use a real session, set an API key and click New Session:"
echo "    OPENAI_API_KEY=sk-...  ./start.sh demo"
echo ""
echo "  To stop : ./start.sh stop"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
