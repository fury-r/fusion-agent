# AI Agent CLI — Requirements Document

## Overview
**vibe-agent** is an npm-deployable TypeScript tool that integrates with top AI providers and acts as a _vibe coder_, session manager, live-service debugger, and provides a Web UI for managing AI agent sessions.

---

## 1. Functional Requirements

### 1.1 Multi-Provider AI Integration
- Support **OpenAI** (GPT-4o, GPT-4-turbo, GPT-3.5-turbo)
- Support **Anthropic** (Claude 3.5 Sonnet, Claude 3 Haiku)
- Support **Google Gemini** (gemini-1.5-pro, gemini-1.5-flash)
- Provider selection via config file, environment variable, or CLI flag
- Streaming responses supported for all providers

### 1.2 Vibe Coder Mode
- Acts as an AI pair-programmer that understands project context
- Reads local files and directory structures to build context
- Generates, modifies, and refactors code based on natural-language prompts
- Applies changes to files automatically with user confirmation step
- Uses speckit templates for common coding patterns

### 1.3 Prebuilt Speckits
Speckits are pre-configured agent configurations (similar to GitHub speckit concept — opinionated starter templates):
- **vibe-coder**: Full-stack code generation and refactoring
- **debugger**: Analyze logs, traces, and errors to suggest fixes
- **code-review**: Review code for quality, security, and best practices
- **doc-writer**: Generate or improve documentation
- **test-writer**: Generate unit and integration tests
- **refactor**: Suggest and apply structural refactoring
- **security-audit**: Scan code for security vulnerabilities

### 1.4 Live Service Debugger
- Connect to a running service via:
  - Log file watching (tail -f)
  - HTTP endpoint polling
  - Docker container log streaming
  - Process stdout/stderr attachment
- Stream logs to the AI provider in real time
- AI analyzes errors and proposes code fixes
- Apply fixes directly to the codebase
- Supports rollback of applied fixes

### 1.5 Session Management
- Create named agent sessions with unique IDs
- Persist session history (conversation, files changed, fixes applied)
- Resume interrupted sessions
- Sessions stored in `~/.vibe-agent/sessions/`
- Session export to JSON

### 1.6 Guardrails & Rules
Configurable per-session rules that the AI must follow or must not violate:
- **Allowed file paths**: restrict file access to specific directories
- **Forbidden operations**: prevent deletion, overwrite of certain files
- **Max tokens / cost limit**: cap spending per session
- **Style rules**: enforce coding style (language, framework, patterns)
- **Custom rules**: free-text rules injected into system prompt
- Rules defined in `.vibe-agent.json` or per-session config

### 1.7 Web UI
- Built-in Express + Socket.IO web server
- **Sessions Dashboard**: list all sessions, status, timestamps
- **Session Detail**: conversation history, file diffs, guardrails
- **Live Debugger View**: real-time log stream + AI analysis
- **Settings**: configure API keys, default provider, global guardrails
- Accessible at `http://localhost:PORT` (default 3000)

### 1.8 CLI Interface
```
ai-agent [command] [options]

Commands:
  chat          Start an interactive chat session (vibe coder mode)
  speckit       List or run a prebuilt speckit
  debug         Attach to a live service and start debugging
  session       Manage sessions (list, resume, delete, export)
  ui            Launch the Web UI
  config        Configure API keys and settings

Options:
  --provider    AI provider (openai|anthropic|gemini)
  --model       Specific model to use
  --session     Session name or ID
  --speckit     Speckit to use
  --guardrail   Add a guardrail rule
  --port        Web UI port (default: 3000)
```

### 1.9 Library / Programmatic API
```typescript
import { AgentCLI, Session, providers, speckits } from 'vibe-agent';

const agent = new AgentCLI({ provider: 'openai', model: 'gpt-4o' });
const session = await agent.createSession({ name: 'my-session', guardrails: [...] });
const response = await session.chat('Refactor this function...');
```

---

## 2. Non-Functional Requirements

- **Language**: TypeScript (compiled to JS for distribution)
- **Node.js**: >=18.0.0
- **Streaming**: All AI calls support streaming output
- **Security**: API keys never logged or stored in plaintext in session files
- **Configuration**: `.vibe-agent.json` in project root or `~/.vibe-agent/config.json`
- **Error handling**: Graceful fallback, meaningful error messages
- **Extensibility**: Provider and speckit plug-in architecture

---

## 3. Architecture

```
src/
├── index.ts              # Library entry point
├── cli.ts                # CLI entry point (bin)
├── providers/            # AI provider adapters
│   ├── base.ts
│   ├── openai.ts
│   ├── anthropic.ts
│   └── gemini.ts
├── session/              # Session management
│   ├── session.ts
│   ├── session-manager.ts
│   └── guardrails.ts
├── speckits/             # Prebuilt speckit templates
│   ├── index.ts
│   ├── vibe-coder.ts
│   ├── debugger.ts
│   ├── code-review.ts
│   ├── doc-writer.ts
│   ├── test-writer.ts
│   ├── refactor.ts
│   └── security-audit.ts
├── live-debugger/        # Live service debugger
│   ├── index.ts
│   ├── log-watcher.ts
│   └── service-connector.ts
├── web/                  # Web UI
│   ├── server.ts
│   ├── routes/
│   └── public/
└── utils/
    ├── config.ts
    ├── file-ops.ts
    └── logger.ts
```

---

## 4. Deployment

- Published to **npm** as `vibe-agent`
- Global install: `npm install -g vibe-agent`
- Local dev dependency: `npm install --save-dev vibe-agent`
- Binary: `ai-agent` (aliased as `aac`)
