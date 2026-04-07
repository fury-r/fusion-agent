import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { SessionManager } from '../session/session-manager';
import { createSessionRoutes } from './routes/sessions';
import { createSettingsRoutes } from './routes/settings';
import { createVibeCoderRoutes, registerVibeCoderSocket } from './routes/vibe-coder';
import { createDebuggerRoutes } from './routes/debugger';
import { createWebhookRoutes } from './routes/webhooks';
import { createCronRoutes } from './routes/cron';
import { CronManager } from '../cron/cron-manager';
import { agentBus } from '../agent-bus/agent-bus';
import { listSkills } from '../skills/registry';
import { logger } from '../utils/logger';

export interface WebServerOptions {
  port?: number;
  sessionManager: SessionManager;
  apiKey?: string;
  provider?: string;
  /** Default AI model for new vibe-coder sessions (falls back to provider default). */
  model?: string;
  /** Default project directory for new vibe-coder sessions (falls back to process.cwd()). */
  projectDir?: string;
}

export function createWebServer(options: WebServerOptions) {
  const port = options.port ?? 3000;
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Apply rate limiting to all routes (200 req/min per IP)
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
  app.use(globalLimiter);

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  const vibeCoderOptions = {
    sessionManager: options.sessionManager,
    apiKey: options.apiKey,
    provider: options.provider,
    model: options.model,
    projectDir: options.projectDir,
  };

  // API routes
  app.use('/api/sessions', createSessionRoutes(options.sessionManager));
  app.use('/api/settings', createSettingsRoutes());
  app.use('/api/vibe-coder', createVibeCoderRoutes(options.sessionManager, vibeCoderOptions));
  app.use('/api/debugger', createDebuggerRoutes(options.sessionManager));

  // Webhooks
  const webhookOptions = {
    sessionManager: options.sessionManager,
    apiKey: options.apiKey,
    provider: options.provider,
    model: options.model,
  };
  app.use('/api/webhooks', createWebhookRoutes(webhookOptions));

  // Cron
  const cronManager = new CronManager(options.sessionManager, {
    apiKey: options.apiKey,
    provider: options.provider,
    model: options.model,
  });
  cronManager.restoreJobs();
  app.use('/api/cron', createCronRoutes(cronManager));

  // Skills list (read-only)
  app.get('/api/skills', (_req, res) => {
    res.json({ skills: listSkills() });
  });

  // Agents list (active sessions registered on the bus)
  app.get('/api/agents', (_req, res) => {
    res.json({ agents: agentBus.list() });
  });

  // Agent-to-agent message (external trigger)
  app.post('/api/agents/:id/message', async (req, res) => {
    const { message, fromSessionId } = req.body as { message?: string; fromSessionId?: string };
    if (!message) {
      res.status(400).json({ error: '"message" is required' });
      return;
    }
    try {
      const reply = await agentBus.send(fromSessionId || 'external', req.params.id, message);
      res.json({ reply });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // Catch-all: serve index.html for SPA-style navigation
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Socket.IO for real-time updates
  io.on('connection', (socket) => {
    logger.debug(`Web UI client connected: ${socket.id}`);

    socket.on('subscribe:session', (sessionId: string) => {
      void socket.join(`session:${sessionId}`);
      logger.debug(`Client ${socket.id} subscribed to session ${sessionId}`);
    });

    socket.on('unsubscribe:session', (sessionId: string) => {
      void socket.leave(`session:${sessionId}`);
    });

    // Live Debugger: subscribe to real-time log and analysis events
    socket.on('subscribe:debugger', (sessionId: string) => {
      void socket.join(`debugger:${sessionId}`);
      logger.debug(`Client ${socket.id} subscribed to debugger session ${sessionId}`);
    });

    socket.on('unsubscribe:debugger', (sessionId: string) => {
      void socket.leave(`debugger:${sessionId}`);
    });

    // Vibe Coder: interactive chat + autonomous mode
    registerVibeCoderSocket(socket, vibeCoderOptions);

    socket.on('disconnect', () => {
      logger.debug(`Web UI client disconnected: ${socket.id}`);
    });
  });

  // Forward agent-bus events to all connected Socket.IO clients
  agentBus.on('agent:message', (data: unknown) => {
    io.emit('agent:message', data);
  });
  agentBus.on('agent:registered', (data: unknown) => {
    io.emit('agent:registered', data);
  });
  agentBus.on('agent:unregistered', (data: unknown) => {
    io.emit('agent:unregistered', data);
  });

  function watchSessionsDir(): void {
    const sessionsDir = options.sessionManager.sessionsDir;
    if (!fs.existsSync(sessionsDir)) return;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    try {
      fs.watch(sessionsDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        const sessionId = filename.replace(/\.json$/, '');
        const existing = debounceTimers.get(sessionId);
        if (existing) clearTimeout(existing);
        debounceTimers.set(sessionId, setTimeout(() => {
          debounceTimers.delete(sessionId);
          io.to(`session:${sessionId}`).emit('session:updated', { sessionId });
          logger.debug(`session:updated emitted for ${sessionId}`);
        }, 300));
      });
      logger.debug(`Watching sessions directory for changes: ${sessionsDir}`);
    } catch (err) {
      logger.warn(`Could not watch sessions directory: ${err}`);
    }
  }

  function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(port, () => {
        logger.info(`AI Agent Web UI running at http://localhost:${port}`);
        watchSessionsDir();
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { app, io, httpServer, start, stop };
}
