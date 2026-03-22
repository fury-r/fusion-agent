// Main library entry point
export * from './providers';
export * from './session';
export * from './speckits';
export { LiveDebugger, LogWatcher, ServiceConnector } from './live-debugger';
export type { LiveDebuggerOptions, ServiceConnectionOptions } from './live-debugger';
export { ClusterMonitor, RemediationEngine, NotificationManager, KubernetesConnector, discoverServices, loadClusterRules, validateClusterRules, findMatchingRule, avoidanceRulesToSystemPrompt, DEFAULT_CLUSTER_RULES } from './cluster-monitor';
export type { ClusterMonitorConfig, ServiceTarget, AllServiceConnectionOptions, KubernetesConnectionOptions, LogFileConnectionOptions, MonitorMode, ClusterRules, RemediationRule, RemediationAction, AvoidanceRule, NotificationConfig, DetectedFailure, HITLRequest, HITLResponse, ClusterRulesFile, RemediationResult, NotificationMessage } from './cluster-monitor';
export { createWebServer } from './web/server';
export { loadConfig, saveConfig } from './utils/config';
export type { AIAgentConfig, GuardrailConfig } from './utils/config';
export { gatherProjectContext, getDirectoryStructure, createChange, applyChange, revertChange } from './utils/file-ops';

import { loadConfig, AIAgentConfig } from './utils/config';
import { createProvider } from './providers';
import { SessionManager } from './session/session-manager';
import { SessionConfig } from './session/session';
import { Session } from './session/session';
import { SPECKITS } from './speckits';
import os from 'os';
import path from 'path';

export interface AgentCLIOptions extends Partial<AIAgentConfig> {
  sessionsDir?: string;
}

/**
 * Main programmatic API for vibe-agent.
 */
export class AgentCLI {
  private config: AIAgentConfig;
  public readonly sessionManager: SessionManager;

  constructor(options: AgentCLIOptions = {}) {
    this.config = loadConfig(options);
    const sessionsDir = options.sessionsDir || this.config.sessionDir || path.join(os.homedir(), '.vibe-agent', 'sessions');
    this.sessionManager = new SessionManager(sessionsDir);
  }

  /**
   * Create a new agent session.
   */
  createSession(config: Partial<SessionConfig> & { name: string }): Session {
    const speckit = config.speckit ? SPECKITS[config.speckit] : undefined;
    const fullConfig: SessionConfig = {
      provider: config.provider || this.config.provider,
      model: config.model || this.config.model || '',
      guardrails: (config.guardrails || this.config.guardrails || []).map((g) => ({
        id: (g as { id?: string }).id || `gr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: g.type,
        value: g.value,
        description: g.description,
      })),
      systemPrompt: config.systemPrompt || speckit?.systemPrompt,
      projectDir: config.projectDir || process.cwd(),
      speckit: config.speckit,
      name: config.name,
    };
    return this.sessionManager.createSession(fullConfig, this.config.apiKey);
  }

  /**
   * Load an existing session by ID.
   */
  loadSession(sessionId: string): Session {
    return this.sessionManager.loadSession(sessionId, this.config.apiKey);
  }

  /**
   * Quick one-shot chat without managing sessions.
   */
  async chat(message: string, options: { provider?: string; model?: string; speckit?: string; stream?: boolean; onChunk?: (c: string) => void } = {}): Promise<string> {
    const speckit = options.speckit ? SPECKITS[options.speckit] : undefined;
    const provider = createProvider({
      provider: (options.provider || this.config.provider) as 'openai' | 'anthropic' | 'gemini',
      model: options.model || this.config.model,
      apiKey: this.config.apiKey,
    });

    const result = await provider.complete({
      messages: [
        { role: 'system', content: speckit?.systemPrompt || 'You are a helpful AI coding assistant.' },
        { role: 'user', content: message },
      ],
      stream: options.stream,
      onChunk: options.onChunk,
    });
    return result.content;
  }
}
