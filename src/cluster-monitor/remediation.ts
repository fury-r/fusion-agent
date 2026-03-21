import { spawn } from 'child_process';
import { Session } from '../session/session';
import {
  ClusterRules,
  RemediationRule,
  RemediationAction,
  DetectedFailure,
} from './types';
import { avoidanceRulesToSystemPrompt, findMatchingRule } from './rules';
import { logger } from '../utils/logger';

// ── Result type ───────────────────────────────────────────────────────────────

export interface RemediationResult {
  success: boolean;
  action: string;
  output?: string;
  error?: string;
  requiresApproval: boolean;
}

// ── Remediation engine ────────────────────────────────────────────────────────

/**
 * Analyses failures with AI and executes (or proposes) remediation actions
 * subject to the ClusterRules constraints.
 */
export class RemediationEngine {
  private session: Session;
  private rules: ClusterRules;

  constructor(session: Session, rules: ClusterRules) {
    this.session = session;
    this.rules = rules;
  }

  // ── AI analysis ────────────────────────────────────────────────────────────

  /**
   * Ask the AI to analyse the failure and return a proposed fix as a string.
   */
  async analyzeAndProposeFix(failure: DetectedFailure): Promise<string> {
    const avoidanceContext = avoidanceRulesToSystemPrompt(this.rules.avoid);
    const logText = failure.logLines.join('\n');

    const prompt = [
      `You are analyzing logs from service "${failure.serviceName}" running in a cluster.`,
      '',
      'Recent log output:',
      '```',
      logText,
      '```',
      '',
      `Error summary: ${failure.errorSummary}`,
      '',
      'Please:',
      '1. Identify the root cause',
      '2. Explain why it is happening',
      '3. Propose a concrete, minimal fix',
      '4. Rate confidence: low / medium / high',
      '5. Rate risk: low / medium / high',
      '',
      ...(avoidanceContext ? [avoidanceContext] : []),
    ].join('\n');

    let analysis = '';
    await this.session.chat(prompt, {
      stream: true,
      onChunk: (chunk) => { analysis += chunk; },
    });
    return analysis;
  }

  // ── Rule helpers ────────────────────────────────────────────────────────────

  /** Return the highest-priority rule that matches these log lines, or null. */
  findApplicableRule(failure: DetectedFailure): RemediationRule | null {
    return findMatchingRule(failure.logLines, this.rules.canAutoFix);
  }

  /**
   * Returns true if this rule (or its action type) requires human approval
   * even when running in auto-fix mode.
   */
  requiresApproval(rule: RemediationRule): boolean {
    if (rule.requireApproval) return true;
    if (this.rules.requireApproval?.includes(rule.action.type)) return true;
    return false;
  }

  // ── Action execution ────────────────────────────────────────────────────────

  /** Execute a concrete remediation action and return the result. */
  async applyAction(
    action: RemediationAction,
    failure: DetectedFailure
  ): Promise<RemediationResult> {
    logger.info(`Applying remediation action "${action.type}" for ${failure.serviceName}`);

    switch (action.type) {
      case 'restart-pod':
        return this.exec('kubectl', [
          'rollout', 'restart',
          ...(action.namespace ? ['-n', action.namespace] : []),
          action.selector || `deployment/${failure.serviceName}`,
        ]);

      case 'scale-deployment':
        return this.exec('kubectl', [
          'scale',
          ...(action.namespace ? ['-n', action.namespace] : []),
          `deployment/${failure.serviceName}`,
          `--replicas=${action.replicas}`,
        ]);

      case 'kubectl':
        return this.exec('kubectl', [action.subcommand, ...(action.args || [])]);

      case 'docker':
        return this.exec('docker', [action.subcommand, ...(action.args || [])]);

      case 'exec-command':
        return this.exec(action.command, action.args || []);

      case 'ai-fix':
        // AI-generated code changes always surface for human review
        return {
          success: true,
          action: 'ai-fix',
          output: failure.proposedFix || failure.aiAnalysis || 'No fix available.',
          requiresApproval: true,
        };

      case 'notify-only':
        return { success: true, action: 'notify-only', output: 'Notification sent.', requiresApproval: false };

      default: {
        const unknownType = (action as RemediationAction).type;
        return {
          success: false,
          action: unknownType,
          error: `Unknown action type: ${unknownType}`,
          requiresApproval: false,
        };
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private exec(cmd: string, args: string[]): Promise<RemediationResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, action: `${cmd} ${args.join(' ')}`, output: stdout.trim(), requiresApproval: false });
        } else {
          resolve({ success: false, action: `${cmd} ${args.join(' ')}`, error: stderr.trim() || `Exit code ${code}`, requiresApproval: false });
        }
      });
      child.on('error', (err) => {
        resolve({ success: false, action: `${cmd} ${args.join(' ')}`, error: err.message, requiresApproval: false });
      });
    });
  }
}
