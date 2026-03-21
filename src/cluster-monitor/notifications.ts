import axios from 'axios';
import {
  NotificationConfig,
  DetectedFailure,
  HITLRequest,
} from './types';
import { logger } from '../utils/logger';

// ── Message shape ─────────────────────────────────────────────────────────────

export interface NotificationMessage {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  service: string;
  failure?: DetectedFailure;
  hitlRequest?: HITLRequest;
}

// ── Notification manager ──────────────────────────────────────────────────────

/**
 * Dispatches notifications to every enabled channel (Slack, Webhook, Teams,
 * PagerDuty, Email) in parallel.
 */
export class NotificationManager {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  async send(message: NotificationMessage): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (this.config.slack?.enabled) tasks.push(this.sendSlack(message));
    if (this.config.webhook?.enabled) tasks.push(this.sendWebhook(message));
    if (this.config.teams?.enabled) tasks.push(this.sendTeams(message));
    if (this.config.pagerduty?.enabled) tasks.push(this.sendPagerDuty(message));
    if (this.config.email?.enabled) tasks.push(this.sendEmail(message));

    await Promise.allSettled(tasks);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Build the human-in-the-loop body text used by every channel. */
  private buildHITLText(message: NotificationMessage): string {
    const hitl = message.hitlRequest;
    if (!hitl) return message.body;

    const logSnippet = hitl.failure.logLines.slice(-10).join('\n');
    return [
      `*Service:* ${message.service}`,
      `*Error:* ${hitl.failure.errorSummary}`,
      '',
      '*Recent logs:*',
      '```',
      logSnippet,
      '```',
      '',
      '*AI analysis:*',
      hitl.failure.aiAnalysis || '_(analyzing)_',
      '',
      '*Proposed fix:*',
      hitl.proposedFix,
      '',
      `_Reply \`approve ${hitl.failure.id}\`, \`reject ${hitl.failure.id}\`, or \`debug ${hitl.failure.id}\` to respond._`,
    ].join('\n');
  }

  // ── Channel senders ────────────────────────────────────────────────────────

  private async sendSlack(message: NotificationMessage): Promise<void> {
    const cfg = this.config.slack!;
    const color =
      message.severity === 'critical' || message.severity === 'error'
        ? 'danger'
        : message.severity === 'warning'
          ? 'warning'
          : 'good';

    const payload: Record<string, unknown> = {
      attachments: [
        {
          color,
          title: message.title,
          text: this.buildHITLText(message),
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
    if (cfg.channel) payload.channel = cfg.channel;
    if (cfg.username) payload.username = cfg.username;

    try {
      await axios.post(cfg.webhookUrl, payload);
      logger.debug(`Slack notification sent: ${message.title}`);
    } catch (err) {
      logger.error(`Failed to send Slack notification: ${err}`);
    }
  }

  private async sendWebhook(message: NotificationMessage): Promise<void> {
    const cfg = this.config.webhook!;
    const payload = {
      title: message.title,
      body: message.body,
      severity: message.severity,
      service: message.service,
      timestamp: new Date().toISOString(),
      hitlRequest: message.hitlRequest,
      failure: message.failure,
    };
    try {
      await axios.request({
        method: cfg.method || 'POST',
        url: cfg.url,
        headers: cfg.headers,
        data: payload,
      });
      logger.debug(`Webhook notification sent: ${message.title}`);
    } catch (err) {
      logger.error(`Failed to send webhook notification: ${err}`);
    }
  }

  private async sendTeams(message: NotificationMessage): Promise<void> {
    const cfg = this.config.teams!;
    const themeColor =
      message.severity === 'critical'
        ? 'FF0000'
        : message.severity === 'error'
          ? 'FF8C00'
          : '00B050';
    const payload = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor,
      summary: message.title,
      sections: [
        {
          activityTitle: message.title,
          activitySubtitle: `Service: ${message.service}`,
          text: this.buildHITLText(message),
        },
      ],
    };
    try {
      await axios.post(cfg.webhookUrl, payload);
      logger.debug(`Teams notification sent: ${message.title}`);
    } catch (err) {
      logger.error(`Failed to send Teams notification: ${err}`);
    }
  }

  private async sendPagerDuty(message: NotificationMessage): Promise<void> {
    const cfg = this.config.pagerduty!;
    const payload = {
      routing_key: cfg.integrationKey,
      event_action: 'trigger',
      dedup_key: message.failure?.id,
      payload: {
        summary: message.title,
        severity: cfg.severity || 'error',
        source: message.service,
        custom_details: {
          body: message.body,
          analysis: message.hitlRequest?.failure.aiAnalysis,
          proposedFix: message.hitlRequest?.proposedFix,
        },
      },
    };
    try {
      await axios.post('https://events.pagerduty.com/v2/enqueue', payload);
      logger.debug(`PagerDuty notification sent: ${message.title}`);
    } catch (err) {
      logger.error(`Failed to send PagerDuty notification: ${err}`);
    }
  }

  private async sendEmail(message: NotificationMessage): Promise<void> {
    const cfg = this.config.email!;
    const payload = {
      to: cfg.to,
      from: cfg.from,
      subject: message.title,
      text: this.buildHITLText(message),
    };
    try {
      await axios.post(cfg.gatewayUrl, payload, { headers: cfg.headers });
      logger.debug(`Email notification sent: ${message.title}`);
    } catch (err) {
      logger.error(`Failed to send email notification: ${err}`);
    }
  }
}
