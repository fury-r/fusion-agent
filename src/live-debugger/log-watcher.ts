import fs from 'fs';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import { logger } from '../utils/logger';

export interface LogWatcherOptions {
  filePath: string;
  /** Lines to send as initial context (default: 50) */
  tailLines?: number;
  onLine?: (line: string) => void;
}

export class LogWatcher extends EventEmitter {
  private filePath: string;
  private tailLines: number;
  private watcher?: ReturnType<typeof chokidar.watch>;
  private fileSize = 0;
  private buffer = '';

  constructor(options: LogWatcherOptions) {
    super();
    this.filePath = options.filePath;
    this.tailLines = options.tailLines ?? 50;
    if (options.onLine) {
      this.on('line', options.onLine);
    }
  }

  start(): void {
    if (!fs.existsSync(this.filePath)) {
      const err = new Error(`Log file not found: ${this.filePath}`);
      logger.error(err.message);
      this.emit('error', err);
      return;
    }

    try {
      // Emit tail of existing content
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const tailLines = lines.slice(-this.tailLines);
      for (const line of tailLines) {
        this.emit('line', line);
      }

      this.fileSize = fs.statSync(this.filePath).size;
    } catch (err) {
      logger.error(`Log watcher failed to read initial content: ${err}`);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.watcher = chokidar.watch(this.filePath, { persistent: true });
    this.watcher.on('change', () => this.onFileChange());
    this.watcher.on('error', (err) => {
      logger.error(`Log watcher chokidar error: ${err}`);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
    logger.debug(`Log watcher started: ${this.filePath}`);
  }

  private onFileChange(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.fileSize) {
        // File was truncated/rotated
        this.fileSize = 0;
        this.buffer = '';
      }

      const newSize = stat.size;
      if (newSize <= this.fileSize) return;

      const fd = fs.openSync(this.filePath, 'r');
      const chunkSize = newSize - this.fileSize;
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, this.fileSize);
      fs.closeSync(fd);

      this.fileSize = newSize;
      const newContent = this.buffer + buf.toString('utf-8');
      const lines = newContent.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this.emit('line', line);
        }
      }
    } catch (err) {
      logger.error(`Log watcher error: ${err}`);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    logger.debug(`Log watcher stopped: ${this.filePath}`);
  }
}
