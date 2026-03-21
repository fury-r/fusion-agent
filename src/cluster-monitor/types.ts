import { ServiceConnectionOptions } from '../live-debugger/service-connector';

// ── Connection options specific to cluster-monitor ──────────────────────────

export interface KubernetesConnectionOptions {
  type: 'kubernetes';
  /** Pod name, deployment name, or label selector (e.g. "app=my-api") */
  selector: string;
  /** Kubernetes namespace (default: 'default') */
  namespace?: string;
  /** Number of log lines to tail initially (default: 100) */
  tail?: number;
  /** Path to kubeconfig file */
  kubeconfig?: string;
  /** kubectl context to use */
  context?: string;
}

export interface LogFileConnectionOptions {
  type: 'log-file';
  filePath: string;
  tailLines?: number;
}

/** Union of all connection option types understood by the cluster monitor. */
export type AllServiceConnectionOptions =
  | ServiceConnectionOptions
  | KubernetesConnectionOptions
  | LogFileConnectionOptions;

// ── Service target ───────────────────────────────────────────────────────────

export interface ServiceTarget {
  /** Human-readable service name (used in notifications and logs) */
  name: string;
  /** How to connect to / tail the service's output */
  connection: AllServiceConnectionOptions;
}

// ── Monitor modes ────────────────────────────────────────────────────────────

/** Operating mode for the cluster monitor */
export type MonitorMode = 'auto-fix' | 'notify-only' | 'human-in-loop';

// ── Remediation rules ────────────────────────────────────────────────────────

export interface RemediationRule {
  id: string;
  name: string;
  description: string;
  /** Regex pattern (or plain substring) matched against log lines to trigger this rule */
  trigger: string;
  /** Action to execute when the trigger matches */
  action: RemediationAction;
  /** Higher value = evaluated first (default: 0) */
  priority?: number;
  /** When true this rule always requires human approval even in auto-fix mode */
  requireApproval?: boolean;
}

export type RemediationAction =
  | { type: 'restart-pod'; namespace?: string; selector?: string }
  | { type: 'scale-deployment'; replicas: number; namespace?: string }
  | { type: 'exec-command'; command: string; args?: string[] }
  | { type: 'kubectl'; subcommand: string; args?: string[] }
  | { type: 'docker'; subcommand: string; args?: string[] }
  | { type: 'ai-fix'; systemPromptAddendum?: string }
  | { type: 'notify-only' };

// ── Avoidance rules ──────────────────────────────────────────────────────────

export interface AvoidanceRule {
  id: string;
  description: string;
  /** Regex or keyword describing the class of operation to prohibit */
  pattern: string;
}

// ── Cluster rules (loaded from YAML/JSON) ───────────────────────────────────

export interface ClusterRules {
  /**
   * Rules defining what the agent is allowed to auto-fix.
   * If empty, the agent will never auto-fix anything.
   */
  canAutoFix: RemediationRule[];
  /**
   * Rules defining what the agent MUST NOT do.
   * Injected into the AI system prompt as hard constraints.
   */
  avoid: AvoidanceRule[];
  /**
   * Action-type strings that always require human approval,
   * regardless of individual rule settings.
   */
  requireApproval?: string[];
}

// ── Notification configs ─────────────────────────────────────────────────────

export interface SlackNotificationConfig {
  enabled: boolean;
  webhookUrl: string;
  channel?: string;
  username?: string;
}

export interface WebhookNotificationConfig {
  enabled: boolean;
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
}

export interface TeamsNotificationConfig {
  enabled: boolean;
  webhookUrl: string;
}

export interface PagerDutyNotificationConfig {
  enabled: boolean;
  integrationKey: string;
  severity?: 'critical' | 'error' | 'warning' | 'info';
}

export interface EmailNotificationConfig {
  enabled: boolean;
  /** HTTP API endpoint for an email gateway (e.g. SendGrid, Mailgun) */
  gatewayUrl: string;
  headers?: Record<string, string>;
  to: string[];
  from?: string;
}

export interface NotificationConfig {
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;
  teams?: TeamsNotificationConfig;
  pagerduty?: PagerDutyNotificationConfig;
  email?: EmailNotificationConfig;
}

// ── Main monitor config ──────────────────────────────────────────────────────

export interface ClusterMonitorConfig {
  /** Explicit list of services to watch */
  services: ServiceTarget[];
  /** When true, auto-discover all deployments in `namespace` (Kubernetes only) */
  monitorAll?: boolean;
  /** Kubernetes namespace used for service discovery */
  namespace?: string;
  /** AI provider name */
  provider: string;
  model?: string;
  apiKey: string;
  /** Remediation and avoidance rules */
  rules: ClusterRules;
  /** Notification channels */
  notifications?: NotificationConfig;
  /** Operating mode */
  mode: MonitorMode;
  /** Lines to accumulate before triggering AI analysis (default: 20) */
  batchSize?: number;
  /** Seconds to wait before flushing a partial batch (default: 30) */
  maxWaitSeconds?: number;
  /** Max consecutive auto-fixes before requiring human approval (default: 3) */
  maxConsecutiveAutoFixes?: number;
  /**
   * Custom regex pattern to detect error lines in logs.
   * Defaults to: error|exception|fatal|critical|traceback|panic|fail|oom|killed|crash
   */
  errorKeywordsPattern?: string;
}

// ── Failure tracking ─────────────────────────────────────────────────────────

export interface DetectedFailure {
  id: string;
  serviceName: string;
  timestamp: string;
  logLines: string[];
  errorSummary: string;
  aiAnalysis?: string;
  proposedFix?: string;
  appliedRule?: RemediationRule;
  status:
    | 'detected'
    | 'analyzing'
    | 'proposed'
    | 'auto-fixed'
    | 'human-approved'
    | 'human-rejected'
    | 'skipped';
}

// ── Human-in-the-loop ────────────────────────────────────────────────────────

export interface HITLRequest {
  failure: DetectedFailure;
  proposedFix: string;
  affectedRule?: RemediationRule;
  timestamp: string;
}

export interface HITLResponse {
  failureId: string;
  decision: 'approve' | 'reject' | 'debug-more';
  comment?: string;
}

// ── Rules file (YAML/JSON schema) ────────────────────────────────────────────

export interface ClusterRulesFile {
  version?: string;
  rules: ClusterRules;
  notifications?: NotificationConfig;
}
