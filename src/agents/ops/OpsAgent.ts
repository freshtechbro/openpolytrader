import { messageBus } from '../../core/MessageBus.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import { OpsHealthSummarySchema } from '../../domain/llm.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { safeParseJSON } from '../../utils/serialization.js';

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
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: 'OpsAgent', request: LLMRequest) => Promise<LLMCallResult> };
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
    eventStore?: EventStore;
  };
}

export class OpsAgent {
  private timer: NodeJS.Timeout | null = null;
  private loopActive = false;
  private startedAt = 0;
  private alertWebhookUrl: string | null;
  private eventStore?: EventStore;
  private llm?: NonNullable<OpsAgentConfig['llm']>;
  private outlierHandler: ((payload: unknown) => void) | null = null;
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
    this.eventStore = config.eventStore;
    this.llm = config.llm;
  }

  setChecks(checks: HealthCheck[]): void {
    this.config.checks = checks;
  }

  start(): void {
    if (this.loopActive) {
      return;
    }

    this.loopActive = true;
    this.startedAt = Date.now();
    if (!this.outlierHandler) {
      this.outlierHandler = (payload) => {
        const nowMs = Date.now();
        this.metrics?.record({
          type: 'info',
          timestamp: nowMs,
          data: { message: 'marketdata_outlier', payload }
        });
      };
      messageBus.on('marketdata:outlier', this.outlierHandler);
    }
    const tick = async () => {
      if (!this.loopActive) return;
      try {
        await this.runChecks();
      } catch {
        // runChecks already records failures; keep scheduling even if something escapes.
      }
      if (!this.loopActive) return;
      const delayMs = Math.max(this.config.intervalMs, 0);
      this.timer = setTimeout(() => void tick(), delayMs);
    };

    void tick();
  }

  stop(): void {
    this.loopActive = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.outlierHandler) {
      messageBus.off('marketdata:outlier', this.outlierHandler);
      this.outlierHandler = null;
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

    await this.maybeGenerateHealthSummary(this.lastReport, now);
  }

  private async maybeGenerateHealthSummary(report: OpsHealthReport, nowMs: number): Promise<void> {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return;
    if (llm.config.agents.OpsAgent.mode === 'disabled') return;

    const promptEnvelope = {
      task: 'health_summary',
      inputs: {
        metrics: {
          uptimeMs: report.uptimeMs,
          status: report.status,
          checks: Object.fromEntries(
            Object.entries(report.checks).map(([name, check]) => [
              name,
              { ok: check.ok, latencyMs: check.latencyMs ?? null, error: check.error ?? null }
            ])
          )
        }
      },
      output: {
        risk_level: 'low|medium|high',
        alerts: [],
        summary: '...',
        confidence: 0.0
      }
    };

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model: llm.config.agents.OpsAgent.model,
      temperature: 0,
      messages: [
        {
          role: 'developer',
          content:
            'Return JSON only, with shape: {"risk_level":"low"|"medium"|"high","alerts":string[],"summary":string,"confidence":number}. Use only the inputs. Alerts must reference failing checks by name; if all checks are ok, return alerts=[], risk_level="low". Keep summary concise (1-2 sentences). Confidence must be between 0 and 1. No prose.'
        },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ]
    };

    const call = await llm.client.call('OpsAgent', request);
    if (!call.outputText) return;

    const parsed = safeParseJSON(call.outputText);
    const validated = OpsHealthSummarySchema.safeParse(parsed);
    if (!validated.success) return;

    messageBus.emit('ops:health_summary', { ...validated.data, generatedAtMs: nowMs });
    logLLMDecision({
      agent: 'OpsAgent',
      mode: llm.config.agents.OpsAgent.mode,
      task: 'health_summary',
      subject: 'system:ops-health',
      baseline: promptEnvelope.inputs,
      output: validated.data,
      confidence: validated.data.confidence,
      applied: true,
      clamp: { raw: parsed, final: validated.data },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: promptEnvelope.inputs,
      promptVersion: llm.promptVersion,
      policyHashes: llm.policyHashes,
      providerFallback: {
        providerId: llm.config.agents.OpsAgent.provider,
        baseUrl: llm.config.providers[llm.config.agents.OpsAgent.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      store: this.eventStore ?? llm.eventStore
    });
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
