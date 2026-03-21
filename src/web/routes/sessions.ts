import { Router, Request, Response } from 'express';
import { SessionManager } from '../../session/session-manager';

export function createSessionRoutes(sessionManager: SessionManager): Router {
  const router = Router();

  // GET /api/sessions — list all sessions
  router.get('/', (_req: Request, res: Response) => {
    try {
      const sessions = sessionManager.listSessions();
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id — get session details
  router.get('/:id', (req: Request, res: Response) => {
    try {
      const data = sessionManager.exportSession(req.params.id);
      res.json(JSON.parse(data));
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // DELETE /api/sessions/:id — delete session
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      sessionManager.deleteSession(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id/export — export session as JSON download
  router.get('/:id/export', (req: Request, res: Response) => {
    try {
      const data = sessionManager.exportSession(req.params.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}.json"`);
      res.send(data);
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  return router;
}
