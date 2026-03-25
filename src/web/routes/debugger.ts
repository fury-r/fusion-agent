import { Router, Request, Response } from 'express';
import { SessionManager } from '../../session/session-manager';
import { JiraClient } from '../../integrations/jira';
import { GitPatchApplier, GitHubClient } from '../../integrations/git';
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
 * POST /api/debugger/:sessionId/copilot-issue
 *   Body: { githubConfig, turnId?, title?, body?, labels? }
 *   Creates a GitHub issue from a debugger turn and assigns it to the Copilot
 *   coding agent so it autonomously attempts a fix.
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

      // Guard: refuse to apply a git fix when the session delegates fixes to Copilot
      const liveSession = sessionManager.loadSession(sessionId);
      if (liveSession.config.github?.autoAssignCopilot) {
        res.status(409).json({
          error:
            'This session has autoAssignCopilot enabled. The live debugger delegates fixes to the GitHub Copilot coding agent. ' +
            'Disable autoAssignCopilot or use the copilot-issue endpoint instead.',
        });
        return;
      }

      const sessionData = JSON.parse(sessionManager.exportSession(sessionId)) as {
        turns: Array<{ id: string; assistantMessage: string; debuggerMeta?: { matchedLogLines?: string[]; copilotIssueUrl?: string } }>;
        name: string;
      };

      const turn = turnId
        ? sessionData.turns.find((t) => t.id === turnId)
        : sessionData.turns[sessionData.turns.length - 1];

      if (!turn) {
        res.status(404).json({ error: 'Turn not found' });
        return;
      }

      // Guard: refuse if a Copilot issue was already created for this specific turn
      if (turn.debuggerMeta?.copilotIssueUrl) {
        res.status(409).json({
          error:
            `A Copilot issue has already been filed for this turn (${turn.debuggerMeta.copilotIssueUrl}). ` +
            'Applying a git fix on top would create competing pull requests.',
        });
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
        const liveTurn = liveSession.getTurns().find((t) => t.id === turn.id);
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
        sessionManager.persistSession(liveSession);
      } catch (persistErr) {
        logger.warn(`Could not persist gitFixUrl to session: ${persistErr}`);
      }

      res.json(result);
    } catch (err) {
      logger.error(`Debugger Git-fix route error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/debugger/:sessionId/copilot-issue ───────────────────────────
  router.post('/:sessionId/copilot-issue', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const {
        githubConfig,
        turnId,
        title: customTitle,
        body: customBody,
        labels,
        bypassGuardrails,
      } = req.body as {
        githubConfig: import('../../integrations/git').GitHubConfig;
        turnId?: string;
        title?: string;
        body?: string;
        labels?: string[];
        bypassGuardrails?: boolean;
      };

      if (!githubConfig?.token || !githubConfig?.repoUrl) {
        res.status(400).json({ error: 'githubConfig.token and githubConfig.repoUrl are required' });
        return;
      }

      const sessionData = JSON.parse(sessionManager.exportSession(sessionId)) as {
        turns: Array<{ id: string; assistantMessage: string; userMessage: string; debuggerMeta?: { matchedLogLines?: string[]; promptSentAt?: string } }>;
        name: string;
      };

      const turn = turnId
        ? sessionData.turns.find((t) => t.id === turnId)
        : sessionData.turns[sessionData.turns.length - 1];

      if (!turn) {
        res.status(404).json({ error: 'Turn not found' });
        return;
      }

      const firstLine = turn.assistantMessage.split('\n')[0].replace(/^#+\s*/, '').slice(0, 140);
      const title = customTitle || `[Live Debugger] ${sessionData.name}: ${firstLine}`;
      const body =
        customBody ||
        `## Live Debugger Analysis\n\n` +
        `**Session:** ${sessionData.name}  \n` +
        `**Detected:** ${turn.debuggerMeta?.promptSentAt ?? new Date().toISOString()}\n\n` +
        `### Matched Log Lines\n\`\`\`\n${(turn.debuggerMeta?.matchedLogLines ?? []).slice(0, 30).join('\n')}\n\`\`\`\n\n` +
        `### AI Analysis\n${turn.assistantMessage}`;
      const issueLabels = labels ?? [];

      const client = new GitHubClient(githubConfig);

      // Evaluate guardrails unless the caller explicitly bypasses them
      if (!bypassGuardrails) {
        const violation = client.checkCopilotGuardrails(title, body, issueLabels);
        if (violation) {
          res.status(422).json({ error: `Guardrail violation: ${violation}`, violation });
          return;
        }
      }

      const result = await client.createIssueForCopilot(title, body, issueLabels);
      logger.info(`Copilot issue created: ${result.issueUrl}`);

      // Persist the issue URL on the turn's debuggerMeta
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
          liveTurn.debuggerMeta.copilotIssueUrl = result.issueUrl;
        }
        sessionManager.persistSession(session);
      } catch (persistErr) {
        logger.warn(`Could not persist copilotIssueUrl to session: ${persistErr}`);
      }

      res.json(result);
    } catch (err) {
      logger.error(`Debugger copilot-issue route error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
