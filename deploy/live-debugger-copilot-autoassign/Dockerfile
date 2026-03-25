# ─────────────────────────────────────────────────────────────────────────────
# Live Debugger — Copilot Auto-Assign
#
# Builds a self-contained image that:
#   • Compiles the fusion-agent library from source
#   • Runs the copilot-autoassign example entry-point (index.ts)
#
# Build:
#   docker build \
#     -f deploy/live-debugger-copilot-autoassign/Dockerfile \
#     -t fusion-agent-copilot-autoassign:latest \
#     .
#
# Run (standalone):
#   docker run --rm \
#     -e OPENAI_API_KEY=sk-... \
#     -e GITHUB_TOKEN=ghp_... \
#     -e GITHUB_REPO=https://github.com/org/my-service \
#     -p 3000:3000 \
#     --name fusion-copilot-autoassign \
#     fusion-agent-copilot-autoassign:latest
#
# Prefer using docker-compose.yml which also starts the dummy error server.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install all deps (including devDependencies needed for tsc)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev-only packages to slim the final image
RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

# git is required so GitPatchApplier can commit (not used in the copilot
# autoassign path, but kept in case the user enables git guardrail logging)
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled output + production node_modules
COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/package.json  ./package.json

# Copy the example entry-point and compile it at container start via ts-node
# (ts-node + typescript are included as prod deps in the example)
COPY deploy/live-debugger-copilot-autoassign/index.ts   ./example/index.ts
COPY deploy/live-debugger-copilot-autoassign/config.example.json ./example/config.example.json
COPY tsconfig.json ./tsconfig.json

# Install ts-node for running the example TypeScript file directly
RUN npm install --no-save ts-node typescript

# Session data persisted here — mount a host volume to keep sessions across restarts
RUN mkdir -p /root/.fusion-agent/sessions
VOLUME ["/root/.fusion-agent"]

# ── Runtime env defaults (all overridable via docker run -e / env_file) ───────

ENV NODE_ENV=production \
    AI_PROVIDER=openai \
    AI_MODEL=gpt-4o \
    WEB_PORT=3000 \
    DOCKER_CONTAINER=fusion-live-debugger-dummy

EXPOSE 3000

# Use ts-node to run the annotated TypeScript example directly
ENTRYPOINT ["node_modules/.bin/ts-node", "--transpile-only", "--project", "tsconfig.json", "example/index.ts"]
