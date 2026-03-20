import { Router, Request, Response } from 'express';
import { loadConfig, saveConfig } from '../../utils/config';

export function createSettingsRoutes(): Router {
  const router = Router();

  // GET /api/settings
  router.get('/', (_req: Request, res: Response) => {
    try {
      const config = loadConfig();
      // Redact API key
      const { apiKey: _apiKey, ...safeConfig } = config;
      res.json(safeConfig);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/settings — update settings
  router.post('/', (req: Request, res: Response) => {
    try {
      const { provider, model, port, logLevel } = req.body as {
        provider?: string;
        model?: string;
        port?: number;
        logLevel?: string;
      };
      saveConfig({ provider: provider as 'openai' | 'anthropic' | 'gemini', model, port, logLevel });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
