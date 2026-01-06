import { messageBus } from '../../core/MessageBus.js';
import type { MetricsStore } from '../../telemetry/metrics.js';

export interface HealthCheckResult {
  ok: boolean;
  info?: string;
  latencyMs?: number;
  error?: string;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<HealthCheckResult>;
}

export interface OpsHealthReport {
  status: 'healthy' | 'degraded';
  checks: Record<string, HealthCheckResult>;
  lastCheckMs: number | null;
  uptimeMs: number;
}

export interface OpsAgentConfig {
  intervalMs: number;
  checks: HealthCheck[];
  alertWebhookUrl?: string;
}

export class OpsAgent {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private alertWebhookUrl: string | null;
  private lastReport: OpsHealthReport = {
    status: 'healthy',
    checks: {},
    lastCheckMs: null,
    uptimeMs: 0
  };

  constructor(
    private config: OpsAgentConfig,
    private metrics?: MetricsStore
  ) {
    const webhook = config.alertWebhookUrl?.trim();
    this.alertWebhookUrl = webhook && webhook.length > 0 ? webhook : null;
  }

  setChecks(checks: HealthCheck[]): void {
    this.config.checks = checks;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.startedAt = Date.now();
    void this.runChecks();
    this.timer = setInterval(() => void this.runChecks(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getReport(): OpsHealthReport {
    return {
      ...this.lastReport,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0
    };
  }

  async runOnce(): Promise<OpsHealthReport> {
    await this.runChecks();
    return this.getReport();
  }

  private async runChecks(): Promise<void> {
    const now = Date.now();
    const results: Record<string, HealthCheckResult> = {};

    await Promise.all(
      this.config.checks.map(async (check) => {
        const start = Date.now();
        try {
          const result = await check.check();
          results[check.name] = {
            ...result,
            latencyMs: result.latencyMs ?? Date.now() - start
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_error';
          results[check.name] = {
            ok: false,
            error: message,
            latencyMs: Date.now() - start
          };
        }
      })
    );

    const degraded = Object.values(results).some((result) => !result.ok);
    this.lastReport = {
      status: degraded ? 'degraded' : 'healthy',
      checks: results,
      lastCheckMs: now,
      uptimeMs: this.startedAt ? now - this.startedAt : 0
    };

    messageBus.emit('ops:health', this.lastReport);
    this.metrics?.record({
      type: 'health',
      timestamp: now,
      data: this.lastReport
    });

    if (degraded) {
      for (const [name, result] of Object.entries(results)) {
        if (!result.ok) {
          const alert = { check: name, result, timestamp: now };
          messageBus.emit('ops:alert', alert);
          this.metrics?.record({
            type: 'incident',
            timestamp: now,
            data: alert
          });
          void this.sendAlert(alert);
        }
      }
    }
  }

  private async sendAlert(payload: unknown): Promise<void> {
    if (!this.alertWebhookUrl) return;
    try {
      const response = await fetch(this.alertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        this.metrics?.record({
          type: 'error',
          timestamp: Date.now(),
          data: { message: 'ops_alert_send_failed', status: response.status }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics?.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'ops_alert_send_failed', error: message }
      });
    }
  }
}
