import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { JiraClient } from '../src/integrations/jira';
import { GitPatchApplier } from '../src/integrations/git';

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
