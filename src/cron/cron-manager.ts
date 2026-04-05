import fs from 'fs';
import path from 'path';
import os from 'os';
import * as cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { SessionManager } from '../session/session-manager';
import { AutonomousVibeAgent } from '../vibe-coder/autonomous-agent';
import { SPECKITS } from '../speckits';
import { logger } from '../utils/logger';
import type { AutonomousConfig } from '../vibe-coder/types';

export interface CronJobConfig {
  id: string;
  name: string;
  /** node-cron schedule expression, e.g. "0 9 * * 1-5" */
  schedule: string;
  sessionName: string;
  autonomousConfig: AutonomousConfig;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

const CRON_FILE = path.join(os.homedir(), '.fusion-agent', 'cron.json');

export class CronManager {
  private readonly sessionManager?: SessionManager;
  private readonly apiKey?: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly tasks = new Map<string, cron.ScheduledTask>();

  constructor(
    sessionManager?: SessionManager,
    opts: { apiKey?: string; provider?: string; model?: string } = {}
  ) {
    this.sessionManager = sessionManager;
    this.apiKey = opts.apiKey;
    this.provider = opts.provider;
    this.model = opts.model;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private readStore(): CronJobConfig[] {
    if (!fs.existsSync(CRON_FILE)) return [];
    try {
      return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8')) as CronJobConfig[];
    } catch {
      return [];
    }
  }

  private writeStore(configs: CronJobConfig[]): void {
    const dir = path.dirname(CRON_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CRON_FILE, JSON.stringify(configs, null, 2), 'utf-8');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load all persisted jobs and start the enabled ones.
   * Call this once at server startup.
   */
  restoreJobs(): void {
    const configs = this.readStore();
    for (const config of configs) {
      if (config.enabled) {
        this.scheduleTask(config);
      }
    }
    logger.info(`CronManager: restored ${configs.filter((c) => c.enabled).length} cron job(s)`);
  }

  /**
   * Add and immediately schedule a new cron job.
   * Returns the created config.
   */
  addJob(
    name: string,
    schedule: string,
    sessionName: string,
    autonomousConfig: AutonomousConfig
  ): CronJobConfig {
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron schedule: "${schedule}"`);
    }
    const config: CronJobConfig = {
      id: uuidv4(),
      name,
      schedule,
      sessionName,
      autonomousConfig,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const store = this.readStore();
    store.push(config);
    this.writeStore(store);
    if (this.sessionManager) this.scheduleTask(config);
    logger.info(`CronManager: added job "${name}" (${schedule})`);
    return config;
  }

  /** Remove a job by ID. Returns false if not found. */
  removeJob(id: string): boolean {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    const store = this.readStore();
    const next = store.filter((c) => c.id !== id);
    if (next.length === store.length) return false;
    this.writeStore(next);
    logger.info(`CronManager: removed job ${id}`);
    return true;
  }

  /** List all jobs (including disabled). */
  listJobs(): CronJobConfig[] {
    return this.readStore();
  }

  /** Enable or disable a job. */
  setEnabled(id: string, enabled: boolean): boolean {
    const store = this.readStore();
    const config = store.find((c) => c.id === id);
    if (!config) return false;

    config.enabled = enabled;
    this.writeStore(store);

    if (!enabled) {
      this.tasks.get(id)?.stop();
      this.tasks.delete(id);
    } else if (this.sessionManager) {
      this.scheduleTask(config);
    }
    return true;
  }

  /** Stop all running tasks (call on process exit). */
  stopAll(): void {
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private scheduleTask(config: CronJobConfig): void {
    const existing = this.tasks.get(config.id);
    if (existing) existing.stop();

    const task = cron.schedule(config.schedule, () => {
      void this.runJob(config.id);
    });
    this.tasks.set(config.id, task);
  }

  private async runJob(id: string): Promise<void> {
    const store = this.readStore();
    const config = store.find((c) => c.id === id);
    if (!config || !config.enabled) return;
    if (!this.sessionManager) {
      logger.warn(`CronManager: cannot run job "${config.name}" — no SessionManager provided`);
      return;
    }

    logger.info(`CronManager: running job "${config.name}" (${id})`);

    // Update lastRunAt
    config.lastRunAt = new Date().toISOString();
    this.writeStore(store);

    try {
      const session = this.sessionManager.createSession(
        {
          name: `${config.sessionName}-cron-${Date.now()}`,
          provider: this.provider || 'openai',
          model: this.model || '',
          speckit: 'vibe-coder',
          systemPrompt: SPECKITS['vibe-coder']?.systemPrompt,
        },
        this.apiKey
      );

      const agent = new AutonomousVibeAgent(session, config.autonomousConfig);
      agent.on('complete', () => {
        this.sessionManager?.persistSession(session);
        logger.info(`CronManager: job "${config.name}" complete (session ${session.id})`);
      });
      agent.on('error', (err: Error) => {
        logger.error(`CronManager: job "${config.name}" error: ${err.message}`);
      });
      await agent.run();
    } catch (err) {
      logger.error(`CronManager: failed to run job "${config.name}": ${err}`);
    }
  }
}
