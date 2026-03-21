import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

export interface AIAgentConfig {
  provider: 'openai' | 'anthropic' | 'gemini';
  model?: string;
  apiKey?: string;
  port?: number;
  sessionDir?: string;
  guardrails?: GuardrailConfig[];
  logLevel?: string;
}

export interface GuardrailConfig {
  id?: string;
  type: 'allow-paths' | 'deny-paths' | 'deny-operations' | 'max-tokens' | 'style' | 'custom';
  value: string | string[] | number;
  description?: string;
}

const DEFAULT_CONFIG: AIAgentConfig = {
  provider: 'openai',
  model: undefined,
  port: 3000,
  sessionDir: path.join(os.homedir(), '.ai-agent-cli', 'sessions'),
  guardrails: [],
  logLevel: 'info',
};

function getConfigPaths(): string[] {
  return [
    path.join(process.cwd(), '.ai-agent-cli.json'),
    path.join(process.cwd(), '.ai-agent-cli.yaml'),
    path.join(os.homedir(), '.ai-agent-cli', 'config.json'),
    path.join(os.homedir(), '.ai-agent-cli', 'config.yaml'),
  ];
}

function parseConfigFile(filePath: string): Partial<AIAgentConfig> {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');
  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content) as Partial<AIAgentConfig>;
  }
  return JSON.parse(content) as Partial<AIAgentConfig>;
}

export function loadConfig(overrides: Partial<AIAgentConfig> = {}): AIAgentConfig {
  let fileConfig: Partial<AIAgentConfig> = {};

  for (const configPath of getConfigPaths()) {
    if (fs.existsSync(configPath)) {
      try {
        fileConfig = parseConfigFile(configPath);
        break;
      } catch {
        // ignore parse errors, try next
      }
    }
  }

  const envConfig: Partial<AIAgentConfig> = {};
  if (process.env.AI_PROVIDER) {
    envConfig.provider = process.env.AI_PROVIDER as AIAgentConfig['provider'];
  }
  if (process.env.AI_MODEL) envConfig.model = process.env.AI_MODEL;
  if (process.env.OPENAI_API_KEY && (!envConfig.provider || envConfig.provider === 'openai')) {
    envConfig.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.ANTHROPIC_API_KEY && envConfig.provider === 'anthropic') {
    envConfig.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.GEMINI_API_KEY && envConfig.provider === 'gemini') {
    envConfig.apiKey = process.env.GEMINI_API_KEY;
  }
  if (process.env.AI_AGENT_PORT) envConfig.port = parseInt(process.env.AI_AGENT_PORT, 10);

  const merged: AIAgentConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    ...overrides,
  };

  // Resolve API key from environment if not set
  if (!merged.apiKey) {
    if (merged.provider === 'openai') merged.apiKey = process.env.OPENAI_API_KEY;
    else if (merged.provider === 'anthropic') merged.apiKey = process.env.ANTHROPIC_API_KEY;
    else if (merged.provider === 'gemini') merged.apiKey = process.env.GEMINI_API_KEY;
  }

  // Ensure session dir exists
  if (merged.sessionDir && !fs.existsSync(merged.sessionDir)) {
    fs.mkdirSync(merged.sessionDir, { recursive: true });
  }

  return merged;
}

export function saveConfig(config: Partial<AIAgentConfig>): void {
  const configDir = path.join(os.homedir(), '.ai-agent-cli');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'config.json');
  let existing: Partial<AIAgentConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // ignore
    }
  }
  const merged = { ...existing, ...config };
  // Never save raw API keys to config file
  delete merged.apiKey;
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}
