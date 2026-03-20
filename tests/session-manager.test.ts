import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../src/session/session-manager';
import { createGuardrail } from '../src/session/guardrails';

// Mock the createProvider function to avoid needing real API keys in tests
jest.mock('../src/providers', () => ({
  createProvider: jest.fn(() => ({
    complete: jest.fn().mockResolvedValue({ content: 'Mocked AI response', model: 'gpt-4o' }),
    getModel: jest.fn().mockReturnValue('gpt-4o'),
  })),
}));

describe('SessionManager', () => {
  let sessionsDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    sessionsDir = path.join(os.tmpdir(), `test-sessions-${Date.now()}`);
    manager = new SessionManager(sessionsDir);
  });

  afterEach(() => {
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('should create sessions directory if it does not exist', () => {
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it('should create a session and persist it', () => {
    const session = manager.createSession({
      name: 'test-session',
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(session.name).toBe('test-session');
    expect(session.id).toBeDefined();

    const files = fs.readdirSync(sessionsDir);
    expect(files).toContain(`${session.id}.json`);
  });

  it('should list created sessions', () => {
    manager.createSession({ name: 'session-a', provider: 'openai', model: 'gpt-4o' });
    manager.createSession({ name: 'session-b', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });

    const list = manager.listSessions();
    expect(list.length).toBe(2);
    const names = list.map((s) => s.name);
    expect(names).toContain('session-a');
    expect(names).toContain('session-b');
  });

  it('should delete a session', () => {
    const session = manager.createSession({ name: 'to-delete', provider: 'openai', model: 'gpt-4o' });
    manager.deleteSession(session.id);

    const list = manager.listSessions();
    expect(list.find((s) => s.id === session.id)).toBeUndefined();
  });

  it('should load a session by id', () => {
    const created = manager.createSession({ name: 'load-me', provider: 'openai', model: 'gpt-4o' });
    const manager2 = new SessionManager(sessionsDir);
    const loaded = manager2.loadSession(created.id);
    expect(loaded.id).toBe(created.id);
    expect(loaded.name).toBe('load-me');
  });

  it('should throw when loading non-existent session', () => {
    expect(() => manager.loadSession('nonexistent-id')).toThrow(/not found/);
  });

  it('should export session as JSON string', () => {
    const session = manager.createSession({ name: 'export-test', provider: 'openai', model: 'gpt-4o' });
    const json = manager.exportSession(session.id);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(session.id);
    expect(parsed.name).toBe('export-test');
  });

  it('should support sessions with guardrails', () => {
    const guardrails = [
      createGuardrail('custom', 'Always use TypeScript'),
      createGuardrail('deny-paths', '/node_modules'),
    ];
    const session = manager.createSession({
      name: 'guarded',
      provider: 'openai',
      model: 'gpt-4o',
      guardrails,
    });
    expect(session.config.guardrails?.length).toBe(2);
  });
});
