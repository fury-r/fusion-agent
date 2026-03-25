# ─────────────────────────────────────────────────────────────────────────────
# Live Debugger — Self-Fix + GitHub Commit
#
# Builds a self-contained image that:
#   • Compiles the fusion-agent library from source
#   • Runs the selffix example entry-point (index.ts)
#
# Build:
#   docker build \
#     -f deploy/live-debugger-selffix/Dockerfile \
#     -t fusion-agent-selffix:latest \
#     .
#
# Run (standalone — git repo must be bind-mounted):
#   docker run --rm \
#     -e OPENAI_API_KEY=sk-... \
#     -e GITHUB_TOKEN=ghp_... \
#     -e GITHUB_REPO=https://github.com/org/my-service \
#     -e GIT_REPO_PATH=/repo \
#     -v /absolute/path/to/my-service:/repo \
#     -p 3000:3000 \
#     --name fusion-selffix \
#     fusion-agent-selffix:latest
#
# Prefer using docker-compose.yml which wires all services together.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

# git is required — GitPatchApplier shells out to git to commit and push
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure git so it does not complain about no global identity
# (the example sets per-commit author via env vars anyway)
RUN git config --global user.email "fusion-agent@noreply" \
 && git config --global user.name "fusion-agent[bot]" \
 && git config --global --add safe.directory "*"

WORKDIR /app

COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/package.json  ./package.json

COPY deploy/live-debugger-selffix/index.ts          ./example/index.ts
COPY deploy/live-debugger-selffix/config.example.json ./example/config.example.json
COPY tsconfig.json ./tsconfig.json

RUN npm install --no-save ts-node typescript

# ── Volumes ───────────────────────────────────────────────────────────────────
# /root/.fusion-agent   — session persistence
# /repo                 — the git repository to auto-fix (bind-mount from host)
RUN mkdir -p /root/.fusion-agent/sessions /repo
VOLUME ["/root/.fusion-agent", "/repo"]

# ── Runtime env defaults ──────────────────────────────────────────────────────
ENV NODE_ENV=production \
    AI_PROVIDER=openai \
    AI_MODEL=gpt-4o \
    WEB_PORT=3000 \
    DOCKER_CONTAINER=fusion-live-debugger-dummy \
    GIT_REPO_PATH=/repo \
    GIT_BRANCH=fusion-agent/auto-fix \
    BASE_BRANCH=main \
    GIT_AUTHOR_NAME="fusion-agent[bot]" \
    GIT_AUTHOR_EMAIL="fusion-agent@noreply" \
    GIT_API_BASE_URL=https://api.github.com

EXPOSE 3000

ENTRYPOINT ["node_modules/.bin/ts-node", "--transpile-only", "--project", "tsconfig.json", "example/index.ts"]
