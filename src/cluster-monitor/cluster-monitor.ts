import { EventEmitter } from 'events';
import readline from 'readline';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { Session } from '../session/session';
import { ServiceConnector, ServiceConnectionOptions } from '../live-debugger/service-connector';
import { LogWatcher } from '../live-debugger/log-watcher';
import { KubernetesConnector, discoverServices } from './kubernetes-connector';
import { RemediationEngine } from './remediation';
import { NotificationManager, NotificationMessage } from './notifications';
import {
  ClusterMonitorConfig,
  ServiceTarget,
  DetectedFailure,
  MonitorMode,
  HITLRequest,
  HITLResponse,
  KubernetesConnectionOptions,
  LogFileConnectionOptions,
} from './types';
import { logger } from '../utils/logger';

// ── Shared connector interface ─────────────────────────────────────────────────

/** Minimal interface satisfied by all connector types. */
interface Connectable {
  on(event: string, listener: (...args: unknown[]) => void): this;
  start(): void;
  stop(): void;
}

// ── Error detection ───────────────────────────────────────────────────────────

const DEFAULT_ERROR_KEYWORDS = /error|exception|fatal|critical|traceback|panic|fail|oom|killed|crash/i;

// ── Internal watcher record ───────────────────────────────────────────────────

interface ServiceWatcher {
  name: string;
  connector: Connectable;
  logBatch: string[];
  flushTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Monitors one or more services in a cluster (Kubernetes, Docker, process,
 * log files or HTTP endpoints), detects failures, and either:
 *
 * - **auto-fix**: applies a matching remediation rule without human input,
 * - **notify-only**: sends a notification with the AI analysis, or
 * - **human-in-loop**: sends a HITL notification and waits for approval.
 *
 * Rules define what the agent *can* auto-fix and what it must *avoid*.
 */
export class ClusterMonitor extends EventEmitter {
  private config: ClusterMonitorConfig;
  private session: Session;
  private remediation: RemediationEngine;
  private notificationManager?: NotificationManager;
  private errorKeywords: RegExp;

  private watchers = new Map<string, ServiceWatcher>();
  private failures = new Map<string, DetectedFailure>();
  private analyzing = new Set<string>();
  private consecutiveAutoFixes = 0;

  constructor(config: ClusterMonitorConfig, session: Session) {
    super();
    this.config = config;
    this.session = session;
    this.remediation = new RemediationEngine(session, config.rules);
    this.errorKeywords = config.errorKeywordsPattern
      ? new RegExp(config.errorKeywordsPattern, 'i')
      : DEFAULT_ERROR_KEYWORDS;
    if (config.notifications) {
      this.notificationManager = new NotificationManager(config.notifications);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start monitoring all configured (and, optionally, auto-discovered) services.
   */
  async start(): Promise<void> {
    const services: ServiceTarget[] = [...this.config.services];

    if (this.config.monitorAll && this.config.namespace) {
      logger.info(`Discovering services in namespace "${this.config.namespace}"…`);
      try {
        const found = await discoverServices(this.config.namespace);
        for (const resourceName of found) {
          const shortName = resourceName.replace(/^deployment\.apps\//, '');
          if (!services.find((s) => s.name === shortName)) {
            services.push({
              name: shortName,
              connection: {
                type: 'kubernetes',
                selector: resourceName,
                namespace: this.config.namespace,
              } as KubernetesConnectionOptions,
            });
          }
        }
        logger.info(`Discovered ${found.length} service(s)`);
      } catch (err) {
        logger.error(`Service discovery failed: ${err}`);
      }
    }

    for (const svc of services) {
      this.attachWatcher(svc);
    }

    logger.info(
      `Cluster monitor started — watching ${this.watchers.size} service(s) in "${this.config.mode}" mode`
    );
  }

  /** Stop all watchers and release resources. */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      if (watcher.flushTimer) clearTimeout(watcher.flushTimer);
      watcher.connector.stop();
    }
    this.watchers.clear();
    logger.info('Cluster monitor stopped');
  }

  /** Return all tracked failures (read-only snapshot). */
  getFailures(): DetectedFailure[] {
    return Array.from(this.failures.values());
  }

  // ── HITL response (from external webhook / messaging platform) ────────────

  /**
   * Process an approve/reject/debug-more decision from an external system
   * (e.g. Slack interactivity, a webhook endpoint).
   */
  async processHITLResponse(response: HITLResponse): Promise<void> {
    const failure = this.failures.get(response.failureId);
    if (!failure) {
      logger.warn(`Unknown failureId in HITL response: ${response.failureId}`);
      return;
    }

    if (response.decision === 'approve') {
      if (failure.appliedRule) {
        const result = await this.remediation.applyAction(failure.appliedRule.action, failure);
        failure.status = result.success ? 'human-approved' : 'proposed';
        this.emit('fix-applied', failure, result);
      } else {
        failure.status = 'human-approved';
        this.emit('fix-applied', failure, {
          success: true,
          action: 'ai-fix',
          requiresApproval: false,
          output: failure.proposedFix,
        });
      }
    } else if (response.decision === 'reject') {
      failure.status = 'human-rejected';
      this.emit('fix-rejected', failure);
    } else {
      // debug-more — re-analyse with the user comment appended
      const augmented: DetectedFailure = {
        ...failure,
        logLines: [
          ...failure.logLines,
          ...(response.comment ? [`User comment: ${response.comment}`] : []),
        ],
      };
      const deepAnalysis = await this.remediation.analyzeAndProposeFix(augmented);
      failure.aiAnalysis = deepAnalysis;
      failure.status = 'proposed';
      await this.notify(failure, deepAnalysis);
    }
  }

  // ── Watcher setup ─────────────────────────────────────────────────────────

  private attachWatcher(service: ServiceTarget): void {
    const conn = service.connection;
    let connector: Connectable;

    if (conn.type === 'kubernetes') {
      connector = new KubernetesConnector(conn as KubernetesConnectionOptions);
    } else if (conn.type === 'log-file') {
      const lf = conn as LogFileConnectionOptions;
      connector = new LogWatcher({ filePath: lf.filePath, tailLines: lf.tailLines });
    } else {
      connector = new ServiceConnector(conn as ServiceConnectionOptions);
    }

    const watcher: ServiceWatcher = { name: service.name, connector, logBatch: [] };

    connector.on('line', (line: unknown) => this.handleLine(service.name, watcher, String(line)));
    connector.on('error', (err: unknown) => {
      logger.error(`Connector error for "${service.name}": ${err instanceof Error ? err.message : err}`);
    });

    connector.start();
    this.watchers.set(service.name, watcher);
    logger.debug(`Watching service: ${service.name}`);
  }

  // ── Log processing pipeline ───────────────────────────────────────────────

  private handleLine(serviceName: string, watcher: ServiceWatcher, line: string): void {
    watcher.logBatch.push(line);

    const maxWait = (this.config.maxWaitSeconds ?? 30) * 1000;
    if (watcher.flushTimer) clearTimeout(watcher.flushTimer);
    watcher.flushTimer = setTimeout(() => { void this.flush(serviceName, watcher); }, maxWait);

    const batchSize = this.config.batchSize ?? 20;
    if (watcher.logBatch.length >= batchSize) {
      void this.flush(serviceName, watcher);
    }
  }

  private async flush(serviceName: string, watcher: ServiceWatcher): Promise<void> {
    if (this.analyzing.has(serviceName) || watcher.logBatch.length === 0) return;

    const lines = [...watcher.logBatch];
    watcher.logBatch = [];
    if (watcher.flushTimer) {
      clearTimeout(watcher.flushTimer);
      watcher.flushTimer = undefined;
    }

    if (!lines.some((l) => this.errorKeywords.test(l))) return;

    this.analyzing.add(serviceName);

    const failure: DetectedFailure = {
      id: uuidv4(),
      serviceName,
      timestamp: new Date().toISOString(),
      logLines: lines,
      errorSummary: this.buildErrorSummary(lines),
      status: 'analyzing',
    };
    this.failures.set(failure.id, failure);
    this.emit('failure', failure);

    try {
      const analysis = await this.remediation.analyzeAndProposeFix(failure);
      failure.aiAnalysis = analysis;
      failure.proposedFix = analysis;
      failure.status = 'proposed';
      this.emit('analysis', failure);

      const rule = this.remediation.findApplicableRule(failure);
      if (rule) failure.appliedRule = rule;

      await this.dispatchFailure(failure, rule);
    } catch (err) {
      logger.error(`Analysis error for "${serviceName}": ${err}`);
      failure.status = 'skipped';
    } finally {
      this.analyzing.delete(serviceName);
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private async dispatchFailure(
    failure: DetectedFailure,
    rule: ReturnType<RemediationEngine['findApplicableRule']>
  ): Promise<void> {
    const mode: MonitorMode = this.config.mode;

    if (mode === 'notify-only') {
      await this.notify(failure, failure.aiAnalysis || '');
      failure.status = 'skipped';
      return;
    }

    if (mode === 'human-in-loop') {
      await this.requestApproval(failure);
      return;
    }

    // auto-fix ─────────────────────────────────────────────────────────────
    const maxAuto = this.config.maxConsecutiveAutoFixes ?? 3;
    if (this.consecutiveAutoFixes >= maxAuto) {
      logger.warn(`Max consecutive auto-fixes reached (${maxAuto}). Falling back to HITL.`);
      await this.requestApproval(failure);
      return;
    }

    if (rule && !this.remediation.requiresApproval(rule)) {
      await this.autoFix(failure, rule);
    } else {
      await this.requestApproval(failure);
    }
  }

  private async autoFix(
    failure: DetectedFailure,
    rule: NonNullable<ReturnType<RemediationEngine['findApplicableRule']>>
  ): Promise<void> {
    logger.info(`Auto-applying rule "${rule.name}" for "${failure.serviceName}"`);
    const result = await this.remediation.applyAction(rule.action, failure);
    this.consecutiveAutoFixes++;

    if (result.success) {
      failure.status = 'auto-fixed';
      this.consecutiveAutoFixes = 0;
      this.emit('fix-applied', failure, result);
      logger.info(`Auto-fix succeeded: ${result.output || result.action}`);

      if (this.notificationManager) {
        await this.notificationManager.send({
          title: `✅ Auto-fix applied: ${failure.serviceName}`,
          body: `Rule "${rule.name}" applied.\n\nOutput: ${result.output ?? 'n/a'}`,
          severity: 'info',
          service: failure.serviceName,
          failure,
        });
      }
    } else {
      logger.error(`Auto-fix failed: ${result.error}`);
      await this.requestApproval(failure);
    }
  }

  // ── HITL helpers ──────────────────────────────────────────────────────────

  private async requestApproval(failure: DetectedFailure): Promise<void> {
    const proposedFix = failure.aiAnalysis || 'No fix proposed.';
    failure.status = 'proposed';

    if (this.notificationManager) {
      await this.notify(failure, proposedFix, {
        failure,
        proposedFix,
        affectedRule: failure.appliedRule,
        timestamp: new Date().toISOString(),
      });
      this.emit('notification-sent', failure.serviceName, 'hitl');
    } else {
      // Fall back to interactive CLI prompt
      await this.cliPrompt(failure, proposedFix);
    }
  }

  private async notify(
    failure: DetectedFailure,
    proposedFix: string,
    hitlRequest?: HITLRequest
  ): Promise<void> {
    if (!this.notificationManager) return;
    const msg: NotificationMessage = {
      title: `🔴 Failure in ${failure.serviceName}`,
      body: failure.errorSummary,
      severity: 'error',
      service: failure.serviceName,
      failure,
      hitlRequest: hitlRequest || {
        failure,
        proposedFix,
        timestamp: new Date().toISOString(),
      },
    };
    await this.notificationManager.send(msg);
  }

  // ── Interactive CLI (fallback HITL) ───────────────────────────────────────

  private async cliPrompt(failure: DetectedFailure, proposedFix: string): Promise<void> {
    console.log('\n' + chalk.red('─'.repeat(60)));
    console.log(chalk.red(`🔴  Failure in: ${chalk.bold(failure.serviceName)}`));
    console.log(chalk.yellow('\nError summary:\n') + failure.errorSummary);
    console.log(chalk.yellow('\nRecent logs:\n') + failure.logLines.slice(-10).join('\n'));
    if (failure.aiAnalysis) {
      console.log(chalk.cyan('\nAI analysis:\n') + failure.aiAnalysis);
    }
    console.log(chalk.green('\nProposed fix:\n') + proposedFix);
    console.log(chalk.red('─'.repeat(60)));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        chalk.bold('\nOptions: [a]pply fix  [d]ebug more  [s]kip  > '),
        (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); }
      );
    });

    if (answer === 'a' || answer === 'apply') {
      if (failure.appliedRule) {
        const result = await this.remediation.applyAction(failure.appliedRule.action, failure);
        if (result.success) {
          failure.status = 'human-approved';
          console.log(chalk.green(`\n✅ Fix applied: ${result.output || 'done'}`));
          this.emit('fix-applied', failure, result);
        } else {
          console.log(chalk.red(`\n❌ Fix failed: ${result.error}`));
        }
      } else {
        console.log(chalk.yellow('\n⚠ No actionable rule found. The AI-proposed fix is shown above.'));
        failure.status = 'human-approved';
      }
    } else if (answer === 'd' || answer === 'debug') {
      await this.cliDebugSession(failure);
    } else {
      failure.status = 'human-rejected';
      this.emit('fix-rejected', failure);
      console.log(chalk.gray('\n⏭  Skipped.'));
    }
  }

  private async cliDebugSession(failure: DetectedFailure): Promise<void> {
    console.log(chalk.cyan('\nEntering debug session. Type "exit" to return.\n'));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt(chalk.cyan('debug> '));
    rl.prompt();

    await new Promise<void>((resolve) => {
      rl.on('line', async (input) => {
        const trimmed = input.trim();
        if (trimmed === 'exit' || trimmed === 'quit') { rl.close(); return; }
        await this.session.chat(`Context: debugging service "${failure.serviceName}". ${trimmed}`, {
          stream: true,
          onChunk: (c) => process.stdout.write(c),
        });
        console.log('\n');
        rl.prompt();
      });
      rl.on('close', resolve);
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private buildErrorSummary(lines: string[]): string {
    return lines
      .filter((l) => this.errorKeywords.test(l))
      .slice(0, 3)
      .join(' | ')
      .slice(0, 500);
  }
}
