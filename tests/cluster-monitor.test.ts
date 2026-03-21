import {
  findMatchingRule,
  validateClusterRules,
  avoidanceRulesToSystemPrompt,
  DEFAULT_CLUSTER_RULES,
  loadClusterRules,
} from '../src/cluster-monitor/rules';
import { NotificationManager } from '../src/cluster-monitor/notifications';
import {
  RemediationRule,
  AvoidanceRule,
  ClusterRulesFile,
  NotificationConfig,
} from '../src/cluster-monitor/types';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── findMatchingRule ──────────────────────────────────────────────────────────

describe('findMatchingRule', () => {
  const rules: RemediationRule[] = [
    {
      id: 'rule-oom',
      name: 'Restart on OOM',
      description: 'Restart when out of memory',
      trigger: 'OOMKilled|out of memory',
      action: { type: 'restart-pod' },
      priority: 10,
    },
    {
      id: 'rule-crash',
      name: 'Restart on crash',
      description: 'Restart on exit',
      trigger: 'crash|CrashLoopBackOff',
      action: { type: 'restart-pod' },
      priority: 5,
    },
  ];

  it('returns null when log lines are empty', () => {
    expect(findMatchingRule([], rules)).toBeNull();
  });

  it('returns null when no rules are provided', () => {
    expect(findMatchingRule(['ERROR: something bad'], [])).toBeNull();
  });

  it('returns null when no rule matches', () => {
    expect(findMatchingRule(['INFO: request processed', 'DEBUG: cache hit'], rules)).toBeNull();
  });

  it('matches a rule using regex trigger (case-insensitive)', () => {
    const result = findMatchingRule(['FATAL: OOMKilled — container exceeded limit'], rules);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('rule-oom');
  });

  it('returns the highest-priority matching rule when multiple rules match', () => {
    // Both "OOMKilled" and "crash" appear — rule-oom (priority 10) should win
    const result = findMatchingRule(['OOMKilled crash loop detected'], rules);
    expect(result?.id).toBe('rule-oom');
  });

  it('falls back to substring matching when trigger is an invalid regex', () => {
    const invalidRule: RemediationRule = {
      id: 'r-invalid',
      name: 'invalid regex',
      description: '',
      trigger: '[unclosed bracket',
      action: { type: 'notify-only' },
    };
    // The trigger string as a substring is present in the log line
    const result = findMatchingRule(['error: [unclosed bracket found'], [invalidRule]);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('r-invalid');
  });

  it('returns null when invalid-regex trigger does not match as substring either', () => {
    const invalidRule: RemediationRule = {
      id: 'r-invalid',
      name: 'invalid regex',
      description: '',
      trigger: '[unclosed bracket',
      action: { type: 'notify-only' },
    };
    expect(findMatchingRule(['INFO: completely unrelated'], [invalidRule])).toBeNull();
  });
});

// ── validateClusterRules ──────────────────────────────────────────────────────

describe('validateClusterRules', () => {
  it('fills in defaults for an empty input', () => {
    const result = validateClusterRules({});
    expect(result.version).toBe('1.0');
    expect(result.rules.canAutoFix).toEqual([]);
    expect(result.rules.avoid).toEqual([]);
    expect(result.rules.requireApproval).toEqual([]);
  });

  it('assigns generated ids when id is empty or absent', () => {
    const raw: Partial<ClusterRulesFile> = {
      rules: {
        canAutoFix: [
          { id: '', name: 'Test', description: '', trigger: 'error', action: { type: 'notify-only' } },
        ],
        avoid: [{ id: '', description: 'No deletes', pattern: 'delete' }],
      },
    };
    const result = validateClusterRules(raw);
    expect(result.rules.canAutoFix[0].id).toBeTruthy();
    expect(result.rules.avoid[0].id).toBeTruthy();
  });

  it('sets default priority to 0 when not supplied', () => {
    const raw: Partial<ClusterRulesFile> = {
      rules: {
        canAutoFix: [
          { id: 'r1', name: 'Test', description: '', trigger: 'error', action: { type: 'notify-only' } },
        ],
        avoid: [],
      },
    };
    const result = validateClusterRules(raw);
    expect(result.rules.canAutoFix[0].priority).toBe(0);
  });

  it('sets requireApproval to false by default', () => {
    const raw: Partial<ClusterRulesFile> = {
      rules: {
        canAutoFix: [
          { id: 'r1', name: 'Test', description: '', trigger: 'error', action: { type: 'notify-only' } },
        ],
        avoid: [],
      },
    };
    const result = validateClusterRules(raw);
    expect(result.rules.canAutoFix[0].requireApproval).toBe(false);
  });

  it('preserves existing version', () => {
    const result = validateClusterRules({ version: '2.5', rules: { canAutoFix: [], avoid: [] } });
    expect(result.version).toBe('2.5');
  });
});

// ── avoidanceRulesToSystemPrompt ──────────────────────────────────────────────

describe('avoidanceRulesToSystemPrompt', () => {
  it('returns empty string for an empty avoidance list', () => {
    expect(avoidanceRulesToSystemPrompt([])).toBe('');
  });

  it('includes all avoidance descriptions in the prompt', () => {
    const avoid: AvoidanceRule[] = [
      { id: 'a1', description: 'Do not delete databases', pattern: 'delete.*db' },
      { id: 'a2', description: 'Do not scale to zero', pattern: 'scale.*0' },
    ];
    const prompt = avoidanceRulesToSystemPrompt(avoid);
    expect(prompt).toContain('Do not delete databases');
    expect(prompt).toContain('Do not scale to zero');
  });

  it('includes the STRICTLY PROHIBITED footer', () => {
    const avoid: AvoidanceRule[] = [
      { id: 'a1', description: 'No deletes', pattern: 'delete' },
    ];
    expect(avoidanceRulesToSystemPrompt(avoid)).toContain('STRICTLY PROHIBITED');
  });
});

// ── DEFAULT_CLUSTER_RULES ─────────────────────────────────────────────────────

describe('DEFAULT_CLUSTER_RULES', () => {
  it('has no canAutoFix entries (safe-by-default, opt-in model)', () => {
    expect(DEFAULT_CLUSTER_RULES.canAutoFix).toHaveLength(0);
  });

  it('contains avoidance rules for dangerous operations', () => {
    const ids = DEFAULT_CLUSTER_RULES.avoid.map((a) => a.id);
    expect(ids).toContain('avoid-delete-db');
    expect(ids).toContain('avoid-scale-zero');
    expect(ids).toContain('avoid-delete-namespace');
    expect(ids).toContain('avoid-delete-secrets');
  });

  it('requires approval for database-migration and config-change', () => {
    expect(DEFAULT_CLUSTER_RULES.requireApproval).toContain('database-migration');
    expect(DEFAULT_CLUSTER_RULES.requireApproval).toContain('config-change');
  });
});

// ── loadClusterRules ─────────────────────────────────────────────────────────

describe('loadClusterRules', () => {
  const tmpDir = os.tmpdir();

  it('loads and validates a YAML rules file', () => {
    const yaml = `
version: "1.0"
rules:
  canAutoFix:
    - id: r1
      name: Test rule
      description: restart on crash
      trigger: "crash"
      action:
        type: restart-pod
  avoid:
    - id: a1
      description: No deletes
      pattern: delete
`;
    const file = path.join(tmpDir, 'test-rules.yaml');
    fs.writeFileSync(file, yaml, 'utf-8');
    const result = loadClusterRules(file);
    expect(result.rules.canAutoFix).toHaveLength(1);
    expect(result.rules.canAutoFix[0].id).toBe('r1');
    expect(result.rules.avoid).toHaveLength(1);
    fs.unlinkSync(file);
  });

  it('loads and validates a JSON rules file', () => {
    const json = JSON.stringify({
      version: '1.0',
      rules: { canAutoFix: [], avoid: [] },
    });
    const file = path.join(tmpDir, 'test-rules.json');
    fs.writeFileSync(file, json, 'utf-8');
    const result = loadClusterRules(file);
    expect(result.rules.canAutoFix).toEqual([]);
    fs.unlinkSync(file);
  });

  it('throws when the file does not exist', () => {
    expect(() => loadClusterRules('/nonexistent/path/rules.yaml')).toThrow(
      /not found/i
    );
  });
});

// ── NotificationManager ───────────────────────────────────────────────────────

describe('NotificationManager', () => {
  it('instantiates without errors', () => {
    const mgr = new NotificationManager({
      slack: { enabled: false, webhookUrl: 'https://hooks.slack.com/test' },
    });
    expect(mgr).toBeDefined();
  });

  it('resolves without throwing when all channels are disabled', async () => {
    const config: NotificationConfig = {
      slack: { enabled: false, webhookUrl: 'https://hooks.slack.com/test' },
      webhook: { enabled: false, url: 'https://example.com/hook' },
      teams: { enabled: false, webhookUrl: 'https://teams.example.com/hook' },
      pagerduty: { enabled: false, integrationKey: 'abc123' },
      email: {
        enabled: false,
        gatewayUrl: 'https://api.sendgrid.com/v3/mail/send',
        to: ['test@example.com'],
      },
    };
    const mgr = new NotificationManager(config);
    await expect(
      mgr.send({
        title: 'Test alert',
        body: 'Something went wrong',
        severity: 'error',
        service: 'test-service',
      })
    ).resolves.toBeUndefined();
  });

  it('handles an empty config without throwing', async () => {
    const mgr = new NotificationManager({});
    await expect(
      mgr.send({ title: 'T', body: 'B', severity: 'info', service: 'svc' })
    ).resolves.toBeUndefined();
  });
});
