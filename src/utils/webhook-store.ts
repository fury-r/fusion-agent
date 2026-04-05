import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AutonomousConfig } from '../vibe-coder/types';

export interface WebhookConfig {
  id: string;
  name: string;
  /** SHA-256 hex hash of the secret token. */
  tokenHash: string;
  sessionName: string;
  autonomousConfig: AutonomousConfig;
  createdAt: string;
}

const WEBHOOKS_FILE = path.join(os.homedir(), '.fusion-agent', 'webhooks.json');

function readStore(): WebhookConfig[] {
  if (!fs.existsSync(WEBHOOKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8')) as WebhookConfig[];
  } catch {
    return [];
  }
}

function writeStore(configs: WebhookConfig[]): void {
  const dir = path.dirname(WEBHOOKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(configs, null, 2), 'utf-8');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create and persist a new webhook.
 * Returns the generated webhook ID and the plain-text token (shown once only).
 */
export function createWebhook(
  name: string,
  sessionName: string,
  autonomousConfig: AutonomousConfig
): { id: string; token: string } {
  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');
  const config: WebhookConfig = {
    id,
    name,
    tokenHash: hashToken(token),
    sessionName,
    autonomousConfig,
    createdAt: new Date().toISOString(),
  };
  const store = readStore();
  store.push(config);
  writeStore(store);
  return { id, token };
}

/** List all webhook configs (tokens are never returned). */
export function listWebhooks(): Omit<WebhookConfig, 'tokenHash'>[] {
  return readStore().map(({ tokenHash: _t, ...rest }) => rest);
}

/** Delete a webhook by ID. Returns true if it was found and removed. */
export function deleteWebhook(id: string): boolean {
  const store = readStore();
  const next = store.filter((w) => w.id !== id);
  if (next.length === store.length) return false;
  writeStore(next);
  return true;
}

/**
 * Validate an incoming token for a given webhook ID.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateWebhookToken(id: string, token: string): WebhookConfig | null {
  const store = readStore();
  const config = store.find((w) => w.id === id);
  if (!config) return null;

  const incoming = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(config.tokenHash, 'hex');

  if (incoming.length !== stored.length) return null;
  if (!crypto.timingSafeEqual(incoming, stored)) return null;

  return config;
}
