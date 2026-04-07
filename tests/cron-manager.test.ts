import fs from 'fs';
import path from 'path';
import os from 'os';

// Redirect cron store to a temp file
const TEST_DIR = path.join(os.tmpdir(), `fusion-agent-test-cron-${process.pid}`);
const TEST_CRON_FILE = path.join(TEST_DIR, 'cron.json');

jest.mock('path', () => {
  const actual = jest.requireActual<typeof import('path')>('path');
  return {
    ...actual,
    join: (...args: string[]) => {
      if (
        args[0] === os.homedir() &&
        args[1] === '.fusion-agent' &&
        args[2] === 'cron.json'
      ) {
        return TEST_CRON_FILE;
      }
      return actual.join(...args);
    },
  };
});

// Mock node-cron so tests never wait for real ticks
jest.mock('node-cron', () => ({
  validate: jest.fn((expr: string) => /\S/.test(expr)),
  schedule: jest.fn(() => ({
    stop: jest.fn(),
    start: jest.fn(),
  })),
}));

import * as nodeCron from 'node-cron';
import { CronManager } from '../src/cron/cron-manager';

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(TEST_CRON_FILE)) fs.unlinkSync(TEST_CRON_FILE);
  jest.clearAllMocks();
  (nodeCron.validate as jest.Mock).mockImplementation((expr: string) => /\S/.test(expr));
});

function makeManager(): CronManager {
  return new CronManager(undefined); // no session manager — CLI mode
}

// ── addJob ────────────────────────────────────────────────────────────────────

describe('CronManager.addJob', () => {
  it('throws for an invalid cron schedule', () => {
    const m = makeManager();
    (nodeCron.validate as jest.Mock).mockReturnValue(false);
    expect(() => m.addJob('bad-job', 'not a cron', 'my-session', {})).toThrow(
      /Invalid cron schedule/
    );
  });

  it('persists the job and returns its config', () => {
    const m = makeManager();
    const job = m.addJob('daily', '0 9 * * 1-5', 'my-session', { requirementsContent: 'do work' });
    expect(job.name).toBe('daily');
    expect(job.schedule).toBe('0 9 * * 1-5');
    expect(job.sessionName).toBe('my-session');
    expect(job.enabled).toBe(true);
    expect(typeof job.id).toBe('string');
  });

  it('writes the job to disk', () => {
    const m = makeManager();
    m.addJob('disk-job', '* * * * *', 'sess', {});
    expect(fs.existsSync(TEST_CRON_FILE)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(TEST_CRON_FILE, 'utf-8')) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('accumulates multiple jobs', () => {
    const m = makeManager();
    m.addJob('job-a', '* * * * *', 'sess-a', {});
    m.addJob('job-b', '* * * * *', 'sess-b', {});
    expect(m.listJobs()).toHaveLength(2);
  });
});

// ── listJobs ──────────────────────────────────────────────────────────────────

describe('CronManager.listJobs', () => {
  it('returns empty array when no jobs exist', () => {
    expect(makeManager().listJobs()).toEqual([]);
  });

  it('returns all jobs regardless of enabled state', () => {
    const m = makeManager();
    const job = m.addJob('j1', '* * * * *', 'sess', {});
    m.setEnabled(job.id, false);
    expect(m.listJobs()).toHaveLength(1);
  });
});

// ── removeJob ─────────────────────────────────────────────────────────────────

describe('CronManager.removeJob', () => {
  it('returns false for a nonexistent id', () => {
    expect(makeManager().removeJob('ghost')).toBe(false);
  });

  it('removes the job from disk and returns true', () => {
    const m = makeManager();
    const job = m.addJob('removable', '* * * * *', 'sess', {});
    expect(m.removeJob(job.id)).toBe(true);
    expect(m.listJobs()).toHaveLength(0);
  });

  it('does not remove other jobs', () => {
    const m = makeManager();
    const job1 = m.addJob('keep-me', '* * * * *', 'sess-a', {});
    const job2 = m.addJob('delete-me', '* * * * *', 'sess-b', {});
    m.removeJob(job2.id);
    const remaining = m.listJobs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(job1.id);
  });
});

// ── setEnabled ────────────────────────────────────────────────────────────────

describe('CronManager.setEnabled', () => {
  it('returns false for a nonexistent id', () => {
    expect(makeManager().setEnabled('ghost', false)).toBe(false);
  });

  it('disables a job', () => {
    const m = makeManager();
    const job = m.addJob('toggle', '* * * * *', 'sess', {});
    m.setEnabled(job.id, false);
    const stored = m.listJobs().find((j) => j.id === job.id)!;
    expect(stored.enabled).toBe(false);
  });

  it('re-enables a job', () => {
    const m = makeManager();
    const job = m.addJob('enable-me', '* * * * *', 'sess', {});
    m.setEnabled(job.id, false);
    m.setEnabled(job.id, true);
    const stored = m.listJobs().find((j) => j.id === job.id)!;
    expect(stored.enabled).toBe(true);
  });
});
