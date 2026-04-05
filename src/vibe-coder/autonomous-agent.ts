import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { Session } from '../session/session';
import { logger } from '../utils/logger';
import {
  AutonomousConfig,
  AutonomousStatus,
  HILReason,
  HILRequest,
  VibeCoderStep,
} from './types';
import { extractFileBlocks, detectCompletion, extractBrowserBlocks, extractAgentBlocks } from './file-parser';
import { LoopDetector } from './loop-detector';
import { loadSkillsContent } from '../skills/registry';
import { BrowserController } from '../browser/browser-controller';
import { agentBus } from '../agent-bus/agent-bus';

/**
 * Events emitted by AutonomousVibeAgent:
 *
 *  'status'        (status: AutonomousStatus)
 *  'chunk'         (chunk: string, stepNumber: number)  — streaming token
 *  'file-changed'  (filePath: string, stepNumber: number)
 *  'step'          (step: VibeCoderStep)  — after each step completes
 *  'hil-request'   (request: HILRequest) — agent needs human guidance
 *  'complete'      (steps: VibeCoderStep[])
 *  'error'         (err: Error)
 */
export class AutonomousVibeAgent extends EventEmitter {
  private readonly session: Session;
  private readonly config: AutonomousConfig;
  private status: AutonomousStatus = 'idle';
  private readonly steps: VibeCoderStep[] = [];
  private readonly loopDetector: LoopDetector;
  private stepsWithoutChanges = 0;
  private startTime = 0;
  private stopped = false;
  private pendingHILResolve?: (guidance: string) => void;
  private browser: BrowserController | null = null;

  constructor(session: Session, config: AutonomousConfig) {
    super();
    if (!config.requirementsFile && !config.requirementsContent) {
      throw new Error(
        'AutonomousVibeAgent: either requirementsFile or requirementsContent is required'
      );
    }
    this.session = session;
    this.config = config;
    this.loopDetector = new LoopDetector(
      config.loopWindowSize ?? 4,
      config.loopSimilarityThreshold ?? 0.85
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start the autonomous run. Resolves when complete, stopped, or timed-out. */
  async run(): Promise<void> {
    if (this.status !== 'idle') throw new Error('Agent is already running');

    this.startTime = Date.now();
    this.setStatus('running');

    // Register on the agent bus so other agents can send messages to this session
    agentBus.register(this.session);

    try {
      const requirements = this.loadRequirements();
      const rulesText = this.buildRulesText();
      const maxSteps = this.config.maxSteps ?? 50;

      // Step 0 — inject requirements and generate the plan + first implementation
      const planPrompt = this.buildPlanPrompt(requirements, rulesText);
      const planResponse = await this.sendStep(0, planPrompt);
      const planFiles = this.applyFileChanges(planResponse, 0);
      await this.executeBrowserBlocks(planResponse, 0);
      await this.executeAgentBlocks(planResponse);
      this.recordStep(0, planPrompt, planResponse, planFiles);

      if (detectCompletion(planResponse)) {
        this.setStatus('completed');
        this.emit('complete', [...this.steps]);
        return;
      }

      // Main execution loop
      for (let step = 1; step <= maxSteps; step++) {
        if (this.stopped) break;

        if (this.isTimedOut()) {
          logger.warn('Autonomous vibe agent timed out');
          this.setStatus('timed-out');
          this.emit('complete', [...this.steps]);
          return;
        }

        const stepPrompt =
          `Continue implementing the requirements. This is step ${step}. ` +
          `Apply the next pending item from your plan. ` +
          `When ALL requirements are fully implemented, end your response with exactly: REQUIREMENTS_COMPLETE`;

        let response: string;
        try {
          response = await this.sendStep(step, stepPrompt);
        } catch (err) {
          if (this.stopped) break;
          logger.error(`Autonomous step ${step} failed: ${err}`);
          const guidance = await this.requestHIL(
            step,
            'error',
            `Step ${step} threw an error: ${String(err)}`
          );
          if (this.stopped) break;
          response = await this.sendStep(
            step,
            `User guidance: ${guidance}\n\nContinue from where you left off.`
          );
        }

        const changedFiles = this.applyFileChanges(response, step);
        await this.executeBrowserBlocks(response, step);
        await this.executeAgentBlocks(response);
        this.recordStep(step, stepPrompt, response, changedFiles);

        // No-progress tracking
        if (changedFiles.length === 0) {
          this.stepsWithoutChanges++;
        } else {
          this.stepsWithoutChanges = 0;
        }

        // Loop / stuck detection
        const isLoop = this.loopDetector.add(response);
        const isStuck =
          this.stepsWithoutChanges >= (this.config.stuckThreshold ?? 3);

        if (isLoop || isStuck) {
          if (this.stopped) break;
          const reason: HILReason = isLoop ? 'loop-detected' : 'stuck';
          const guidance = await this.requestHIL(step, reason);
          if (this.stopped) break;
          // Inject guidance as context and let the agent recalibrate
          await this.sendStep(
            step,
            `User guidance received: ${guidance}\n\n` +
            `Please re-read the original requirements and continue implementation ` +
            `in a different way, avoiding what you have already tried.`
          );
          this.stepsWithoutChanges = 0;
          this.loopDetector.reset();
        }

        if (detectCompletion(response)) {
          this.setStatus('completed');
          this.emit('complete', [...this.steps]);
          return;
        }
      }

      if (!this.stopped) {
        // Exhausted max steps — ask user how to proceed
        await this.requestHIL(this.steps.length, 'max-steps-reached');
      }

      this.setStatus(this.stopped ? 'stopped' : 'completed');
      this.emit('complete', [...this.steps]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Autonomous vibe agent error: ${error.message}`);
      this.setStatus('stopped');
      this.emit('error', error);
    } finally {
      agentBus.unregister(this.session.id);
      await this.browser?.close();
      this.browser = null;
    }
  }

  /**
   * Provide human guidance to an agent that is waiting at a HIL checkpoint.
   * No-op if the agent is not currently waiting.
   */
  receiveHILResponse(guidance: string): void {
    if (this.pendingHILResolve) {
      const resolve = this.pendingHILResolve;
      this.pendingHILResolve = undefined;
      resolve(guidance);
    }
  }

  /** Abort the agent. Safe to call multiple times or when not running. */
  stop(): void {
    this.stopped = true;
    if (this.pendingHILResolve) {
      const resolve = this.pendingHILResolve;
      this.pendingHILResolve = undefined;
      resolve('Stop execution.');
    }
    this.setStatus('stopped');
    agentBus.unregister(this.session.id);
    void this.browser?.close();
    this.browser = null;
  }

  getStatus(): AutonomousStatus {
    return this.status;
  }

  getSteps(): VibeCoderStep[] {
    return [...this.steps];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async sendStep(stepNumber: number, prompt: string): Promise<string> {
    let response = '';
    await this.session.chat(prompt, {
      stream: true,
      onChunk: (chunk) => {
        response += chunk;
        this.emit('chunk', chunk, stepNumber);
      },
    });
    return response;
  }

  private applyFileChanges(response: string, stepNumber: number): string[] {
    const blocks = extractFileBlocks(response);
    const projectDir = this.session.config.projectDir ?? process.cwd();
    const applied: string[] = [];

    for (const block of blocks) {
      try {
        const absPath = path.isAbsolute(block.filePath)
          ? block.filePath
          : path.resolve(projectDir, block.filePath);
        this.session.applyFileChange(absPath, block.content);
        applied.push(block.filePath);
        this.emit('file-changed', block.filePath, stepNumber);
      } catch (err) {
        logger.warn(`Could not apply file change "${block.filePath}": ${err}`);
      }
    }
    return applied;
  }

  private recordStep(
    stepNumber: number,
    prompt: string,
    response: string,
    filesChanged: string[]
  ): void {
    const step: VibeCoderStep = {
      stepNumber,
      prompt,
      response,
      filesChanged,
      timestamp: new Date().toISOString(),
    };
    this.steps.push(step);
    this.emit('step', step);
  }

  /**
   * Pause execution, ask the AI to summarise its confusion, then emit a
   * `hil-request` event and wait for `receiveHILResponse()` to be called.
   */
  private async requestHIL(
    stepNumber: number,
    reason: HILReason,
    extraContext?: string
  ): Promise<string> {
    this.setStatus('waiting-hil');

    // Ask the AI to articulate what it is confused about
    let confusionSummary =
      extraContext ?? `Reason: ${reason.replace(/-/g, ' ')}.`;
    try {
      const clarifyTurn = await this.session.chat(
        'In 2–3 sentences, describe exactly what you are trying to implement, ' +
        'what you have already done, and what is blocking your progress or ' +
        'causing you to produce repetitive responses.',
        { stream: false }
      );
      confusionSummary = clarifyTurn.assistantMessage;
    } catch {
      // Keep the fallback summary
    }

    const request: HILRequest = {
      stepNumber,
      reason,
      confusionSummary,
      recentSteps: this.steps.slice(-3),
    };
    this.emit('hil-request', request);

    const guidance = await new Promise<string>((resolve) => {
      this.pendingHILResolve = resolve;
    });

    if (!this.stopped) this.setStatus('running');
    return guidance;
  }

  private loadRequirements(): string {
    if (this.config.requirementsContent) {
      return this.config.requirementsContent;
    }
    const filePath = this.config.requirementsFile!;
    if (!fs.existsSync(filePath)) {
      throw new Error(`Requirements file not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  private buildRulesText(): string {
    const rules = this.config.rules ?? [];
    if (rules.length === 0) return '';
    return (
      '\n\nRules you MUST follow:\n' +
      rules.map((r, i) => `${i + 1}. ${r.description}`).join('\n')
    );
  }

  private buildPlanPrompt(requirements: string, rulesText: string): string {
    const skillNames = this.config.skills ?? [];
    let skillsSection = '';
    if (skillNames.length > 0) {
      const content = loadSkillsContent(skillNames);
      if (content) {
        skillsSection = `\n\nSKILLS & DOMAIN KNOWLEDGE:\n${content}\n`;
      }
    }

    const browserNote = this.config.browserEnabled
      ? '\n\nBROWSER CONTROL: You have access to a browser. Emit browser instructions ' +
      'inside <browser>…</browser> tags (one instruction per line):\n' +
      '  navigate <url>    — go to a URL\n' +
      '  snapshot          — capture the current page text\n' +
      '  click <selector>  — click a CSS selector\n' +
      '  type <selector> <text> — type text into a field\n' +
      '  eval <js>         — evaluate JavaScript and return the result\n' +
      'Results will be injected into your next step as context.'
      : '';

    const agentNote =
      '\n\nAGENT-TO-AGENT: You can message other active sessions by emitting:\n' +
      '  <agent>send to:<sessionId> message:<your message></agent>\n' +
      'The reply will be injected into your next step as context.';

    return (
      `You are an autonomous AI developer (vibe coder). ` +
      `Fully implement the following requirements by making all necessary file changes.\n\n` +
      `REQUIREMENTS:\n${requirements}${rulesText}${skillsSection}${browserNote}${agentNote}\n\n` +
      `INSTRUCTIONS:\n` +
      `1. First, write a numbered implementation plan.\n` +
      `2. Immediately implement step 1 by writing complete file content in code blocks:\n` +
      `   \`\`\`typescript:src/path/to/file.ts\n` +
      `   // complete file content\n` +
      `   \`\`\`\n` +
      `3. In each subsequent message you will implement the next step.\n` +
      `4. When ALL requirements are fully implemented, end your response with: REQUIREMENTS_COMPLETE\n\n` +
      `Begin your plan and implement step 1 now.`
    );
  }

  /**
   * Parse and execute any <browser>…</browser> blocks in the AI response.
   * Results are injected back into the session as a system context message.
   */
  private async executeBrowserBlocks(response: string, stepNumber: number): Promise<void> {
    if (!this.config.browserEnabled) return;
    const blocks = extractBrowserBlocks(response);
    if (blocks.length === 0) return;

    if (!this.browser) {
      this.browser = new BrowserController(this.config.browserExecutablePath);
    }

    for (const block of blocks) {
      const results = await this.browser.execute(block.instructions);
      const summary = results
        .map((r) => `[${r.success ? 'OK' : 'ERR'}] ${r.action}${r.data ? `\n${r.data}` : ''}${r.error ? `\nError: ${r.error}` : ''}`)
        .join('\n\n');

      logger.debug(`Browser results (step ${stepNumber}):\n${summary.slice(0, 500)}`);

      // Inject browser results back into the conversation
      await this.session.chat(
        `[Browser results from step ${stepNumber}]:\n${summary}\n\nContinue based on these results.`,
        { stream: false }
      );
    }
  }

  /**
   * Parse and dispatch any <agent>send to:<id> message:<text></agent> blocks.
   * Replies are injected back into the session as context.
   */
  private async executeAgentBlocks(response: string): Promise<void> {
    const blocks = extractAgentBlocks(response);
    if (blocks.length === 0) return;

    for (const block of blocks) {
      try {
        if (!agentBus.isRegistered(block.toSessionId)) {
          logger.warn(
            `Agent-to-agent: target session "${block.toSessionId}" is not registered`
          );
          continue;
        }
        const reply = await agentBus.send(this.session.id, block.toSessionId, block.message);
        logger.debug(
          `Agent-to-agent reply from ${block.toSessionId}: ${reply.slice(0, 120)}`
        );
        // Inject the reply back into this session
        await this.session.chat(
          `[Reply from agent ${block.toSessionId}]: ${reply}\n\nContinue based on this reply.`,
          { stream: false }
        );
      } catch (err) {
        logger.warn(`Agent-to-agent send failed: ${err}`);
      }
    }
  }

  private isTimedOut(): boolean {
    const limit = this.config.timeLimitSeconds;
    if (!limit || limit <= 0) return false;
    return (Date.now() - this.startTime) / 1000 >= limit;
  }

  private setStatus(status: AutonomousStatus): void {
    this.status = status;
    this.emit('status', status);
  }
}
