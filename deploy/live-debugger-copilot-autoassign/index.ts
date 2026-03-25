/**
 * Example: Live Debugger → GitHub Copilot Auto-Assign
 * =====================================================
 * Watches a Docker container for errors, has the AI analyse each batch,
 * then automatically files a GitHub issue and assigns it to the Copilot
 * coding agent so it opens a fix PR without any manual action.
 *
 * Also creates a Jira ticket for every analysis and sends Slack/webhook
 * notifications when the auto-assign is blocked by a guardrail.
 *
 * Prerequisites
 * -------------
 *   npm install -g ts-node          # or: npx ts-node index.ts
 *   cp config.example.json .fusion-agent.json   # fill in real values
 *   bash ../live-debugger-dummy-server/start.sh start-only   # start dummy server
 *
 * Run
 * ---
 *   ts-node index.ts
 *   # or:
 *   bash start.sh
 */

import {
    AgentCLI,
    LiveDebugger,
    JiraClient,
    GitHubClient,
    createWebServer,
} from 'fusion-agent';

// ── Environment / configuration ──────────────────────────────────────────────

const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic' | 'gemini';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';  // e.g. https://github.com/your-org/my-service
const JIRA_URL = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT = process.env.JIRA_PROJECT_KEY || 'OPS';
const SLACK_HOOK = process.env.SLACK_WEBHOOK_URL || '';
const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';
const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'fusion-live-debugger-dummy';
const WEB_PORT = Number(process.env.WEB_PORT || 3000);

// ── Validate required config ──────────────────────────────────────────────────

if (!process.env[`${AI_PROVIDER.toUpperCase()}_API_KEY`] && !process.env.AI_API_KEY) {
    console.warn(`⚠  No API key found for provider "${AI_PROVIDER}". Set ${AI_PROVIDER.toUpperCase()}_API_KEY.`);
}
if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('⚠  GITHUB_TOKEN and GITHUB_REPO are required for Copilot auto-assign.');
}

// ── Build the agent ───────────────────────────────────────────────────────────

const agent = new AgentCLI({ provider: AI_PROVIDER, model: AI_MODEL });

// Session config embeds the GitHub integration so the live debugger picks it
// up automatically after every AI analysis.
const session = agent.createSession({
    name: 'live-debug-copilot-autoassign',
    speckit: 'debugger',
    github: {
        token: GITHUB_TOKEN,
        repoUrl: GITHUB_REPO,
        assignee: 'copilot',      // must match the GitHub username for the Copilot agent
        autoAssignCopilot: true,  // fire automatically — no manual click needed

        // ── Copilot issue guardrails ───────────────────────────────────────────
        // If any rule is violated the issue is NOT created and instead:
        //   • a "debugger:copilot-guardrail-blocked" event is pushed to the Web UI
        //   • a notification is sent on the configured channels
        //   • the analysis card shows an ⚠ Copilot Blocked badge in the UI
        guardrails: [
            'deny-keyword:classified',       // never expose classified content in issues
            'deny-keyword:internal-only',    // block any internal-only information
            'require-label:fusion-agent',    // every issue must carry the fusion-agent label
            'max-title-length:200',          // GitHub title hard-cap
            'max-body-length:65536',         // stay within GitHub's 65 KB body limit
        ],
    },
});

// ── Start the Web UI ──────────────────────────────────────────────────────────

const server = createWebServer({
    port: WEB_PORT,
    sessionManager: agent.sessionManager,
    provider: AI_PROVIDER,
    model: AI_MODEL,
});

await server.start();
console.log(`✅  Web UI running at http://localhost:${WEB_PORT}`);
console.log(`    Open the "${session.name}" session → Subscribe Live to watch in real time.`);

// ── Build the Live Debugger ───────────────────────────────────────────────────

const debugger_ = new LiveDebugger({
    session,
    io: server.io,

    // How many log lines to accumulate before sending to the AI
    batchSize: 10,
    // Maximum seconds to wait before flushing even if batchSize hasn't been reached
    maxWaitSeconds: 30,

    // Only analyse lines that contain these log levels
    logLevels: ['ERROR', 'FATAL', 'WARN'],

    // AI call resilience
    retryCount: 3,
    retryDelayMs: 1000,

    // ── Notification channels ────────────────────────────────────────────────
    // Used when: all AI retries are exhausted, OR a Copilot guardrail blocks
    // the auto-assign (the Web UI also shows the blocked event directly).
    notifications: {
        slack: {
            enabled: !!SLACK_HOOK,
            webhookUrl: SLACK_HOOK,
            channel: '#ops-alerts',    // optional — uses the webhook default if omitted
            username: 'fusion-agent',  // optional
        },
        webhook: {
            enabled: !!WEBHOOK_URL,
            url: WEBHOOK_URL,
            method: 'POST',
            headers: { 'X-Source': 'fusion-agent-live-debugger' },
        },
    },

    // Called synchronously after every successful AI analysis
    onAnalysis: async (analysis) => {
        // Persist so the session appears in the Web UI sessions list immediately
        agent.sessionManager.persistSession(session);

        // ── Optional: create a Jira ticket for every analysis ─────────────────
        // Remove this block if you want Jira tickets to be manual (via Web UI).
        if (JIRA_URL && JIRA_EMAIL && JIRA_TOKEN) {
            try {
                const jira = new JiraClient({
                    baseUrl: JIRA_URL,
                    email: JIRA_EMAIL,
                    apiToken: JIRA_TOKEN,
                    projectKey: JIRA_PROJECT,
                    issueType: 'Bug',
                    labels: ['live-debugger', 'copilot-assigned'],
                    guardrails: [
                        'deny-keyword:classified',
                        'max-summary-length:200',
                    ],
                });

                const firstLine = analysis.split('\n')[0].replace(/^#+\s*/, '').slice(0, 100);
                const ticket = await jira.createIssue({
                    summary: `[Live Debugger] ${firstLine}`,
                    description:
                        `*Analysed by fusion-agent live debugger*\n\n` +
                        `*Analysis:*\n${analysis}\n\n` +
                        `_A GitHub issue has been automatically filed and assigned to the Copilot coding agent._`,
                    priority: 'High',
                    labels: ['live-debugger', 'copilot-assigned', 'production'],
                });

                console.log(`📋  Jira ticket created: ${ticket.key} — ${ticket.url}`);
            } catch (jiraErr) {
                console.warn(`⚠  Jira ticket creation failed (non-fatal): ${(jiraErr as Error).message}`);
            }
        }
    },
});

// Never crash the process on a debugger error
debugger_.on('error', (err) => {
    console.error(`❌  Debugger error: ${err.message}`);
});

// ── Connect to the service under observation ──────────────────────────────────

// Option A — Docker container (used by default in this example)
debugger_.connectToService({ type: 'docker', container: DOCKER_CONTAINER });
console.log(`👁  Watching Docker container: ${DOCKER_CONTAINER}`);

// Option B — local log file (uncomment and adjust path):
// debugger_.watchLogFile('/var/log/my-service/app.log');

// Option C — spawned process (uncomment and adjust):
// debugger_.connectToService({ type: 'process', command: 'node', args: ['server.js'] });

// Option D — HTTP health poll (uncomment and adjust):
// debugger_.connectToService({ type: 'http-poll', url: 'http://localhost:8080/health' });

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
    console.log('\n🛑  Shutting down…');
    debugger_.stop();
    agent.sessionManager.persistSession(session);
    void server.stop().finally(() => process.exit(0));
});

console.log('\n🚀  Live Debugger (Copilot auto-assign) running.');
console.log('    Ctrl-C to stop.\n');
