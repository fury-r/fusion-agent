import { Router, Request, Response } from 'express';
import { SessionManager } from '../../session/session-manager';
import { AutonomousVibeAgent } from '../../vibe-coder/autonomous-agent';
import { SPECKITS } from '../../speckits';
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  validateWebhookToken,
} from '../../utils/webhook-store';
import { logger } from '../../utils/logger';
import type { AutonomousConfig } from '../../vibe-coder/types';

export interface WebhookRoutesOptions {
  sessionManager: SessionManager;
  apiKey?: string;
  provider?: string;
  model?: string;
}

export function createWebhookRoutes(options: WebhookRoutesOptions): Router {
  const router = Router();

  // POST /api/webhooks — register a new webhook
  router.post('/', (req: Request, res: Response) => {
    try {
      const { name, sessionName, autonomousConfig } = req.body as {
        name?: string;
        sessionName?: string;
        autonomousConfig?: AutonomousConfig;
      };

      if (!name || !sessionName || !autonomousConfig) {
        res.status(400).json({ error: 'name, sessionName, and autonomousConfig are required' });
        return;
      }
      if (!autonomousConfig.requirementsContent && !autonomousConfig.requirementsFile) {
        res.status(400).json({
          error: 'autonomousConfig must include requirementsContent or requirementsFile',
        });
        return;
      }

      const { id, token } = createWebhook(name, sessionName, autonomousConfig);
      logger.info(`Webhook created: ${id} (${name})`);
      res.status(201).json({ id, token, note: 'Token shown once — store it securely.' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/webhooks — list all webhooks
  router.get('/', (_req: Request, res: Response) => {
    res.json({ webhooks: listWebhooks() });
  });

  // DELETE /api/webhooks/:id — remove a webhook
  router.delete('/:id', (req: Request, res: Response) => {
    const removed = deleteWebhook(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ success: true });
  });

  // POST /api/webhooks/:id/trigger — trigger autonomous run
  router.post('/:id/trigger', (req: Request, res: Response) => {
    const token = req.headers['x-webhook-token'];
    if (!token || typeof token !== 'string') {
      res.status(401).json({ error: 'X-Webhook-Token header is required' });
      return;
    }

    const config = validateWebhookToken(req.params.id, token);
    if (!config) {
      res.status(403).json({ error: 'Invalid webhook token or webhook not found' });
      return;
    }

    // Fire-and-forget the autonomous agent run
    void (async () => {
      try {
        const session = options.sessionManager.createSession(
          {
            name: `${config.sessionName}-${Date.now()}`,
            provider: options.provider || 'openai',
            model: options.model || '',
            speckit: 'vibe-coder',
            systemPrompt: SPECKITS['vibe-coder']?.systemPrompt,
          },
          options.apiKey
        );

        const agent = new AutonomousVibeAgent(session, config.autonomousConfig);
        agent.on('complete', () => {
          options.sessionManager.persistSession(session);
          logger.info(`Webhook ${config.id}: autonomous run complete for session ${session.id}`);
        });
        agent.on('error', (err: Error) => {
          logger.error(`Webhook ${config.id}: autonomous run error: ${err.message}`);
        });
        void agent.run();
      } catch (err) {
        logger.error(`Webhook ${config.id}: failed to start autonomous run: ${err}`);
      }
    })();

    res.status(202).json({ message: 'Autonomous run started', webhookId: config.id });
  });

  return router;
}
