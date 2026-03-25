import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { extractFileBlocks, detectCompletion } from '../src/vibe-coder/file-parser';
import { LoopDetector, jaccardSimilarity } from '../src/vibe-coder/loop-detector';
import { AutonomousVibeAgent } from '../src/vibe-coder/autonomous-agent';
import { Session } from '../src/session/session';
import { LiveDebugger } from '../src/live-debugger';

// ── extractFileBlocks ─────────────────────────────────────────────────────────

describe('extractFileBlocks', () => {
  it('returns empty array for text with no code blocks', () => {
    expect(extractFileBlocks('Here is some plain text.')).toEqual([]);
  });

  it('parses a single typescript block', () => {
    const text = '```typescript:src/foo.ts\nconst x = 1;\n```';
    const result = extractFileBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('src/foo.ts');
    expect(result[0].content).toContain('const x = 1;');
  });

  it('parses multiple blocks from one response', () => {
    const text =
      '```ts:a.ts\nA\n```\n\nsome prose\n\n```js:b.js\nB\n```';
    const result = extractFileBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('a.ts');
    expect(result[1].filePath).toBe('b.js');
  });

  it('handles blocks with no language prefix', () => {
    const text = '```:plain.txt\nhello\n```';
    const result = extractFileBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('plain.txt');
  });

  it('ignores ordinary code blocks without a filepath header', () => {
    const text = '```typescript\nconst y = 2;\n```';
    expect(extractFileBlocks(text)).toHaveLength(0);
  });

  it('trims whitespace from file paths', () => {
    const text = '```ts:  src/utils.ts  \ncode\n```';
    expect(extractFileBlocks(text)[0].filePath).toBe('src/utils.ts');
  });
});

// ── detectCompletion ──────────────────────────────────────────────────────────

describe('detectCompletion', () => {
  it('returns false for normal text', () => {
    expect(detectCompletion('Step 3: write tests')).toBe(false);
  });

  it('returns true when sentinel is present (exact case)', () => {
    expect(detectCompletion('Done.\nREQUIREMENTS_COMPLETE')).toBe(true);
  });

  it('returns true regardless of case', () => {
    expect(detectCompletion('requirements_complete')).toBe(true);
    expect(detectCompletion('Requirements_Complete')).toBe(true);
  });
});

// ── jaccardSimilarity ─────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(jaccardSimilarity('apple banana', 'cat dog fish')).toBe(0);
  });

  it('returns 1 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
  });

  it('returns intermediate value for partial overlap', () => {
    const s = jaccardSimilarity('hello world foo', 'hello world bar');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1);
  });
});

// ── LoopDetector ──────────────────────────────────────────────────────────────

describe('LoopDetector', () => {
  it('does not flag the first response', () => {
    const d = new LoopDetector(4, 0.85);
    expect(d.add('some response text here')).toBe(false);
  });

  it('detects a near-identical follow-up response', () => {
    const d = new LoopDetector(4, 0.85);
    d.add('I will now create the Button component and write its tests.');
    expect(
      d.add('I will now create the Button component and write its tests again.')
    ).toBe(true);
  });

  it('does not flag genuinely different responses', () => {
    const d = new LoopDetector(4, 0.85);
    d.add('Creating the database schema');
    expect(d.add('Writing the REST API endpoints for user authentication')).toBe(false);
  });

  it('slides the window — old entries fall out', () => {
    const d = new LoopDetector(2, 0.85); // window of 2
    d.add('response one');
    d.add('response two');
    d.add('response three'); // "one" slides out
    // "one" is no longer in window so should not be flagged
    expect(d.add('response one')).toBe(false);
  });

  it('reset() clears the window', () => {
    const d = new LoopDetector(4, 0.85);
    d.add('same text here to detect loop');
    d.reset();
    expect(d.add('same text here to detect loop')).toBe(false);
  });
});

// ── AutonomousVibeAgent ────────────────────────────────────────────────────────

function makeMockSession(chatImpl?: (msg: string) => Promise<string>): Session {
  const session = new EventEmitter() as unknown as Session;
  (session as unknown as Record<string, unknown>).config = {
    projectDir: os.tmpdir(),
    guardrails: [],
  };
  (session as unknown as Record<string, unknown>).chat = jest.fn(
    async (msg: string, opts?: { stream?: boolean; onChunk?: (c: string) => void }) => {
      const text = chatImpl ? await chatImpl(msg) : 'ok REQUIREMENTS_COMPLETE';
      opts?.onChunk?.(text);
      return { id: 'turn-1', timestamp: '', userMessage: msg, assistantMessage: text };
    }
  );
  (session as unknown as Record<string, unknown>).applyFileChange = jest.fn(() => ({
    filePath: '',
    originalContent: '',
    newContent: '',
    patch: '',
  }));
  return session;
}

describe('AutonomousVibeAgent', () => {
  it('throws when neither requirementsFile nor requirementsContent is provided', () => {
    const session = makeMockSession();
    expect(
      () => new AutonomousVibeAgent(session, {} as never)
    ).toThrow(/requirementsFile or requirementsContent/);
  });

  it('completes immediately when AI returns REQUIREMENTS_COMPLETE in plan step', async () => {
    const session = makeMockSession(async () => 'Plan done. REQUIREMENTS_COMPLETE');
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'Build a hello-world function',
    });

    const completed: unknown[] = [];
    agent.on('complete', (steps) => completed.push(steps));
    await agent.run();

    expect(agent.getStatus()).toBe('completed');
    expect(completed).toHaveLength(1);
  });

  it('emits step events for each iteration', async () => {
    let calls = 0;
    const session = makeMockSession(async () => {
      calls++;
      return calls >= 2 ? 'Step done. REQUIREMENTS_COMPLETE' : 'Step ' + calls;
    });
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'Build something',
      maxSteps: 5,
    });

    const steps: unknown[] = [];
    agent.on('step', (s) => steps.push(s));
    await agent.run();

    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(agent.getStatus()).toBe('completed');
  });

  it('stop() sets status to stopped and resolves run()', async () => {
    const session = makeMockSession(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'still working';
    });
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'never ends',
      maxSteps: 100,
    });

    const runPromise = agent.run();
    await new Promise((r) => setTimeout(r, 30));
    agent.stop();
    await runPromise;

    expect(['stopped', 'completed']).toContain(agent.getStatus());
  });

  it('receiveHILResponse() is a no-op when no HIL is pending', () => {
    const session = makeMockSession();
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'test',
    });
    expect(() => agent.receiveHILResponse('some guidance')).not.toThrow();
  });

  it('getSteps() returns a defensive copy', async () => {
    const session = makeMockSession(async () => 'REQUIREMENTS_COMPLETE');
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'build',
    });
    await agent.run();
    const steps = agent.getSteps();
    steps.push({} as never); // mutating the copy
    expect(agent.getSteps()).toHaveLength(steps.length - 1);
  });

  it('respects timeLimitSeconds', async () => {
    const session = makeMockSession(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 'still going';
    });
    const agent = new AutonomousVibeAgent(session, {
      requirementsContent: 'long task',
      timeLimitSeconds: 0.05, // 50 ms
      maxSteps: 50,
    });

    await agent.run();
    expect(['timed-out', 'completed', 'stopped']).toContain(agent.getStatus());
  });
});

// ── LiveDebugger — retry + log filtering ─────────────────────────────────────

function makeMockLiveSession(chatImpl?: () => Promise<void>): Session {
  const session = new EventEmitter() as unknown as Session;
  (session as unknown as Record<string, unknown>).chat = jest.fn(
    async (_msg: string, opts?: { stream?: boolean; onChunk?: (c: string) => void }) => {
      if (chatImpl) await chatImpl();
      else opts?.onChunk?.('ok');
      return { id: 't', timestamp: '', userMessage: '', assistantMessage: 'ok' };
    }
  );
  (session as unknown as Record<string, unknown>).getTurns = jest.fn(() => []);
  return session;
}

describe('LiveDebugger — log pattern filtering', () => {
  it('only batches lines matching logPatterns when configured', async () => {
    const chatMock = jest.fn();
    const session = makeMockLiveSession();
    (session as unknown as Record<string, unknown>).chat = chatMock;

    const dbg = new LiveDebugger({
      session,
      batchSize: 2,
      maxWaitSeconds: 60,
      logPatterns: ['ERROR'],
    });
    dbg.on('error', () => { /* swallow */ });

    const logged: string[] = [];
    dbg.on('log', (l) => logged.push(l));

    const hl = (dbg as unknown as { handleLine(l: string): void }).handleLine.bind(dbg);
    hl('INFO: server started');
    hl('ERROR: connection refused');
    hl('DEBUG: cache miss');
    hl('ERROR: timeout');

    // Only the 2 ERROR lines should be logged and should trigger flush
    await new Promise((r) => setTimeout(r, 50));
    expect(logged).toEqual(['ERROR: connection refused', 'ERROR: timeout']);
    dbg.stop();
  });

  it('only batches lines matching logLevels when configured', async () => {
    const session = makeMockLiveSession();
    const chatMock = jest.fn().mockResolvedValue(undefined);
    (session as unknown as Record<string, unknown>).chat = chatMock;

    const dbg = new LiveDebugger({
      session,
      batchSize: 3,
      maxWaitSeconds: 60,
      logLevels: ['ERROR', 'FATAL'],
    });
    dbg.on('error', () => { /* swallow */ });

    const logged: string[] = [];
    dbg.on('log', (l) => logged.push(l));

    const hl = (dbg as unknown as { handleLine(l: string): void }).handleLine.bind(dbg);
    hl('INFO: all good');
    hl('[ERROR] disk full');
    hl('[WARN] slow query');
    hl('[FATAL] process killed');

    await new Promise((r) => setTimeout(r, 20));
    expect(logged).toEqual(['[ERROR] disk full', '[FATAL] process killed']);
    dbg.stop();
  });

  it('skips the default errorKeywords gate when custom filters are active', async () => {
    const chatMock = jest.fn().mockImplementation(
      async (_: string, opts?: { onChunk?: (c: string) => void }) => {
        opts?.onChunk?.('analysis');
        return { id: 't', timestamp: '', userMessage: '', assistantMessage: 'analysis' };
      }
    );
    const session = makeMockLiveSession();
    (session as unknown as Record<string, unknown>).chat = chatMock;

    const dbg = new LiveDebugger({
      session,
      batchSize: 2,
      maxWaitSeconds: 60,
      logPatterns: ['CUSTOM'], // custom filter active
    });
    dbg.on('error', () => { /* swallow */ });

    const hl = (dbg as unknown as { handleLine(l: string): void }).handleLine.bind(dbg);
    // These lines match the pattern but contain NO error keywords
    hl('CUSTOM: metric alpha');
    hl('CUSTOM: metric beta');

    await new Promise((r) => setTimeout(r, 50));
    // AI should be called even though no error keywords present
    expect(chatMock).toHaveBeenCalled();
    dbg.stop();
  });
});

describe('LiveDebugger — retry logic', () => {
  it('retries on AI failure and succeeds on a later attempt', async () => {
    let attempt = 0;
    const chatMock = jest.fn().mockImplementation(
      async (_: string, opts?: { onChunk?: (c: string) => void }) => {
        attempt++;
        if (attempt < 2) throw new Error('transient error');
        opts?.onChunk?.('recovered');
        return { id: 't', timestamp: '', userMessage: '', assistantMessage: 'recovered' };
      }
    );
    const session = makeMockLiveSession();
    (session as unknown as Record<string, unknown>).chat = chatMock;

    const dbg = new LiveDebugger({
      session,
      batchSize: 5,
      maxWaitSeconds: 60,
      retryCount: 3,
      retryDelayMs: 10,
    });
    const errors: Error[] = [];
    dbg.on('error', (e) => errors.push(e));

    const analyses: string[] = [];
    dbg.on('analysis', (a) => analyses.push(a));

    await dbg.analyzeNow('test prompt');

    expect(errors).toHaveLength(0);
    expect(analyses[0]).toBe('recovered');
  });

  it('emits error after all retries are exhausted', async () => {
    const chatMock = jest.fn().mockRejectedValue(new Error('always fails'));
    const session = makeMockLiveSession();
    (session as unknown as Record<string, unknown>).chat = chatMock;

    const dbg = new LiveDebugger({
      session,
      batchSize: 5,
      maxWaitSeconds: 60,
      retryCount: 2,
      retryDelayMs: 5,
    });
    const errors: Error[] = [];
    dbg.on('error', (e) => errors.push(e));

    const result = await dbg.analyzeNow('test');

    expect(result).toBe('');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('always fails');
    // retryCount=2 means 3 total attempts (0 + 2 retries)
    expect(chatMock).toHaveBeenCalledTimes(3);
  });
});
