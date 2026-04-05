import { EventEmitter } from 'events';
import { Session } from '../session/session';
import { logger } from '../utils/logger';

export interface AgentInfo {
  sessionId: string;
  sessionName: string;
  registeredAt: string;
}

/**
 * In-process agent-to-agent message bus.
 *
 * Agents (AutonomousVibeAgent or interactive sessions) register themselves
 * when they start and unregister when they stop.  Any registered agent can
 * send a message to any other registered agent; the reply is the AI assistant's
 * response to that message.
 *
 * This is an in-memory-only singleton — all sessions must be running in the
 * same Node.js process.
 */
export class AgentBus extends EventEmitter {
  private readonly agents = new Map<string, Session>();
  private readonly metadata = new Map<string, AgentInfo>();

  /** Register a session so other agents can route messages to it. */
  register(session: Session): void {
    this.agents.set(session.id, session);
    this.metadata.set(session.id, {
      sessionId: session.id,
      sessionName: session.name,
      registeredAt: new Date().toISOString(),
    });
    logger.debug(`AgentBus: registered session ${session.id} (${session.name})`);
    this.emit('agent:registered', this.metadata.get(session.id));
  }

  /** Unregister a session. Safe to call after it has already been removed. */
  unregister(sessionId: string): void {
    this.agents.delete(sessionId);
    this.metadata.delete(sessionId);
    logger.debug(`AgentBus: unregistered session ${sessionId}`);
    this.emit('agent:unregistered', { sessionId });
  }

  /**
   * Send a message from one session to another.
   * Returns the AI assistant's reply.
   * Throws if the target session is not registered.
   */
  async send(fromSessionId: string, toSessionId: string, message: string): Promise<string> {
    const target = this.agents.get(toSessionId);
    if (!target) {
      throw new Error(
        `AgentBus: target session "${toSessionId}" is not registered. ` +
        `Available: [${[...this.agents.keys()].join(', ')}]`
      );
    }

    logger.info(`AgentBus: ${fromSessionId} → ${toSessionId}: ${message.slice(0, 80)}`);

    const turn = await target.chat(
      `[Agent message from ${fromSessionId}]: ${message}`,
      { stream: false }
    );

    this.emit('agent:message', {
      fromSessionId,
      toSessionId,
      message,
      reply: turn.assistantMessage,
      timestamp: new Date().toISOString(),
    });

    return turn.assistantMessage;
  }

  /** List all currently registered agents. */
  list(): AgentInfo[] {
    return [...this.metadata.values()];
  }

  /** Return true if a session is currently registered. */
  isRegistered(sessionId: string): boolean {
    return this.agents.has(sessionId);
  }
}

/** Singleton bus shared across the entire process. */
export const agentBus = new AgentBus();
