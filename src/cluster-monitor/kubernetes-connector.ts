import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { KubernetesConnectionOptions } from './types';
import { logger } from '../utils/logger';

// ── Kubernetes log connector ──────────────────────────────────────────────────

/**
 * Streams pod / deployment logs via `kubectl logs --follow`.
 * Emits `'line'` for each log line, `'exit'` when the process exits,
 * and `'error'` on spawn errors.
 */
export class KubernetesConnector extends EventEmitter {
  private options: KubernetesConnectionOptions;
  private child?: ChildProcess;
  private running = false;

  constructor(options: KubernetesConnectionOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const { selector, namespace, tail, kubeconfig, context } = this.options;
    const args: string[] = ['logs', '--follow'];

    if (namespace) args.push('-n', namespace);
    args.push('--tail', tail != null ? String(tail) : '100');
    if (kubeconfig) args.push('--kubeconfig', kubeconfig);
    if (context) args.push('--context', context);

    // Determine whether to use -l (label selector) or direct resource reference
    if (selector.includes('=') || selector.startsWith('{')) {
      args.push('-l', selector);
    } else if (
      selector.startsWith('deployment/') ||
      selector.startsWith('pod/') ||
      selector.startsWith('statefulset/') ||
      selector.startsWith('daemonset/')
    ) {
      args.push(selector);
    } else {
      // bare name — assume pod
      args.push(selector);
    }

    logger.debug(`KubernetesConnector: kubectl ${args.join(' ')}`);

    this.child = spawn('kubectl', args, {
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
    this.child.on('exit', (code) => {
      this.running = false;
      this.emit('exit', code);
    });
    this.child.on('error', (err: Error) => {
      this.running = false;
      this.emit('error', err);
    });
  }

  stop(): void {
    this.running = false;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = undefined;
    }
  }
}

// ── Service discovery ─────────────────────────────────────────────────────────

/**
 * Lists all deployment names in the given namespace using `kubectl get deployments`.
 * Returns an array of strings like `["deployment.apps/api", "deployment.apps/worker"]`.
 */
export function discoverServices(
  namespace: string,
  kubeconfig?: string,
  context?: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ['get', 'deployments', '-n', namespace, '-o', 'name'];
    if (kubeconfig) args.push('--kubeconfig', kubeconfig);
    if (context) args.push('--context', context);

    const child = spawn('kubectl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim().split('\n').filter(Boolean));
      } else {
        reject(new Error(`kubectl get deployments exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}
