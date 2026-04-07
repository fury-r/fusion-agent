#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig } from './utils/config';
import { createProvider } from './providers';
import { SessionManager } from './session/session-manager';
import { Session } from './session/session';
import { SPECKITS, listSpeckits } from './speckits';
import { LiveDebugger } from './live-debugger';
import { gatherProjectContext } from './utils/file-ops';
import { createWebServer } from './web/server';
import { createGuardrail } from './session/guardrails';
import { Guardrail } from './session/guardrails';
import { logger } from './utils/logger';
import { ClusterMonitor } from './cluster-monitor/cluster-monitor';
import { loadClusterRules, DEFAULT_CLUSTER_RULES } from './cluster-monitor/rules';
import { ClusterMonitorConfig, ServiceTarget, MonitorMode } from './cluster-monitor/types';
import { listSkills, loadSkill, loadRemoteSkill } from './skills/registry';
import { createWebhook, listWebhooks, deleteWebhook } from './utils/webhook-store';
import { CronManager } from './cron/cron-manager';

const program = new Command();

program
  .name('ai-agent')
  .description('AI-powered vibe coder, debugger, and session manager')
  .version('1.0.0');

// ── chat command ─────────────────────────────────────────────
program
  .command('chat')
  .description('Start an interactive chat session (vibe coder mode)')
  .option('-p, --provider <provider>', 'AI provider (openai|anthropic|gemini)')
  .option('-m, --model <model>', 'Model name')
  .option('-s, --session <name>', 'Session name (creates or resumes)', 'default')
  .option('-k, --speckit <speckit>', 'Speckit to use (e.g. vibe-coder, debugger)')
  .option('-g, --guardrail <rule>', 'Add a guardrail rule (can be repeated)', collectArray, [])
  .option('--context', 'Include project context in first message', false)
  .action(async (opts) => {
    const config = loadConfig({
      provider: opts.provider,
      model: opts.model,
    });

    if (!config.apiKey) {
      console.error(chalk.red(`✗ No API key found for provider "${config.provider}".`));
      console.error(chalk.yellow(`  Set the ${providerEnvVar(config.provider)} environment variable.`));
      process.exit(1);
    }

    const speckit = opts.speckit ? SPECKITS[opts.speckit] : SPECKITS['vibe-coder'];
    if (opts.speckit && !speckit) {
      console.error(chalk.red(`✗ Unknown speckit: ${opts.speckit}`));
      process.exit(1);
    }

    const guardrails: Guardrail[] = (opts.guardrail as string[]).map((r: string) =>
      createGuardrail('custom', r)
    );

    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.fusion-agent', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);
    const provider = createProvider({ provider: config.provider, model: config.model, apiKey: config.apiKey });

    // Try to find existing session by name
    const existing = sessionManager.listSessions().find((s) => s.name === opts.session);
    let session: Session;

    if (existing) {
      session = sessionManager.loadSession(existing.id, config.apiKey);
      session.resume();
      console.log(chalk.cyan(`\n  Resumed session: ${chalk.bold(session.name)} (${session.id.slice(0, 8)}…)\n`));
    } else {
      session = sessionManager.createSession(
        {
          name: opts.session,
          provider: config.provider,
          model: config.model || provider.getModel(),
          speckit: opts.speckit || 'vibe-coder',
          systemPrompt: speckit?.systemPrompt,
          guardrails,
          projectDir: process.cwd(),
        },
        config.apiKey
      );
      console.log(chalk.green(`\n  New session: ${chalk.bold(session.name)} (${session.id.slice(0, 8)}…)`));
      if (speckit) {
        console.log(chalk.dim(`  Speckit: ${speckit.name} — ${speckit.description}\n`));
      }
    }

    // Optionally inject project context
    if (opts.context) {
      const ctx = gatherProjectContext(process.cwd());
      const spinner = ora('Loading project context…').start();
      await session.chat(`Here is the project context:\n\n${ctx}\n\nPlease acknowledge and let me know if you have any questions.`, { stream: false });
      spinner.succeed('Project context loaded');
    }

    printHelp();
    await interactiveLoop(session, sessionManager);
  });

// ── speckit command ─────────────────────────────────────────
program
  .command('speckit [name]')
  .description('List or run a prebuilt speckit')
  .action((name?: string) => {
    if (!name) {
      console.log(chalk.bold('\n  Available Speckits:\n'));
      for (const sk of listSpeckits()) {
        console.log(`  ${chalk.cyan(sk.name.padEnd(18))} ${chalk.dim(sk.description)}`);
      }
      console.log();
      return;
    }
    const sk = SPECKITS[name];
    if (!sk) {
      console.error(chalk.red(`✗ Unknown speckit: ${name}`));
      process.exit(1);
    }
    console.log(chalk.bold(`\n  ${sk.name}`));
    console.log(chalk.dim(`  ${sk.description}\n`));
    console.log(chalk.gray('  System prompt preview:'));
    console.log(chalk.dim(sk.systemPrompt.slice(0, 300) + (sk.systemPrompt.length > 300 ? '…' : '')));
    if (sk.examples?.length) {
      console.log(chalk.gray('\n  Examples:'));
      sk.examples.forEach((ex) => console.log(chalk.dim(`  • ${ex}`)));
    }
    console.log();
  });

// ── debug command ─────────────────────────────────────────────
program
  .command('debug')
  .description('Attach to a live service and start AI-assisted debugging')
  .option('-p, --provider <provider>', 'AI provider')
  .option('-m, --model <model>', 'Model name')
  .option('-f, --file <logFile>', 'Watch a log file')
  .option('-d, --docker <container>', 'Attach to Docker container logs')
  .option('-c, --cmd <command>', 'Run and attach to a process command')
  .option('-s, --session <name>', 'Session name (default: <svc-name>-live-debug-<id>)')
  .option('--batch <n>', 'Lines to batch before analysis', '20')
  .option('--retry <n>', 'AI analysis retry attempts on failure', '3')
  .option('--retry-delay <ms>', 'Base retry delay in ms (doubles each attempt)', '1000')
  .option('--notify-slack <url>', 'Slack webhook URL for failure notifications')
  .option('--notify-teams <url>', 'Microsoft Teams webhook URL for failure notifications')
  .option('--notify-webhook <url>', 'HTTP webhook URL for failure notifications')
  .option('--log-pattern <patterns>', 'Comma-separated regex patterns; only matching lines are analyzed')
  .option('--log-level <levels>', 'Comma-separated log levels to watch (e.g. ERROR,WARN,FATAL)')
  .option('--log-token-limit <n>', 'Max tokens to include in each AI prompt; auto-detected from 429 errors if omitted')
  .option('--ui', 'Also launch the Web UI alongside the debugger')
  .option('--port <port>', 'Web UI port when --ui is used (default: 3000)', '3000')
  .action(async (opts) => {
    const config = loadConfig({ provider: opts.provider, model: opts.model });

    if (!config.apiKey) {
      console.error(chalk.red(`✗ No API key for provider "${config.provider}".`));
      process.exit(1);
    }

    if (!opts.file && !opts.docker && !opts.cmd) {
      console.error(chalk.red('✗ Provide --file, --docker, or --cmd to connect to a service.'));
      process.exit(1);
    }

    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.fusion-agent', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);

    // Build session name: user-provided, else {svc-name}-live-debug-{shortId}
    const svcName = (opts.docker as string | undefined)
      || (opts.file as string | undefined)?.replace(/.*[/\\]/, '').replace(/\.[^.]+$/, '')
      || (opts.cmd as string | undefined)?.split(/\s+/)[0]
      || 'service';
    const sessionName = opts.session || `${svcName}-live-debug-${Date.now().toString(36)}`;

    const session = sessionManager.createSession(
      {
        name: sessionName,
        provider: config.provider,
        model: config.model || '',
        speckit: 'debugger',
        systemPrompt: SPECKITS['debugger']?.systemPrompt,
        projectDir: process.cwd(),
      },
      config.apiKey
    );

    console.log(chalk.yellow('\n  🔍 Live Debugger started'));
    console.log(chalk.dim(`  Session: ${chalk.bold(sessionName)} (${session.id})`));
    console.log(chalk.dim('  AI will analyze errors as they appear. Press Ctrl+C to stop.\n'));

    // Optionally launch Web UI
    let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
    if (opts.ui) {
      const uiPort = parseInt(opts.port as string, 10) || 3000;
      webServer = createWebServer({
        port: uiPort,
        sessionManager,
        apiKey: config.apiKey,
        provider: config.provider,
        model: config.model,
        projectDir: process.cwd(),
      });
      await webServer.start();
      console.log(
        chalk.green(`  ✓ Web UI running at ${chalk.bold(`http://localhost:${uiPort}`)}\n`) +
        chalk.dim(`    Open the Sessions tab to monitor this debug session.\n`)
      );
    }

    // Build optional notification config from CLI flags
    const notifications = (() => {
      const slack = opts.notifySlack as string | undefined;
      const teams = opts.notifyTeams as string | undefined;
      const webhook = opts.notifyWebhook as string | undefined;
      if (!slack && !teams && !webhook) return undefined;
      return {
        ...(slack ? { slack: { enabled: true, webhookUrl: slack } } : {}),
        ...(teams ? { teams: { enabled: true, webhookUrl: teams } } : {}),
        ...(webhook ? { webhook: { enabled: true, url: webhook } } : {}),
      };
    })();

    const debugger_ = new LiveDebugger({
      session,
      batchSize: parseInt(opts.batch, 10),
      retryCount: parseInt(opts.retry, 10),
      retryDelayMs: parseInt(opts.retryDelay, 10),
      notifications,
      logPatterns: opts.logPattern
        ? (opts.logPattern as string).split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined,
      logLevels: opts.logLevel
        ? (opts.logLevel as string).split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean)
        : undefined,
      logTokenLimit: opts.logTokenLimit ? parseInt(opts.logTokenLimit as string, 10) : undefined,
      // Wire up Socket.IO for real-time Web UI updates
      io: webServer?.io,
      onLog: (line) => process.stdout.write(chalk.dim(`  ${line}\n`)),
      onAnalysis: (analysis) => {
        console.log(chalk.bold.yellow('\n  ━━ AI Analysis ━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.white(analysis));
        console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
        sessionManager.persistSession(session);
      },
    });

    debugger_.on('error', (err: Error) => {
      console.error(chalk.red(`\n  ⚠ Live Debugger error: ${err.message}\n`));
    });

    if (opts.file) {
      debugger_.watchLogFile(opts.file);
    } else if (opts.docker) {
      debugger_.connectToService({ type: 'docker', container: opts.docker });
    } else if (opts.cmd) {
      const [cmd, ...args] = opts.cmd.split(' ');
      debugger_.connectToService({ type: 'process', command: cmd, args });
    }

    process.on('SIGINT', () => {
      debugger_.stop();
      sessionManager.persistSession(session);
      console.log(chalk.green('\n  Debugger stopped. Session saved.\n'));
      if (webServer) {
        void webServer.stop();
      }
      process.exit(0);
    });
  });

// ── session command ─────────────────────────────────────────
program
  .command('session')
  .description('Manage sessions')
  .option('-l, --list', 'List all sessions')
  .option('-d, --delete <id>', 'Delete a session by ID')
  .option('-e, --export <id>', 'Export a session as JSON')
  .action((opts) => {
    const config = loadConfig();
    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.fusion-agent', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);

    if (opts.list || (!opts.delete && !opts.export)) {
      const sessions = sessionManager.listSessions();
      if (!sessions.length) {
        console.log(chalk.dim('\n  No sessions found.\n'));
        return;
      }
      console.log(chalk.bold('\n  Sessions:\n'));
      for (const s of sessions) {
        const status = s.status === 'active' ? chalk.green('●') : chalk.dim('○');
        console.log(`  ${status} ${chalk.bold(s.name.padEnd(20))} ${chalk.dim(s.id.slice(0, 8))}  ${chalk.dim(s.config.provider + '/' + (s.config.model || 'default'))}  ${chalk.dim(new Date(s.updatedAt).toLocaleString())}`);
      }
      console.log();
    }

    if (opts.delete) {
      try {
        sessionManager.deleteSession(opts.delete);
        console.log(chalk.green(`  ✓ Session ${opts.delete} deleted.\n`));
      } catch (err) {
        console.error(chalk.red(`  ✗ ${err}\n`));
      }
    }

    if (opts.export) {
      try {
        const json = sessionManager.exportSession(opts.export);
        console.log(json);
      } catch (err) {
        console.error(chalk.red(`  ✗ ${err}\n`));
      }
    }
  });

// ── ui command ──────────────────────────────────────────────
program
  .command('ui')
  .description('Launch the Web UI for session viewing and management')
  .option('--port <port>', 'Port to listen on', '3000')
  .action(async (opts) => {
    const config = loadConfig({ port: parseInt(opts.port, 10) });
    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.fusion-agent', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);

    const server = createWebServer({
      port: config.port,
      sessionManager,
      apiKey: config.apiKey,
      provider: config.provider,
      model: config.model,
      projectDir: process.cwd(),
    });
    await server.start();

    console.log(chalk.green(`\n  ✓ AI Agent Web UI running at ${chalk.bold(`http://localhost:${config.port}`)}`));
    console.log(chalk.dim('  Press Ctrl+C to stop.\n'));

    process.on('SIGINT', async () => {
      await server.stop();
      console.log(chalk.yellow('\n  Web UI stopped.\n'));
      process.exit(0);
    });
  });

// ── config command ──────────────────────────────────────────
program
  .command('config')
  .description('Configure API keys and default settings')
  .option('--provider <provider>', 'Set default provider')
  .option('--model <model>', 'Set default model')
  .option('--port <port>', 'Set default Web UI port')
  .option('--show', 'Show current configuration')
  .action((opts) => {
    const config = loadConfig();

    if (opts.show) {
      const { apiKey: _key, ...safeConfig } = config;
      console.log(chalk.bold('\n  Current Configuration:\n'));
      console.log(JSON.stringify(safeConfig, null, 2));
      console.log();
      return;
    }

    const updates: Record<string, unknown> = {};
    if (opts.provider) updates.provider = opts.provider;
    if (opts.model) updates.model = opts.model;
    if (opts.port) updates.port = parseInt(opts.port, 10);

    if (Object.keys(updates).length) {
      saveConfig(updates as Parameters<typeof saveConfig>[0]);
      console.log(chalk.green('  ✓ Configuration saved.\n'));
    } else {
      program.commands.find((c) => c.name() === 'config')?.help();
    }
  });

// ── helpers ──────────────────────────────────────────────────

function collectArray(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function providerEnvVar(provider: string): string {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
  };
  return map[provider] || 'API_KEY';
}

function printHelp(): void {
  console.log(chalk.dim('  Type your message and press Enter. Special commands:'));
  console.log(chalk.dim('  /exit or /quit  — end session'));
  console.log(chalk.dim('  /context        — inject project context'));
  console.log(chalk.dim('  /save           — save session'));
  console.log(chalk.dim('  /turns          — show conversation history'));
  console.log();
}

async function interactiveLoop(session: Session, sessionManager: SessionManager): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question(chalk.cyan('  You: '), resolve);
    });

  while (true) {
    let input: string;
    try {
      input = (await prompt()).trim();
    } catch {
      break;
    }

    if (!input) continue;

    // Special commands
    if (input === '/exit' || input === '/quit') {
      sessionManager.persistSession(session);
      console.log(chalk.green('  Session saved. Goodbye!\n'));
      rl.close();
      process.exit(0);
    }
    if (input === '/save') {
      sessionManager.persistSession(session);
      console.log(chalk.green('  ✓ Session saved.\n'));
      continue;
    }
    if (input === '/turns') {
      const turns = session.getTurns();
      console.log(chalk.bold(`\n  ${turns.length} turn(s) in this session:\n`));
      turns.forEach((t, i) => {
        console.log(chalk.dim(`  [${i + 1}] ${new Date(t.timestamp).toLocaleTimeString()} — ${t.userMessage.slice(0, 60)}…`));
      });
      console.log();
      continue;
    }
    if (input === '/context') {
      const spinner = ora('Gathering project context…').start();
      const ctx = gatherProjectContext(process.cwd());
      await session.chat(`Project context:\n\n${ctx}`, { stream: false });
      spinner.succeed('Context injected');
      sessionManager.persistSession(session);
      continue;
    }

    // Regular chat message
    process.stdout.write(chalk.green('\n  Assistant: '));
    try {
      await session.chat(input, {
        stream: true,
        onChunk: (chunk) => process.stdout.write(chunk),
      });
      process.stdout.write('\n\n');
      sessionManager.persistSession(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  ✗ Error: ${msg}\n`));
      logger.debug(String(err));
    }
  }

  rl.close();
}

// ── cluster-debug command ─────────────────────────────────────────────────────
program
  .command('cluster-debug')
  .description('Monitor cluster services and auto-debug failures with AI assistance')
  .option('-c, --config <file>', 'Path to cluster rules YAML/JSON config file')
  .option('-s, --service <spec>', 'Service to monitor: name:type:target (can repeat)', collectArray, [])
  .option('--all', 'Discover and monitor all deployments in the namespace', false)
  .option('-n, --namespace <ns>', 'Kubernetes namespace', 'default')
  .option('-m, --mode <mode>', 'Mode: auto-fix | notify-only | human-in-loop', 'human-in-loop')
  .option('-p, --provider <provider>', 'AI provider (openai|anthropic|gemini)')
  .option('--model <model>', 'Model name')
  .option('--batch-size <n>', 'Log lines before AI analysis (default: 20)', '20')
  .option('--max-wait <s>', 'Max seconds before flushing partial batch (default: 30)', '30')
  .action(async (opts) => {
    const config = loadConfig({ provider: opts.provider, model: opts.model });

    if (!config.apiKey) {
      console.error(chalk.red(`✗ No API key found for provider "${config.provider}".`));
      console.error(chalk.yellow(`  Set ${providerEnvVar(config.provider)} environment variable.`));
      process.exit(1);
    }

    // Load rules file if provided
    let clusterCfg: ClusterMonitorConfig;
    if (opts.config) {
      try {
        const rulesFile = loadClusterRules(opts.config);
        clusterCfg = {
          services: [],
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey!,
          rules: rulesFile.rules,
          notifications: rulesFile.notifications,
          mode: (opts.mode as MonitorMode) || 'human-in-loop',
          monitorAll: opts.all,
          namespace: opts.namespace,
          batchSize: parseInt(opts.batchSize, 10),
          maxWaitSeconds: parseInt(opts.maxWait, 10),
        };
      } catch (err) {
        console.error(chalk.red(`✗ Failed to load rules file: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    } else {
      clusterCfg = {
        services: [],
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey!,
        rules: DEFAULT_CLUSTER_RULES,
        mode: (opts.mode as MonitorMode) || 'human-in-loop',
        monitorAll: opts.all,
        namespace: opts.namespace,
        batchSize: parseInt(opts.batchSize, 10),
        maxWaitSeconds: parseInt(opts.maxWait, 10),
      };
    }

    // Parse --service name:type:target specs
    for (const spec of opts.service as string[]) {
      const parts = spec.split(':');
      if (parts.length < 3) {
        console.error(chalk.red(`✗ Invalid --service spec "${spec}". Expected name:type:target`));
        process.exit(1);
      }
      const [name, type, ...targetParts] = parts;
      const target = targetParts.join(':');
      let svc: ServiceTarget;

      if (type === 'kubernetes') {
        svc = { name, connection: { type: 'kubernetes', selector: target, namespace: opts.namespace } };
      } else if (type === 'log-file') {
        svc = { name, connection: { type: 'log-file', filePath: target } };
      } else if (type === 'docker') {
        svc = { name, connection: { type: 'docker', container: target } };
      } else if (type === 'process') {
        svc = { name, connection: { type: 'process', command: target } };
      } else if (type === 'http') {
        svc = { name, connection: { type: 'http-poll', url: target } };
      } else {
        console.error(chalk.red(`✗ Unknown service type "${type}". Use: kubernetes|log-file|docker|process|http`));
        process.exit(1);
      }
      clusterCfg.services.push(svc);
    }

    if (!clusterCfg.services.length && !clusterCfg.monitorAll) {
      console.error(chalk.red('✗ No services specified. Use --service or --all.'));
      console.error(chalk.yellow('  Example: ai-agent cluster-debug --service api:kubernetes:deployment/api'));
      process.exit(1);
    }

    // Build session
    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.fusion-agent', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);
    const speckit = SPECKITS['cluster-debugger'];
    const session = sessionManager.createSession(
      {
        name: `cluster-debug-${Date.now()}`,
        provider: config.provider,
        model: config.model || '',
        speckit: 'cluster-debugger',
        systemPrompt: speckit?.systemPrompt,
        guardrails: [],
        projectDir: process.cwd(),
      },
      config.apiKey
    );

    const monitor = new ClusterMonitor(clusterCfg, session);

    monitor.on('failure', (f) => {
      logger.debug(`Failure detected in ${f.serviceName}: ${f.errorSummary}`);
    });
    monitor.on('analysis', (f) => {
      logger.debug(`Analysis complete for ${f.serviceName}`);
    });
    monitor.on('fix-applied', (f, result) => {
      if (result.success) {
        console.log(chalk.green(`\n✅ Fix applied for ${f.serviceName}: ${result.output || result.action}`));
      }
    });

    console.log(chalk.cyan(`\n🔍 Cluster debug monitor starting in ${chalk.bold(clusterCfg.mode)} mode…`));
    if (clusterCfg.services.length) {
      console.log(chalk.dim(`   Services: ${clusterCfg.services.map((s) => s.name).join(', ')}`));
    }
    if (clusterCfg.monitorAll) {
      console.log(chalk.dim(`   Namespace: ${clusterCfg.namespace}`));
    }
    console.log(chalk.dim('   Press Ctrl+C to stop.\n'));

    await monitor.start();

    process.on('SIGINT', () => {
      monitor.stop();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      monitor.stop();
      process.exit(0);
    });

    // Keep alive
    await new Promise<void>(() => { /* resolved by SIGINT/SIGTERM */ });
  });

// ── skill command ─────────────────────────────────────────────────────────────
program
  .command('skill [subcommand] [args...]')
  .description('Manage installed skills (~/.fusion-agent/skills/)\n  Subcommands: list, show <name>, fetch <name> <url>')
  .action((subcommand: string | undefined, args: string[]) => {
    if (!subcommand || subcommand === 'list') {
      const skills = listSkills();
      if (!skills.length) {
        console.log(chalk.dim('\n  No skills installed. Use: ai-agent skill fetch <name> <url>\n'));
        return;
      }
      console.log(chalk.bold('\n  Installed Skills:\n'));
      for (const sk of skills) {
        console.log(`  ${chalk.cyan(sk)}`);
      }
      console.log();
      return;
    }

    if (subcommand === 'show') {
      const name = args[0];
      if (!name) {
        console.error(chalk.red('✗ Provide a skill name: ai-agent skill show <name>'));
        process.exit(1);
      }
      const skill = loadSkill(name);
      if (!skill) {
        console.error(chalk.red(`✗ Skill "${name}" not found.`));
        process.exit(1);
      }
      console.log(chalk.bold(`\n  Skill: ${skill.name}\n`));
      console.log(skill.content);
      console.log();
      return;
    }

    if (subcommand === 'fetch') {
      const [name, url] = args;
      if (!name || !url) {
        console.error(chalk.red('✗ Usage: ai-agent skill fetch <name> <url>'));
        process.exit(1);
      }
      const spinner = ora(`Fetching skill "${name}"…`).start();
      loadRemoteSkill(name, url, true)
        .then((skill) => {
          spinner.succeed(`Skill "${skill.name}" installed.`);
        })
        .catch((err: unknown) => {
          spinner.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
      return;
    }

    console.error(chalk.red(`✗ Unknown subcommand "${subcommand}". Use: list | show <name> | fetch <name> <url>`));
    process.exit(1);
  });

// ── webhook command ───────────────────────────────────────────────────────────
program
  .command('webhook <action>')
  .description('Manage autonomous agent webhooks\n  Actions: list, add, remove <id>')
  .option('--name <name>', 'Webhook name (for add)')
  .option('--session <session>', 'Target session name (for add)')
  .option('--requirements <text>', 'Requirements text for the autonomous run (for add)')
  .action((action: string, opts: { name?: string; session?: string; requirements?: string }) => {
    if (action === 'list') {
      const hooks = listWebhooks();
      if (!hooks.length) {
        console.log(chalk.dim('\n  No webhooks registered.\n'));
        return;
      }
      console.log(chalk.bold('\n  Registered Webhooks:\n'));
      for (const h of hooks) {
        console.log(`  ${chalk.cyan(h.id.padEnd(20))} ${chalk.bold((h.name || '(unnamed)').padEnd(20))} session: ${chalk.dim(h.sessionName || '—')}`);
      }
      console.log();
      return;
    }

    if (action === 'add') {
      if (!opts.name) {
        console.error(chalk.red('✗ --name is required for webhook add'));
        process.exit(1);
      }
      const result = createWebhook(
        opts.name,
        opts.session || opts.name,
        opts.requirements ? { requirementsContent: opts.requirements } : {}
      );
      console.log(chalk.green('\n  ✓ Webhook created.\n'));
      console.log(`  ${chalk.bold('ID:')}    ${result.id}`);
      console.log(`  ${chalk.bold('Token:')} ${result.token}`);
      console.log(chalk.yellow('\n  ⚠ Save this token — it will not be shown again.\n'));
      return;
    }

    if (action === 'remove') {
      const id = opts.name; // repurpose --name as id if positional not available
      // Try to get id from remaining argv
      const rawArgs = process.argv;
      const actionIdx = rawArgs.indexOf('remove');
      const webhookId = actionIdx >= 0 ? rawArgs[actionIdx + 1] : undefined;
      const targetId = webhookId && !webhookId.startsWith('--') ? webhookId : id;
      if (!targetId) {
        console.error(chalk.red('✗ Provide webhook ID: ai-agent webhook remove <id>'));
        process.exit(1);
      }
      const deleted = deleteWebhook(targetId);
      if (deleted) {
        console.log(chalk.green(`  ✓ Webhook ${targetId} removed.\n`));
      } else {
        console.error(chalk.red(`  ✗ Webhook "${targetId}" not found.\n`));
        process.exit(1);
      }
      return;
    }

    console.error(chalk.red(`✗ Unknown action "${action}". Use: list | add | remove <id>`));
    process.exit(1);
  });

// ── cron command ──────────────────────────────────────────────────────────────
program
  .command('cron <action>')
  .description('Manage scheduled autonomous agent runs\n  Actions: list, add, remove <id>, enable <id>, disable <id>')
  .option('--name <name>', 'Job name (for add)')
  .option('--schedule <cron>', 'Cron expression, e.g. "0 9 * * 1-5" (for add)')
  .option('--session <session>', 'Target session name (for add)')
  .option('--requirements <text>', 'Requirements text for the autonomous run (for add)')
  .action((action: string, opts: { name?: string; schedule?: string; session?: string; requirements?: string }) => {
    // CronManager is used as a file-only manager here (no live scheduler in CLI mode)
    const cronManager = new CronManager(undefined);

    if (action === 'list') {
      const jobs = cronManager.listJobs();
      if (!jobs.length) {
        console.log(chalk.dim('\n  No cron jobs scheduled.\n'));
        return;
      }
      console.log(chalk.bold('\n  Scheduled Jobs:\n'));
      for (const j of jobs) {
        const status = j.enabled ? chalk.green('●') : chalk.dim('○');
        console.log(`  ${status} ${chalk.cyan(j.id.slice(0, 8))} ${chalk.bold((j.name || '—').padEnd(20))} ${chalk.dim(j.schedule.padEnd(16))} session: ${chalk.dim(j.sessionName || '—')}`);
      }
      console.log();
      return;
    }

    if (action === 'add') {
      if (!opts.name || !opts.schedule) {
        console.error(chalk.red('✗ --name and --schedule are required for cron add'));
        console.error(chalk.dim('  Example: ai-agent cron add --name daily-review --schedule "0 9 * * 1-5" --requirements "Review open PRs"'));
        process.exit(1);
      }
      const job = cronManager.addJob(
        opts.name,
        opts.schedule,
        opts.session || opts.name,
        opts.requirements ? { requirementsContent: opts.requirements } : {}
      );
      console.log(chalk.green('\n  ✓ Cron job created.\n'));
      console.log(`  ${chalk.bold('ID:')}       ${job.id}`);
      console.log(`  ${chalk.bold('Name:')}     ${job.name}`);
      console.log(`  ${chalk.bold('Schedule:')} ${job.schedule}`);
      console.log(`  ${chalk.bold('Session:')}  ${job.sessionName}\n`);
      cronManager.stopAll();
      return;
    }

    if (action === 'remove') {
      const rawArgs = process.argv;
      const actionIdx = rawArgs.indexOf('remove');
      const cronId = actionIdx >= 0 ? rawArgs[actionIdx + 1] : undefined;
      const targetId = cronId && !cronId.startsWith('--') ? cronId : opts.name;
      if (!targetId) {
        console.error(chalk.red('✗ Provide job ID: ai-agent cron remove <id>'));
        process.exit(1);
      }
      const removed = cronManager.removeJob(targetId);
      if (removed) {
        console.log(chalk.green(`  ✓ Cron job ${targetId} removed.\n`));
      } else {
        console.error(chalk.red(`  ✗ Cron job "${targetId}" not found.\n`));
        process.exit(1);
      }
      cronManager.stopAll();
      return;
    }

    if (action === 'enable' || action === 'disable') {
      const rawArgs = process.argv;
      const actionIdx = rawArgs.indexOf(action);
      const cronId = actionIdx >= 0 ? rawArgs[actionIdx + 1] : undefined;
      const targetId = cronId && !cronId.startsWith('--') ? cronId : opts.name;
      if (!targetId) {
        console.error(chalk.red(`✗ Provide job ID: ai-agent cron ${action} <id>`));
        process.exit(1);
      }
      const updated = cronManager.setEnabled(targetId, action === 'enable');
      if (updated) {
        console.log(chalk.green(`  ✓ Cron job ${targetId} ${action}d.\n`));
      } else {
        console.error(chalk.red(`  ✗ Cron job "${targetId}" not found.\n`));
        process.exit(1);
      }
      cronManager.stopAll();
      return;
    }

    console.error(chalk.red(`✗ Unknown action "${action}". Use: list | add | remove <id> | enable <id> | disable <id>`));
    process.exit(1);
  });

program.parse(process.argv);
