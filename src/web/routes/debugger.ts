import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { SessionManager } from '../../session/session-manager';
import { JiraClient } from '../../integrations/jira';
import { GitPatchApplier, GitHubClient, GitHubPatcher } from '../../integrations/git';
import { extractFileBlocks } from '../../vibe-coder/file-parser';
import { logger } from '../../utils/logger';

/**
 * Fallback parser: extract plain ``` code blocks when the AI didn't use the
 * `language:filepath` convention. Infers the filename from:
 *  1. A preceding heading line containing a path-like token, e.g.
 *     `#### Fixed Code (src/services/foo.ts)` or `### src/services/foo.ts`
 *  2. The first comment line inside the block: `// src/path/to/file.ts`
 *  3. If nothing matches, labels the block "fix-N.txt"
 */
function extractFallbackBlocks(text: string): Array<{ filePath: string; content: string }> {
  const results: Array<{ filePath: string; content: string }> = [];
  // Split into segments around ``` fences so we can look at the text before each block
  const parts = text.split(/(```[\w.+-]*\n[\s\S]*?```)/g);
  let blockIndex = 0;

  for (let i = 0; i < parts.length; i++) {
    const fenceMatch = parts[i].match(/^```[\w.+-]*\n([\s\S]*?)```$/);
    if (!fenceMatch) continue;

    const content = fenceMatch[1];
    blockIndex++;

    // Look for a path-like token in the preceding ~3 lines of surrounding text
    let filePath = '';
    const preceding = parts[i - 1] ?? '';
    const precedingLines = preceding.split('\n').slice(-4);

    for (const line of precedingLines.reverse()) {
      // Match something that looks like a file path: contains / or . with an extension
      const pathMatch = line.match(/([`'"]?)([\w./\\-]+\.\w{1,10})\1/);
      if (pathMatch) {
        filePath = pathMatch[2].replace(/^[`'"]+|[`'"]+$/g, '');
        break;
      }
    }

    // Also check first comment line inside the block
    if (!filePath) {
      const firstLine = content.split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:\/\/|#|--)\s*([\w./\\-]+\.\w{1,10})/);
      if (commentMatch) filePath = commentMatch[1];
    }

    if (!filePath) filePath = `fix-${blockIndex}.txt`;

    results.push({ filePath, content });
  }

  return results;
}

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

  // ── POST /api/debugger/:sessionId/preview-git-fix ────────────────────────
  // Returns the file blocks parsed from the AI analysis plus, when repoPath is
  // supplied, the current on-disk content so the UI can render a before/after diff.
  router.post('/:sessionId/preview-git-fix', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { turnId, repoPath } = req.body as { turnId?: string; repoPath?: string };

      const sessionData = JSON.parse(sessionManager.exportSession(sessionId)) as {
        turns: Array<{ id: string; assistantMessage: string }>;
      };

      const turn = turnId
        ? sessionData.turns.find((t) => t.id === turnId)
        : sessionData.turns[sessionData.turns.length - 1];

      if (!turn) {
        res.status(404).json({ error: 'Turn not found' });
        return;
      }

      const blocks = extractFileBlocks(turn.assistantMessage);

      // Fallback: also parse plain ``` code blocks and attempt to infer a
      // filename from a preceding heading or comment line like:
      //   #### Fixed Code (`src/foo/bar.ts`) or  // src/foo/bar.ts
      const fallbackBlocks = blocks.length === 0
        ? extractFallbackBlocks(turn.assistantMessage)
        : [];

      const allBlocks = [...blocks, ...fallbackBlocks];
      if (allBlocks.length === 0) {
        res.status(422).json({ error: 'No file code blocks found in the AI analysis for this turn' });
        return;
      }

      const changes = allBlocks.map((block) => {
        let before: string | null = null;
        if (repoPath) {
          try {
            const abs = path.resolve(repoPath, block.filePath);
            // Guard against path traversal
            const resolved = path.resolve(repoPath);
            if (abs.startsWith(resolved + path.sep) || abs === resolved) {
              before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
            }
          } catch {
            before = null;
          }
        }
        return {
          filePath: block.filePath,
          before,          // null = new file
          after: block.content,
        };
      });

      res.json({ changes });
    } catch (err) {
      logger.error(`Debugger preview-git-fix route error: ${err}`);
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

      if (!gitConfig?.repoPath && !(gitConfig?.token && gitConfig?.remoteUrl)) {
        res.status(400).json({ error: 'Either gitConfig.repoPath (local) or gitConfig.token + gitConfig.remoteUrl (GitHub API) is required' });
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

      // Use GitHub API patcher when token + remoteUrl are available (no local git needed).
      // Fall back to local GitPatchApplier only when repoPath is given without a token.
      let result: import('../../integrations/git').GitPatchResult;
      if (gitConfig.token && gitConfig.remoteUrl) {
        const patcher = new GitHubPatcher(gitConfig);
        result = await patcher.applyAndCommit({
          files,
          commitMessage: customMessage ?? `fix: apply AI-suggested fix from live debugger (session ${sessionId})`,
          pullRequestTitle: prTitle,
          pullRequestBody: prBody,
          baseBranch,
        });
      } else {
        const patcher = new GitPatchApplier(gitConfig);
        result = await patcher.applyAndCommit({
          files,
          commitMessage: customMessage ?? `fix: apply AI-suggested fix from live debugger (session ${sessionId})`,
          pullRequestTitle: prTitle,
          pullRequestBody: prBody,
          baseBranch,
        });
      }

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

      const effectiveGithubConfig = {
        ...(githubConfig ?? {}),
        token: githubConfig?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
        repoUrl: githubConfig?.repoUrl || process.env.GITHUB_REPO_URL || process.env.REPO_URL,
        assignee:
          githubConfig?.assignee || process.env.GITHUB_COPILOT_ASSIGNEE || process.env.COPILOT_ASSIGNEE,
      };

      if (!effectiveGithubConfig.token || !effectiveGithubConfig.repoUrl) {
        res.status(400).json({
          error:
            'githubConfig.token and githubConfig.repoUrl are required (or set GITHUB_TOKEN and GITHUB_REPO_URL in environment)',
        });
        return;
      }

      const resolvedGithubConfig = effectiveGithubConfig as import('../../integrations/git').GitHubConfig;

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

      const client = new GitHubClient(resolvedGithubConfig);

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
      const message = err instanceof Error ? err.message : String(err);
      const ghMatch = message.match(/GitHub API error\s+(\d{3}):\s*(.+)$/i);
      if (ghMatch) {
        const statusCode = Number(ghMatch[1]);
        const ghMessage = ghMatch[2];
        if (statusCode === 403) {
          res.status(403).json({
            error:
              'GitHub token cannot perform this action. Ensure the token has repository Issues write access (or classic repo scope) for the target repository.',
            githubMessage: ghMessage,
          });
          return;
        }
        if (statusCode === 404) {
          res.status(404).json({
            error:
              'GitHub repository was not found for this token. Verify githubConfig.repoUrl / GITHUB_REPO_URL and token repository access.',
            githubMessage: ghMessage,
          });
          return;
        }
        res.status(Math.min(Math.max(statusCode, 400), 502)).json({
          error: `GitHub API error ${statusCode}`,
          githubMessage: ghMessage,
        });
        return;
      }

      res.status(500).json({ error: message });
    }
  });

  return router;
}
