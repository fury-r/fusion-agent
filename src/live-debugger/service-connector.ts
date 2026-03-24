import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import { logger } from '../utils/logger';

export type ServiceConnectionType = 'process' | 'docker' | 'http-poll';

export interface ProcessConnectionOptions {
  type: 'process';
  command: string;
  args?: string[];
  cwd?: string;
}

export interface DockerConnectionOptions {
  type: 'docker';
  container: string;
  tail?: number;
}

export interface HttpPollConnectionOptions {
  type: 'http-poll';
  url: string;
  intervalMs?: number;
  headers?: Record<string, string>;
}

export type ServiceConnectionOptions =
  | ProcessConnectionOptions
  | DockerConnectionOptions
  | HttpPollConnectionOptions;

export class ServiceConnector extends EventEmitter {
  private options: ServiceConnectionOptions;
  private child?: ChildProcess;
  private pollInterval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(options: ServiceConnectionOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    switch (this.options.type) {
      case 'process':
        this.startProcess(this.options);
        break;
      case 'docker':
        this.startDocker(this.options);
        break;
      case 'http-poll':
        this.startHttpPoll(this.options);
        break;
    }
  }

  private startProcess(opts: ProcessConnectionOptions): void {
    logger.debug(`Attaching to process: ${opts.command} ${(opts.args || []).join(' ')}`);
    this.child = spawn(opts.command, opts.args || [], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const processBuffer = (buffer: string, data: Buffer): string => {
      const combined = buffer + data.toString('utf-8');
      const lines = combined.split('\n');
      const remainder = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.emit('line', line);
      }
      return remainder;
    };

    this.child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer = processBuffer(stdoutBuffer, data);
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      stderrBuffer = processBuffer(stderrBuffer, data);
    });
    this.child.on('error', (err) => {
      logger.error(`Process connector error: ${err.message}`);
      this.emit('error', err);
      this.running = false;
    });
    this.child.on('exit', (code) => {
      if (!this.running) return; // already handled by error handler
      this.emit('exit', code);
      this.running = false;
    });
  }

  private startDocker(opts: DockerConnectionOptions): void {
    const tail = opts.tail ?? 100;
    logger.debug(`Attaching to Docker container: ${opts.container}`);
    this.child = spawn('docker', ['logs', '-f', '--tail', String(tail), opts.container], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const processData = (data: Buffer): void => {
      buffer += data.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.emit('line', line);
      }
    };
    this.child.stdout?.on('data', processData);
    this.child.stderr?.on('data', processData);
    this.child.on('error', (err) => {
      logger.error(`Docker connector error: ${err.message}`);
      this.emit('error', err);
      this.running = false;
    });
    this.child.on('exit', (code) => {
      if (!this.running) return; // already handled by error handler
      this.emit('exit', code);
      this.running = false;
    });
  }

  private startHttpPoll(opts: HttpPollConnectionOptions): void {
    const interval = opts.intervalMs ?? 5000;
    logger.debug(`HTTP polling: ${opts.url} every ${interval}ms`);

    let lastStatus = '';
    const poll = async (): Promise<void> => {
      try {
        const response = await axios.get(opts.url, {
          headers: opts.headers,
          timeout: interval - 500,
        });
        const statusLine = `HTTP ${response.status} - ${JSON.stringify(response.data).slice(0, 200)}`;
        if (statusLine !== lastStatus) {
          this.emit('line', statusLine);
          lastStatus = statusLine;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('line', `HTTP ERROR: ${msg}`);
      }
    };

    void poll();
    this.pollInterval = setInterval(() => { void poll(); }, interval);
  }

  stop(): void {
    this.running = false;
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch (err) {
        logger.error(`Error stopping process connector: ${err}`);
      }
      this.child = undefined;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }
}
