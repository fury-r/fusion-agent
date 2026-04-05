import { Router, Request, Response } from 'express';
import { CronManager } from '../../cron/cron-manager';
import type { AutonomousConfig } from '../../vibe-coder/types';

export function createCronRoutes(cronManager: CronManager): Router {
  const router = Router();

  // GET /api/cron — list all jobs
  router.get('/', (_req: Request, res: Response) => {
    res.json({ jobs: cronManager.listJobs() });
  });

  // POST /api/cron — create a new job
  router.post('/', (req: Request, res: Response) => {
    try {
      const { name, schedule, sessionName, autonomousConfig } = req.body as {
        name?: string;
        schedule?: string;
        sessionName?: string;
        autonomousConfig?: AutonomousConfig;
      };

      if (!name || !schedule || !sessionName || !autonomousConfig) {
        res.status(400).json({
          error: 'name, schedule, sessionName, and autonomousConfig are required',
        });
        return;
      }
      if (!autonomousConfig.requirementsContent && !autonomousConfig.requirementsFile) {
        res.status(400).json({
          error: 'autonomousConfig must include requirementsContent or requirementsFile',
        });
        return;
      }

      const job = cronManager.addJob(name, schedule, sessionName, autonomousConfig);
      res.status(201).json(job);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // DELETE /api/cron/:id — remove a job
  router.delete('/:id', (req: Request, res: Response) => {
    const removed = cronManager.removeJob(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    res.json({ success: true });
  });

  // PATCH /api/cron/:id — enable or disable a job
  router.patch('/:id', (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: '"enabled" (boolean) is required' });
      return;
    }
    const ok = cronManager.setEnabled(req.params.id, enabled);
    if (!ok) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    res.json({ success: true, enabled });
  });

  return router;
}
