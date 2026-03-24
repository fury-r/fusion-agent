import fs from 'fs';
import path from 'path';
import { Session, SessionConfig, SessionData } from './session';
import { createProvider, ProviderName } from '../providers';
import { logger } from '../utils/logger';

export class SessionManager {
  readonly sessionsDir: string;
  private sessions: Map<string, Session> = new Map();

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
  }

  createSession(
    config: SessionConfig,
    apiKey?: string
  ): Session {
    const provider = createProvider({
      provider: config.provider as ProviderName,
      model: config.model,
      apiKey,
    });
    const session = new Session(provider, config);
    this.sessions.set(session.id, session);
    this.persistSession(session);
    logger.info(`Created session: ${session.name} (${session.id})`);
    return session;
  }

  loadSession(sessionId: string, apiKey?: string): Session {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const filePath = this.getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const data: SessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const provider = createProvider({
      provider: data.config.provider as ProviderName,
      model: data.config.model,
      apiKey,
    });
    const session = new Session(provider, data.config, data);
    this.sessions.set(session.id, session);
    return session;
  }

  persistSession(session: Session): void {
    const filePath = this.getSessionPath(session.id);
    fs.writeFileSync(filePath, JSON.stringify(session.toJSON(), null, 2), 'utf-8');
  }

  listSessions(): SessionData[] {
    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
    const sessions: SessionData[] = [];
    for (const file of files) {
      try {
        const data: SessionData = JSON.parse(
          fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8')
        );
        sessions.push(data);
      } catch {
        logger.warn(`Could not read session file: ${file}`);
      }
    }
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  deleteSession(sessionId: string): void {
    const filePath = this.getSessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.sessions.delete(sessionId);
    logger.info(`Deleted session: ${sessionId}`);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  exportSession(sessionId: string): string {
    // Always read from disk so callers get the latest persisted state,
    // even if the session was written by an external process (e.g. the CLI
    // live debugger running alongside the Web UI).
    const filePath = this.getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}
