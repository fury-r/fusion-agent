# Live Debugger — Self-Fix + Commit to GitHub Example

Demonstrates the full **fusion-agent self-fix** workflow — no external coding agent required:

1. The live debugger watches a Docker container for errors.
2. Every batch of matching log lines is sent to the AI for analysis.
3. **fusion-agent itself** parses the proposed code changes from the analysis, commits them to a new branch, and opens a Pull Request — all automatically.
4. Configurable **guardrails** govern which files may be modified and how many files can be changed per commit.
5. A **Jira ticket** is created for every analysis, and the PR URL is added as a follow-up comment.
6. Slack / webhook **notifications** are sent when retries are exhausted or a guardrail is violated.

> **When to use this vs. the Copilot example:**  
> Use this example when you want fusion-agent to write and commit the fix directly. Use the [copilot-autoassign](../live-debugger-copilot-autoassign/README.md) example when you want to delegate the fix to the GitHub Copilot coding agent.

---

## Prerequisites

| Requirement                         | Details                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| Node.js ≥ 18                        | `node --version`                                                     |
| Docker                              | for the dummy error-emitting server                                  |
| `git`                               | must be in `PATH` and the repo at `GIT_REPO_PATH` must be cloned     |
| `ts-node`                           | `npm install -g ts-node` or use `npx` (auto-installed by `start.sh`) |
| OpenAI / Anthropic / Gemini API key | at least one                                                         |
| GitHub personal access token        | needs `repo` + `pull_request:write` scopes                           |

---

## Quick Start

```bash
# 1. Copy and edit the example config
cp config.example.json .fusion-agent.json

# 2. Clone the repo you want to auto-fix (if you haven't already)
git clone https://github.com/your-org/my-service /home/user/my-service

# 3. Export required secrets
export OPENAI_API_KEY=sk-...
export GITHUB_TOKEN=ghp_...
export GITHUB_REPO=https://github.com/your-org/my-service
export GIT_REPO_PATH=/home/user/my-service   # absolute path to local clone

# Optional — branch/commit config
export GIT_BRANCH=fusion-agent/auto-fix       # default
export BASE_BRANCH=main                        # PR target
export GIT_AUTHOR_NAME="fusion-agent[bot]"
export GIT_AUTHOR_EMAIL="fusion-agent@noreply"

# Optional — Jira integration
export JIRA_BASE_URL=https://yourorg.atlassian.net
export JIRA_EMAIL=you@yourorg.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT_KEY=OPS

# Optional — Slack / webhook notifications
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
export NOTIFY_WEBHOOK_URL=https://your-webhook-receiver/events

# 4. Run
bash start.sh
```

Open `http://localhost:3000` — the `live-debug-selffix` session appears in the Sessions tab.  
Click **Subscribe Live** to watch logs and analysis cards update in real time.  
Each card includes a **🔗 Git Fix** chip linking to the PR once the fix is applied.

---

## Environment Variables

| Variable                                                  | Required                                   | Description                            |
| --------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `AI_PROVIDER`                                             | No (default: `openai`)                     | `openai` · `anthropic` · `gemini`      |
| `AI_MODEL`                                                | No (default: `gpt-4o`)                     | Model name for the chosen provider     |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Yes (one of)                               | AI provider key                        |
| `GITHUB_TOKEN`                                            | Yes                                        | PAT with `repo` + `pull_request:write` |
| `GITHUB_REPO`                                             | Yes                                        | `https://github.com/org/repo`          |
| `GIT_REPO_PATH`                                           | Yes                                        | Absolute path to the local git clone   |
| `GIT_BRANCH`                                              | No (default: `fusion-agent/auto-fix`)      | Branch to commit to                    |
| `BASE_BRANCH`                                             | No (default: `main`)                       | PR base branch                         |
| `GIT_API_BASE_URL`                                        | No (default: `https://api.github.com`)     | GitHub Enterprise base URL             |
| `GIT_AUTHOR_NAME`                                         | No                                         | Commit author name                     |
| `GIT_AUTHOR_EMAIL`                                        | No                                         | Commit author email                    |
| `DOCKER_CONTAINER`                                        | No (default: `fusion-live-debugger-dummy`) | Container to tail                      |
| `WEB_PORT`                                                | No (default: `3000`)                       | Web UI port                            |
| `JIRA_BASE_URL`                                           | No                                         | Enable Jira auto-ticketing             |
| `JIRA_EMAIL`                                              | No                                         |                                        |
| `JIRA_API_TOKEN`                                          | No                                         |                                        |
| `JIRA_PROJECT_KEY`                                        | No (default: `OPS`)                        |                                        |
| `SLACK_WEBHOOK_URL`                                       | No                                         | Slack incoming webhook                 |
| `NOTIFY_WEBHOOK_URL`                                      | No                                         | Generic HTTP webhook                   |

---

## How AI-proposed fixes are extracted

The AI analyses a batch of log lines and, when it can identify a fix, it includes code blocks tagged with the destination file path:

````
```typescript:src/server.ts
// fixed content goes here
```
````

`extractFileBlocks()` parses these blocks and passes the resulting `{ filePath, content }` map directly to `GitPatchApplier.applyAndCommit()`.  
If the analysis contains no code blocks the git step is silently skipped.

---

## Git Guardrails

Guardrails are evaluated **before** any file is written to disk.  
If a rule is violated the commit is rejected, an error is printed, and the Web UI shows a toast.

Configured in `index.ts` (or override in `config.example.json`):

```typescript
guardrails: [
  "allow-path:src/", // only modify files under src/
  "deny-path:src/secrets/", // never touch the secrets directory
  "deny-path:migrations/", // never auto-modify database migrations
  "max-files:10", // at most 10 files per auto-commit
];
```

| Rule                  | Example                 | Effect                                             |
| --------------------- | ----------------------- | -------------------------------------------------- |
| `allow-path:<prefix>` | `allow-path:src/`       | Only files under this prefix may be modified       |
| `deny-path:<prefix>`  | `deny-path:migrations/` | Files under this prefix are always blocked         |
| `max-files:<n>`       | `max-files:10`          | Reject the commit if more than N files are changed |

---

## Jira integration

When `JIRA_*` env vars are set, for each analysis:

1. A Jira ticket is created with the log snippet and full AI analysis.
2. After the PR is opened successfully, the PR URL is added as a **comment** on the same ticket.

Jira guardrails are also applied:

```typescript
guardrails: [
  "deny-keyword:classified", // block tickets containing this word
  "max-summary-length:200", // hard-cap on ticket summary length
];
```

---

## What the Web UI shows

| UI Element                 | Description                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Analysis card              | AI analysis rendered as Markdown                                                        |
| **▶ Prompt** toggle        | Raw log lines sent to the AI                                                            |
| **🔗 Git Fix** chip        | Link to the opened Pull Request                                                         |
| **📋 Jira ticket** chip    | Link to the Jira ticket                                                                 |
| **🔔 Notified** badge      | A notification was dispatched                                                           |
| **⚙ Apply Git Fix** button | Manually trigger a git fix from the UI (for analyses where auto-fix had no code blocks) |
| **🔴 / 🟡 / 🟢** dot       | Live connection status                                                                  |

---

## Stopping

Press `Ctrl-C`. The debugger flushes pending analysis, persists the session, and exits cleanly.

To stop only the dummy server:

```bash
docker compose -f ../live-debugger-dummy-server/docker-compose.yml down
```

---

## Project structure

```
live-debugger-selffix/
├── index.ts              ← main example — fully annotated
├── config.example.json   ← copy to .fusion-agent.json and fill in
├── start.sh              ← one-command start (starts dummy server + runs example)
└── README.md             ← this file
```
