import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { JiraClient } from '../src/integrations/jira';
import { GitPatchApplier, GitHubClient } from '../src/integrations/git';

const execFileAsync = promisify(execFile);

// ── JiraClient ────────────────────────────────────────────────────────────────

describe('JiraClient', () => {
  const baseConfig = {
    baseUrl: 'https://example.atlassian.net',
    email: 'user@example.com',
    apiToken: 'tok',
    projectKey: 'OPS',
  };

  it('throws on deny-keyword guardrail match', async () => {
    const client = new JiraClient({
      ...baseConfig,
      guardrails: ['deny-keyword:secret'],
    });
    await expect(
      client.createIssue({ summary: 'Contains secret data', description: 'desc' })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('throws on require-label guardrail when label is missing', async () => {
    const client = new JiraClient({
      ...baseConfig,
      guardrails: ['require-label:live-debugger'],
    });
    await expect(
      client.createIssue({ summary: 'No label', description: 'desc' })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('passes require-label guardrail when label is present', async () => {
    // We can't call the real Jira API but we can verify guardrail passes
    // by intercepting at the network call — mock with a jest spy on `post`
    const client = new JiraClient({
      ...baseConfig,
      guardrails: ['require-label:live-debugger'],
    });
    // Patch the private `post` method to throw a predictable network error
    // so we confirm the guardrail didn't reject first
    const postSpy = jest
      .spyOn(client as unknown as { post: () => Promise<unknown> }, 'post')
      .mockRejectedValue(new Error('network'));

    await expect(
      client.createIssue({ summary: 'Fixed issue', description: 'desc', labels: ['live-debugger'] })
    ).rejects.toThrow('network');
    expect(postSpy).toHaveBeenCalled(); // reached the network call (guardrail passed)
    postSpy.mockRestore();
  });

  it('throws on max-summary-length guardrail breach', async () => {
    const client = new JiraClient({
      ...baseConfig,
      guardrails: ['max-summary-length:10'],
    });
    await expect(
      client.createIssue({ summary: 'This summary is too long', description: 'desc' })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('passes with no guardrails (reaches network)', async () => {
    const client = new JiraClient(baseConfig);
    const postSpy = jest
      .spyOn(client as unknown as { post: () => Promise<unknown> }, 'post')
      .mockRejectedValue(new Error('no network'));
    await expect(
      client.createIssue({ summary: 'Normal summary', description: 'desc' })
    ).rejects.toThrow('no network');
    expect(postSpy).toHaveBeenCalled();
    postSpy.mockRestore();
  });

  it('addComment reaches the network layer', async () => {
    const client = new JiraClient(baseConfig);
    const postSpy = jest
      .spyOn(client as unknown as { post: () => Promise<unknown> }, 'post')
      .mockRejectedValue(new Error('no network'));
    await expect(client.addComment('OPS-1', 'Hello')).rejects.toThrow('no network');
    postSpy.mockRestore();
  });
});

// ── GitPatchApplier ────────────────────────────────────────────────────────────

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', dir]);
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  // Create an initial commit so we have a HEAD
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
}

describe('GitPatchApplier', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-git-test-'));
    await initRepo(repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('throws when repoPath does not exist', () => {
    expect(() => new GitPatchApplier({ repoPath: '/does/not/exist' })).toThrow(/does not exist/);
  });

  it('applies files and creates a commit', async () => {
    const patcher = new GitPatchApplier({ repoPath: repoDir });
    const result = await patcher.applyAndCommit({
      files: { 'src/fix.ts': '// auto-fix\n' },
      commitMessage: 'fix: test commit',
    });

    expect(result.branch).toBe('fusion-agent/auto-fix');
    expect(result.commitSha).toHaveLength(40);
    expect(fs.existsSync(path.join(repoDir, 'src/fix.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(repoDir, 'src/fix.ts'), 'utf-8')).toBe('// auto-fix\n');
  });

  it('uses configured branch name', async () => {
    const patcher = new GitPatchApplier({ repoPath: repoDir, branch: 'my/custom-branch' });
    const result = await patcher.applyAndCommit({
      files: { 'fix.txt': 'ok' },
      commitMessage: 'chore: custom branch',
    });
    expect(result.branch).toBe('my/custom-branch');
  });

  it('throws on deny-path guardrail', async () => {
    const patcher = new GitPatchApplier({
      repoPath: repoDir,
      guardrails: ['deny-path:secrets/'],
    });
    await expect(
      patcher.applyAndCommit({
        files: { 'secrets/creds.txt': 'password=...' },
        commitMessage: 'bad commit',
      })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('throws on allow-path guardrail when file is outside allowed dir', async () => {
    const patcher = new GitPatchApplier({
      repoPath: repoDir,
      guardrails: ['allow-path:src/'],
    });
    await expect(
      patcher.applyAndCommit({
        files: { 'outside.ts': 'code' },
        commitMessage: 'bad commit',
      })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('throws on max-files guardrail', async () => {
    const patcher = new GitPatchApplier({
      repoPath: repoDir,
      guardrails: ['max-files:1'],
    });
    await expect(
      patcher.applyAndCommit({
        files: { 'a.ts': 'a', 'b.ts': 'b' },
        commitMessage: 'too many files',
      })
    ).rejects.toThrow(/guardrail violation/i);
  });

  it('respects custom author', async () => {
    const patcher = new GitPatchApplier({
      repoPath: repoDir,
      authorName: 'Bot',
      authorEmail: 'bot@example.com',
    });
    const result = await patcher.applyAndCommit({
      files: { 'bot.ts': '// bot' },
      commitMessage: 'bot commit',
    });
    const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%an <%ae>'], { cwd: repoDir });
    expect(stdout.trim()).toBe('Bot <bot@example.com>');
    expect(result.commitSha).toHaveLength(40);
  });
});

// ── DebuggerTurnMeta on SessionTurn ───────────────────────────────────────────

describe('DebuggerTurnMeta', () => {
  it('is a plain serialisable object that round-trips through JSON', () => {
    const meta = {
      matchedLogLines: ['ERROR: disk full'],
      promptSentAt: '2024-01-01T00:00:00.000Z',
      responseReceivedAt: '2024-01-01T00:00:01.000Z',
      notificationSent: true,
      fixApplied: false,
      jiraKey: 'OPS-42',
    };
    const json = JSON.parse(JSON.stringify(meta)) as typeof meta;
    expect(json.matchedLogLines).toEqual(['ERROR: disk full']);
    expect(json.notificationSent).toBe(true);
    expect(json.jiraKey).toBe('OPS-42');
  });
});

// ── GitHubClient — checkCopilotGuardrails ─────────────────────────────────────

describe('GitHubClient — checkCopilotGuardrails', () => {
  const makeClient = (guardrails: string[]) =>
    new GitHubClient({
      token: 'ghp_test',
      repoUrl: 'https://github.com/test-org/test-repo',
      guardrails,
    });

  it('returns null when no guardrails are configured', () => {
    const client = makeClient([]);
    expect(client.checkCopilotGuardrails('Some title', 'Some body', [])).toBeNull();
  });

  it('deny-keyword: returns violation when title contains the keyword', () => {
    const client = makeClient(['deny-keyword:secret']);
    const result = client.checkCopilotGuardrails('Contains secret data', 'body', []);
    expect(result).not.toBeNull();
    expect(result).toContain('denied keyword');
    expect(result).toContain('secret');
  });

  it('deny-keyword: returns violation when body contains the keyword', () => {
    const client = makeClient(['deny-keyword:password']);
    const result = client.checkCopilotGuardrails('Clean title', 'Has password=abc123 inside', []);
    expect(result).not.toBeNull();
    expect(result).toContain('password');
  });

  it('deny-keyword: match is case-insensitive', () => {
    const client = makeClient(['deny-keyword:secret']);
    expect(client.checkCopilotGuardrails('This has SECRET in caps', 'body', [])).not.toBeNull();
    expect(client.checkCopilotGuardrails('Title', 'Body with Secret word', [])).not.toBeNull();
  });

  it('deny-keyword: returns null when keyword is absent', () => {
    const client = makeClient(['deny-keyword:secret']);
    expect(client.checkCopilotGuardrails('Normal title', 'Normal body', [])).toBeNull();
  });

  it('require-label: returns violation when label is missing from the list', () => {
    const client = makeClient(['require-label:live-debugger']);
    const result = client.checkCopilotGuardrails('title', 'body', ['some-other-label']);
    expect(result).not.toBeNull();
    expect(result).toContain('live-debugger');
  });

  it('require-label: returns null when required label is present', () => {
    const client = makeClient(['require-label:live-debugger']);
    expect(client.checkCopilotGuardrails('title', 'body', ['live-debugger', 'fusion-agent'])).toBeNull();
  });

  it('require-label: comparison is case-insensitive', () => {
    const client = makeClient(['require-label:Live-Debugger']);
    expect(client.checkCopilotGuardrails('title', 'body', ['live-debugger'])).toBeNull();
  });

  it('require-label: returns null when labels list is empty and no rule', () => {
    const client = makeClient([]);
    expect(client.checkCopilotGuardrails('title', 'body', [])).toBeNull();
  });

  it('max-title-length: returns violation when title exceeds max', () => {
    const client = makeClient(['max-title-length:20']);
    const result = client.checkCopilotGuardrails('A'.repeat(21), 'body', []);
    expect(result).not.toBeNull();
    expect(result).toContain('21 characters');
    expect(result).toContain('max 20');
  });

  it('max-title-length: returns null when title is exactly at the limit', () => {
    const client = makeClient(['max-title-length:10']);
    expect(client.checkCopilotGuardrails('A'.repeat(10), 'body', [])).toBeNull();
  });

  it('max-body-length: returns violation when body exceeds max', () => {
    const client = makeClient(['max-body-length:50']);
    const result = client.checkCopilotGuardrails('title', 'B'.repeat(51), []);
    expect(result).not.toBeNull();
    expect(result).toContain('51 characters');
  });

  it('max-body-length: returns null when body is within the limit', () => {
    const client = makeClient(['max-body-length:100']);
    expect(client.checkCopilotGuardrails('title', 'B'.repeat(100), [])).toBeNull();
  });

  it('unrecognised rules are silently ignored and do not block', () => {
    const client = makeClient(['unknown-rule:value', 'another-unknown:xyz']);
    expect(client.checkCopilotGuardrails('title', 'body', [])).toBeNull();
  });

  it('returns the first violation when multiple rules are configured', () => {
    const client = makeClient(['deny-keyword:secret', 'require-label:required']);
    // Both rules fire — expect the deny-keyword one (first in list) to be returned
    const result = client.checkCopilotGuardrails('Has secret inside', 'body', []);
    expect(result).not.toBeNull();
    expect(result).toContain('deny-keyword');
  });

  it('checks all rules and returns null only when every rule passes', () => {
    const client = makeClient([
      'deny-keyword:secret',
      'require-label:live-debugger',
      'max-title-length:100',
      'max-body-length:500',
    ]);
    expect(
      client.checkCopilotGuardrails('Normal title', 'Normal body', ['live-debugger'])
    ).toBeNull();
  });
});

// ── GitHubClient — constructor validation ─────────────────────────────────────

describe('GitHubClient — constructor validation', () => {
  it('throws when token is empty', () => {
    expect(
      () => new GitHubClient({ token: '', repoUrl: 'https://github.com/test/repo' })
    ).toThrow(/token/);
  });

  it('throws when repoUrl is empty', () => {
    expect(
      () => new GitHubClient({ token: 'ghp_test', repoUrl: '' })
    ).toThrow(/repoUrl/);
  });

  it('constructs successfully with valid token and repoUrl', () => {
    expect(
      () => new GitHubClient({ token: 'ghp_test', repoUrl: 'https://github.com/org/repo' })
    ).not.toThrow();
  });
});
