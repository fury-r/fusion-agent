import https from 'https';
import http from 'http';
import { URL } from 'url';
import { logger } from '../utils/logger';

export interface JiraConfig {
  /** Jira base URL, e.g. https://yourorg.atlassian.net */
  baseUrl: string;
  /** User email (for basic auth) */
  email: string;
  /** Jira API token */
  apiToken: string;
  /** Default project key, e.g. OPS */
  projectKey: string;
  /** Default issue type name (default: 'Bug') */
  issueType?: string;
  /** Extra labels to apply to every created issue */
  labels?: string[];
  /** Guardrails: custom rules injected into the ticket-creation prompt */
  guardrails?: string[];
}

export interface JiraIssuePayload {
  summary: string;
  description: string;
  /** Priority name: Highest | High | Medium | Low | Lowest */
  priority?: string;
  labels?: string[];
  /** Extra fields merged into the Jira issue body */
  extraFields?: Record<string, unknown>;
}

export interface JiraIssueResult {
  id: string;
  key: string;
  url: string;
}

/**
 * Thin Jira REST API v3 client.
 * Uses only Node built-ins (http/https) — no extra dependencies.
 */
export class JiraClient {
  private readonly config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  /**
   * Create a Jira issue and return its key and browse URL.
   */
  async createIssue(payload: JiraIssuePayload): Promise<JiraIssueResult> {
    // Apply guardrail rules (content-level checks — the AI never touches Jira
    // directly; we apply them to the summary/description before posting)
    const guardrailViolation = this.checkGuardrails(payload);
    if (guardrailViolation) {
      throw new Error(`Jira guardrail violation: ${guardrailViolation}`);
    }

    const body: Record<string, unknown> = {
      fields: {
        project: { key: this.config.projectKey },
        summary: payload.summary.slice(0, 255),
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: payload.description }],
            },
          ],
        },
        issuetype: { name: this.config.issueType ?? 'Bug' },
        ...(payload.priority ? { priority: { name: payload.priority } } : {}),
        ...(payload.labels || this.config.labels
          ? { labels: [...(this.config.labels ?? []), ...(payload.labels ?? [])] }
          : {}),
        ...payload.extraFields,
      },
    };

    const result = await this.post('/rest/api/3/issue', body);
    const url = `${this.config.baseUrl}/browse/${result.key as string}`;
    logger.info(`Jira issue created: ${result.key as string} — ${url}`);
    return { id: result.id as string, key: result.key as string, url };
  }

  /**
   * Add a comment to an existing issue.
   */
  async addComment(issueKey: string, comment: string): Promise<void> {
    const body = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: comment }],
          },
        ],
      },
    };
    await this.post(`/rest/api/3/issue/${issueKey}/comment`, body);
    logger.info(`Jira comment added to ${issueKey}`);
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private checkGuardrails(payload: JiraIssuePayload): string | null {
    const rules = this.config.guardrails ?? [];
    for (const rule of rules) {
      // Rule format: "deny-keyword:<word>" — block tickets containing the word
      if (rule.startsWith('deny-keyword:')) {
        const kw = rule.slice('deny-keyword:'.length).toLowerCase();
        const text = `${payload.summary} ${payload.description}`.toLowerCase();
        if (text.includes(kw)) {
          return `Issue content contains denied keyword "${kw}" (rule: ${rule})`;
        }
      }
      // Rule format: "require-label:<label>" — enforce a label
      if (rule.startsWith('require-label:')) {
        const required = rule.slice('require-label:'.length);
        const labels = [...(this.config.labels ?? []), ...(payload.labels ?? [])];
        if (!labels.includes(required)) {
          return `Issue must have label "${required}" (rule: ${rule})`;
        }
      }
      // Rule format: "max-summary-length:<n>"
      if (rule.startsWith('max-summary-length:')) {
        const max = parseInt(rule.slice('max-summary-length:'.length), 10);
        if (!isNaN(max) && payload.summary.length > max) {
          return `Summary exceeds max length ${max} (rule: ${rule})`;
        }
      }
    }
    return null;
  }

  private post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const baseUrl = new URL(this.config.baseUrl);
      const isHttps = baseUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const port = baseUrl.port
        ? parseInt(baseUrl.port, 10)
        : isHttps ? 443 : 80;

      const payload = JSON.stringify(body);
      const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');

      const req = transport.request(
        {
          hostname: baseUrl.hostname,
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Basic ${token}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              const statusCode = res.statusCode ?? 0;
              if (statusCode >= 200 && statusCode < 300) {
                resolve(parsed);
              } else {
                reject(new Error(`Jira API error ${statusCode}: ${data}`));
              }
            } catch {
              reject(new Error(`Jira response parse error: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
