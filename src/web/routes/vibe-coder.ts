import { Router, Request, Response } from 'express';
import { Socket } from 'socket.io';
import path from 'path';
import { SessionManager } from '../../session/session-manager';
import { SPECKITS } from '../../speckits';
import { gatherProjectContext } from '../../utils/file-ops';
import { logger } from '../../utils/logger';
import {
  AutonomousVibeAgent,
  extractFileBlocks,
} from '../../vibe-coder';
import type { AutonomousConfig, HILRequest } from '../../vibe-coder';

export interface VibeCoderSocketOptions {
  sessionManager: SessionManager;
  apiKey?: string;
  provider?: string;
  model?: string;
  projectDir?: string;
}

/**
 * Register all Vibe Coder socket handlers on a single connected socket.
 * Called once per client connection from server.ts.
 *
 * Socket events handled:
 *   vibe:start              — create or resume a vibe-coder session
 *   vibe:chat               — interactive chat turn (streaming)
 *   vibe:inject-context     — inject project directory structure
 *   vibe:start-autonomous   — start an autonomous run
 *   vibe:hil-response       — deliver user guidance to a waiting agent
 *   vibe:stop-autonomous    — abort a running autonomous agent
 *
 * Events emitted to client:
 *   vibe:ready              — session created/loaded
 *   vibe:chunk              — streaming token (both modes)
 *   vibe:file-changed       — a file was written
 *   vibe:turn-complete      — interactive turn finished
 *   vibe:step-complete      — autonomous step finished
 *   vibe:autonomous-status  — agent status changed
 *   vibe:hil-request        — agent needs human guidance
 *   vibe:autonomous-complete — autonomous run finished
 *   vibe:error              — error in any operation
 */
export function registerVibeCoderSocket(
  socket: Socket,
  options: VibeCoderSocketOptions
): void {
  const { sessionManager, apiKey, provider, model, projectDir: defaultProjectDir } = options;

  // Active autonomous agents keyed by sessionId; cleaned up on completion/stop/disconnect
  const agents = new Map<string, AutonomousVibeAgent>();

  // ── vibe:start ────────────────────────────────────────────────────────────
  socket.on(
    'vibe:start',
    (data: { sessionId?: string; sessionName?: string; projectDir?: string }) => {
      try {
        const projectDir = data.projectDir || defaultProjectDir || process.cwd();
        let session;
        if (data.sessionId) {
          try {
            session = sessionManager.loadSession(data.sessionId, apiKey);
          } catch {
            /* not found — fall through to create */
          }
        }
        if (!session) {
          session = sessionManager.createSession(
            {
              name: data.sessionName || `vibe-${Date.now()}`,
              provider: provider || 'openai',
              model: model || '',
              speckit: 'vibe-coder',
              systemPrompt: SPECKITS['vibe-coder']?.systemPrompt,
              projectDir,
            },
            apiKey
          );
        }
        void socket.join(`vibe:${session.id}`);
        socket.emit('vibe:ready', session.toJSON());
      } catch (err) {
        socket.emit('vibe:error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // ── vibe:chat (interactive) ───────────────────────────────────────────────
  socket.on('vibe:chat', (data: { sessionId: string; message: string }) => {
    void (async () => {
      try {
        const session =
          sessionManager.getSession(data.sessionId) ||
          sessionManager.loadSession(data.sessionId, apiKey);
        const projectDir =
          session.config.projectDir || defaultProjectDir || process.cwd();

        let fullResponse = '';
        const turn = await session.chat(data.message, {
          stream: true,
          onChunk: (chunk) => {
            fullResponse += chunk;
            socket.emit('vibe:chunk', { sessionId: data.sessionId, chunk });
          },
        });

        // Parse and apply file changes from the response
        const blocks = extractFileBlocks(fullResponse);
        const appliedFiles: string[] = [];
        for (const block of blocks) {
          try {
            const absPath = path.isAbsolute(block.filePath)
              ? block.filePath
              : path.resolve(projectDir, block.filePath);
            session.applyFileChange(absPath, block.content);
            appliedFiles.push(block.filePath);
            socket.emit('vibe:file-changed', {
              sessionId: data.sessionId,
              filePath: block.filePath,
            });
          } catch (err) {
            logger.warn(
              `Could not apply file change "${block.filePath}": ${err}`
            );
          }
        }

        sessionManager.persistSession(session);
        socket.emit('vibe:turn-complete', {
          sessionId: data.sessionId,
          turn,
          appliedFiles,
        });
      } catch (err) {
        socket.emit('vibe:error', {
          sessionId: data.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  // ── vibe:inject-context ───────────────────────────────────────────────────
  socket.on('vibe:inject-context', (data: { sessionId: string }) => {
    void (async () => {
      try {
        const session =
          sessionManager.getSession(data.sessionId) ||
          sessionManager.loadSession(data.sessionId, apiKey);
        const projectDir =
          session.config.projectDir || defaultProjectDir || process.cwd();
        const context = gatherProjectContext(projectDir);
        const message = `Here is the current project context:\n\n${context}`;

        let fullResponse = '';
        const turn = await session.chat(message, {
          stream: true,
          onChunk: (chunk) => {
            fullResponse += chunk;
            socket.emit('vibe:chunk', { sessionId: data.sessionId, chunk });
          },
        });

        // Apply any file changes mentioned in the response
        const blocks = extractFileBlocks(fullResponse);
        const appliedFiles: string[] = [];
        for (const block of blocks) {
          try {
            const absPath = path.isAbsolute(block.filePath)
              ? block.filePath
              : path.resolve(
                  session.config.projectDir || defaultProjectDir || process.cwd(),
                  block.filePath
                );
            session.applyFileChange(absPath, block.content);
            appliedFiles.push(block.filePath);
            socket.emit('vibe:file-changed', {
              sessionId: data.sessionId,
              filePath: block.filePath,
            });
          } catch (err) {
            logger.warn(
              `Could not apply file change "${block.filePath}": ${err}`
            );
          }
        }

        sessionManager.persistSession(session);
        socket.emit('vibe:turn-complete', {
          sessionId: data.sessionId,
          turn,
          appliedFiles,
        });
      } catch (err) {
        socket.emit('vibe:error', {
          sessionId: data.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  // ── vibe:start-autonomous ─────────────────────────────────────────────────
  socket.on(
    'vibe:start-autonomous',
    (data: { sessionId: string; config: AutonomousConfig }) => {
      void (async () => {
        try {
          const session =
            sessionManager.getSession(data.sessionId) ||
            sessionManager.loadSession(data.sessionId, apiKey);

          // Stop any previously running agent for this session
          const existing = agents.get(data.sessionId);
          if (existing) {
            existing.stop();
            agents.delete(data.sessionId);
          }

          const agent = new AutonomousVibeAgent(session, data.config);
          agents.set(data.sessionId, agent);

          agent.on('chunk', (chunk: string, stepNumber: number) => {
            socket.emit('vibe:chunk', {
              sessionId: data.sessionId,
              chunk,
              stepNumber,
            });
          });

          agent.on('file-changed', (filePath: string, stepNumber: number) => {
            socket.emit('vibe:file-changed', {
              sessionId: data.sessionId,
              filePath,
              stepNumber,
            });
          });

          agent.on('step', (step: unknown) => {
            sessionManager.persistSession(session);
            socket.emit('vibe:step-complete', {
              sessionId: data.sessionId,
              step,
            });
          });

          agent.on('status', (status: unknown) => {
            socket.emit('vibe:autonomous-status', {
              sessionId: data.sessionId,
              status,
            });
          });

          agent.on('hil-request', (request: HILRequest) => {
            socket.emit('vibe:hil-request', {
              sessionId: data.sessionId,
              request,
            });
          });

          agent.on('complete', (steps: unknown) => {
            sessionManager.persistSession(session);
            agents.delete(data.sessionId);
            socket.emit('vibe:autonomous-complete', {
              sessionId: data.sessionId,
              steps,
            });
          });

          agent.on('error', (err: Error) => {
            agents.delete(data.sessionId);
            socket.emit('vibe:error', {
              sessionId: data.sessionId,
              message: err.message,
            });
          });

          void agent.run();
        } catch (err) {
          socket.emit('vibe:error', {
            sessionId: data.sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }
  );

  // ── vibe:hil-response ─────────────────────────────────────────────────────
  socket.on(
    'vibe:hil-response',
    (data: { sessionId: string; guidance: string }) => {
      const agent = agents.get(data.sessionId);
      if (agent) {
        agent.receiveHILResponse(data.guidance);
      } else {
        logger.warn(
          `vibe:hil-response: no active agent for session ${data.sessionId}`
        );
      }
    }
  );

  // ── vibe:stop-autonomous ──────────────────────────────────────────────────
  socket.on('vibe:stop-autonomous', (data: { sessionId: string }) => {
    const agent = agents.get(data.sessionId);
    if (agent) {
      agent.stop();
      agents.delete(data.sessionId);
      socket.emit('vibe:autonomous-status', {
        sessionId: data.sessionId,
        status: 'stopped',
      });
    }
  });

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const [sessionId, agent] of agents) {
      agent.stop();
      logger.debug(
        `Stopped autonomous agent for session ${sessionId} on client disconnect`
      );
    }
    agents.clear();
  });
}

/** REST endpoints for Vibe Coder session management. */
export function createVibeCoderRoutes(
  sessionManager: SessionManager,
  options: VibeCoderSocketOptions
): Router {
  const router = Router();

  // POST /api/vibe-coder/sessions — create a new vibe-coder session
  router.post('/sessions', (req: Request, res: Response) => {
    try {
      const { name, projectDir } = req.body as {
        name?: string;
        projectDir?: string;
      };
      const session = sessionManager.createSession(
        {
          name: name || `vibe-${Date.now()}`,
          provider: options.provider || 'openai',
          model: options.model || '',
          speckit: 'vibe-coder',
          systemPrompt: SPECKITS['vibe-coder']?.systemPrompt,
          projectDir:
            projectDir || options.projectDir || process.cwd(),
        },
        options.apiKey
      );
      res.json(session.toJSON());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
