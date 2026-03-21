import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  ClusterRules,
  ClusterRulesFile,
  RemediationRule,
  AvoidanceRule,
} from './types';

// ── File loading ─────────────────────────────────────────────────────────────

/**
 * Load cluster rules from a YAML or JSON file.
 * Throws if the file is missing or cannot be parsed.
 */
export function loadClusterRules(filePath: string): ClusterRulesFile {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Cluster rules file not found: ${absPath}`);
  }
  const content = fs.readFileSync(absPath, 'utf-8');
  const ext = path.extname(absPath).toLowerCase();
  const raw =
    ext === '.yaml' || ext === '.yml'
      ? (yaml.load(content) as Partial<ClusterRulesFile>)
      : (JSON.parse(content) as Partial<ClusterRulesFile>);
  return validateClusterRules(raw);
}

/**
 * Validate a raw (possibly partial) rules file object and fill in defaults.
 */
export function validateClusterRules(raw: Partial<ClusterRulesFile>): ClusterRulesFile {
  const rawRules: Partial<ClusterRules> = raw.rules || {};
  return {
    version: raw.version || '1.0',
    rules: {
      canAutoFix: (rawRules.canAutoFix || []).map((r: Partial<RemediationRule>, i: number): RemediationRule => ({
        id: r.id || `rule-${i}`,
        name: r.name || `Rule ${i}`,
        description: r.description || '',
        trigger: r.trigger || '',
        action: r.action || { type: 'notify-only' },
        priority: r.priority ?? 0,
        requireApproval: r.requireApproval ?? false,
      })),
      avoid: (rawRules.avoid || []).map((a: Partial<AvoidanceRule>, i: number): AvoidanceRule => ({
        id: a.id || `avoid-${i}`,
        description: a.description || '',
        pattern: a.pattern || '',
      })),
      requireApproval: rawRules.requireApproval || [],
    },
    notifications: raw.notifications,
  };
}

// ── Rule matching ─────────────────────────────────────────────────────────────

/**
 * Find the highest-priority remediation rule whose trigger matches the given log lines.
 * Returns null if no rule matches.
 */
export function findMatchingRule(
  logLines: string[],
  rules: RemediationRule[]
): RemediationRule | null {
  if (!logLines.length || !rules.length) return null;

  const logText = logLines.join('\n');
  const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const rule of sorted) {
    let matched: boolean;
    try {
      matched = new RegExp(rule.trigger, 'i').test(logText);
    } catch {
      // Trigger is not a valid regex — fall back to case-insensitive substring
      matched = logText.toLowerCase().includes(rule.trigger.toLowerCase());
    }
    if (matched) return rule;
  }
  return null;
}

// ── System-prompt helpers ─────────────────────────────────────────────────────

/**
 * Convert avoidance rules into a system-prompt section the AI must honour.
 */
export function avoidanceRulesToSystemPrompt(avoid: AvoidanceRule[]): string {
  if (!avoid.length) return '';
  return [
    '## CLUSTER REMEDIATION CONSTRAINTS (MUST FOLLOW)',
    'You MUST NOT perform any of the following operations:',
    ...avoid.map((a) => `- ${a.description}`),
    'Violating any of the above is STRICTLY PROHIBITED.',
  ].join('\n');
}

// ── Safe defaults ─────────────────────────────────────────────────────────────

/**
 * Conservative default rules shipped with the library.
 * No auto-fix actions are enabled by default (opt-in model).
 * Only hard avoidance constraints are set.
 */
export const DEFAULT_CLUSTER_RULES: ClusterRules = {
  canAutoFix: [],
  avoid: [
    {
      id: 'avoid-delete-db',
      description:
        'Do not delete databases, persistent volumes, or any storage resources',
      pattern: 'delete.*pv|delete.*pvc|drop.*database|truncate.*table',
    },
    {
      id: 'avoid-delete-secrets',
      description: 'Do not delete Kubernetes Secrets or ConfigMaps',
      pattern: 'delete.*secret|delete.*configmap',
    },
    {
      id: 'avoid-scale-zero',
      description: 'Do not scale any deployment to zero replicas',
      pattern: 'scale.*replicas.*0',
    },
    {
      id: 'avoid-delete-namespace',
      description: 'Do not delete namespaces or cluster-level resources',
      pattern: 'delete.*namespace',
    },
    {
      id: 'avoid-all-at-once',
      description: 'Do not stop or delete all services simultaneously',
      pattern: 'delete all|stop all|remove all',
    },
  ],
  requireApproval: ['database-migration', 'config-change', 'dependency-update'],
};
