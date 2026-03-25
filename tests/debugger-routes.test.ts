/**
 * Integration tests for the Live Debugger REST routes.
 *
 * Spins up a real Express server on an ephemeral port so the full
 * request/response cycle (body parsing, status codes, route guards) is
 * covered without any extra runtime dependencies.
 *
 * Tested routes:
 *   POST /api/debugger/:sessionId/git-fix
 *   POST /api/debugger/:sessionId/copilot-issue
 */

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createDebuggerRoutes } from '../src/web/routes/debugger';
import { SessionManager } from '../src/session/session-manager';
import { GitHubClient } from '../src/integrations/git';

// ── Mock session manager helpers ──────────────────────────────────────────────

const mockLoadSession = jest.fn();
const mockExportSession = jest.fn();
const mockPersistSession = jest.fn();

const mockSessionManager = {
    loadSession: mockLoadSession,
    exportSession: mockExportSession,
    persistSession: mockPersistSession,
} as unknown as SessionManager;

// ── Express test server ───────────────────────────────────────────────────────

let server: http.Server;
let port: number;

beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/debugger', createDebuggerRoutes(mockSessionManager));
    server = http.createServer(app);
    server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        done();
    });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
    jest.clearAllMocks();
    mockPersistSession.mockReturnValue(undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ── HTTP request helper ───────────────────────────────────────────────────────

function post(
    path: string,
    body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const json = JSON.stringify(body);
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(json),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (c: Buffer) => { raw += c.toString(); });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode!, data: JSON.parse(raw) as Record<string, unknown> });
                    } catch {
                        resolve({ status: res.statusCode!, data: { raw } });
                    }
                });
            },
        );
        req.on('error', reject);
        req.write(json);
        req.end();
    });
}

// ── Shared test-data builders ─────────────────────────────────────────────────

/** Minimal session export JSON containing a single turn. */
function exportWithTurn(turn: Record<string, unknown>): string {
    return JSON.stringify({
        name: 'test-session',
        turns: [{ id: 'turn-1', assistantMessage: 'AI analysis', userMessage: 'logs', ...turn }],
    });
}

/** Live-session stub returned by loadSession. */
function liveSession(opts: { autoAssignCopilot?: boolean; turns?: unknown[] } = {}) {
    return {
        config: {
            github: opts.autoAssignCopilot !== undefined
                ? { autoAssignCopilot: opts.autoAssignCopilot }
                : undefined,
        },
        getTurns: jest.fn(() => opts.turns ?? [{ id: 'turn-1', debuggerMeta: undefined }]),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/debugger/:sessionId/git-fix
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/debugger/:sessionId/git-fix', () => {
    it('returns 400 when gitConfig.repoPath is missing', async () => {
        const { status, data } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: {},
        });
        expect(status).toBe(400);
        expect(String(data.error)).toContain('repoPath');
    });

    it('returns 400 when body has no gitConfig', async () => {
        const { status } = await post('/api/debugger/sess-1/git-fix', {});
        expect(status).toBe(400);
    });

    // ── autoAssignCopilot session guard ───────────────────────────────────────

    it('returns 409 when session.config.github.autoAssignCopilot is true', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: true }));

        const { status, data } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
        });

        expect(status).toBe(409);
        expect(String(data.error)).toContain('autoAssignCopilot');
    });

    it('does NOT return 409 when autoAssignCopilot is false', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: false }));
        // Provide a turn without file blocks — route will return 422 instead of 409
        mockExportSession.mockReturnValue(
            exportWithTurn({ assistantMessage: 'no code blocks here' }),
        );

        const { status } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
        });

        expect(status).not.toBe(409);
    });

    it('does NOT return 409 when github config is absent', async () => {
        mockLoadSession.mockReturnValue(liveSession());  // no github config
        mockExportSession.mockReturnValue(
            exportWithTurn({ assistantMessage: 'no code blocks here' }),
        );

        const { status } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
        });

        expect(status).not.toBe(409);
    });

    // ── copilotIssueUrl turn guard ────────────────────────────────────────────

    it('returns 409 when the selected turn already has a copilotIssueUrl', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: false }));
        mockExportSession.mockReturnValue(
            exportWithTurn({
                id: 'turn-1',
                assistantMessage: 'analysis',
                debuggerMeta: { copilotIssueUrl: 'https://github.com/test/repo/issues/5' },
            }),
        );

        const { status, data } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
            turnId: 'turn-1',
        });

        expect(status).toBe(409);
        expect(String(data.error)).toMatch(/copilot issue/i);
    });

    it('does NOT return 409 when the turn has no copilotIssueUrl', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: false }));
        mockExportSession.mockReturnValue(
            exportWithTurn({
                id: 'turn-1',
                assistantMessage: 'no code blocks — plain text',
                debuggerMeta: {},   // no copilotIssueUrl
            }),
        );

        const { status } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
            turnId: 'turn-1',
        });

        // Falls through the guards — hits the 422 "no code blocks" check
        expect(status).not.toBe(409);
    });

    // ── other early-exit paths ────────────────────────────────────────────────

    it('returns 404 when the requested turn is not found', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: false }));
        mockExportSession.mockReturnValue(
            JSON.stringify({ name: 'test-session', turns: [] }),
        );

        const { status } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
            turnId: 'nonexistent-turn',
        });

        expect(status).toBe(404);
    });

    it('returns 422 when the AI analysis contains no file code blocks', async () => {
        mockLoadSession.mockReturnValue(liveSession({ autoAssignCopilot: false }));
        mockExportSession.mockReturnValue(
            exportWithTurn({
                id: 'turn-1',
                assistantMessage: 'There are no code blocks — just prose describing the issue.',
                debuggerMeta: {},
            }),
        );

        const { status, data } = await post('/api/debugger/sess-1/git-fix', {
            gitConfig: { repoPath: '/any/path' },
            turnId: 'turn-1',
        });

        expect(status).toBe(422);
        expect(String(data.error)).toMatch(/no file code blocks/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/debugger/:sessionId/copilot-issue
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/debugger/:sessionId/copilot-issue', () => {
    const validGithubConfig = {
        token: 'ghp_test',
        repoUrl: 'https://github.com/test-org/test-repo',
    };

    // ── Input validation ──────────────────────────────────────────────────────

    it('returns 400 when githubConfig is absent', async () => {
        const { status } = await post('/api/debugger/sess-1/copilot-issue', {});
        expect(status).toBe(400);
    });

    it('returns 400 when githubConfig.token is missing', async () => {
        const { status } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: { repoUrl: 'https://github.com/test/repo' },
        });
        expect(status).toBe(400);
    });

    it('returns 400 when githubConfig.repoUrl is missing', async () => {
        const { status } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: { token: 'ghp_test' },
        });
        expect(status).toBe(400);
    });

    // ── Turn look-up ──────────────────────────────────────────────────────────

    it('returns 404 when the requested turn does not exist', async () => {
        mockExportSession.mockReturnValue(
            JSON.stringify({ name: 'test-session', turns: [] }),
        );

        const { status } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: validGithubConfig,
            turnId: 'nonexistent',
        });

        expect(status).toBe(404);
    });

    // ── Guardrail enforcement ─────────────────────────────────────────────────

    it('returns 422 with violation details when a guardrail is triggered', async () => {
        mockExportSession.mockReturnValue(exportWithTurn({}));

        jest
            .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
            .mockReturnValue('Issue content contains denied keyword "secret" (rule: deny-keyword:secret)');

        const { status, data } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: { ...validGithubConfig, guardrails: ['deny-keyword:secret'] },
        });

        expect(status).toBe(422);
        expect(String(data.error)).toMatch(/guardrail violation/i);
        expect(typeof data.violation).toBe('string');
        expect(String(data.violation)).toContain('denied keyword');
    });

    it('does NOT call createIssueForCopilot when guardrail fires', async () => {
        mockExportSession.mockReturnValue(exportWithTurn({}));

        jest
            .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
            .mockReturnValue('blocked by guardrail');

        const createSpy = jest
            .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
            .mockResolvedValue({ issueNumber: 1, issueUrl: 'https://github.com/test/1' });

        await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: validGithubConfig,
        });

        expect(createSpy).not.toHaveBeenCalled();
    });

    // ── bypassGuardrails ──────────────────────────────────────────────────────

    it('skips checkCopilotGuardrails when bypassGuardrails is true', async () => {
        mockExportSession.mockReturnValue(exportWithTurn({}));
        mockLoadSession.mockReturnValue(
            liveSession({ turns: [{ id: 'turn-1', debuggerMeta: undefined }] }),
        );

        const checkSpy = jest
            .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
            .mockReturnValue('would-be-blocked');

        jest
            .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
            .mockResolvedValue({ issueNumber: 9, issueUrl: 'https://github.com/test/repo/issues/9' });

        const { status } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: validGithubConfig,
            bypassGuardrails: true,
        });

        expect(checkSpy).not.toHaveBeenCalled();
        expect(status).toBe(200);
    });

    it('creates the issue and returns result when guardrail passes', async () => {
        mockExportSession.mockReturnValue(exportWithTurn({}));
        mockLoadSession.mockReturnValue(
            liveSession({ turns: [{ id: 'turn-1', debuggerMeta: undefined }] }),
        );

        jest
            .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
            .mockReturnValue(null); // passes

        const createSpy = jest
            .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
            .mockResolvedValue({ issueNumber: 42, issueUrl: 'https://github.com/test/repo/issues/42' });

        const { status, data } = await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: validGithubConfig,
        });

        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(status).toBe(200);
        expect(data.issueNumber).toBe(42);
        expect(typeof data.issueUrl).toBe('string');
    });

    it('passes custom title, body, and labels to checkCopilotGuardrails', async () => {
        mockExportSession.mockReturnValue(exportWithTurn({}));
        mockLoadSession.mockReturnValue(
            liveSession({ turns: [{ id: 'turn-1', debuggerMeta: undefined }] }),
        );

        const checkSpy = jest
            .spyOn(GitHubClient.prototype, 'checkCopilotGuardrails')
            .mockReturnValue(null);

        jest
            .spyOn(GitHubClient.prototype, 'createIssueForCopilot')
            .mockResolvedValue({ issueNumber: 1, issueUrl: 'https://github.com/test/repo/issues/1' });

        await post('/api/debugger/sess-1/copilot-issue', {
            githubConfig: validGithubConfig,
            title: 'Custom issue title',
            body: 'Custom body text',
            labels: ['custom-label'],
        });

        expect(checkSpy).toHaveBeenCalledWith(
            'Custom issue title',
            'Custom body text',
            ['custom-label'],
        );
    });
});
