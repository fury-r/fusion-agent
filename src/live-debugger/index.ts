import { EventEmitter } from 'events';
import { Session } from '../session/session';
import { DebuggerTurnMeta } from '../session/session';
import { LogWatcher } from './log-watcher';
import { ServiceConnector, ServiceConnectionOptions } from './service-connector';
import { logger } from '../utils/logger';
import { NotificationManager } from '../cluster-monitor/notifications';
import { NotificationConfig } from '../cluster-monitor/types';

export interface LiveDebuggerOptions {
  session: Session;
  /** How many log lines to accumulate before analyzing (default: 20) */
  batchSize?: number;
  /** Max seconds to wait before analyzing accumulated lines (default: 30) */
  maxWaitSeconds?: number;
  onAnalysis?: (analysis: string) => void;
  onLog?: (line: string) => void;
  /**
   * How many times to retry a failed AI analysis call (default: 3).
   * Set to 0 to disable retries.
   */
  retryCount?: number;
  /**
   * Base delay in milliseconds between retry attempts.
   * Each retry doubles the delay (exponential back-off). Default: 1000 ms.
   */
  retryDelayMs?: number;
  /**
   * Messaging platform configuration. When configured, a notification is sent
   * if all retry attempts are exhausted instead of silently failing.
   */
  notifications?: NotificationConfig;
  /**
   * Regex pattern strings. Only log lines that match at least one pattern are
   * batched. When omitted all lines are accepted (existing behaviour).
   */
  logPatterns?: string[];
  /**
   * Log-level names (e.g. `['ERROR', 'WARN', 'FATAL']`). Only lines that
   * contain one of these level tokens are batched. When omitted all levels
   * are accepted. Combined with `logPatterns` using OR logic.
   */
  logLevels?: string[];
  /**
   * Maximum number of tokens to include in a single prompt sent to the AI.
   * Lines are trimmed from the oldest first to fit within the budget.
   * When omitted the limit is extracted automatically from the first 429
   * "Request too large" error and applied to all subsequent flushes.
   */
  logTokenLimit?: number;
  /**
   * Optional Socket.IO server instance. When provided, real-time events are
   * pushed to all clients subscribed to `debugger:<sessionId>`.
   * Accepted events: `debugger:log`, `debugger:analysis`, `debugger:error`.
   */
  io?: {
    to(room: string): { emit(event: string, ...args: unknown[]): void };
  };
}

export class LiveDebugger extends EventEmitter {
  private session: Session;
  private batchSize: number;
  private maxWaitSeconds: number;
  private retryCount: number;
  private retryDelayMs: number;
  private notificationManager?: NotificationManager;
  private lineFilter?: (line: string) => boolean;
  private customFiltersActive: boolean;
  private logBatch: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private connector?: ServiceConnector | LogWatcher;
  private analyzing = false;
  private io?: LiveDebuggerOptions['io'];
  private sessionId: string;
  /** Effective token limit for log prompts. Auto-detected from 429 errors when not configured. */
  private logTokenLimit?: number;

  constructor(options: LiveDebuggerOptions) {
    super();
    this.session = options.session;
    this.sessionId = options.session.id;
    this.batchSize = options.batchSize ?? 20;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 30;
    this.retryCount = options.retryCount ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.io = options.io;

    if (options.notifications) {
      this.notificationManager = new NotificationManager(options.notifications);
    }

    if (options.logTokenLimit && options.logTokenLimit > 0) {
      this.logTokenLimit = options.logTokenLimit;
    }

    // Build the log line pre-filter when patterns or levels are configured
    const patternRegexes: RegExp[] = [];
    for (const p of options.logPatterns ?? []) {
      try {
        patternRegexes.push(new RegExp(p, 'i'));
      } catch {
        logger.warn(`LiveDebugger: ignoring invalid logPattern "${p}"`);
      }
    }
    const levelRe =
      options.logLevels && options.logLevels.length > 0
        ? new RegExp(`\\b(${options.logLevels.join('|')})\\b`, 'i')
        : null;

    this.customFiltersActive = patternRegexes.length > 0 || levelRe !== null;

    if (this.customFiltersActive) {
      this.lineFilter = (line: string) =>
        patternRegexes.some((p) => p.test(line)) || (levelRe !== null && levelRe.test(line));
    }

    if (options.onAnalysis) this.on('analysis', options.onAnalysis);
    if (options.onLog) this.on('log', options.onLog);
  }

  watchLogFile(filePath: string, tailLines = 50): void {
    try {
      const watcher = new LogWatcher({ filePath, tailLines });
      watcher.on('line', (line: string) => this.handleLine(line));
      watcher.on('error', (err: Error) => {
        logger.error(`Live debugger log watcher error: ${err.message}`);
        this.emit('error', err);
      });
      watcher.start();
      this.connector = watcher;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Live debugger failed to start log watcher: ${error.message}`);
      this.emit('error', error);
    }
  }

  connectToService(options: ServiceConnectionOptions): void {
    try {
      const connector = new ServiceConnector(options);
      connector.on('line', (line: string) => this.handleLine(line));
      connector.on('error', (err: Error) => {
        logger.error(`Live debugger service connector error: ${err.message}`);
        this.emit('error', err);
      });
      connector.on('exit', (code: number) => {
        logger.info(`Service exited with code: ${code}`);
        this.emit('exit', code);
      });
      connector.start();
      this.connector = connector;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Live debugger failed to start service connector: ${error.message}`);
      this.emit('error', error);
    }
  }

  private handleLine(line: string): void {
    try {
      if (typeof line !== 'string') return;

      // Apply configured log filters before buffering
      if (this.lineFilter && !this.lineFilter(line)) return;

      this.emit('log', line);
      // Push to Web UI in real time
      this.io?.to(`debugger:${this.sessionId}`).emit('debugger:log', {
        sessionId: this.sessionId,
        line,
        timestamp: new Date().toISOString(),
      });
      this.logBatch.push(line);

      // Reset flush timer
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => { void this.flush(); }, this.maxWaitSeconds * 1000);

      if (this.logBatch.length >= this.batchSize) {
        void this.flush();
      }
    } catch (err) {
      logger.error(`Live debugger handleLine error: ${err}`);
    }
  }

  private async flush(): Promise<void> {
    if (this.analyzing || this.logBatch.length === 0) return;

    const lines = [...this.logBatch];
    this.logBatch = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.analyzing = true;

    try {
      // When custom filters are active the user has already scoped what lines
      // to batch, so skip the default error-keyword gate.
      if (!this.customFiltersActive) {
        const errorKeywords = /error|exception|fatal|critical|traceback|panic|fail/i;
        const hasErrors = lines.some((l) => errorKeywords.test(l));
        if (!hasErrors) {
          return;
        }
      }

      const rawLogContent = lines.join('\n');
      const logContent = this.truncateToTokenLimit(rawLogContent);
      const prompt = `Analyze the following log output from a running service. Identify any errors, their root causes, and provide specific code fixes if possible.\n\n\`\`\`\n${logContent}\n\`\`\``;
      const promptSentAt = new Date().toISOString();

      const analysis = await this.callAI(prompt);
      const responseReceivedAt = new Date().toISOString();

      // Build debugger metadata for the session turn
      const meta: DebuggerTurnMeta = {
        matchedLogLines: lines,
        promptSentAt,
        responseReceivedAt,
        notificationSent: false,
        fixApplied: false,
      };

      // Attach meta to the most-recently created turn
      const turns = typeof this.session.getTurns === 'function' ? this.session.getTurns() : [];
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        lastTurn.debuggerMeta = meta;
      }

      this.emit('analysis', analysis, meta);
      // Push to Web UI in real time
      this.io?.to(`debugger:${this.sessionId}`).emit('debugger:analysis', {
        sessionId: this.sessionId,
        prompt,
        analysis,
        meta,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Live debugger analysis error (all retries exhausted): ${error.message}`);
      const notified = await this.notifyFailure(error, lines);
      if (notified) {
        // Mark the last turn's meta as notified if it exists
        const turns = typeof this.session.getTurns === 'function' ? this.session.getTurns() : [];
        const lastTurn = turns[turns.length - 1];
        if (lastTurn?.debuggerMeta) {
          lastTurn.debuggerMeta.notificationSent = true;
        }
      }
      this.io?.to(`debugger:${this.sessionId}`).emit('debugger:error', {
        sessionId: this.sessionId,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
      this.emit('error', error);
    } finally {
      this.analyzing = false;
    }
  }

  async analyzeNow(customPrompt?: string): Promise<string> {
    const lines = [...this.logBatch];
    this.logBatch = [];

    const logContent = lines.join('\n');
    const prompt =
      customPrompt ||
      `Analyze these logs and identify any issues:\n\n\`\`\`\n${logContent}\n\`\`\``;

    try {
      const analysis = await this.callAI(prompt);
      this.emit('analysis', analysis);
      return analysis;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Live debugger analyzeNow error (all retries exhausted): ${error.message}`);
      await this.notifyFailure(error, lines);
      this.emit('error', error);
      return '';
    }
  }

  /**
   * Rough token estimator: ~1 token per 4 characters.
   * Trims oldest lines first to stay within the configured budget.
   */
  private truncateToTokenLimit(content: string): string {
    if (!this.logTokenLimit || this.logTokenLimit <= 0) return content;
    // Reserve ~500 tokens for the surrounding prompt template
    const budget = Math.max(100, this.logTokenLimit - 500);
    const charBudget = budget * 4;
    if (content.length <= charBudget) return content;
    // Drop oldest lines until it fits
    const lines = content.split('\n');
    while (lines.length > 1 && lines.join('\n').length > charBudget) {
      lines.shift();
    }
    return lines.join('\n');
  }

  /**
   * Call the AI provider with automatic retry on failure.
   * Uses exponential back-off: delay doubles after each attempt.
   */
  private async callAI(initialPrompt: string): Promise<string> {
    let lastError: Error | undefined;
    let prompt = initialPrompt;

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        logger.warn(
          `Live debugger AI retry ${attempt}/${this.retryCount} in ${delay} ms…`
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      try {
        let analysis = '';
        await this.session.chat(prompt, {
          stream: true,
          onChunk: (chunk) => {
            analysis += chunk;
            this.emit('analysis-chunk', chunk);
          },
        });
        return analysis;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          `Live debugger AI attempt ${attempt + 1}/${this.retryCount + 1} failed: ${lastError.message}`
        );

        // Auto-detect token limit from 429 "Request too large" errors and
        // truncate the prompt before the next retry.
        const tpmMatch = lastError.message.match(
          /tokens per min.*?Limit\s+(\d+)/i
        );
        if (tpmMatch) {
          const detected = parseInt(tpmMatch[1], 10);
          if (!this.logTokenLimit || detected < this.logTokenLimit) {
            this.logTokenLimit = detected;
            logger.warn(
              `Live debugger: auto-detected token limit ${detected} from 429 error. Truncating future prompts.`
            );
          }
          // Re-truncate the current prompt for the next retry
          const codeBlockMatch = prompt.match(/```\n([\s\S]*?)\n```/);
          if (codeBlockMatch) {
            const truncated = this.truncateToTokenLimit(codeBlockMatch[1]);
            prompt = prompt.replace(codeBlockMatch[1], truncated);
          }
        }
      }
    }

    throw lastError!;
  }

  /** Send a notification when all AI retries are exhausted. Returns true if notification was sent. */
  private async notifyFailure(error: Error, logLines: string[]): Promise<boolean> {
    if (!this.notificationManager) return false;
    try {
      await this.notificationManager.send({
        title: '⚠ Live Debugger: AI analysis failed',
        body:
          `All ${this.retryCount + 1} analysis attempt(s) failed.\n` +
          `Last error: ${error.message}\n\n` +
          `Last log lines:\n${logLines.slice(-5).join('\n')}`,
        severity: 'error',
        service: 'live-debugger',
      });
      return true;
    } catch (notifyErr) {
      logger.error(`Live debugger notification error: ${notifyErr}`);
      return false;
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.connector) {
      try {
        this.connector.stop();
      } catch (err) {
        logger.error(`Live debugger stop error: ${err}`);
      }
    }
  }
}

export { LogWatcher } from './log-watcher';
export { ServiceConnector } from './service-connector';
export type { ServiceConnectionOptions } from './service-connector';
