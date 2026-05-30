import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

function extractOwnerRepo(repoRef?: string): string | null {
  if (!repoRef) return null;
  const input = repoRef.trim().replace(/\.git$/, '');

  // SCP-like syntax: git@host:owner/repo
  const scpMatch = input.match(/^[^@\s]+@[^:\s]+:([\w.-]+\/[\w.-]+)$/);
  if (scpMatch) return scpMatch[1];

  // URL-like syntax: https://host/owner/repo or ssh://git@host/owner/repo
  try {
    const asUrl = new URL(input);
    const parts = asUrl.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    // Fall through to plain owner/repo parsing.
  }

  // Plain owner/repo fallback.
  const plainMatch = input.match(/^([\w.-]+\/[\w.-]+)$/);
  return plainMatch ? plainMatch[1] : null;
}

export interface GitConfig {
  /**
   * Absolute path to the local git repository. The directory must already be
   * a valid git repo (git init / clone before using this).
   */
  repoPath: string;
  /**
   * Personal access token or app token used for authenticating HTTPS pushes.
   * Leave empty if the repo is already authenticated via SSH or credential
   * helper.
   */
  token?: string;
  /**
   * Remote URL to push to (optional — defaults to the existing `origin`
   * remote). Accepts `https://github.com/owner/repo` style URLs.
   */
  remoteUrl?: string;
  /**
   * Author name for commits (default: 'fusion-agent[bot]')
   */
  authorName?: string;
  /**
   * Author email for commits (default: 'fusion-agent@noreply')
   */
  authorEmail?: string;
  /**
   * Target branch for commits.  The branch is created if it does not exist.
   * Default: 'fusion-agent/auto-fix'
   */
  branch?: string;
  /**
   * GitHub / GitLab API base URL for creating pull/merge requests.
   * Example: https://api.github.com
   * Leave empty to skip PR creation.
   */
  apiBaseUrl?: string;
  /**
   * Guardrails: list of rule strings that control which file paths the
   * integration is allowed to modify.
   *
   * Supported formats:
   *   allow-path:<relative/path>   — only these paths may be modified
   *   deny-path:<relative/path>    — these paths must never be modified
   *   max-files:<n>                — at most N files per commit
   */
  guardrails?: string[];
}

export interface GitPatchOptions {
  /** Files to write: map of relative path → new content */
  files: Record<string, string>;
  /** Commit message */
  commitMessage: string;
  /**
   * If set and `apiBaseUrl` is configured, open a pull/merge request after
   * pushing.
   */
  pullRequestTitle?: string;
  pullRequestBody?: string;
  /** Base branch for the PR (default: 'main') */
  baseBranch?: string;
}

export interface GitPatchResult {
  branch: string;
  commitSha: string;
  /** URL of the created pull request, if requested */
  pullRequestUrl?: string;
}

/**
 * Applies AI-proposed code fixes to a local git repository and optionally
 * pushes them and opens a pull request.
 */
export class GitPatchApplier {
  private readonly config: GitConfig;

  constructor(config: GitConfig) {
    if (!fs.existsSync(config.repoPath)) {
      throw new Error(`Git repoPath does not exist: ${config.repoPath}`);
    }
    this.config = config;
  }

  async applyAndCommit(options: GitPatchOptions): Promise<GitPatchResult> {
    // Guardrail checks
    const violation = this.checkGuardrails(options);
    if (violation) {
      throw new Error(`Git guardrail violation: ${violation}`);
    }

    const branch = this.config.branch ?? 'fusion-agent/auto-fix';
    const authorName = this.config.authorName ?? 'fusion-agent[bot]';
    const authorEmail = this.config.authorEmail ?? 'fusion-agent@noreply';
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    // Ensure we are on the right branch (create if needed)
    await this.git(['checkout', '-B', branch], env);

    // Write all files
    for (const [relPath, content] of Object.entries(options.files)) {
      const absPath = path.resolve(this.config.repoPath, relPath);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(absPath, content, 'utf-8');
      await this.git(['add', relPath], env);
    }

    // Commit
    const { stdout } = await this.git(
      ['commit', '-m', options.commitMessage, '--allow-empty'],
      env
    );
    logger.info(`Git commit: ${stdout.trim()}`);

    // Get the SHA
    const { stdout: sha } = await this.git(['rev-parse', 'HEAD'], env);
    const commitSha = sha.trim();

    // Push
    const remote = this.buildRemoteUrl();
    if (remote) {
      try {
        await this.git(['push', '-u', remote, branch], env);
        logger.info(`Git push succeeded to ${branch}`);
      } catch (pushErr) {
        logger.warn(`Git push failed (non-fatal): ${pushErr}`);
      }
    }

    // Open PR if requested
    let pullRequestUrl: string | undefined;
    if (options.pullRequestTitle && this.config.apiBaseUrl) {
      try {
        pullRequestUrl = await this.createPullRequest(
          options.pullRequestTitle,
          options.pullRequestBody ?? options.commitMessage,
          branch,
          options.baseBranch ?? 'main'
        );
        logger.info(`Pull request created: ${pullRequestUrl}`);
      } catch (prErr) {
        logger.warn(`Pull request creation failed (non-fatal): ${prErr}`);
      }
    }

    return { branch, commitSha, pullRequestUrl };
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private checkGuardrails(options: GitPatchOptions): string | null {
    const rules = this.config.guardrails ?? [];
    const filePaths = Object.keys(options.files);

    for (const rule of rules) {
      if (rule.startsWith('allow-path:')) {
        const allowed = rule.slice('allow-path:'.length);
        for (const fp of filePaths) {
          if (!fp.startsWith(allowed)) {
            return `File "${fp}" is outside allowed path "${allowed}" (rule: ${rule})`;
          }
        }
      }
      if (rule.startsWith('deny-path:')) {
        const denied = rule.slice('deny-path:'.length);
        for (const fp of filePaths) {
          if (fp.startsWith(denied)) {
            return `File "${fp}" is within denied path "${denied}" (rule: ${rule})`;
          }
        }
      }
      if (rule.startsWith('max-files:')) {
        const max = parseInt(rule.slice('max-files:'.length), 10);
        if (!isNaN(max) && filePaths.length > max) {
          return `Commit touches ${filePaths.length} files, exceeding max ${max} (rule: ${rule})`;
        }
      }
    }
    return null;
  }

  private buildRemoteUrl(): string | undefined {
    if (!this.config.remoteUrl) return 'origin';
    if (!this.config.token) return this.config.remoteUrl;
    // Inject token into HTTPS URL
    try {
      const u = new URL(this.config.remoteUrl);
      u.username = 'oauth2';
      u.password = this.config.token;
      return u.toString();
    } catch {
      return this.config.remoteUrl;
    }
  }

  private git(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, { cwd: this.config.repoPath, env });
  }

  /**
   * Create a GitHub pull request using the REST API.
   * Other platforms (GitLab, Bitbucket) have similar endpoints — extend here.
   */
  private createPullRequest(
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.config.apiBaseUrl || !this.config.token) {
        reject(new Error('apiBaseUrl and token are required to create a pull request'));
        return;
      }

      const apiBase = new URL(this.config.apiBaseUrl);
      // Determine owner/repo from remoteUrl
      const repoPath = this.parseRepoPath();
      if (!repoPath) {
        reject(new Error('Could not determine owner/repo from remoteUrl'));
        return;
      }

      const prPath = `/repos/${repoPath}/pulls`;
      const payload = JSON.stringify({ title, body, head, base });
      const isHttps = apiBase.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        {
          hostname: apiBase.hostname,
          port: apiBase.port ? parseInt(apiBase.port, 10) : isHttps ? 443 : 80,
          path: prPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${this.config.token}`,
            'User-Agent': 'fusion-agent',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as { html_url?: string; message?: string };
              if (parsed.html_url) {
                resolve(parsed.html_url);
              } else {
                reject(new Error(`PR creation failed: ${data}`));
              }
            } catch {
              reject(new Error(`PR response parse error: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  private parseRepoPath(): string | null {
    return extractOwnerRepo(this.config.remoteUrl);
  }
}

// ── GitHub Copilot Agent integration ────────────────────────────────────────

/**
 * Commits files directly to GitHub via the Git Data API — no local git clone
 * required. Uses the following flow:
 *   1. Resolve base branch HEAD SHA
 *   2. Create blobs for each file
 *   3. Build a new tree on top of the base tree
 *   4. Create a commit
 *   5. Create (or force-update) the target branch ref
 *   6. Optionally open a pull request
 */
export class GitHubPatcher {
  private readonly config: GitConfig;
  private readonly ownerRepo: string;

  constructor(config: GitConfig) {
    if (!config.token) throw new Error('GitHubPatcher: token is required');
    const ownerRepo = extractOwnerRepo(config.remoteUrl);
    if (!ownerRepo) throw new Error(`GitHubPatcher: cannot determine owner/repo from remoteUrl: ${config.remoteUrl}`);
    this.config = config;
    this.ownerRepo = ownerRepo;
  }

  async applyAndCommit(options: GitPatchOptions): Promise<GitPatchResult> {
    const branch = this.config.branch ?? 'fusion-agent/auto-fix';
    const baseBranch = options.baseBranch ?? 'main';
    const authorName = this.config.authorName ?? 'fusion-agent[bot]';
    const authorEmail = this.config.authorEmail ?? 'fusion-agent@noreply';

    // Guardrail checks (reuse same logic as GitPatchApplier)
    const guardViolation = checkGuardrailsStatic(this.config.guardrails ?? [], options);
    if (guardViolation) throw new Error(`Git guardrail violation: ${guardViolation}`);

    // 1. Get base branch HEAD SHA
    const baseRef = await this.api<{ object: { sha: string } }>(
      'GET', `/repos/${this.ownerRepo}/git/ref/heads/${encodeURIComponent(baseBranch)}`
    );
    const baseSha = baseRef.object.sha;

    // 2. Get base commit tree SHA
    const baseCommit = await this.api<{ tree: { sha: string } }>(
      'GET', `/repos/${this.ownerRepo}/git/commits/${baseSha}`
    );
    const baseTreeSha = baseCommit.tree.sha;

    // 3. Create blobs
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const [relPath, content] of Object.entries(options.files)) {
      const blob = await this.api<{ sha: string }>(
        'POST', `/repos/${this.ownerRepo}/git/blobs`,
        { content: Buffer.from(content, 'utf-8').toString('base64'), encoding: 'base64' }
      );
      treeItems.push({ path: relPath, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // 4. Create tree
    const newTree = await this.api<{ sha: string }>(
      'POST', `/repos/${this.ownerRepo}/git/trees`,
      { base_tree: baseTreeSha, tree: treeItems }
    );

    // 5. Create commit
    const newCommit = await this.api<{ sha: string }>(
      'POST', `/repos/${this.ownerRepo}/git/commits`,
      {
        message: options.commitMessage,
        tree: newTree.sha,
        parents: [baseSha],
        author: { name: authorName, email: authorEmail, date: new Date().toISOString() },
      }
    );

    // 6. Create or force-update the branch ref
    try {
      await this.api('POST', `/repos/${this.ownerRepo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: newCommit.sha,
      });
    } catch {
      // Branch already exists — force-update
      await this.api('PATCH', `/repos/${this.ownerRepo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: newCommit.sha,
        force: true,
      });
    }

    logger.info(`GitHubPatcher: pushed ${Object.keys(options.files).length} file(s) to ${this.ownerRepo}@${branch}`);

    // 7. Open pull request if requested
    let pullRequestUrl: string | undefined;
    if (options.pullRequestTitle) {
      try {
        const pr = await this.api<{ html_url: string }>(
          'POST', `/repos/${this.ownerRepo}/pulls`,
          {
            title: options.pullRequestTitle,
            body: options.pullRequestBody ?? options.commitMessage,
            head: branch,
            base: baseBranch,
          }
        );
        pullRequestUrl = pr.html_url;
        logger.info(`GitHubPatcher: PR created: ${pullRequestUrl}`);
      } catch (prErr) {
        logger.warn(`GitHubPatcher: PR creation failed (non-fatal): ${prErr}`);
      }
    }

    return { branch, commitSha: newCommit.sha, pullRequestUrl };
  }

  private api<T>(method: string, apiPath: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const apiBase = new URL(this.config.apiBaseUrl ?? 'https://api.github.com');
      const isHttps = apiBase.protocol === 'https:';
      const transport = isHttps ? https : http;
      const body = payload ? JSON.stringify(payload) : undefined;

      const req = transport.request(
        {
          hostname: apiBase.hostname,
          port: apiBase.port ? parseInt(apiBase.port, 10) : isHttps ? 443 : 80,
          path: apiPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Authorization': `Bearer ${this.config.token}`,
            'User-Agent': 'fusion-agent',
            ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as T & { message?: string };
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(
                  `GitHub API error ${res.statusCode} on ${method} ${apiPath}: ${(parsed as Record<string, unknown>).message ?? data
                  }`
                ));
              } else {
                resolve(parsed);
              }
            } catch {
              reject(new Error(`GitHub API response parse error: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

/** Shared guardrail checker (extracted so both patchers can reuse it). */
function checkGuardrailsStatic(
  rules: string[],
  options: GitPatchOptions
): string | null {
  const filePaths = Object.keys(options.files);
  for (const rule of rules) {
    if (rule.startsWith('allow-path:')) {
      const allowed = rule.slice('allow-path:'.length);
      for (const fp of filePaths) {
        if (!fp.startsWith(allowed))
          return `File "${fp}" is outside allowed path "${allowed}" (rule: ${rule})`;
      }
    }
    if (rule.startsWith('deny-path:')) {
      const denied = rule.slice('deny-path:'.length);
      for (const fp of filePaths) {
        if (fp.startsWith(denied))
          return `File "${fp}" is within denied path "${denied}" (rule: ${rule})`;
      }
    }
    if (rule.startsWith('max-files:')) {
      const max = parseInt(rule.slice('max-files:'.length), 10);
      if (!isNaN(max) && filePaths.length > max)
        return `Commit touches ${filePaths.length} files, exceeding max ${max} (rule: ${rule})`;
    }
  }
  return null;
}

// ── GitHub Copilot Agent integration ────────────────────────────────────────


export interface GitHubConfig {
  /** Personal access token with repo + issues:write scope */
  token: string;
  /** e.g. https://api.github.com (default) */
  apiBaseUrl?: string;
  /** https://github.com/owner/repo */
  repoUrl: string;
  /** Assignee to trigger the Copilot coding agent (default: 'copilot') */
  assignee?: string;
  /** Automatically file and assign a GitHub issue after each live debugger analysis */
  autoAssignCopilot?: boolean;
  /**
   * Guardrails that gate Copilot issue creation.  Identical format to the
   * Git integration guardrails but applied to issue content:
   *
   *   deny-keyword:<word>     — block if title **or** body contains the word (case-insensitive)
   *   require-label:<label>   — block if the label is not present in the labels list
   *   max-title-length:<n>    — block if the issue title exceeds N characters
   *   max-body-length:<n>     — block if the issue body exceeds N characters
   */
  guardrails?: string[];
}

export interface GitHubIssueResult {
  issueNumber: number;
  issueUrl: string;
  copilotAssigned?: boolean;
  assignedTo?: string;
  assignmentError?: string;
}

/**
 * Lightweight GitHub REST API client for creating issues and triggering the
 * GitHub Copilot coding agent via assignee assignment.
 */
export class GitHubClient {
  private readonly config: GitHubConfig;

  constructor(config: GitHubConfig) {
    if (!config.token) throw new Error('GitHubClient: token is required');
    if (!config.repoUrl) throw new Error('GitHubClient: repoUrl is required');
    this.config = config;
  }

  /** Create a GitHub issue and return its number + URL. */
  async createIssue(title: string, body: string, labels?: string[]): Promise<GitHubIssueResult> {
    const repoPath = this.parseRepoPath();
    if (!repoPath) throw new Error(`Could not determine owner/repo from repoUrl: ${this.config.repoUrl}`);
    const payload: Record<string, unknown> = { title, body };
    if (labels && labels.length > 0) payload.labels = labels;
    const data = await this.apiRequest<{ number: number; html_url: string }>(
      'POST', `/repos/${repoPath}/issues`, payload
    );
    return { issueNumber: data.number, issueUrl: data.html_url };
  }

  /** Assign an existing issue to the Copilot coding agent. */
  async assignIssueToCopilot(issueNumber: number): Promise<string> {
    const repoPath = this.parseRepoPath();
    if (!repoPath) throw new Error(`Could not determine owner/repo from repoUrl: ${this.config.repoUrl}`);

    // The REST API requires the literal login "copilot-swe-agent[bot]"
    // and an `agent_assignment` object to actually trigger the agent.
    // Docs: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
    const copilotLogin = this.config.assignee ?? 'copilot-swe-agent[bot]';
    await this.apiRequest('POST', `/repos/${repoPath}/issues/${issueNumber}/assignees`, {
      assignees: [copilotLogin],
      agent_assignment: {
        target_repo: repoPath,
        base_branch: 'main',
        custom_instructions: '',
        custom_agent: '',
        model: '',
      },
    });
    return copilotLogin;
  }

  /**
   * Evaluate the configured guardrails against the proposed issue content.
   * Returns a human-readable violation string when a rule is broken, or
   * `null` when all rules pass.
   */
  checkCopilotGuardrails(title: string, body: string, labels: string[]): string | null {
    const rules = this.config.guardrails ?? [];
    for (const rule of rules) {
      if (rule.startsWith('deny-keyword:')) {
        const kw = rule.slice('deny-keyword:'.length).toLowerCase();
        if (title.toLowerCase().includes(kw) || body.toLowerCase().includes(kw)) {
          return `Issue content contains denied keyword "${kw}" (rule: ${rule})`;
        }
      }
      if (rule.startsWith('require-label:')) {
        const required = rule.slice('require-label:'.length).trim();
        if (!labels.map((l) => l.trim().toLowerCase()).includes(required.toLowerCase())) {
          return `Required label "${required}" is missing from the issue labels (rule: ${rule})`;
        }
      }
      if (rule.startsWith('max-title-length:')) {
        const max = parseInt(rule.slice('max-title-length:'.length), 10);
        if (!isNaN(max) && title.length > max) {
          return `Issue title is ${title.length} characters, exceeding max ${max} (rule: ${rule})`;
        }
      }
      if (rule.startsWith('max-body-length:')) {
        const max = parseInt(rule.slice('max-body-length:'.length), 10);
        if (!isNaN(max) && body.length > max) {
          return `Issue body is ${body.length} characters, exceeding max ${max} (rule: ${rule})`;
        }
      }
    }
    return null;
  }

  /**
   * Create a GitHub issue and assign it to the Copilot coding agent in a
   * single API request by including `assignees` and `agent_assignment` in
   * the issue creation payload.
   * Docs: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
   */
  async createIssueForCopilot(title: string, body: string, labels?: string[]): Promise<GitHubIssueResult> {
    const repoPath = this.parseRepoPath();
    if (!repoPath) throw new Error(`Could not determine owner/repo from repoUrl: ${this.config.repoUrl}`);

    const copilotLogin = this.config.assignee ?? 'copilot-swe-agent[bot]';
    const payload: Record<string, unknown> = {
      title,
      body,
      assignees: [copilotLogin],
      agent_assignment: {
        target_repo: repoPath,
        base_branch: 'main',
        custom_instructions: '',
        custom_agent: '',
        model: '',
      },
    };
    if (labels && labels.length > 0) payload.labels = labels;

    try {
      const data = await this.apiRequest<{ number: number; html_url: string }>(
        'POST', `/repos/${repoPath}/issues`, payload
      );
      return {
        issueNumber: data.number,
        issueUrl: data.html_url,
        copilotAssigned: true,
        assignedTo: copilotLogin,
      };
    } catch (err) {
      // Fall back: create without agent_assignment, then assign separately
      logger.warn(`Copilot issue creation with agent_assignment failed, falling back: ${err}`);
      const result = await this.createIssue(title, body, labels);
      try {
        const assignedTo = await this.assignIssueToCopilot(result.issueNumber);
        return { ...result, copilotAssigned: true, assignedTo };
      } catch (assignErr) {
        const assignmentError = assignErr instanceof Error ? assignErr.message : String(assignErr);
        logger.warn(`Copilot assignment failed for issue #${result.issueNumber}: ${assignmentError}`);
        return { ...result, copilotAssigned: false, assignmentError };
      }
    }
  }

  private parseRepoPath(): string | null {
    return extractOwnerRepo(this.config.repoUrl);
  }

  private apiRequest<T>(method: string, apiPath: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const apiBase = new URL(this.config.apiBaseUrl ?? 'https://api.github.com');
      const isHttps = apiBase.protocol === 'https:';
      const transport = isHttps ? https : http;
      const body = payload ? JSON.stringify(payload) : undefined;
      const req = transport.request(
        {
          hostname: apiBase.hostname,
          port: apiBase.port ? parseInt(apiBase.port, 10) : isHttps ? 443 : 80,
          path: apiPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Authorization': `Bearer ${this.config.token}`,
            'User-Agent': 'fusion-agent',
            ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as T & { message?: string };
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(
                  `GitHub API error ${res.statusCode}: ${(parsed as Record<string, unknown>).message ?? data}`
                ));
              } else {
                resolve(parsed);
              }
            } catch {
              reject(new Error(`GitHub API response parse error: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
