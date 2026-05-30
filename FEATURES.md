# fusion-agent — Complete Feature Reference

A single document covering every feature, how to install and configure it, and how to use it from the CLI, Web UI, and programmatic API.

---

## Table of Contents

1. [Installation & Configuration](#1-installation--configuration)
2. [AI Providers](#2-ai-providers)
3. [Vibe Coder — Interactive Chat](#3-vibe-coder--interactive-chat)
4. [Autonomous Agent](#4-autonomous-agent)
5. [Live Debugger](#5-live-debugger)
   - [Watching a Log File](#51-watching-a-log-file)
   - [Watching a Docker Container](#52-watching-a-docker-container)
   - [Spawning a Process](#53-spawning-a-process)
   - [HTTP Polling](#54-http-polling)
   - [Log Filtering](#55-log-filtering)
   - [Notifications (Slack / Teams / Webhook / PagerDuty)](#56-notifications)
   - [Web UI Integration](#57-web-ui-integration)
   - [Creating a Jira Ticket](#58-creating-a-jira-ticket)
   - [Applying a Git Fix & Opening a PR](#59-applying-a-git-fix--opening-a-pr)
   - [Assigning to GitHub Copilot](#510-assigning-to-github-copilot)
6. [Docker Deployment Examples](#6-docker-deployment-examples)
   - [Self-Fix + GitHub PR](#61-self-fix--github-pr)
   - [Copilot Auto-Assign](#62-copilot-auto-assign)
7. [Cluster Monitor](#7-cluster-monitor)
8. [Session Management](#8-session-management)
9. [Guardrails](#9-guardrails)
10. [Speckits](#10-speckits)
11. [Skills Registry](#11-skills-registry)
12. [Cron Scheduler](#12-cron-scheduler)
13. [Webhooks](#13-webhooks)
14. [Browser Control](#14-browser-control)
15. [Agent-to-Agent Routing](#15-agent-to-agent-routing)
16. [Web UI — Dashboard Walkthrough](#16-web-ui--dashboard-walkthrough)
17. [Programmatic / Library API](#17-programmatic--library-api)
18. [REST & Socket.IO API Reference](#18-rest--socketio-api-reference)
19. [Full CLI Reference](#19-full-cli-reference)

---

## 1. Installation & Configuration

### Install

```bash
# Global CLI
npm install -g fusion-agent

# Project dependency (library API)
npm install fusion-agent

# From source
git clone https://github.com/fury-r/fusion-agent.git
cd fusion-agent && npm install && npm run build
```

### Environment variables

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
```

### Config file

Create `.fusion-agent.json` in your project root **or** `~/.fusion-agent/config.json` for a global default.

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "port": 3000,
  "logLevel": "info",
  "sessionDir": "~/.fusion-agent/sessions",
  "guardrails": [
    { "type": "custom", "value": "Always use TypeScript strict mode" }
  ],
  "github": {
    "token": "ghp_...",
    "repoUrl": "https://github.com/your-org/my-api",
    "assignee": "copilot",
    "autoAssignCopilot": false
  }
}
```

Config is resolved in this order (later overrides earlier):

| Priority    | Source                                                             |
| ----------- | ------------------------------------------------------------------ |
| 1 (lowest)  | `~/.fusion-agent/config.json` / `.yaml`                            |
| 2           | `.fusion-agent.json` / `.yaml` in cwd                              |
| 3           | Environment variables (`AI_PROVIDER`, `AI_MODEL`, `AI_AGENT_PORT`) |
| 4 (highest) | CLI flags                                                          |

Quick check:

```bash
ai-agent config --show          # print resolved config
ai-agent config --provider anthropic --model claude-3-5-sonnet-20241022
```

---

## 2. AI Providers

| Provider      | Env var             | Example models                                          |
| ------------- | ------------------- | ------------------------------------------------------- |
| OpenAI        | `OPENAI_API_KEY`    | `gpt-4o`, `gpt-4-turbo`, `gpt-3.5-turbo`                |
| Anthropic     | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307` |
| Google Gemini | `GEMINI_API_KEY`    | `gemini-1.5-pro`, `gemini-1.5-flash`                    |

All providers support **streaming responses**. Switch providers at any time with `--provider` / `--model` flags or by updating the config.

---

## 3. Vibe Coder — Interactive Chat

An AI pair-programmer that reads your project, generates code, and writes files to disk.

### Start a session

```bash
ai-agent chat                                      # default session
ai-agent chat --session my-project                 # named session (resume if exists)
ai-agent chat --context                            # inject directory tree upfront
ai-agent chat --provider anthropic --model claude-3-5-sonnet-20241022
ai-agent chat --guardrail "Use TypeScript strict mode" --guardrail "No inline styles"
ai-agent chat --speckit code-review                # use a different speckit
```

### In-session commands

| Command            | Action                                              |
| ------------------ | --------------------------------------------------- |
| `/context`         | Inject current directory tree into the conversation |
| `/save`            | Save session without ending                         |
| `/turns`           | Display conversation history                        |
| `/exit` or `/quit` | Save and exit                                       |

### How files are written

When the AI produces a fenced code block with a file path:

````
```typescript:src/server.ts
// content here
```
````

fusion-agent writes that content to `src/server.ts` and records the change in the session turn. You can revert:

```typescript
session.revertTurnChanges(turn.id);
```

### Via Web UI

```bash
ai-agent ui
# Navigate to ⚡ Vibe Coder → Chat tab
```

Type in the chat box, press **Send** (or `Ctrl+Enter`). Click **⊞ Inject context** to send the project tree before prompting.

---

## 4. Autonomous Agent

Give it a requirements file and rules; it codes end-to-end until done. No babysitting required.

### Via Web UI (recommended)

```bash
ai-agent ui
# Navigate to ⚡ Vibe Coder → Autonomous tab
```

| Field                  | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| Requirements file path | Server-side path to a `.md` or `.txt` file                 |
| Paste requirements     | Paste text directly — no file needed                       |
| Rules                  | Constraints injected into every step (one per line)        |
| Time limit             | Auto-stop after N seconds (`0` = no limit)                 |
| Max steps              | Maximum iterations before a forced Human-in-the-Loop check |

Click **▶ Run Autonomous** to start. Progress streams live in the step list. When the agent is confused, a **Human-in-the-Loop (HIL) modal** appears — type your guidance and click **Continue →**.

### CLI (programmatic only — no dedicated command)

Use the programmatic API or the Web UI. See §17 for the full API.

### How loop detection works

After every step, the agent computes **Jaccard similarity** between the last N responses. If similarity ≥ threshold, it fires a HIL event:

| Config                    | Default | Description                                         |
| ------------------------- | ------- | --------------------------------------------------- |
| `loopWindowSize`          | `4`     | Number of recent responses to compare               |
| `loopSimilarityThreshold` | `0.85`  | Similarity fraction that triggers a HIL             |
| `stuckThreshold`          | `3`     | Consecutive steps with no file changes before a HIL |
| `maxSteps`                | `50`    | Hard cap — triggers a HIL on reaching it            |

### HIL reasons

| Reason              | Trigger                                      |
| ------------------- | -------------------------------------------- |
| `loop-detected`     | Recent responses are too similar             |
| `stuck`             | N consecutive steps produced no file changes |
| `max-steps-reached` | Step count hit `maxSteps`                    |
| `error`             | Unrecoverable error                          |

---

## 5. Live Debugger

Tails log sources, batches lines, sends them to the AI, and pushes analysis cards to the Web UI in real time.

```
log source → filter → batch → AI → analysis card
                                  ↓
                         Jira / Git PR / Copilot issue / Slack notification
```

### 5.1 Watching a Log File

```bash
ai-agent debug --file /var/log/app.log
ai-agent debug --file /var/log/app.log --log-level ERROR,FATAL
ai-agent debug --file /var/log/app.log --ui           # open Web UI at :3000
```

### 5.2 Watching a Docker Container

```bash
# Basic — tails the container stdout/stderr
ai-agent debug --docker my-api-container

# With Web UI on a custom port
ai-agent debug --docker my-api-container --ui --port 4000

# Filter to errors only + Slack notification
ai-agent debug --docker my-api-container \
  --log-level ERROR,FATAL \
  --notify-slack https://hooks.slack.com/services/XXX/YYY/ZZZ \
  --ui

# Full production setup
ai-agent debug \
  --docker my-api \
  --log-level ERROR,FATAL \
  --batch 15 \
  --retry 3 \
  --retry-delay 1000 \
  --log-token-limit 25000 \
  --notify-slack https://hooks.slack.com/services/XXX/YYY/ZZZ \
  --session my-api-live-debug \
  --ui --port 3000
```

The container must be **running** and visible to the local Docker daemon. fusion-agent uses `docker logs -f` under the hood — no agent inside the container is needed.

### 5.3 Spawning a Process

```bash
# Node.js app
ai-agent debug --cmd "node server.js"

# With a working directory
ai-agent debug --cmd "node server.js" --batch 10

# Python app
ai-agent debug --cmd "python3 app.py"
```

The process is spawned by fusion-agent. Its stdout and stderr are captured and fed to the AI.

### 5.4 HTTP Polling

Programmatic only (no CLI flag). See §17.

### 5.5 Log Filtering

**By level** — only lines containing the level keyword are forwarded:

```bash
ai-agent debug --docker my-app --log-level ERROR,FATAL,WARN
```

**By regex pattern** — multiple patterns are comma-separated; a line matching any pattern is kept:

```bash
ai-agent debug --file app.log --log-pattern "OOM|out of memory,connection refused"
```

**Combine both:**

```bash
ai-agent debug --docker my-app \
  --log-level ERROR \
  --log-pattern "ECONNREFUSED,timeout"
```

### 5.6 Notifications

| Channel         | Flag                           | Notes             |
| --------------- | ------------------------------ | ----------------- |
| Slack           | `--notify-slack <webhook-url>` | Incoming webhook  |
| Microsoft Teams | `--notify-teams <webhook-url>` | Connector card    |
| Generic HTTP    | `--notify-webhook <url>`       | POST JSON payload |

Notifications fire when:

- An analysis is produced (first occurrence)
- All retries are exhausted on an AI call failure

```bash
ai-agent debug --docker my-app \
  --notify-slack https://hooks.slack.com/services/XXX/YYY/ZZZ \
  --notify-teams https://outlook.office.com/webhook/...
```

PagerDuty and Email are available programmatically only (see §17).

### 5.7 Web UI Integration

Add `--ui` to any `debug` command to open the dashboard:

```bash
ai-agent debug --docker my-api --ui
# → http://localhost:3000
```

In the Web UI:

1. Go to **Sessions** → find the debugger session → click the row.
2. Click **Subscribe Live** to open the real-time log + analysis view.
3. Log lines stream in the left panel. AI analysis cards appear on the right.
4. Each analysis card has action buttons: **Create Jira Ticket**, **Apply Git Fix**, **Assign to Copilot**.

### 5.8 Creating a Jira Ticket

From the Web UI — click **🎫 Create Jira Ticket** on any analysis card. A modal asks for:

| Field         | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| Jira base URL | `https://yourorg.atlassian.net`                                            |
| Email         | Your Atlassian account email                                               |
| API token     | [Create here](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Project key   | e.g. `OPS`                                                                 |
| Issue type    | Bug, Task, Story, etc.                                                     |
| Summary       | Pre-filled from AI analysis                                                |
| Priority      | Highest / High / Medium / Low                                              |
| Labels        | Comma-separated                                                            |
| Guardrails    | Per-integration rules (deny-keyword, require-label, max-summary-length)    |

The Jira key (e.g. `OPS-42`) is stored on the analysis card and in the session turn metadata.

**Automatic Jira ticketing** (no manual click needed) — see §6.1 and §17.

### 5.9 Applying a Git Fix & Opening a PR

From the Web UI — click **⚙ Apply Git Fix** on an analysis card. A wizard walks through:

**Step 1 — Repository**

| Field               | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| Repo path           | Absolute path to a local git clone, e.g. `/home/user/my-service`           |
| GitHub token        | PAT with `repo` + `pull_request:write` scopes                              |
| Remote URL          | `https://github.com/your-org/my-service` (optional — defaults to `origin`) |
| Branch              | Branch to commit to (created if missing, default: `fusion-agent/auto-fix`) |
| GitHub API base URL | `https://api.github.com` for github.com                                    |

**Step 2 — Commit & PR**

| Field          | Description                                            |
| -------------- | ------------------------------------------------------ |
| Commit message | Pre-filled from AI analysis                            |
| PR title       | Title for the pull request                             |
| Base branch    | Target branch (default: `main`)                        |
| Guardrails     | `allow-path:src/`, `deny-path:secrets/`, `max-files:5` |

**Step 3 — Review diff** — shows every file that will be changed before confirming.

After submitting:

- Files are written to the local clone on the specified branch
- `git commit` and `git push` are executed
- A PR is opened via the GitHub API
- The PR URL appears on the analysis card

**File path guardrail syntax (Git):**

| Rule                | Example              | Effect                                  |
| ------------------- | -------------------- | --------------------------------------- |
| `allow-path:<path>` | `allow-path:src/`    | Only files under `src/` may be modified |
| `deny-path:<path>`  | `deny-path:secrets/` | Block commits touching `secrets/`       |
| `max-files:<n>`     | `max-files:5`        | At most 5 files per commit              |

### 5.10 Assigning to GitHub Copilot

From the Web UI — click **🤖 Assign to Copilot** on an analysis card. A modal asks for:

| Field        | Description                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------- |
| GitHub token | PAT with `repo` + `issues:write`                                                                   |
| Repo URL     | `https://github.com/your-org/my-service`                                                           |
| Assignee     | `copilot` (or any username)                                                                        |
| Issue title  | Pre-filled from AI analysis                                                                        |
| Labels       | Comma-separated; the Copilot agent needs at least one label that matches your repo's Copilot label |
| Guardrails   | Per-integration rules (deny-keyword, require-label, max-title-length, max-body-length)             |

A GitHub issue is created and assigned to the Copilot agent, which then opens a fix PR automatically.

If a **guardrail blocks** the issue:

- The analysis card shows a **⚠ Copilot Blocked** badge
- Click the badge to view the violation reason
- Click **Override** to bypass and file anyway

**Copilot issue guardrail syntax:**

| Rule                    | Example                      | Effect                                   |
| ----------------------- | ---------------------------- | ---------------------------------------- |
| `deny-keyword:<word>`   | `deny-keyword:classified`    | Block if title or body contains the word |
| `require-label:<label>` | `require-label:fusion-agent` | Issue must include this label            |
| `max-title-length:<n>`  | `max-title-length:200`       | Truncate or reject long titles           |
| `max-body-length:<n>`   | `max-body-length:65536`      | Truncate or reject long bodies           |

---

## 6. Docker Deployment Examples

### 6.1 Self-Fix + GitHub PR

fusion-agent watches a Docker container, generates a fix, commits it, and opens a PR — all automatically. No external coding agent needed.

**Workflow:**

```
Docker container errors → AI analysis → parse file blocks
  → git commit on fusion-agent/auto-fix branch
  → push → open GitHub PR
  → (optional) create Jira ticket + post PR URL as comment
  → (optional) send Slack/webhook notification
```

**Setup:**

```bash
cd deploy/live-debugger-selffix

# 1. Copy and edit config
cp config.example.json .fusion-agent.json

# 2. Clone the repo you want to auto-fix
git clone https://github.com/your-org/my-service /home/user/my-service

# 3. Export secrets
export OPENAI_API_KEY=sk-...
export GITHUB_TOKEN=ghp_...                           # repo + pull_request:write
export GITHUB_REPO=https://github.com/your-org/my-service
export GIT_REPO_PATH=/home/user/my-service

# Optional Git config
export GIT_BRANCH=fusion-agent/auto-fix
export BASE_BRANCH=main
export GIT_AUTHOR_NAME="fusion-agent[bot]"
export GIT_AUTHOR_EMAIL="fusion-agent@noreply"

# Optional Jira
export JIRA_BASE_URL=https://yourorg.atlassian.net
export JIRA_EMAIL=you@yourorg.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT_KEY=OPS

# Optional notifications
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ

# 4. Start
bash start.sh
```

Open `http://localhost:3000` → Sessions → `live-debug-selffix` → **Subscribe Live**.

**Docker Compose:**

```bash
cd deploy
docker compose up
```

The `docker-compose.yml` mounts `cluster-debug-rules.example.yaml` and sets the monitor to `human-in-loop` mode watching a sample app that emits synthetic errors.

### 6.2 Copilot Auto-Assign

fusion-agent watches a container and delegates fixes to the GitHub Copilot agent.

**Workflow:**

```
Docker container errors → AI analysis → guardrail check
  → create GitHub issue assigned to Copilot
  → Copilot opens fix PR autonomously
  → (optional) create Jira ticket
  → (optional) send Slack/webhook notification
```

**Setup:**

```bash
cd deploy/live-debugger-copilot-autoassign

cp config.example.json .fusion-agent.json

export OPENAI_API_KEY=sk-...
export GITHUB_TOKEN=ghp_...         # repo + issues:write
export GITHUB_REPO=https://github.com/your-org/my-service

# Optional Jira + notifications (same env vars as §6.1)

bash start.sh
```

Open `http://localhost:3000` → Sessions → `live-debug-copilot-autoassign` → **Subscribe Live**.

**Kubernetes (Helm-style manifest):**

```bash
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
```

---

## 7. Cluster Monitor

Monitors multiple services simultaneously (Kubernetes deployments, Docker containers, log files, or processes), detects failures, and auto-remediates based on configurable rules.

### Modes

| Mode            | Behaviour                                               |
| --------------- | ------------------------------------------------------- |
| `auto-fix`      | Apply matching remediation rule without human input     |
| `notify-only`   | Send notification with AI analysis, no action taken     |
| `human-in-loop` | Send notification + wait for approve/reject via webhook |

### CLI

```bash
# Watch all pods in a Kubernetes namespace
ai-agent cluster-debug --config cluster-rules.yaml --all --namespace production

# Watch a specific service
ai-agent cluster-debug --service "api:docker:my-container" --mode notify-only

# Watch multiple services with a rules file
ai-agent cluster-debug \
  --config cluster-rules.yaml \
  --mode human-in-loop \
  --service "api:docker:api-container" \
  --service "worker:log-file:/var/log/worker.log"
```

### Rules file (`cluster-rules.yaml`)

```yaml
version: "1.0"

rules:
  canAutoFix:
    - id: restart-on-oom
      name: Restart on OOM
      trigger: "OOMKilled|out of memory|killed"
      action:
        type: restart-pod
      priority: 10
      requireApproval: false

    - id: restart-on-crash
      name: Restart on crash
      trigger: "CrashLoopBackOff|exit code [1-9]|panic"
      action:
        type: restart-pod
      priority: 8
      requireApproval: false

  avoid:
    - id: avoid-delete-db
      description: Do not delete databases or persistent volumes
      pattern: "delete.*pv|delete.*pvc|drop.*database"

    - id: avoid-scale-zero
      description: Do not scale any deployment to zero replicas
      pattern: "scale.*replicas.*0"

  requireApproval:
    - database-migration
    - config-change
    - ai-fix

notifications:
  slack:
    enabled: true
    webhookUrl: "https://hooks.slack.com/services/YOUR/WEBHOOK"
  pagerduty:
    enabled: false
    integrationKey: "YOUR_KEY"
```

### Supported action types

| Action        | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `restart-pod` | Restart the Kubernetes pod or Docker container                         |
| `notify-only` | Send notification, take no code action                                 |
| `ai-fix`      | Generate a code fix via AI and apply it (requires approval by default) |
| `scale`       | Scale the deployment (always requires approval)                        |

### Trigger matching

`trigger` is evaluated as a **case-insensitive regex** against the concatenated log lines. If the regex is invalid, it falls back to a case-insensitive substring match.

---

## 8. Session Management

Sessions persist full conversation history, file changes, and debugger metadata.

### Storage location

```
~/.fusion-agent/sessions/
  <session-id>.json
```

### CLI

```bash
ai-agent session list                     # list all sessions
ai-agent session resume <name-or-id>      # resume a previous session
ai-agent session delete <name-or-id>      # delete a session
ai-agent session export <name-or-id>      # print JSON to stdout
```

### Web UI

**Sessions** page lists all sessions with status badges. Click a row to open the detail view: full conversation turns, file diffs per turn, and debugger metadata (matched log lines, Jira key, PR URL).

Export and Delete buttons are available in the detail header.

### Session turn structure

```json
{
  "id": "turn-uuid",
  "timestamp": "2026-05-31T10:00:00.000Z",
  "userMessage": "Add JWT auth",
  "assistantMessage": "Here is the middleware...",
  "fileChanges": [
    {
      "filePath": "src/middleware/auth.ts",
      "previousContent": null,
      "newContent": "// new file content"
    }
  ],
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 800,
    "totalTokens": 2000
  },
  "debuggerMeta": {
    "matchedLogLines": ["ERROR: connection refused"],
    "promptSentAt": "2026-05-31T10:00:00Z",
    "responseReceivedAt": "2026-05-31T10:00:03Z",
    "notificationSent": true,
    "fixApplied": false,
    "jiraKey": "OPS-42",
    "gitFixUrl": "https://github.com/org/repo/pull/7",
    "copilotIssueUrl": "https://github.com/org/repo/issues/12"
  }
}
```

---

## 9. Guardrails

Safety rules injected into the AI system prompt and enforced at the file-write layer.

### Types

| Type              | Value                               | Effect                               |
| ----------------- | ----------------------------------- | ------------------------------------ |
| `allow-paths`     | `["src/", "tests/"]`                | AI may only read/modify these paths  |
| `deny-paths`      | `["secrets/", ".env"]`              | AI must not touch these paths        |
| `deny-operations` | `["delete", "rm -rf"]`              | AI must not perform these operations |
| `max-tokens`      | `4000`                              | Cap AI responses to N tokens         |
| `style`           | `"Use functional React components"` | Coding style constraint              |
| `custom`          | Any free text                       | Injected verbatim as a constraint    |

### Via CLI

```bash
ai-agent chat \
  --guardrail "Use TypeScript strict mode" \
  --guardrail "No inline styles"
```

### Via config file

```json
{
  "guardrails": [
    { "type": "allow-paths", "value": ["src/", "tests/"] },
    { "type": "deny-paths", "value": ["secrets/"] },
    { "type": "custom", "value": "Never use any" }
  ]
}
```

### Via programmatic API

```typescript
import { createGuardrail } from "fusion-agent";

const session = agent.createSession({
  guardrails: [
    createGuardrail("allow-paths", ["src/", "tests/"]),
    createGuardrail("deny-paths", ["secrets/", ".env"]),
    createGuardrail("custom", "Always add JSDoc to public functions"),
  ],
});
```

When a file write violates a guardrail it is **skipped** and the user is warned. The guardrail text is also injected into the system prompt so the AI self-enforces the constraints.

---

## 10. Speckits

Pre-configured agent personas with tuned system prompts.

| Speckit          | Key                | Best for                                |
| ---------------- | ------------------ | --------------------------------------- |
| Vibe Coder       | `vibe-coder`       | General coding, file generation         |
| Debugger         | `debugger`         | Log analysis, error explanation         |
| Code Review      | `code-review`      | Quality, security, best-practice review |
| Doc Writer       | `doc-writer`       | Documentation generation                |
| Test Writer      | `test-writer`      | Unit and integration test generation    |
| Refactor         | `refactor`         | Structural improvements                 |
| Security Audit   | `security-audit`   | Vulnerability scanning                  |
| Cluster Debugger | `cluster-debugger` | Multi-service / Kubernetes analysis     |

### List available speckits

```bash
ai-agent speckit          # list all
ai-agent speckit run code-review --session my-pr
```

### Use a speckit

```bash
ai-agent chat --speckit security-audit
ai-agent chat --speckit test-writer --session add-tests
```

### Programmatic

```typescript
const session = agent.createSession({ speckit: "code-review" });
```

---

## 11. Skills Registry

Install domain-expert SKILL.md files. The autonomous agent loads and applies them automatically at runtime.

### Install a skill

```bash
ai-agent skill install ./my-skill/SKILL.md
ai-agent skill install https://github.com/anthropics/skills --skill frontend-design
```

### List skills

```bash
ai-agent skill list
```

Skills are stored in `~/.fusion-agent/skills/<name>/SKILL.md`. Any skill name can be used as a speckit:

```bash
ai-agent chat --speckit frontend-design
```

---

## 12. Cron Scheduler

Schedule autonomous agent runs with standard cron expressions. Jobs persist across restarts via `~/.fusion-agent/cron.json`.

### CLI

```bash
# Add a job
ai-agent cron add \
  --name "nightly-security-scan" \
  --schedule "0 2 * * *" \
  --session security-scan \
  --requirements-file ./security-requirements.md

# List jobs
ai-agent cron list

# Enable / disable a job
ai-agent cron enable <job-id>
ai-agent cron disable <job-id>

# Remove a job
ai-agent cron remove <job-id>
```

### Cron expression examples

| Expression     | Schedule                           |
| -------------- | ---------------------------------- |
| `0 9 * * 1-5`  | 9 AM weekdays                      |
| `0 2 * * *`    | 2 AM every day                     |
| `*/15 * * * *` | Every 15 minutes                   |
| `0 0 1 * *`    | Midnight on the 1st of every month |

### Via Web UI

Settings page → Cron section (if enabled).

---

## 13. Webhooks

Register HTTP webhooks that trigger an autonomous agent run on demand.

### CLI

```bash
# Create a webhook (token is shown once — save it)
ai-agent webhook create \
  --name "deploy-trigger" \
  --session auto-deploy \
  --requirements-file ./deploy-requirements.md

# List webhooks
ai-agent webhook list

# Delete a webhook
ai-agent webhook delete <webhook-id>
```

### Triggering a webhook

```bash
curl -X POST http://localhost:3000/api/webhooks/<webhook-id>/trigger \
  -H "Authorization: Bearer <plain-text-token>" \
  -H "Content-Type: application/json" \
  -d '{"extra": "context"}'
```

Tokens are **SHA-256 hashed** at rest. Validation uses **timing-safe comparison** to prevent timing attacks. The plain-text token is shown only once on creation.

---

## 14. Browser Control

The autonomous agent can control a browser when it emits `<browser>` response blocks.

```xml
<browser>
  <navigate>https://example.com</navigate>
  <snapshot/>
  <click selector=".login-btn"/>
  <type selector="#username" value="admin"/>
  <evaluate>document.title</evaluate>
</browser>
```

**Requirements:** Chrome or Chromium installed. The agent uses Puppeteer/Playwright under the hood.

Use cases:

- UI testing and validation during autonomous builds
- Scraping data as part of a coding task
- Taking screenshots for documentation

---

## 15. Agent-to-Agent Routing

Multiple autonomous agents running in the same process can exchange messages via `<agent>` response blocks and the in-memory **AgentBus**.

```xml
<agent name="reviewer">
  Please review the code I just wrote in src/auth.ts and suggest improvements.
</agent>
```

The AgentBus routes the message to a registered agent named `reviewer`. That agent responds, and its output is injected into the calling agent's next step.

```typescript
import { AgentBus } from "fusion-agent";

const bus = new AgentBus();
bus.register("reviewer", reviewerSession);
bus.register("coder", coderSession);
```

---

## 16. Web UI — Dashboard Walkthrough

```bash
ai-agent ui                  # starts on port 3000
ai-agent ui --port 8080
```

### Sidebar navigation

| Section   | Page                                       |
| --------- | ------------------------------------------ |
| Workspace | Sessions — all session history             |
| Workspace | Vibe Coder — interactive chat + autonomous |
| System    | Settings — AI provider & server config     |
| System    | Docs — built-in documentation              |

### Sessions page

- Lists all sessions with status badges (`idle`, `running`, `error`)
- Colored left border per speckit type
- **Refresh** / **Clear All** buttons
- Click a row to open the session detail

### Session detail page

- Full conversation turn history
- File changes per turn with diffs
- For debugger sessions: matched log lines, Jira key chip, PR link chip
- **Export** (JSON) and **Delete** buttons

### Vibe Coder page — Chat tab

- Session name + project directory inputs
- **New** — create a fresh session
- **▶ Demo** — run a built-in demo
- Status pill: `idle` / `running` / `streaming` / `error`
- Message history with streamed AI responses
- File chip strip below each AI turn (click a chip to view the file)
- **⊞** button — inject project context
- `Ctrl+Enter` sends the message

### Vibe Coder page — Autonomous tab

- Requirements file path or paste area
- Rules list (add/remove per-rule)
- Time limit + max steps
- **▶ Run Autonomous** / **◼ Stop**
- Step list with expandable output per step
- Files panel showing all written files
- HIL modal fires automatically when the agent is stuck

### Live Debugger detail view

Opened by clicking a debugger session and then **Subscribe Live**:

| Panel                 | Contents                                            |
| --------------------- | --------------------------------------------------- |
| Left — log feed       | Real-time streaming log lines                       |
| Right — Analysis tab  | AI analysis cards, one per batch                    |
| Right — Dashboard tab | Stats: total lines, analyses, fixes applied, errors |
| Info panel            | Session metadata, connect status, subscribe button  |

Each **analysis card** shows:

- Timestamp + log lines that triggered it
- Full AI analysis text
- Action buttons: **🎫 Jira**, **⚙ Git Fix**, **🤖 Copilot**

### Settings page

- Default AI provider & model
- Web UI port
- Log level
- API key note (keys are never stored — use env vars)

---

## 17. Programmatic / Library API

```typescript
import {
  AgentCLI,
  LiveDebugger,
  AutonomousVibeAgent,
  ClusterMonitor,
  createWebServer,
  createGuardrail,
} from "fusion-agent";
```

### Basic chat

```typescript
const agent = new AgentCLI({ provider: "openai", model: "gpt-4o" });
const response = await agent.chat("Write a Node.js HTTP server in TypeScript");
```

### Session-based chat with guardrails

```typescript
const agent = new AgentCLI({ provider: "anthropic" });

const session = agent.createSession({
  name: "my-project",
  speckit: "vibe-coder",
  projectDir: "/home/user/my-project",
  guardrails: [
    createGuardrail("allow-paths", ["src/", "tests/"]),
    createGuardrail("custom", "Use TypeScript strict mode"),
  ],
});

const turn = await session.chat("Add JWT authentication middleware", {
  stream: true,
  onChunk: (chunk) => process.stdout.write(chunk),
});

console.log("Files changed:", turn.fileChanges);

// Revert this turn's file changes
session.revertTurnChanges(turn.id);

agent.sessionManager.persistSession(session);
```

### Live Debugger

```typescript
const debugger_ = new LiveDebugger({
  session,
  batchSize: 15,
  maxWaitSeconds: 30,
  logLevels: ["ERROR", "FATAL"],
  retryCount: 3,
  retryDelayMs: 1000,
  notifications: {
    slack: { enabled: true, webhookUrl: process.env.SLACK_WEBHOOK! },
    pagerduty: { enabled: true, routingKey: process.env.PD_KEY! },
  },
  onAnalysis: (analysis, meta) => {
    console.log("Analysis:", analysis);
    console.log("Jira key:", meta?.jiraKey);
    agent.sessionManager.persistSession(session);
  },
});

debugger_.on("error", (err) => console.error("Debugger error:", err.message));

// Connect to a source (choose one)
debugger_.watchLogFile("/var/log/app.log", 50);

debugger_.connectToService({ type: "docker", container: "my-api" });

debugger_.connectToService({
  type: "process",
  command: "node",
  args: ["server.js"],
  cwd: "/home/ubuntu/app",
});

debugger_.connectToService({
  type: "http-poll",
  url: "http://localhost:8080/health",
  intervalMs: 5000,
});

process.on("SIGINT", () => debugger_.stop());
```

### Live Debugger + Web UI

```typescript
const server = createWebServer({
  port: 3000,
  sessionManager: agent.sessionManager,
  provider: "openai",
});
await server.start();

const debugger_ = new LiveDebugger({
  session,
  io: server.io, // ← real-time pushes to the browser
  onAnalysis: () => agent.sessionManager.persistSession(session),
});

debugger_.connectToService({ type: "docker", container: "my-api" });
```

### Autonomous Agent

```typescript
const autoAgent = new AutonomousVibeAgent(session, {
  requirementsFile: "./requirements.md",
  rules: [
    { id: "ts", description: "All files must be TypeScript" },
    { id: "no-class", description: "Use functional patterns, no classes" },
  ],
  maxSteps: 30,
  timeLimitSeconds: 300,
  loopSimilarityThreshold: 0.85,
  stuckThreshold: 3,
});

autoAgent.on("step", (step) =>
  console.log(`Step ${step.stepNumber} — files:`, step.filesChanged),
);
autoAgent.on("hil-request", (req) => {
  console.log("HIL needed:", req.reason);
  autoAgent.receiveHILResponse("Focus on the auth module");
});
autoAgent.on("complete", (steps) =>
  console.log(`Done in ${steps.length} steps`),
);
autoAgent.on("error", (err) => console.error(err.message));

await autoAgent.run();
```

### Jira (direct)

```typescript
import { JiraClient } from "fusion-agent";

const jira = new JiraClient({
  baseUrl: "https://yourorg.atlassian.net",
  email: "you@yourorg.com",
  apiToken: process.env.JIRA_API_TOKEN!,
  projectKey: "OPS",
  issueType: "Bug",
  guardrails: ["deny-keyword:classified", "require-label:automated"],
});

const result = await jira.createIssue({
  summary: "[AI] Connection refused in api-service",
  description: "Full AI analysis text...",
  priority: "High",
  labels: ["automated", "fusion-agent"],
});
console.log(result.key, result.url);

await jira.addComment(
  result.key,
  "PR opened: https://github.com/org/repo/pull/42",
);
```

### Git Fix (direct)

```typescript
import { GitPatchApplier } from "fusion-agent";

const patcher = new GitPatchApplier({
  repoPath: "/home/user/my-service",
  token: process.env.GITHUB_TOKEN,
  remoteUrl: "https://github.com/your-org/my-service",
  branch: "fusion-agent/auto-fix",
  apiBaseUrl: "https://api.github.com",
  guardrails: ["allow-path:src/", "max-files:5"],
});

const result = await patcher.applyAndCommit({
  files: {
    "src/services/db.ts": "// fixed content",
  },
  commitMessage: "fix: handle connection refused in db service",
  pullRequestTitle: "fix: connection refused auto-fix",
  pullRequestBody:
    "AI-generated fix for ECONNREFUSED in db service.\n\nSee Jira: OPS-42",
  baseBranch: "main",
});

console.log("PR URL:", result.pullRequestUrl);
```

---

## 18. REST & Socket.IO API Reference

The web server exposes a REST API and Socket.IO events.

### REST endpoints

| Method   | Path                                     | Description                    |
| -------- | ---------------------------------------- | ------------------------------ |
| `GET`    | `/api/sessions`                          | List all sessions              |
| `GET`    | `/api/sessions/:id`                      | Get session JSON               |
| `DELETE` | `/api/sessions/:id`                      | Delete session                 |
| `GET`    | `/api/settings`                          | Get current settings           |
| `POST`   | `/api/settings`                          | Update settings                |
| `POST`   | `/api/debugger/:sessionId/jira`          | Create Jira ticket from a turn |
| `POST`   | `/api/debugger/:sessionId/git-fix`       | Apply Git fix from a turn      |
| `POST`   | `/api/debugger/:sessionId/copilot-issue` | Create Copilot GitHub issue    |
| `GET`    | `/api/cron`                              | List cron jobs                 |
| `POST`   | `/api/cron`                              | Create cron job                |
| `DELETE` | `/api/cron/:id`                          | Delete cron job                |
| `POST`   | `/api/webhooks/:id/trigger`              | Trigger a webhook run          |

### Key Socket.IO events

**Client → Server:**

| Event                   | Payload                   | Description                  |
| ----------------------- | ------------------------- | ---------------------------- |
| `vibe:chat`             | `{ sessionId, message }`  | Send a chat message          |
| `vibe:start-autonomous` | `{ sessionId, config }`   | Start autonomous run         |
| `vibe:stop-autonomous`  | `{ sessionId }`           | Stop autonomous run          |
| `vibe:hil-response`     | `{ sessionId, guidance }` | Send HIL guidance            |
| `vibe:inject-context`   | `{ sessionId }`           | Inject project context       |
| `debugger:subscribe`    | `{ sessionId }`           | Subscribe to debugger events |

**Server → Client:**

| Event                     | Payload                                     | Description                  |
| ------------------------- | ------------------------------------------- | ---------------------------- |
| `vibe:chunk`              | `{ chunk, sessionId }`                      | Streaming AI token           |
| `vibe:turn-complete`      | `{ turn }`                                  | Full turn (with fileChanges) |
| `vibe:hil-request`        | `{ reason, confusionSummary, recentSteps }` | HIL needed                   |
| `vibe:status`             | `{ status }`                                | Agent status change          |
| `debugger:log`            | `{ line, sessionId }`                       | Raw log line                 |
| `debugger:analysis`       | `{ analysis, meta, sessionId }`             | AI analysis                  |
| `debugger:analysis-chunk` | `{ chunk, sessionId }`                      | Streaming analysis token     |

---

## 19. Full CLI Reference

```
ai-agent [command] [options]
```

| Command         | Description                                           |
| --------------- | ----------------------------------------------------- |
| `chat`          | Start/resume a Vibe Coder session                     |
| `debug`         | Attach a Live Debugger to a log source                |
| `ui`            | Launch the Web Dashboard                              |
| `session`       | Manage sessions (list, resume, delete, export)        |
| `speckit`       | List or run a speckit                                 |
| `cluster-debug` | Start the Cluster Monitor                             |
| `skill`         | Manage skills (install, list)                         |
| `webhook`       | Manage webhooks (create, list, delete)                |
| `cron`          | Manage cron jobs (add, list, enable, disable, remove) |
| `config`        | View or update configuration                          |

### Global options

| Flag                  | Description                            | Default          |
| --------------------- | -------------------------------------- | ---------------- |
| `--provider <name>`   | `openai` \| `anthropic` \| `gemini`    | From config      |
| `--model <name>`      | Model name                             | Provider default |
| `--port <n>`          | Web UI port                            | `3000`           |
| `--log-level <level>` | `debug` \| `info` \| `warn` \| `error` | `info`           |

### `ai-agent chat` options

| Flag                     | Description                            |
| ------------------------ | -------------------------------------- |
| `-s, --session <name>`   | Session name — creates or resumes      |
| `-k, --speckit <name>`   | Speckit to use (default: `vibe-coder`) |
| `-g, --guardrail <rule>` | Add a guardrail (repeatable)           |
| `--context`              | Inject project directory tree upfront  |

### `ai-agent debug` options

| Flag                       | Description                                         | Default              |
| -------------------------- | --------------------------------------------------- | -------------------- |
| `-f, --file <path>`        | Watch a log file                                    | —                    |
| `-d, --docker <container>` | Attach to a Docker container                        | —                    |
| `-c, --cmd <command>`      | Spawn a process                                     | —                    |
| `-s, --session <name>`     | Session name                                        | `live-debugger-<id>` |
| `--batch <n>`              | Lines to buffer before sending to AI                | `20`                 |
| `--retry <n>`              | Max retry attempts                                  | `3`                  |
| `--retry-delay <ms>`       | Base retry delay (exponential back-off)             | `1000`               |
| `--log-token-limit <n>`    | Max tokens per prompt                               | Auto                 |
| `--log-level <levels>`     | Comma-separated levels to keep (e.g. `ERROR,FATAL`) | —                    |
| `--log-pattern <patterns>` | Comma-separated regex patterns                      | —                    |
| `--notify-slack <url>`     | Slack incoming webhook                              | —                    |
| `--notify-teams <url>`     | Teams webhook                                       | —                    |
| `--notify-webhook <url>`   | Generic HTTP webhook                                | —                    |
| `--ui`                     | Launch Web UI alongside debugger                    | —                    |
| `--port <n>`               | Web UI port (requires `--ui`)                       | `3000`               |

### `ai-agent cluster-debug` options

| Flag               | Description                                    |
| ------------------ | ---------------------------------------------- |
| `--config <path>`  | Path to cluster rules YAML/JSON file           |
| `--mode <mode>`    | `auto-fix` \| `notify-only` \| `human-in-loop` |
| `--service <spec>` | `name:type:target` — repeatable                |
| `--all`            | Discover all services in namespace             |
| `--namespace <ns>` | Kubernetes namespace                           |

### `ai-agent session` sub-commands

```bash
ai-agent session list
ai-agent session resume <name-or-id>
ai-agent session delete <name-or-id>
ai-agent session export <name-or-id>
```

### `ai-agent speckit` sub-commands

```bash
ai-agent speckit                            # list all
ai-agent speckit run <name>                 # run speckit interactively
ai-agent speckit run <name> --session <s>   # run with named session
```
