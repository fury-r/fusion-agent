# Live Debugger — GitHub Copilot Auto-Assign Example

Demonstrates the full **auto-assign-to-Copilot** workflow:

1. The live debugger watches a Docker container for errors.
2. Every batch of matching log lines is sent to the AI for analysis.
3. The AI analysis is automatically filed as a GitHub issue and assigned to the **Copilot coding agent** — which then opens a fix PR without any human action.
4. Configurable **guardrails** gate every issue before it is created. If a rule is violated, the Web UI shows a blocking badge and a notification is sent to Slack / your webhook.
5. A **Jira ticket** is optionally created alongside every analysis.

> **When to use this vs. the self-fix example:**  
> Use this example when you want the AI to _delegate_ the fix to the GitHub Copilot agent. Use the [selffix-github](../live-debugger-selffix/README.md) example when you want fusion-agent to write and commit the fix itself.

---

## Prerequisites

| Requirement                         | Details                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| Node.js ≥ 18                        | `node --version`                                                     |
| Docker                              | for the dummy error-emitting server                                  |
| `ts-node`                           | `npm install -g ts-node` or use `npx` (auto-installed by `start.sh`) |
| OpenAI / Anthropic / Gemini API key | at least one                                                         |
| GitHub personal access token        | needs `repo` + `issues:write` scopes                                 |

---

## Quick Start

```bash
# 1. Copy and edit the example config
cp config.example.json .fusion-agent.json
# Edit .fusion-agent.json — fill in your real token and repoUrl

# 2. Export required secrets
export OPENAI_API_KEY=sk-...
export GITHUB_TOKEN=ghp_...
export GITHUB_REPO=https://github.com/your-org/my-service

# Optional — Jira integration
export JIRA_BASE_URL=https://yourorg.atlassian.net
export JIRA_EMAIL=you@yourorg.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT_KEY=OPS

# Optional — Slack / webhook notifications (sent when a guardrail blocks auto-assign)
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
export NOTIFY_WEBHOOK_URL=https://your-webhook-receiver/events

# 3. Run
bash start.sh
```

Open `http://localhost:3000` — the `live-debug-copilot-autoassign` session appears in the Sessions tab. Click **Subscribe Live** to watch logs and AI analysis cards update in real time.

---

## Environment Variables

| Variable                                                  | Required                                   | Description                        |
| --------------------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `AI_PROVIDER`                                             | No (default: `openai`)                     | `openai` · `anthropic` · `gemini`  |
| `AI_MODEL`                                                | No (default: `gpt-4o`)                     | Model name for the chosen provider |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Yes (one of)                               | AI provider key                    |
| `GITHUB_TOKEN`                                            | Yes                                        | PAT with `repo` + `issues:write`   |
| `GITHUB_REPO`                                             | Yes                                        | `https://github.com/org/repo`      |
| `DOCKER_CONTAINER`                                        | No (default: `fusion-live-debugger-dummy`) | Container to tail                  |
| `WEB_PORT`                                                | No (default: `3000`)                       | Web UI port                        |
| `JIRA_BASE_URL`                                           | No                                         | Enable Jira auto-ticketing         |
| `JIRA_EMAIL`                                              | No                                         |                                    |
| `JIRA_API_TOKEN`                                          | No                                         |                                    |
| `JIRA_PROJECT_KEY`                                        | No (default: `OPS`)                        |                                    |
| `SLACK_WEBHOOK_URL`                                       | No                                         | Slack incoming webhook             |
| `NOTIFY_WEBHOOK_URL`                                      | No                                         | Generic HTTP webhook               |

---

## Copilot Issue Guardrails

Guardrails are evaluated **before** every GitHub issue is created.  
If any rule is violated the issue is **not** filed and instead:

- The **Web UI** analysis card shows an ⚠ **Copilot Blocked** badge (click to view the violation and override if needed).
- A **notification** is sent to every configured channel (Slack / webhook) asking you to review.

Guardrails are configured in `config.example.json` → `github.guardrails` (or directly in `index.ts`):

```json
"guardrails": [
  "deny-keyword:classified",
  "deny-keyword:internal-only",
  "require-label:fusion-agent",
  "max-title-length:200",
  "max-body-length:65536"
]
```

| Rule                    | Example                      | Effect                                                          |
| ----------------------- | ---------------------------- | --------------------------------------------------------------- |
| `deny-keyword:<word>`   | `deny-keyword:classified`    | Block if title **or** body contains the word (case-insensitive) |
| `require-label:<label>` | `require-label:fusion-agent` | Block if the label is absent from the issue                     |
| `max-title-length:<n>`  | `max-title-length:200`       | Block if the title exceeds N characters                         |
| `max-body-length:<n>`   | `max-body-length:65536`      | Block if the body exceeds N characters                          |

### Overriding a blocked assignment

When a guardrail fires the Web UI blocked modal appears with:

- The violated rule
- The blocked issue title
- **Override & Assign** button — bypasses the guardrails and creates the issue anyway
- **Dismiss** button — drops this analysis silently

---

## What the Web UI shows

| UI Element                  | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| Analysis card               | AI analysis rendered as Markdown                             |
| **▶ Prompt** toggle         | Expand to see the raw log lines sent to the AI               |
| **🤖 Copilot Issue** chip   | Link to the created GitHub issue (appears after auto-assign) |
| **⚠ Copilot Blocked** badge | Guardrail fired — click to view and override                 |
| **📋 Jira ticket** chip     | Link to the Jira ticket (if Jira is configured)              |
| **🔔 Notified** badge       | A notification was dispatched for this analysis              |
| **🔴 / 🟡 / 🟢** dot        | Live connection status                                       |

---

## Stopping

Press `Ctrl-C`. The debugger flushes any pending analysis, persists the session, and shuts down cleanly.

To stop only the dummy server:

```bash
docker compose -f ../live-debugger-dummy-server/docker-compose.yml down
```

---

## Project structure

```
live-debugger-copilot-autoassign/
├── index.ts              ← main example — fully annotated
├── config.example.json   ← copy to .fusion-agent.json and fill in
├── start.sh              ← one-command start (starts dummy server + runs example)
└── README.md             ← this file
```
