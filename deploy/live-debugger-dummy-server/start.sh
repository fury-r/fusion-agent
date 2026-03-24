#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
CONTAINER_NAME="fusion-live-debugger-dummy"
SERVER_FILE="${SCRIPT_DIR}/server.js"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODE="${1:-debug}"
TEAMS_WEBHOOK_URL="${TEAMS_WEBHOOK_URL:-}"

if [[ "${MODE}" == "debug" || "${MODE}" == "start-only" ]]; then
  shift || true
fi

EXTRA_DEBUG_ARGS=("$@")

load_teams_webhook_from_container() {
  if [[ -n "${TEAMS_WEBHOOK_URL}" ]]; then
    return
  fi

  local container_env
  container_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  TEAMS_WEBHOOK_URL="$(grep '^TEAMS_WEBHOOK_URL=' <<<"${container_env}" | tail -n 1 | sed 's/^TEAMS_WEBHOOK_URL=//' || true)"
}

if [[ ! -f "${SERVER_FILE}" ]]; then
  echo "server.js is missing, recreating it..."
  cat > "${SERVER_FILE}" <<'EOF'
const fs = require('fs');
const http = require('http');
const net = require('net');

const port = Number(process.env.PORT || 8080);
const errorIntervalMs = Number(process.env.ERROR_INTERVAL_MS || 5000);
const dbHost = process.env.DUMMY_DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.DUMMY_DB_PORT || 5432);

function formatMessage(level, message) {
  return `${new Date().toISOString()} ${level} dummy-server ${message}`;
}

function log(level, message, error) {
  const line = formatMessage(level, message);
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }

  if (error) {
    console.error(error.stack || error.message || String(error));
  }
}

function simulateDatabaseFailure() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: dbHost, port: dbPort });

    socket.on('connect', () => {
      socket.destroy();
      log('WARN', `Unexpectedly connected to ${dbHost}:${dbPort}; this fixture expects connection failures.`);
      resolve();
    });

    socket.on('error', (error) => {
      log('ERROR', `Background worker failed to reach postgres at ${dbHost}:${dbPort}`, error);
      resolve();
    });
  });
}

function simulateMissingFile() {
  try {
    fs.readFileSync('/app/runtime/secrets.json', 'utf8');
  } catch (error) {
    log('ERROR', 'Config loader could not read /app/runtime/secrets.json', error);
  }
}

function simulateTypeError() {
  try {
    const payload = null;
    return payload.user.id;
  } catch (error) {
    log('ERROR', 'Request handler crashed while building the JSON response', error);
    return null;
  }
}

async function runBackgroundFailures() {
  log('INFO', 'Running scheduled failure scenarios.');
  await simulateDatabaseFailure();
  simulateMissingFile();
  simulateTypeError();
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'dummy-server' }));
    return;
  }

  if (req.url === '/crash') {
    try {
      JSON.parse('{"broken":}');
    } catch (error) {
      log('ERROR', 'Route /crash raised a JSON parse exception', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Intentional crash route failed.' }));
      return;
    }
  }

  if (req.url === '/db-check') {
    await simulateDatabaseFailure();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Database check failed as intended.' }));
    return;
  }

  log('INFO', `Handled ${req.method} ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      service: 'dummy-server',
      routes: ['/health', '/crash', '/db-check'],
    })
  );
});

server.listen(port, () => {
  log('INFO', `Dummy server listening on 0.0.0.0:${port}`);
  log('WARN', 'This container intentionally emits runtime errors for live debugger testing.');
  void runBackgroundFailures();
});

setInterval(() => {
  void runBackgroundFailures();
}, errorIntervalMs);

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught exception reached process handler', error);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled promise rejection reached process handler', reason);
});
EOF
fi

echo "[1/3] Building and starting dummy server container..."
docker compose -f "${COMPOSE_FILE}" up --build -d

echo "[2/3] Waiting for health endpoint..."
health_ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:8080/health" >/dev/null 2>&1; then
    echo "Dummy server is healthy."
    health_ok=1
    break
  fi
  sleep 1
done

if [[ "${health_ok}" -ne 1 ]]; then
  echo "Dummy server failed health checks after 30 seconds."
  echo "Inspect logs with: docker logs ${CONTAINER_NAME}"
  exit 1
fi

load_teams_webhook_from_container

if [[ "${MODE}" == "start-only" ]]; then
  echo "[3/3] Container started."
  echo ""
  echo "Attach debugger manually with:"
  echo "  ai-agent debug --docker ${CONTAINER_NAME} --batch 5 --log-level ERROR"
  exit 0
fi

echo "[3/3] Starting live debugger..."
echo "Press Ctrl+C to stop debugger (container continues running)."
echo ""

cd "${REPO_ROOT}"

DEBUG_ARGS=(debug --docker "${CONTAINER_NAME}" --batch 5)

run_debugger() {
  local runner=("$@")
  local help_text
  help_text="$("${runner[@]}" debug --help 2>&1 || true)"
  local command_args=("${DEBUG_ARGS[@]}")

  if grep -q -- '--log-level' <<<"${help_text}"; then
    command_args+=(--log-level ERROR)
  else
    echo "Selected ai-agent CLI does not support --log-level; continuing without that filter."
  fi

  if [[ -n "${TEAMS_WEBHOOK_URL}" ]]; then
    if grep -q -- '--notify-teams' <<<"${help_text}"; then
      command_args+=(--notify-teams "${TEAMS_WEBHOOK_URL}")
      echo "Teams notifications enabled for live debugger failures."
    else
      echo "Selected ai-agent CLI does not support --notify-teams; continuing without Teams notifications."
    fi
  fi

  exec "${runner[@]}" "${command_args[@]}" "${EXTRA_DEBUG_ARGS[@]}"
}

if command -v ai-agent >/dev/null 2>&1; then
  run_debugger ai-agent
fi

if [[ -f "${REPO_ROOT}/dist/cli.js" ]]; then
  run_debugger node "${REPO_ROOT}/dist/cli.js"
fi

if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  if [[ -n "${TEAMS_WEBHOOK_URL}" ]]; then
    DEBUG_ARGS+=(--notify-teams "${TEAMS_WEBHOOK_URL}")
    echo "Teams notifications enabled for live debugger failures."
  fi
  exec npm run dev -- "${DEBUG_ARGS[@]}" "${EXTRA_DEBUG_ARGS[@]}"
fi

echo "No usable local CLI was found." >&2
echo "Either install/update the global 'ai-agent' package or run 'npm install' and build the repo." >&2
exit 1