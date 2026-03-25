/**
 * Example: Live Debugger → Self-Fix + Commit to GitHub
 * ======================================================
 * Watches a Docker container for errors, has the AI analyse each batch,
 * then **fusion-agent itself** extracts the proposed code changes from the
 * analysis, commits them to a branch, and opens a Pull Request — all
 * automatically, without delegating to an external agent.
 *
 * Also creates a Jira ticket for every analysis and sends Slack/webhook
 * notifications when the system hits a guardrail or exhausts retries.
 *
 * Prerequisites
 * -------------
 *   npm install -g ts-node          # or: npx ts-node index.ts
 *   cp config.example.json .fusion-agent.json   # fill in real values
 *   bash ../live-debugger-dummy-server/start.sh start-only   # start dummy server
 *   # The repo at GIT_REPO_PATH must already be cloned and have changes to commit
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
    GitPatchApplier,
    extractFileBlocks,
    createWebServer,
} from 'fusion-agent';

// ── Environment / configuration ──────────────────────────────────────────────

const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic' | 'gemini';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o';

// Git/GitHub settings
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';   // https://github.com/org/repo
const GIT_REPO_PATH = process.env.GIT_REPO_PATH || '';   // absolute path to local clone
const GIT_BRANCH = process.env.GIT_BRANCH || 'fusion-agent/auto-fix';
const GIT_API_BASE = process.env.GIT_API_BASE_URL || 'https://api.github.com';
const GIT_AUTHOR = process.env.GIT_AUTHOR_NAME || 'fusion-agent[bot]';
const GIT_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'fusion-agent@noreply';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';

// Optional integrations
const JIRA_URL = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT = process.env.JIRA_PROJECT_KEY || 'OPS';
const SLACK_HOOK = process.env.SLACK_WEBHOOK_URL || '';
const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';
const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'fusion-live-debugger-dummy';
const WEB_PORT = Number(process.env.WEB_PORT || 3000);

// ── Validate required config ──────────────────────────────────────────────────

if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('⚠  GITHUB_TOKEN and GITHUB_REPO are required for auto-commit.');
}
if (!GIT_REPO_PATH) {
    console.warn('⚠  GIT_REPO_PATH is not set — git commits will be skipped.');
}

// ── Build the agent ───────────────────────────────────────────────────────────

const agent = new AgentCLI({ provider: AI_PROVIDER, model: AI_MODEL });

const session = agent.createSession({
    name: 'live-debug-selffix',
    speckit: 'debugger',
    // Note: no `github.autoAssignCopilot` here — we apply the fix ourselves.
    // The copilot-autoassign example uses autoAssignCopilot: true instead.
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

// ── Build the Live Debugger ───────────────────────────────────────────────────

const debugger_ = new LiveDebugger({
    session,
    io: server.io,

    batchSize: 10,
    maxWaitSeconds: 30,
    logLevels: ['ERROR', 'FATAL', 'WARN'],

    retryCount: 3,
    retryDelayMs: 1000,

    // ── Notification channels ────────────────────────────────────────────────
    // Sent when: retries exhausted, a git guardrail is violated, or Jira fails.
    notifications: {
        slack: {
            enabled: !!SLACK_HOOK,
            webhookUrl: SLACK_HOOK,
            channel: '#ops-alerts',
            username: 'fusion-agent',
        },
        webhook: {
            enabled: !!WEBHOOK_URL,
            url: WEBHOOK_URL,
            method: 'POST',
            headers: { 'X-Source': 'fusion-agent-live-debugger' },
        },
    },

    // ── Main callback: runs after every successful AI analysis ───────────────
    onAnalysis: async (analysis, meta) => {
        agent.sessionManager.persistSession(session);

        const firstLine = analysis.split('\n')[0].replace(/^#+\s*/, '').slice(0, 100);
        console.log(`\n🔍  New analysis: ${firstLine}`);

        // ── Step 1: Create a Jira ticket ────────────────────────────────────────
        let jiraKey: string | undefined;
        if (JIRA_URL && JIRA_EMAIL && JIRA_TOKEN) {
            try {
                const jira = new JiraClient({
                    baseUrl: JIRA_URL,
                    email: JIRA_EMAIL,
                    apiToken: JIRA_TOKEN,
                    projectKey: JIRA_PROJECT,
                    issueType: 'Bug',
                    labels: ['live-debugger', 'auto-fix'],
                    guardrails: [
                        'deny-keyword:classified',
                        'max-summary-length:200',
                    ],
                });

                const ticket = await jira.createIssue({
                    summary: `[Live Debugger] ${firstLine}`,
                    description:
                        `*Analysed by fusion-agent live debugger*\n\n` +
                        `*Log lines:*\n{code}\n${(meta.matchedLogLines ?? []).slice(0, 20).join('\n')}\n{code}\n\n` +
                        `*AI Analysis:*\n${analysis}\n\n` +
                        `_fusion-agent will attempt to apply a code fix automatically and open a PR._`,
                    priority: 'High',
                    labels: ['live-debugger', 'auto-fix', 'production'],
                });

                jiraKey = ticket.key;
                console.log(`📋  Jira ticket: ${ticket.key} — ${ticket.url}`);
            } catch (jiraErr) {
                console.warn(`⚠  Jira ticket creation failed (non-fatal): ${(jiraErr as Error).message}`);
            }
        }

        // ── Step 2: Extract code blocks and apply git fix ───────────────────────
        //
        // The AI analysis often includes fenced code blocks tagged with a file path:
        //
        //   ```typescript:src/server.ts
        //   // fixed content
        //   ```
        //
        // `extractFileBlocks` parses those blocks into { filePath, content } pairs.
        // We then commit them to a branch and open a PR.

        if (!GIT_REPO_PATH || !GITHUB_TOKEN || !GITHUB_REPO) {
            console.log('ℹ  Git auto-fix skipped (GIT_REPO_PATH / GITHUB_TOKEN / GITHUB_REPO not set).');
            return;
        }

        const blocks = extractFileBlocks(analysis);
        if (blocks.length === 0) {
            console.log('ℹ  No file code blocks found in this analysis — no git commit.');
            return;
        }

        console.log(`🔧  Applying ${blocks.length} file fix(es): ${blocks.map((b) => b.filePath).join(', ')}`);

        const files: Record<string, string> = {};
        for (const b of blocks) {
            files[b.filePath] = b.content;
        }

        try {
            const patcher = new GitPatchApplier({
                repoPath: GIT_REPO_PATH,
                token: GITHUB_TOKEN,
                remoteUrl: GITHUB_REPO,
                branch: GIT_BRANCH,
                apiBaseUrl: GIT_API_BASE,
                authorName: GIT_AUTHOR,
                authorEmail: GIT_EMAIL,

                // ── Git guardrails ─────────────────────────────────────────────────
                // Protect sensitive paths and prevent oversized commits.
                guardrails: [
                    'allow-path:src/',         // only modify files under src/
                    'deny-path:src/secrets/',  // never touch the secrets directory
                    'deny-path:migrations/',   // never auto-modify database migrations
                    'max-files:10',            // at most 10 files per auto-commit
                ],
            });

            const result = await patcher.applyAndCommit({
                files,
                commitMessage:
                    `fix: AI-suggested auto-fix from live debugger\n\n` +
                    `Analysis: ${firstLine}` +
                    (jiraKey ? `\nJira: ${jiraKey}` : ''),
                pullRequestTitle: `fix: ${firstLine}`,
                pullRequestBody:
                    `## Auto-generated by fusion-agent Live Debugger\n\n` +
                    `**Session:** ${session.name}\n` +
                    `**Analysis:**\n${analysis}\n\n` +
                    (jiraKey ? `**Jira:** ${jiraKey}\n\n` : '') +
                    `### Changed files\n` +
                    Object.keys(files).map((f) => `- \`${f}\``).join('\n'),
                baseBranch: BASE_BRANCH,
            });

            console.log(`✅  Branch: ${result.branch}`);
            console.log(`✅  Commit: ${result.commitSha}`);
            if (result.pullRequestUrl) {
                console.log(`🔗  PR: ${result.pullRequestUrl}`);
            }

            // Optionally add a Jira comment with the PR link
            if (jiraKey && result.pullRequestUrl && JIRA_URL && JIRA_EMAIL && JIRA_TOKEN) {
                try {
                    const jira = new JiraClient({
                        baseUrl: JIRA_URL,
                        email: JIRA_EMAIL,
                        apiToken: JIRA_TOKEN,
                        projectKey: JIRA_PROJECT,
                    });
                    await jira.addComment(
                        jiraKey,
                        `Automated fix applied by fusion-agent: ${result.pullRequestUrl}`,
                    );
                } catch {
                    // non-fatal — Jira comment failure doesn't block anything
                }
            }
        } catch (gitErr) {
            const msg = (gitErr as Error).message;
            console.error(`❌  Git auto-fix failed: ${msg}`);
            // The message is surfaced in the Web UI as a toast via the error event --
            // nothing else to do here.
        }
    },
});

debugger_.on('error', (err) => {
    console.error(`❌  Debugger error: ${err.message}`);
});

// ── Connect to the service under observation ──────────────────────────────────

debugger_.connectToService({ type: 'docker', container: DOCKER_CONTAINER });
console.log(`👁  Watching Docker container: ${DOCKER_CONTAINER}`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
    console.log('\n🛑  Shutting down…');
    debugger_.stop();
    agent.sessionManager.persistSession(session);
    void server.stop().finally(() => process.exit(0));
});

console.log('\n🚀  Live Debugger (self-fix + GitHub commit) running.');
console.log('    Ctrl-C to stop.\n');
