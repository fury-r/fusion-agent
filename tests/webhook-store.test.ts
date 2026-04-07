import fs from 'fs';
import path from 'path';
import os from 'os';

// Point the webhook store to a temp file for testing
const TEST_DIR = path.join(os.tmpdir(), `fusion-agent-test-webhooks-${process.pid}`);
const TEST_WEBHOOKS_FILE = path.join(TEST_DIR, 'webhooks.json');

jest.mock('path', () => {
  const actual = jest.requireActual<typeof import('path')>('path');
  return {
    ...actual,
    join: (...args: string[]) => {
      if (
        args[0] === os.homedir() &&
        args[1] === '.fusion-agent' &&
        args[2] === 'webhooks.json'
      ) {
        return TEST_WEBHOOKS_FILE;
      }
      return actual.join(...args);
    },
  };
});

import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  validateWebhookToken,
} from '../src/utils/webhook-store';

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset state between tests
  if (fs.existsSync(TEST_WEBHOOKS_FILE)) {
    fs.unlinkSync(TEST_WEBHOOKS_FILE);
  }
});

// ── createWebhook ─────────────────────────────────────────────────────────────

describe('createWebhook', () => {
  it('returns an id and a plain-text token', () => {
    const result = createWebhook('my-hook', 'my-session', {});
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
  });

  it('persists the webhook to disk', () => {
    createWebhook('hook-1', 'sess-1', {});
    const hooks = listWebhooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('hook-1');
    expect(hooks[0].sessionName).toBe('sess-1');
  });

  it('never stores the plain-text token (only the hash)', () => {
    const { token } = createWebhook('hook-2', 'sess-2', {});
    const raw = fs.readFileSync(TEST_WEBHOOKS_FILE, 'utf-8');
    expect(raw).not.toContain(token);
  });

  it('accumulates multiple webhooks', () => {
    createWebhook('hook-a', 'sess-a', {});
    createWebhook('hook-b', 'sess-b', {});
    expect(listWebhooks()).toHaveLength(2);
  });
});

// ── listWebhooks ──────────────────────────────────────────────────────────────

describe('listWebhooks', () => {
  it('returns empty array when store is empty', () => {
    expect(listWebhooks()).toEqual([]);
  });

  it('omits tokenHash from returned objects', () => {
    createWebhook('hook-c', 'sess-c', {});
    const hooks = listWebhooks();
    expect(hooks[0]).not.toHaveProperty('tokenHash');
  });
});

// ── deleteWebhook ─────────────────────────────────────────────────────────────

describe('deleteWebhook', () => {
  it('returns false when the webhook does not exist', () => {
    expect(deleteWebhook('nonexistent-id')).toBe(false);
  });

  it('removes the webhook and returns true', () => {
    const { id } = createWebhook('hook-d', 'sess-d', {});
    expect(deleteWebhook(id)).toBe(true);
    expect(listWebhooks()).toHaveLength(0);
  });

  it('does not remove other webhooks', () => {
    const { id: id1 } = createWebhook('hook-e', 'sess-e', {});
    createWebhook('hook-f', 'sess-f', {});
    deleteWebhook(id1);
    const remaining = listWebhooks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('hook-f');
  });
});

// ── validateWebhookToken ──────────────────────────────────────────────────────

describe('validateWebhookToken', () => {
  it('returns null for an unknown webhook id', () => {
    expect(validateWebhookToken('unknown', 'any-token')).toBeNull();
  });

  it('returns null for a wrong token', () => {
    const { id } = createWebhook('hook-g', 'sess-g', {});
    expect(validateWebhookToken(id, 'wrong-token')).toBeNull();
  });

  it('returns the webhook config for the correct token', () => {
    const { id, token } = createWebhook('hook-h', 'sess-h', { requirementsContent: 'do stuff' });
    const config = validateWebhookToken(id, token);
    expect(config).not.toBeNull();
    expect(config!.id).toBe(id);
    expect(config!.name).toBe('hook-h');
  });

  it('is case-sensitive for token comparison', () => {
    const { id, token } = createWebhook('hook-i', 'sess-i', {});
    expect(validateWebhookToken(id, token.toUpperCase())).toBeNull();
  });
});
