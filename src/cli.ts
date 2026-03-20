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

    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.ai-agent-cli', 'sessions');
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
  .option('-s, --session <name>', 'Session name', 'debug-session')
  .option('--batch <n>', 'Lines to batch before analysis', '20')
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

    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.ai-agent-cli', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);
    const session = sessionManager.createSession(
      {
        name: opts.session,
        provider: config.provider,
        model: config.model || '',
        speckit: 'debugger',
        systemPrompt: SPECKITS['debugger']?.systemPrompt,
        projectDir: process.cwd(),
      },
      config.apiKey
    );

    console.log(chalk.yellow('\n  🔍 Live Debugger started'));
    console.log(chalk.dim('  AI will analyze errors as they appear. Press Ctrl+C to stop.\n'));

    const debugger_ = new LiveDebugger({
      session,
      batchSize: parseInt(opts.batch, 10),
      onLog: (line) => process.stdout.write(chalk.dim(`  ${line}\n`)),
      onAnalysis: (analysis) => {
        console.log(chalk.bold.yellow('\n  ━━ AI Analysis ━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.white(analysis));
        console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
        sessionManager.persistSession(session);
      },
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
    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.ai-agent-cli', 'sessions');
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
    const sessionsDir = config.sessionDir || path.join(os.homedir(), '.ai-agent-cli', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);

    const server = createWebServer({ port: config.port, sessionManager });
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

program.parse(process.argv);
