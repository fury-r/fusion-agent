import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { SessionManager } from '../session/session-manager';
import { createSessionRoutes } from './routes/sessions';
import { createSettingsRoutes } from './routes/settings';
import { createVibeCoderRoutes, registerVibeCoderSocket } from './routes/vibe-coder';
import { createDebuggerRoutes } from './routes/debugger';
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

  function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(port, () => {
        logger.info(`AI Agent Web UI running at http://localhost:${port}`);
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
