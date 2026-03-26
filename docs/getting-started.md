# Getting Started

## Requirements

- Node.js 18+
- npm 9+
- An API key for at least one supported provider (OpenAI, Anthropic, or Google Gemini)

---

## Installation

### As a global CLI tool

```bash
npm install -g fusion-agent
```

### As a project dependency

```bash
npm install fusion-agent
```

### From source

```bash
git clone https://github.com/fury-r/fusion-agent.git
cd fusion-agent
npm install
npm run build
```

---

## Configuration

### Environment variables (recommended)

Set the API key for whichever provider you want to use:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
```

### Config file

Create `.fusion-agent.json` in your project root, or `~/.fusion-agent/config.json` for a global default:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "port": 3000
}
```

Full config schema:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "port": 3000,
  "sessionDir": "~/.fusion-agent/sessions",
  "logLevel": "info",
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

Config files are searched in this order:

1. `.fusion-agent.json` (current working directory)
2. `.fusion-agent.yaml` (current working directory)
3. `~/.fusion-agent/config.json`
4. `~/.fusion-agent/config.yaml`

CLI flags always override the config file. Environment variables (`AI_PROVIDER`, `AI_MODEL`, `AI_AGENT_PORT`) also take precedence over the config file.

### CLI config command

```bash
ai-agent config --provider openai --model gpt-4o
ai-agent config --show   # print current resolved config
```

---

## First Steps

### 1. Interactive Vibe Coder (CLI)

```bash
ai-agent chat
```

This starts an interactive REPL using the `vibe-coder` speckit. Type a message and press Enter. Any file blocks produced by the AI (` ```language:path/to/file ``` `) are automatically written to disk.

Useful flags:

```bash
ai-agent chat --provider anthropic --model claude-3-5-sonnet-20241022
ai-agent chat --session my-project          # name your session
ai-agent chat --context                     # inject project dir structure upfront
ai-agent chat --guardrail "Use TypeScript"  # add a constraint
```

### 2. Web Dashboard

```bash
ai-agent ui
```

Opens the browser UI at `http://localhost:3000`. Navigate to **⚡ Vibe Coder** in the sidebar.

```bash
ai-agent ui --port 8080   # custom port
```

### 3. Live Debugger

```bash
# Tail a log file
ai-agent debug --file /var/log/app.log

# Attach to a Docker container
ai-agent debug --docker my-api-container --ui

# Run a process and watch its output
ai-agent debug --cmd "node server.js"
```

### 4. Cluster Monitor

```bash
# With a rules config file
ai-agent cluster-debug --config cluster-rules.yaml --all

# Watch a specific service
ai-agent cluster-debug --service "api:docker:my-container" --mode notify-only
```

---

## Verifying the Install

```bash
ai-agent --version
ai-agent speckit          # list all available speckits
ai-agent config --show    # show resolved configuration
```

---

## Next Steps

- [Vibe Coder](./vibe-coder.md) — interactive and autonomous coding
- [Live Debugger](./live-debugger.md) — real-time error analysis
- [Web UI](./web-ui.md) — browser dashboard walkthrough
- [CLI Reference](./cli-reference.md) — all commands and flags
