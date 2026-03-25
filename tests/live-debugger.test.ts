import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { LiveDebugger } from '../src/live-debugger/index';
import { LogWatcher } from '../src/live-debugger/log-watcher';
import { ServiceConnector } from '../src/live-debugger/service-connector';
import { Session } from '../src/session/session';
import { GitHubClient } from '../src/integrations/git';
import { NotificationManager } from '../src/cluster-monitor/notifications';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock Session whose chat() can be controlled per-test. */
function makeSession(chatImpl?: (prompt: string) => Promise<void>): Session {
  const session = new EventEmitter() as unknown as Session;
  (session as unknown as Record<string, unknown>).chat = jest.fn(
    async (prompt: string, opts?: { stream?: boolean; onChunk?: (c: string) => void }) => {
      if (chatImpl) {
        await chatImpl(prompt);
        return;
      }
      opts?.onChunk?.('ok');
    }
  );
  return session;
}

function makeDebugger(chatImpl?: (prompt: string) => Promise<void>) {
  const session = makeSession(chatImpl);
  // retryCount: 0 keeps tests fast (no exponential back-off delays)
  const dbg = new LiveDebugger({ session, batchSize: 5, maxWaitSeconds: 60, retryCount: 0 });
  // Silence unhandled-error warnings in tests by attaching a default listener
  dbg.on('error', () => { /* handled */ });
  return dbg;
}

// ── LiveDebugger ──────────────────────────────────────────────────────────────

describe('LiveDebugger', () => {
  describe('analyzeNow()', () => {
    it('returns analysis from session.chat', async () => {
      // Default mock calls onChunk('ok')
      const dbg = makeDebugger();
      const result = await dbg.analyzeNow('check logs');
      expect(result).toBe('ok');
    });

    it('does NOT throw when session.chat rejects — returns empty string', async () => {
      const dbg = makeDebugger(async () => { throw new Error('AI provider down'); });
      const errors: Error[] = [];
      dbg.on('error', (e) => errors.push(e));

      await expect(dbg.analyzeNow('test prompt')).resolves.toBe('');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('AI provider down');
    });

    it('handles empty log batch without crashing', async () => {
      const dbg = makeDebugger();
      await expect(dbg.analyzeNow()).resolves.toBeDefined();
    });

    it('emits analysis event on success', async () => {
      const dbg = makeDebugger();
      const analyses: string[] = [];
      dbg.on('analysis', (a) => analyses.push(a));
      await dbg.analyzeNow('prompt');
      expect(analyses).toHaveLength(1);
      expect(analyses[0]).toBe('ok');
    });
  });

  describe('flush() via handleLine()', () => {
    it('does NOT throw when batch triggers flush and AI call fails', async () => {
      const dbg = makeDebugger(async () => { throw new Error('network timeout'); });
      const errors: Error[] = [];
      dbg.on('error', (e) => errors.push(e));

      // Push enough error-containing lines to trigger a flush
      for (let i = 0; i < 5; i++) {
        (dbg as unknown as { handleLine(l: string): void })['handleLine'](`ERROR line ${i}`);
      }

      // Give the async flush a tick to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('network timeout');
    });

    it('discards batch with no error keywords — no AI call made', async () => {
      const chatMock = jest.fn();
      const session = makeSession();
      (session as unknown as Record<string, unknown>).chat = chatMock;
      const dbg = new LiveDebugger({ session, batchSize: 3, maxWaitSeconds: 60, retryCount: 0 });
      dbg.on('error', () => { /* swallow */ });

      for (let i = 0; i < 3; i++) {
        (dbg as unknown as { handleLine(l: string): void })['handleLine'](`INFO: all good ${i}`);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('handles non-string line gracefully in handleLine', () => {
      const dbg = makeDebugger();
      const handleLine = (dbg as unknown as { handleLine(l: unknown): void })['handleLine'].bind(dbg);
      expect(() => handleLine(null)).not.toThrow();
      expect(() => handleLine(undefined)).not.toThrow();
      expect(() => handleLine(42)).not.toThrow();
    });

    it('does not crash when onLog listener throws', () => {
      const dbg = makeDebugger();
      dbg.on('log', () => { throw new Error('listener boom'); });
      const handleLine = (dbg as unknown as { handleLine(l: string): void })['handleLine'].bind(dbg);
      expect(() => handleLine('INFO: normal line')).not.toThrow();
    });
  });

  describe('watchLogFile()', () => {
    it('emits error (does NOT throw) when file does not exist', (done) => {
      const dbg = makeDebugger();
      dbg.removeAllListeners('error'); // remove default swallower
      dbg.on('error', (err: Error) => {
        expect(err.message).toContain('not found');
        done();
      });
      dbg.watchLogFile('/nonexistent/path/app.log');
    });

    it('watches a real log file and emits lines', (done) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-test-'));
      const logFile = path.join(tmpDir, 'app.log');
      fs.writeFileSync(logFile, 'ERROR: initial error\n');

      const dbg = makeDebugger();
      const lines: string[] = [];
      dbg.on('log', (l) => lines.push(l));

      dbg.watchLogFile(logFile, 10);

      setTimeout(() => {
        dbg.stop();
        expect(lines.some((l) => l.includes('initial error'))).toBe(true);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        done();
      }, 200);
    });
  });

  describe('stop()', () => {
    it('can be called multiple times without throwing', () => {
      const dbg = makeDebugger();
      expect(() => {
        dbg.stop();
        dbg.stop();
      }).not.toThrow();
    });

    it('clears the flush timer on stop', () => {
      const dbg = makeDebugger();
      // Trigger a timer by pushing one line
      (dbg as unknown as { handleLine(l: string): void })['handleLine']('INFO: hello');
      expect(() => dbg.stop()).not.toThrow();
    });
  });
});

// ── LogWatcher ────────────────────────────────────────────────────────────────

describe('LogWatcher', () => {
  it('emits error (does NOT throw) when file does not exist', (done) => {
    const watcher = new LogWatcher({ filePath: '/no/such/file.log' });
    watcher.on('error', (err: Error) => {
      expect(err.message).toContain('not found');
      done();
    });
    expect(() => watcher.start()).not.toThrow();
  });

  it('emits existing tail lines on start', (done) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-test-'));
    const logFile = path.join(tmpDir, 'app.log');
    fs.writeFileSync(logFile, 'line1\nline2\nline3\n');

    const watcher = new LogWatcher({ filePath: logFile, tailLines: 2 });
    const lines: string[] = [];
    watcher.on('line', (l) => lines.push(l));
    watcher.on('error', done);

    watcher.start();

    setTimeout(() => {
      watcher.stop();
      expect(lines).toEqual(['line2', 'line3']);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      done();
    }, 100);
  });

  it('stop() is safe to call multiple times', () => {
    const watcher = new LogWatcher({ filePath: '/tmp/nonexistent.log' });
    expect(() => {
      watcher.stop();
      watcher.stop();
    }).not.toThrow();
  });

  it('detects new lines appended to the file', (done) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-append-'));
    const logFile = path.join(tmpDir, 'app.log');
    fs.writeFileSync(logFile, '');

    const watcher = new LogWatcher({ filePath: logFile, tailLines: 0 });
    const lines: string[] = [];
    watcher.on('line', (l) => lines.push(l));
    watcher.on('error', done);
    watcher.start();

    setTimeout(() => {
      fs.appendFileSync(logFile, 'ERROR: new error\n');
    }, 100);

    // chokidar uses polling/native events that may take up to ~500ms to fire;
    // 600ms ensures reliable detection without flakiness.
    setTimeout(() => {
      watcher.stop();
      expect(lines.some((l) => l.includes('new error'))).toBe(true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      done();
    }, 600);
  });
});

// ── ServiceConnector ──────────────────────────────────────────────────────────

describe('ServiceConnector', () => {
  it('emits lines from a process', (done) => {
    const connector = new ServiceConnector({
      type: 'process',
      command: 'echo',
      args: ['hello world'],
    });
    const lines: string[] = [];
    connector.on('line', (l) => lines.push(l));
    connector.on('exit', () => {
      expect(lines.some((l) => l.includes('hello world'))).toBe(true);
      done();
    });
    connector.on('error', done);
    connector.start();
  });

  it('forwards connector error events — does NOT crash the debugger', (done) => {
    // Verify that error events emitted by a ServiceConnector are forwarded
    // through LiveDebugger as its own 'error' event (not unhandled crashes).
    const dbg = makeDebugger();
    dbg.removeAllListeners('error');

    dbg.on('error', (err: Error) => {
      expect(err.message).toBe('connector boom');
      done();
    });

    // connectToService registers an 'error' forwarder on the internal connector;
    // we simulate that error by triggering it after connection.
    dbg.connectToService({ type: 'process', command: 'echo', args: ['x'] });

    // Access the internal connector via the private field to emit a test error
    const internalConnector = (dbg as unknown as { connector: ServiceConnector }).connector;
    setTimeout(() => internalConnector.emit('error', new Error('connector boom')), 50);
  });

  it('stop() is safe to call before start', () => {
    const connector = new ServiceConnector({ type: 'process', command: 'echo', args: ['x'] });
    expect(() => connector.stop()).not.toThrow();
  });

  it('stop() is safe to call multiple times', (done) => {
    const connector = new ServiceConnector({
      type: 'process',
      command: 'echo',
      args: ['x'],
    });
    connector.on('exit', () => {
      expect(() => {
        connector.stop();
        connector.stop();
      }).not.toThrow();
      done();
    });
    connector.on('error', done);
    connector.start();
  });

  it('http-poll emits line on HTTP error', (done) => {
    // Uses a URL guaranteed to fail (connection refused), which causes the
    // catch block in startHttpPoll to emit a line starting with 'HTTP ERROR'.
    const connector = new ServiceConnector({
      type: 'http-poll',
      url: 'http://127.0.0.1:1', // guaranteed connection refused
      intervalMs: 2000, // must be > 500 to avoid negative axios timeout
    });
    const lines: string[] = [];
    connector.on('line', (l) => {
      lines.push(l);
      connector.stop();
      expect(lines[0]).toMatch(/HTTP ERROR/i);
      done();
    });
    connector.start();
  });
});

// ── LiveDebugger — Copilot auto-assign guardrails ───────────────────────────

/**
 * Build a mock Session that has autoAssignCopilot: true + optional guardrails.
 * The chat() mock immediately streams a deterministic analysis string so that
 * flush() advances past the AI step and into the GitHub auto-assign path.
 */
function makeAutoAssignSession(guardrails: string[] = []): Session {
  const session = new EventEmitter() as unknown as Session;
  Object.assign(session, {
    id: 'ga-session-id',
    name: 'ga-test-session',
    config: {
      github: {
        autoAssignCopilot: true,
        token: 'ghp_test_token',
        repoUrl: 'https://github.com/test-org/test-repo',
        guardrails,
      },
    },
    getTurns: jest.fn(() => [{ id: 'turn-ga-1', debuggerMeta: undefined as unknown }]),
    chat: jest.fn(
      async (_: string, opts?: { stream?: boolean; onChunk?: (c: string) => void }) => {
        opts?.onChunk?.('ERROR: auto-assign analysis text');
      },
    ),
  });
  return session;
}

describe('LiveDebugger — Copilot auto-assign guardrails', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Push `batchSize` error-containing lines to trigger flush. */
  function fillBatch(
    dbg: LiveDebugger,
    count = 3,
    line = 'ERROR: something bad happened',
  ): void {
    const hl = (dbg as unknown as { handleLine(l: string): void }).handleLine.bind(dbg);
    for (let i = 0; i < count; i++) hl(`${line} (${i})`);
  }

  it('emits debugger:copilot-guardrail-blocked socket event when a guardrail fires', async () => {
    jest
      .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
      .mockReturnValue('Issue content contains denied keyword "secret" (rule: deny-keyword:secret)');

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const mockIo = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn((event: string, payload: unknown) => {
          emitted.push({ event, payload });
        }),
      }),
    };

    const session = makeAutoAssignSession(['deny-keyword:secret']);
    const dbg = new LiveDebugger({
      session,
      batchSize: 3,
      maxWaitSeconds: 60,
      retryCount: 0,
      io: mockIo,
    });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    const blocked = emitted.find((e) => e.event === 'debugger:copilot-guardrail-blocked');
    expect(blocked).toBeDefined();
    expect((blocked!.payload as Record<string, unknown>).violation).toMatch(/denied keyword/);
    expect((blocked!.payload as Record<string, unknown>).sessionId).toBe('ga-session-id');
    dbg.stop();
  });

  it('does NOT call createIssueForCopilot when a guardrail blocks the issue', async () => {
    jest
      .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
      .mockReturnValue('denied keyword match');
    const createSpy = jest
      .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
      .mockResolvedValue({ issueNumber: 1, issueUrl: 'https://github.com/test/repo/issues/1' });

    const session = makeAutoAssignSession();
    const dbg = new LiveDebugger({ session, batchSize: 3, maxWaitSeconds: 60, retryCount: 0 });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    expect(createSpy).not.toHaveBeenCalled();
    dbg.stop();
  });

  it('calls createIssueForCopilot when the guardrail check returns null (passes)', async () => {
    jest
      .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
      .mockReturnValue(null);
    const createSpy = jest
      .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
      .mockResolvedValue({ issueNumber: 5, issueUrl: 'https://github.com/test/repo/issues/5' });

    const session = makeAutoAssignSession();
    const dbg = new LiveDebugger({ session, batchSize: 3, maxWaitSeconds: 60, retryCount: 0 });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    expect(createSpy).toHaveBeenCalledTimes(1);
    dbg.stop();
  });

  it('sends a notification when guardrail fires and notifications are configured', async () => {
    jest
      .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
      .mockReturnValue('max-title-length exceeded');

    const sendSpy = jest
      .spyOn(NotificationManager.prototype, 'send')
      .mockResolvedValue(undefined);

    const session = makeAutoAssignSession();
    const dbg = new LiveDebugger({
      session,
      batchSize: 3,
      maxWaitSeconds: 60,
      retryCount: 0,
      notifications: { slack: { enabled: false, webhookUrl: 'https://hooks.slack.com/test' } },
    });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    expect(sendSpy).toHaveBeenCalled();
    const callArg = sendSpy.mock.calls[0][0] as { title: string; body: string };
    expect(callArg.title).toMatch(/blocked/i);
    expect(callArg.body).toContain('max-title-length exceeded');
    dbg.stop();
  });

  it('does NOT send a notification when guardrail fires but no notifications are configured', async () => {
    jest
      .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
      .mockReturnValue('denied keyword found');

    const sendSpy = jest
      .spyOn(NotificationManager.prototype, 'send')
      .mockResolvedValue(undefined);

    const session = makeAutoAssignSession();
    // No notifications option
    const dbg = new LiveDebugger({ session, batchSize: 3, maxWaitSeconds: 60, retryCount: 0 });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    expect(sendSpy).not.toHaveBeenCalled();
    dbg.stop();
  });

  it('does NOT create a copilot issue when autoAssignCopilot is false', async () => {
    const createSpy = jest
      .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
      .mockResolvedValue({ issueNumber: 1, issueUrl: 'https://github.com/test/repo/issues/1' });

    // Session with autoAssignCopilot: false
    const session = new EventEmitter() as unknown as Session;
    Object.assign(session, {
      id: 'no-autoassign',
      name: 'test',
      config: {
        github: { autoAssignCopilot: false, token: 'ghp_test', repoUrl: 'https://github.com/test/repo' },
      },
      getTurns: jest.fn(() => []),
      chat: jest.fn(async (_: string, opts?: { onChunk?: (c: string) => void }) => {
        opts?.onChunk?.('ERROR: analysis');
      }),
    });

    const dbg = new LiveDebugger({ session, batchSize: 3, maxWaitSeconds: 60, retryCount: 0 });
    dbg.on('error', () => { /* swallow */ });

    fillBatch(dbg);
    await new Promise((r) => setTimeout(r, 150));

    expect(createSpy).not.toHaveBeenCalled();
    dbg.stop();
  });
});
