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
}

export class OpsAgent {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastReport: OpsHealthReport = {
    status: 'healthy',
    checks: {},
    lastCheckMs: null,
    uptimeMs: 0
  };

  constructor(
    private config: OpsAgentConfig,
    private metrics?: MetricsStore
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.startedAt = Date.now();
    this.runChecks();
    this.timer = setInterval(() => this.runChecks(), this.config.intervalMs);
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
        }
      }
    }
  }
}
