import { EventEmitter } from 'events';
import { Session } from '../session/session';
import { LogWatcher } from './log-watcher';
import { ServiceConnector, ServiceConnectionOptions } from './service-connector';
import { logger } from '../utils/logger';

export interface LiveDebuggerOptions {
  session: Session;
  /** How many log lines to accumulate before analyzing (default: 20) */
  batchSize?: number;
  /** Max seconds to wait before analyzing accumulated lines (default: 30) */
  maxWaitSeconds?: number;
  onAnalysis?: (analysis: string) => void;
  onLog?: (line: string) => void;
}

export class LiveDebugger extends EventEmitter {
  private session: Session;
  private batchSize: number;
  private maxWaitSeconds: number;
  private logBatch: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private connector?: ServiceConnector | LogWatcher;
  private analyzing = false;

  constructor(options: LiveDebuggerOptions) {
    super();
    this.session = options.session;
    this.batchSize = options.batchSize ?? 20;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 30;

    if (options.onAnalysis) this.on('analysis', options.onAnalysis);
    if (options.onLog) this.on('log', options.onLog);
  }

  watchLogFile(filePath: string, tailLines = 50): void {
    const watcher = new LogWatcher({ filePath, tailLines });
    watcher.on('line', (line: string) => this.handleLine(line));
    watcher.start();
    this.connector = watcher;
  }

  connectToService(options: ServiceConnectionOptions): void {
    const connector = new ServiceConnector(options);
    connector.on('line', (line: string) => this.handleLine(line));
    connector.on('exit', (code: number) => {
      logger.info(`Service exited with code: ${code}`);
      this.emit('exit', code);
    });
    connector.start();
    this.connector = connector;
  }

  private handleLine(line: string): void {
    this.emit('log', line);
    this.logBatch.push(line);

    // Reset flush timer
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, this.maxWaitSeconds * 1000);

    if (this.logBatch.length >= this.batchSize) {
      void this.flush();
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

    const errorKeywords = /error|exception|fatal|critical|traceback|panic|fail/i;
    const hasErrors = lines.some((l) => errorKeywords.test(l));
    if (!hasErrors) {
      this.analyzing = false;
      return;
    }

    const logContent = lines.join('\n');
    const prompt = `Analyze the following log output from a running service. Identify any errors, their root causes, and provide specific code fixes if possible.\n\n\`\`\`\n${logContent}\n\`\`\``;

    try {
      let analysis = '';
      await this.session.chat(prompt, {
        stream: true,
        onChunk: (chunk) => {
          analysis += chunk;
          this.emit('analysis-chunk', chunk);
        },
      });
      this.emit('analysis', analysis);
    } catch (err) {
      logger.error(`Live debugger analysis error: ${err}`);
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

    let analysis = '';
    await this.session.chat(prompt, {
      stream: true,
      onChunk: (chunk) => {
        analysis += chunk;
        this.emit('analysis-chunk', chunk);
      },
    });
    this.emit('analysis', analysis);
    return analysis;
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.connector) {
      if (this.connector instanceof LogWatcher) {
        this.connector.stop();
      } else {
        this.connector.stop();
      }
    }
  }
}

export { LogWatcher } from './log-watcher';
export { ServiceConnector } from './service-connector';
export type { ServiceConnectionOptions } from './service-connector';
