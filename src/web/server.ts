import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { SessionManager } from '../session/session-manager';
import { createSessionRoutes } from './routes/sessions';
import { createSettingsRoutes } from './routes/settings';
import { logger } from '../utils/logger';

export interface WebServerOptions {
  port?: number;
  sessionManager: SessionManager;
  apiKey?: string;
  provider?: string;
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

  // API routes
  app.use('/api/sessions', createSessionRoutes(options.sessionManager));
  app.use('/api/settings', createSettingsRoutes());

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
