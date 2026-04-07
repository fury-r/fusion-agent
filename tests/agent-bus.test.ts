import { AgentBus } from '../src/agent-bus/agent-bus';
import { Session } from '../src/session/session';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSession(id: string, name: string, reply = 'ok'): Session {
  return {
    id,
    name,
    chat: jest.fn().mockResolvedValue({ assistantMessage: reply }),
  } as unknown as Session;
}

// ── AgentBus ──────────────────────────────────────────────────────────────────

describe('AgentBus', () => {
  let bus: AgentBus;

  beforeEach(() => {
    bus = new AgentBus();
  });

  // ── register / unregister ───────────────────────────────────────────────────

  describe('register', () => {
    it('makes the session discoverable via list()', () => {
      const session = makeSession('id-1', 'alpha');
      bus.register(session);
      const list = bus.list();
      expect(list).toHaveLength(1);
      expect(list[0].sessionId).toBe('id-1');
      expect(list[0].sessionName).toBe('alpha');
    });

    it('emits agent:registered event with metadata', () => {
      const session = makeSession('id-2', 'beta');
      const handler = jest.fn();
      bus.on('agent:registered', handler);
      bus.register(session);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].sessionId).toBe('id-2');
    });

    it('marks the session as registered', () => {
      const session = makeSession('id-3', 'gamma');
      expect(bus.isRegistered('id-3')).toBe(false);
      bus.register(session);
      expect(bus.isRegistered('id-3')).toBe(true);
    });
  });

  describe('unregister', () => {
    it('removes the session from list()', () => {
      const session = makeSession('id-4', 'delta');
      bus.register(session);
      bus.unregister('id-4');
      expect(bus.list()).toHaveLength(0);
      expect(bus.isRegistered('id-4')).toBe(false);
    });

    it('emits agent:unregistered event', () => {
      const session = makeSession('id-5', 'epsilon');
      bus.register(session);
      const handler = jest.fn();
      bus.on('agent:unregistered', handler);
      bus.unregister('id-5');
      expect(handler).toHaveBeenCalledWith({ sessionId: 'id-5' });
    });

    it('is a no-op when the session is not registered', () => {
      expect(() => bus.unregister('ghost')).not.toThrow();
    });
  });

  // ── send ────────────────────────────────────────────────────────────────────

  describe('send', () => {
    it('routes a message to the target session and returns the reply', async () => {
      const target = makeSession('target-1', 'target', 'Hello from target!');
      bus.register(target);
      const reply = await bus.send('sender-1', 'target-1', 'Hi!');
      expect(reply).toBe('Hello from target!');
      expect(target.chat).toHaveBeenCalledWith(
        expect.stringContaining('Hi!'),
        expect.any(Object)
      );
    });

    it('throws when the target session is not registered', async () => {
      await expect(bus.send('a', 'nonexistent', 'hello')).rejects.toThrow(
        /not registered/
      );
    });

    it('emits agent:message event with from/to/reply', async () => {
      const target = makeSession('t-2', 'tgt', 'reply-text');
      bus.register(target);
      const handler = jest.fn();
      bus.on('agent:message', handler);
      await bus.send('sender-2', 't-2', 'ping');
      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.fromSessionId).toBe('sender-2');
      expect(event.toSessionId).toBe('t-2');
      expect(event.reply).toBe('reply-text');
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when no sessions are registered', () => {
      expect(bus.list()).toEqual([]);
    });

    it('returns metadata for all registered sessions', () => {
      bus.register(makeSession('a', 'session-a'));
      bus.register(makeSession('b', 'session-b'));
      const ids = bus.list().map((i) => i.sessionId);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });
  });
});
