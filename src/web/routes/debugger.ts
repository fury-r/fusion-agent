import { Router, Request, Response } from 'express';
import { SessionManager } from '../../session/session-manager';
import { JiraClient } from '../../integrations/jira';
import { GitPatchApplier } from '../../integrations/git';
import { extractFileBlocks } from '../../vibe-coder/file-parser';
import { logger } from '../../utils/logger';

/**
 * REST endpoints for Live Debugger actions (Jira tickets, Git fixes).
 *
 * POST /api/debugger/:sessionId/jira
 *   Body: { jiraConfig, turnId?, summary?, priority? }
 *   Creates a Jira issue from the debugger turn analysis.
 *
 * POST /api/debugger/:sessionId/git-fix
 *   Body: { gitConfig, turnId?, commitMessage?, prTitle? }
 *   Applies AI-proposed code changes from the debugger turn to a git repo.
 */
export function createDebuggerRoutes(sessionManager: SessionManager): Router {
  const router = Router();

  // ── POST /api/debugger/:sessionId/jira ────────────────────────────────────
  router.post('/:sessionId/jira', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const {
        jiraConfig,
        turnId,
        summary: customSummary,
        priority,
        labels,
      } = req.body as {
        jiraConfig: import('../../integrations/jira').JiraConfig;
        turnId?: string;
        summary?: string;
        priority?: string;
        labels?: string[];
      };

      if (!jiraConfig?.baseUrl || !jiraConfig?.email || !jiraConfig?.apiToken || !jiraConfig?.projectKey) {
        res.status(400).json({ error: 'jiraConfig.baseUrl, .email, .apiToken and .projectKey are required' });
        return;
      }

      const sessionData = JSON.parse(sessionManager.exportSession(sessionId)) as {
        turns: Array<{ id: string; userMessage: string; assistantMessage: string; debuggerMeta?: { matchedLogLines?: string[]; promptSentAt?: string } }>;
        name: string;
      };

      // Pick the specified turn or the latest one
      const turn = turnId
        ? sessionData.turns.find((t) => t.id === turnId)
        : sessionData.turns[sessionData.turns.length - 1];

      if (!turn) {
        res.status(404).json({ error: 'Turn not found' });
        return;
      }

      const summary =
        customSummary ||
        `[Live Debugger] ${sessionData.name}: ${turn.assistantMessage.slice(0, 120).replace(/\n/g, ' ')}…`;

      const description =
        `**Session:** ${sessionData.name}\n` +
        `**Turn ID:** ${turn.id}\n` +
        (turn.debuggerMeta?.promptSentAt
          ? `**Detected at:** ${turn.debuggerMeta.promptSentAt}\n`
          : '') +
        `\n**Matched log lines:**\n${(turn.debuggerMeta?.matchedLogLines ?? []).slice(0, 20).join('\n')}\n` +
        `\n**AI Analysis:**\n${turn.assistantMessage}`;

      const client = new JiraClient(jiraConfig);
      const result = await client.createIssue({ summary, description, priority, labels });

      // Persist the Jira key on the turn's debuggerMeta
      try {
        const session = sessionManager.loadSession(sessionId);
        const liveTurn = session.getTurns().find((t) => t.id === turn.id);
        if (liveTurn) {
          if (!liveTurn.debuggerMeta) {
            liveTurn.debuggerMeta = {
              matchedLogLines: turn.debuggerMeta?.matchedLogLines ?? [],
              promptSentAt: turn.debuggerMeta?.promptSentAt ?? new Date().toISOString(),
              responseReceivedAt: new Date().toISOString(),
              notificationSent: false,
              fixApplied: false,
            };
          }
          liveTurn.debuggerMeta.jiraKey = result.key;
        }
        sessionManager.persistSession(session);
      } catch (persistErr) {
        logger.warn(`Could not persist jiraKey to session: ${persistErr}`);
      }

      res.json(result);
    } catch (err) {
      logger.error(`Debugger Jira route error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/debugger/:sessionId/git-fix ────────────────────────────────
  router.post('/:sessionId/git-fix', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const {
        gitConfig,
        turnId,
        commitMessage: customMessage,
        prTitle,
        prBody,
        baseBranch,
      } = req.body as {
        gitConfig: import('../../integrations/git').GitConfig;
        turnId?: string;
        commitMessage?: string;
        prTitle?: string;
        prBody?: string;
        baseBranch?: string;
      };

      if (!gitConfig?.repoPath) {
        res.status(400).json({ error: 'gitConfig.repoPath is required' });
        return;
      }

      const sessionData = JSON.parse(sessionManager.exportSession(sessionId)) as {
        turns: Array<{ id: string; assistantMessage: string; debuggerMeta?: { matchedLogLines?: string[] } }>;
        name: string;
      };

      const turn = turnId
        ? sessionData.turns.find((t) => t.id === turnId)
        : sessionData.turns[sessionData.turns.length - 1];

      if (!turn) {
        res.status(404).json({ error: 'Turn not found' });
        return;
      }

      // Extract file blocks from the AI analysis
      const blocks = extractFileBlocks(turn.assistantMessage);
      if (blocks.length === 0) {
        res.status(422).json({ error: 'No file code blocks found in the AI analysis for this turn' });
        return;
      }

      const files: Record<string, string> = {};
      for (const block of blocks) {
        files[block.filePath] = block.content;
      }

      const patcher = new GitPatchApplier(gitConfig);
      const result = await patcher.applyAndCommit({
        files,
        commitMessage: customMessage ?? `fix: apply AI-suggested fix from live debugger (session ${sessionId})`,
        pullRequestTitle: prTitle,
        pullRequestBody: prBody,
        baseBranch,
      });

      // Persist the fix URL on the turn's debuggerMeta
      try {
        const session = sessionManager.loadSession(sessionId);
        const liveTurn = session.getTurns().find((t) => t.id === turn.id);
        if (liveTurn) {
          if (!liveTurn.debuggerMeta) {
            liveTurn.debuggerMeta = {
              matchedLogLines: turn.debuggerMeta?.matchedLogLines ?? [],
              promptSentAt: new Date().toISOString(),
              responseReceivedAt: new Date().toISOString(),
              notificationSent: false,
              fixApplied: true,
            };
          }
          liveTurn.debuggerMeta.fixApplied = true;
          liveTurn.debuggerMeta.gitFixUrl = result.pullRequestUrl ?? result.commitSha;
        }
        sessionManager.persistSession(session);
      } catch (persistErr) {
        logger.warn(`Could not persist gitFixUrl to session: ${persistErr}`);
      }

      res.json(result);
    } catch (err) {
      logger.error(`Debugger Git-fix route error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
