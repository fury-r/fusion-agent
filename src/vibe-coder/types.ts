export interface VibeCoderRule {
  /** Short identifier */
  id: string;
  /** Human-readable constraint description */
  description: string;
}

export interface AutonomousConfig {
  /**
   * Path to a requirements file on the server filesystem.
   * Either this or `requirementsContent` is required.
   */
  requirementsFile?: string;
  /**
   * Raw requirements text (used when the caller provides content directly,
   * e.g. pasted into the Web UI).
   * Either this or `requirementsFile` is required.
   */
  requirementsContent?: string;
  /** Rules the agent must follow during autonomous execution. */
  rules?: VibeCoderRule[];
  /** Maximum wall-clock runtime in seconds. 0 or undefined = no limit. */
  timeLimitSeconds?: number;
  /** Maximum number of autonomous steps before stopping (default: 50). */
  maxSteps?: number;
  /**
   * Consecutive steps with no file changes before the agent is considered
   * "stuck" and HIL is triggered (default: 3).
   */
  stuckThreshold?: number;
  /** Number of recent responses kept for loop detection (default: 4). */
  loopWindowSize?: number;
  /**
   * Jaccard word-similarity threshold [0–1] above which two responses are
   * considered duplicates. (default: 0.85)
   */
  loopSimilarityThreshold?: number;
  /**
  * Names of skills to load from ~/.fusion-agent/skills/<name>/SKILL.md.
  * Their content is prepended to the plan prompt as additional context.
  */
  skills?: string[];
  /**
   * Enable browser control. When true, the agent can emit <browser>…</browser>
   * blocks in its responses to navigate pages, take snapshots, click, etc.
   */
  browserEnabled?: boolean;
  /**
   * Absolute path to the Chrome/Chromium executable.
   * Falls back to the CHROME_PATH environment variable, then common OS paths.
   */
  browserExecutablePath?: string;
}

/** A browser action block extracted from an AI response. */
export interface BrowserBlock {
  /** Raw lines of instructions (e.g. ["navigate https://…", "snapshot"]) */
  instructions: string[];
}

/** A cross-agent message block extracted from an AI response. */
export interface AgentMessageBlock {
  toSessionId: string;
  message: string;
}

export interface VibeCoderStep {
  stepNumber: number;
  prompt: string;
  response: string;
  filesChanged: string[];
  timestamp: string;
}

export type AutonomousStatus =
  | 'idle'
  | 'running'
  | 'waiting-hil'
  | 'completed'
  | 'stopped'
  | 'timed-out';

export type HILReason = 'loop-detected' | 'stuck' | 'error' | 'max-steps-reached';

export interface HILRequest {
  stepNumber: number;
  reason: HILReason;
  /** AI-generated summary of what it is confused about. */
  confusionSummary: string;
  /** The last few steps for user context. */
  recentSteps: VibeCoderStep[];
}

export interface VibeCoderFileChange {
  filePath: string;
  content: string;
}
