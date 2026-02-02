import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { StoredEvent } from '../../core/EventStore.js';
import type { EventStore } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import { LearningInsightEventSchema, LearningInsightSchema } from '../../domain/llm.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { safeParseJSON } from '../../utils/serialization.js';

type MessageBusEvent = Parameters<typeof messageBus.on>[0];
type MessageBusHandler = Parameters<typeof messageBus.on>[1];

export interface LearningAgentConfig {
  enabled: boolean;
  statsRetentionMs?: number;
  statsMaxMarkets?: number;
  promptTopNMarkets?: number;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: 'LearningAgent', request: LLMRequest) => Promise<LLMCallResult> };
    promptVersion: string;
    windowMs: number;
    minEventsPerRun: number;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
    intervalMs?: number;
  };
}

/**
 * Phase 1: learning is write-only telemetry.
 * - No online policy updates.
 * - Records key decisions/events to the EventStore for offline analysis.
 */
export class LearningAgent {
  private started = false;
  private pendingEvents = 0;
  private lastSynthesisAtMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private statsDirty = false;
  private lastStatsSnapshotAtMs = 0;
  private lastAppliedStatsEventAtMs = 0;
  private lastPruneAtMs = 0;
  private readonly statsSnapshotIntervalMs = 60000;
  private readonly statsPruneIntervalMs = 60000;
  private readonly statsRetentionMs: number;
  private readonly statsMaxMarkets: number;
  private readonly promptTopNMarkets: number;
  private subscriptions: Array<{ event: MessageBusEvent; handler: MessageBusHandler }> = [];

  private statsByMarket = new Map<
    string,
    {
      opportunities: number;
      approvals: number;
      avgEdge: number;
      slippageSamples: number;
      avgSlippage: number;
      timeouts: number;
      lastUpdatedMs: number;
    }
  >();

  private insightCache = new Map<
    string,
    { insight: (typeof LearningInsightSchema)['_output']; expiresAtMs: number }
  >();

  constructor(
    private config: LearningAgentConfig,
    private store: EventStore
  ) {
    this.statsRetentionMs = Math.max(config.statsRetentionMs ?? 24 * 60 * 60 * 1000, 0);
    this.statsMaxMarkets = Math.max(config.statsMaxMarkets ?? 5000, 1);
    this.promptTopNMarkets = Math.max(config.promptTopNMarkets ?? 100, 1);
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.restoreStatsSnapshot();

    const record = (type: string, payload: unknown, metadata?: StoredEvent['metadata']) => {
      this.store.append({
        id: randomUUID(),
        timestamp: Date.now(),
        type,
        payload,
        metadata: metadata ?? {}
      });
    };

    const subscribe = (event: MessageBusEvent, handler: MessageBusHandler) => {
      messageBus.on(event, handler);
      this.subscriptions.push({ event, handler });
    };

    subscribe('opportunity:detected', (event) => {
      record('opportunity:detected', event, { agent: 'ScannerAgent' });
      const payload = event as { opportunity?: { marketId?: string; edge?: number } };
      const marketId = payload.opportunity?.marketId;
      const edge = payload.opportunity?.edge;
      if (typeof marketId === 'string' && marketId.length > 0) {
        this.updateMarketStats(marketId, { opportunities: 1, edge });
      }
    });
    subscribe('risk:approved', (event) => {
      record('risk:approved', event, { agent: 'RiskAgent' });
      const payload = event as { opportunity?: { marketId?: string } };
      const marketId = payload.opportunity?.marketId;
      if (typeof marketId === 'string' && marketId.length > 0) {
        this.updateMarketStats(marketId, { approvals: 1 });
      }
    });
    subscribe('ops:health', (event) => record('ops:health', event, { agent: 'OpsAgent' }));
    subscribe('ops:alert', (event) => record('ops:alert', event, { agent: 'OpsAgent' }));

    // Forward-compatible subscriptions (emitted once LLM integration is rolled out).
    subscribe('execution:outcome', (event) => {
      record('execution:outcome', event, { agent: 'ExecutionAgent' });
      const payload = event as { marketId?: string; status?: string };
      if (payload.marketId && payload.status === 'timeout') {
        this.updateMarketStats(payload.marketId, { timeouts: 1 });
      }
    });
    subscribe('execution:fill', (event) => {
      record('execution:fill', event, { agent: 'ExecutionAgent' });
      const payload = event as { marketId?: string; slippage?: number };
      if (payload.marketId && typeof payload.slippage === 'number') {
        this.updateMarketStats(payload.marketId, { slippageSample: payload.slippage });
      }
    });

    const intervalMs = Math.max(this.config.llm?.intervalMs ?? 30000, 0);
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), intervalMs);
    }
  }

  stop(): void {
    this.maybePersistStatsSnapshot(Date.now(), { force: true });
    for (const { event, handler } of this.subscriptions.splice(0, this.subscriptions.length)) {
      messageBus.off(event, handler);
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getInsight(marketId: string, nowMs = Date.now()): (typeof LearningInsightSchema)['_output'] | null {
    const cached = this.insightCache.get(marketId);
    if (!cached) return null;
    if (nowMs >= cached.expiresAtMs) {
      this.insightCache.delete(marketId);
      return null;
    }
    return cached.insight;
  }

  async synthesizeNow(): Promise<void> {
    await this.synthesizeInsights();
  }

  private updateMarketStats(
    marketId: string,
    delta: {
      opportunities?: number;
      approvals?: number;
      edge?: number;
      slippageSample?: number;
      timeouts?: number;
    },
    nowMs = Date.now()
  ): void {
    this.applyMarketStatsDelta(marketId, delta, nowMs, { recordPending: true, emitUpdate: true, markDirty: true });
  }

  private applyMarketStatsDelta(
    marketId: string,
    delta: {
      opportunities?: number;
      approvals?: number;
      edge?: number;
      slippageSample?: number;
      timeouts?: number;
    },
    nowMs: number,
    options: { recordPending: boolean; emitUpdate: boolean; markDirty: boolean }
  ): void {
    const existing =
      this.statsByMarket.get(marketId) ?? {
        opportunities: 0,
        approvals: 0,
        avgEdge: 0,
        slippageSamples: 0,
        avgSlippage: 0,
        timeouts: 0,
        lastUpdatedMs: nowMs
      };

    const next = { ...existing, lastUpdatedMs: nowMs };
    if (delta.opportunities) next.opportunities += delta.opportunities;
    if (delta.approvals) next.approvals += delta.approvals;
    if (delta.timeouts) next.timeouts += delta.timeouts;

    if (typeof delta.edge === 'number' && Number.isFinite(delta.edge)) {
      const n = next.opportunities;
      next.avgEdge = n <= 1 ? delta.edge : (existing.avgEdge * (n - 1) + delta.edge) / n;
    }

    if (typeof delta.slippageSample === 'number' && Number.isFinite(delta.slippageSample)) {
      next.slippageSamples += 1;
      const n = next.slippageSamples;
      next.avgSlippage =
        n <= 1 ? delta.slippageSample : (existing.avgSlippage * (n - 1) + delta.slippageSample) / n;
    }

    this.statsByMarket.set(marketId, next);
    this.lastAppliedStatsEventAtMs = Math.max(this.lastAppliedStatsEventAtMs, nowMs);

    if (options.recordPending) {
      this.pendingEvents += 1;
    }
    if (options.markDirty) {
      this.statsDirty = true;
    }
    if (options.emitUpdate) {
      messageBus.emit('learning:update', { at_ms: nowMs, markets_tracked: this.statsByMarket.size });
    }
  }

  private async tick(): Promise<void> {
    this.pruneMarketStats(Date.now());
    this.maybePersistStatsSnapshot(Date.now());
    await this.maybeSynthesize();
  }

  private async maybeSynthesize(): Promise<void> {
    const llm = this.config.llm;
    if (!llm) return;
    if (!llm.config.enabled) return;
    if (llm.config.agents.LearningAgent.mode !== 'active') return;

    const minEvents = Math.max(llm.minEventsPerRun, 1);
    if (this.pendingEvents < minEvents) return;

    await this.synthesizeInsights();
  }

  private async synthesizeInsights(): Promise<void> {
    const llm = this.config.llm;
    if (!llm) return;
    if (!llm.config.enabled) return;
    if (llm.config.agents.LearningAgent.mode !== 'active') return;

    const nowMs = Date.now();
    this.pruneMarketStats(nowMs);
    const stats_by_market: Record<
      string,
      { opportunities: number; approvals: number; avg_edge: number; avg_slippage: number; timeouts: number }
    > = {};

    const selectedForPrompt = this.selectMarketsForPrompt(nowMs, llm.windowMs);
    for (const [marketId, stats] of selectedForPrompt) {
      stats_by_market[marketId] = {
        opportunities: stats.opportunities,
        approvals: stats.approvals,
        avg_edge: stats.avgEdge,
        avg_slippage: stats.avgSlippage,
        timeouts: stats.timeouts
      };
    }

    const promptEnvelope = {
      task: 'summarize_outcomes',
      inputs: {
        window_ms: llm.windowMs,
        stats_by_market
      },
      output: {
        insights: [
          {
            market_id: 'market_id',
            signal: 'high_confidence|medium_confidence|low_confidence|neutral',
            value: 0.0,
            ttl_ms: 60000,
            confidence: 0.0
          }
        ]
      }
    };

    const model = llm.config.agents.LearningAgent.model;
    const instruction =
      'Return JSON only, with shape: {"insights":[{"market_id":string,"signal":"high_confidence"|"medium_confidence"|"low_confidence"|"neutral","value":number,"ttl_ms":number,"confidence":number}]}. Use only the inputs. Include only markets with clear evidence; otherwise return an empty insights array. ttl_ms must be between 30000 and window_ms. Confidence must be between 0 and 1. No prose.';

    const request: LLMRequest =
      model.startsWith('claude-')
        ? {
            endpoint: 'messages',
            model,
            system: instruction,
            messages: [{ role: 'user', content: JSON.stringify(promptEnvelope) }],
            temperature: 0,
            max_tokens: 800
          }
        : {
            endpoint: 'chat.completions',
            model,
            temperature: 0,
            messages: [
              { role: 'developer', content: instruction },
              { role: 'user', content: JSON.stringify(promptEnvelope) }
            ],
            max_tokens: 800
          };

    const call = await llm.client.call('LearningAgent', request);

    const hasOutputText = Boolean(call.outputText);
    const parsed = hasOutputText ? safeParseJSON(call.outputText) : null;
    const validated = hasOutputText
      ? z
          .object({ insights: z.array(LearningInsightSchema) })
          .strict()
          .safeParse(parsed)
      : ({ success: false } as const);

    const insightPayload = validated.success
      ? {
          insights: validated.data.insights.map((insight) => ({
            ...insight,
            source: 'learning' as const,
            kind: 'outcome_summary' as const
          })),
          generatedAtMs: nowMs
        }
      : null;

    if (insightPayload) {
      LearningInsightEventSchema.parse(insightPayload);
      for (const insight of insightPayload.insights) {
        this.insightCache.set(insight.market_id, {
          insight,
          expiresAtMs: nowMs + insight.ttl_ms
        });
      }
      messageBus.emit('learning:insight', insightPayload);
    }

    this.lastSynthesisAtMs = nowMs;
    this.pendingEvents = 0;

    const missingOutput = !hasOutputText;
    const failureOutput = missingOutput
      ? { error: 'missing_output_text', status: call.status, llm_error: call.error ?? null }
      : { error: 'invalid_output' };

    logLLMDecision({
      agent: 'LearningAgent',
      mode: llm.config.agents.LearningAgent.mode,
      task: 'summarize_outcomes',
      subject: 'system:learning',
      baseline: promptEnvelope.inputs,
      output: insightPayload ?? failureOutput,
      confidence: insightPayload ? average(insightPayload.insights.map((i) => i.confidence)) : 0,
      applied: Boolean(insightPayload),
      clamp: { violations: missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output'] },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: promptEnvelope.inputs,
      promptVersion: llm.promptVersion,
      policyHashes: llm.policyHashes,
      providerFallback: {
        providerId: llm.config.agents.LearningAgent.provider,
        baseUrl: llm.config.providers[llm.config.agents.LearningAgent.provider].baseUrl,
        endpoint: request.endpoint,
        model: llm.config.agents.LearningAgent.model
      },
      store: this.store
    });
    if (!validated.success && call.error) {
      messageBus.emit(
        'llm:error',
        {
          agent: 'LearningAgent',
          provider_id: call.providerId ?? llm.config.agents.LearningAgent.provider,
          endpoint: call.endpoint ?? request.endpoint,
          model: call.model ?? request.model,
          error: call.error,
          at_ms: nowMs
        }
      );
    }
  }

  private restoreStatsSnapshot(): void {
    const latest = this.store.getLatestEventByType('learning:market_stats_snapshot');
    const payload = latest?.payload;
    if (!payload || typeof payload !== 'object') {
      this.replayMarketStatsFromStore(0);
      this.pruneMarketStats(Date.now(), { force: true });
      return;
    }

    const anyPayload = payload as {
      schema_version?: number;
      at_ms?: number;
      applied_through_ms?: number;
      stats_by_market?: Record<string, unknown>;
    };
    if (anyPayload.schema_version !== 1 && anyPayload.schema_version !== 2) {
      this.replayMarketStatsFromStore(0);
      this.pruneMarketStats(Date.now(), { force: true });
      return;
    }
    if (!anyPayload.stats_by_market || typeof anyPayload.stats_by_market !== 'object') {
      this.replayMarketStatsFromStore(0);
      this.pruneMarketStats(Date.now(), { force: true });
      return;
    }

    const next = new Map<
      string,
      {
        opportunities: number;
        approvals: number;
        avgEdge: number;
        slippageSamples: number;
        avgSlippage: number;
        timeouts: number;
        lastUpdatedMs: number;
      }
    >();

    for (const [marketId, statsValue] of Object.entries(anyPayload.stats_by_market)) {
      if (!statsValue || typeof statsValue !== 'object') continue;
      const stats = statsValue as Partial<{
        opportunities: number;
        approvals: number;
        avg_edge: number;
        slippage_samples: number;
        avg_slippage: number;
        timeouts: number;
        last_updated_ms: number;
      }>;

      const opportunities = typeof stats.opportunities === 'number' ? Math.max(0, stats.opportunities) : 0;
      const approvals = typeof stats.approvals === 'number' ? Math.max(0, stats.approvals) : 0;
      const avgEdge = typeof stats.avg_edge === 'number' && Number.isFinite(stats.avg_edge) ? stats.avg_edge : 0;
      const slippageSamples =
        typeof stats.slippage_samples === 'number' ? Math.max(0, stats.slippage_samples) : 0;
      const avgSlippage =
        typeof stats.avg_slippage === 'number' && Number.isFinite(stats.avg_slippage) ? stats.avg_slippage : 0;
      const timeouts = typeof stats.timeouts === 'number' ? Math.max(0, stats.timeouts) : 0;
      const lastUpdatedMs =
        typeof stats.last_updated_ms === 'number' && Number.isFinite(stats.last_updated_ms)
          ? Math.max(0, stats.last_updated_ms)
          : 0;

      if (marketId.length === 0) continue;
      next.set(marketId, {
        opportunities,
        approvals,
        avgEdge,
        slippageSamples,
        avgSlippage,
        timeouts,
        lastUpdatedMs
      });
    }

    if (next.size === 0) return;

    this.statsByMarket = next;
    this.statsDirty = false;
    const atMs = typeof anyPayload.at_ms === 'number' ? anyPayload.at_ms : Date.now();
    this.lastStatsSnapshotAtMs = atMs;
    this.lastAppliedStatsEventAtMs =
      typeof anyPayload.applied_through_ms === 'number' && Number.isFinite(anyPayload.applied_through_ms)
        ? Math.max(0, anyPayload.applied_through_ms)
        : atMs;

    this.replayMarketStatsFromStore(this.lastAppliedStatsEventAtMs);
    this.pruneMarketStats(Date.now(), { force: true });
  }

  private replayMarketStatsFromStore(sinceExclusiveMs: number): void {
    const replayTypes = ['opportunity:detected', 'risk:approved', 'execution:outcome', 'execution:fill'];
    const events = this.store.listEventsByTypes({ types: replayTypes, sinceExclusiveMs });

    let maxTs = sinceExclusiveMs;
    let applied = false;

    for (const event of events) {
      maxTs = Math.max(maxTs, event.timestamp);
      if (!event.payload || typeof event.payload !== 'object') continue;
      const payload = event.payload as Record<string, unknown>;

      if (event.type === 'opportunity:detected') {
        const marketId = extractMarketId(payload);
        const edge =
          typeof payload.edge === 'number'
            ? extractNumeric(payload.edge)
            : (() => {
                const opportunity = payload.opportunity;
                if (!opportunity || typeof opportunity !== 'object') return null;
                return extractNumeric((opportunity as Record<string, unknown>).edge);
              })();
        if (marketId) {
          this.applyMarketStatsDelta(marketId, { opportunities: 1, edge: edge ?? undefined }, event.timestamp, {
            recordPending: false,
            emitUpdate: false,
            markDirty: false
          });
          applied = true;
        }
      } else if (event.type === 'risk:approved') {
        const marketId = extractMarketId(payload);
        if (marketId) {
          this.applyMarketStatsDelta(marketId, { approvals: 1 }, event.timestamp, {
            recordPending: false,
            emitUpdate: false,
            markDirty: false
          });
          applied = true;
        }
      } else if (event.type === 'execution:outcome') {
        const marketId = extractMarketId(payload);
        const status = typeof payload.status === 'string' ? payload.status : undefined;
        if (marketId && status === 'timeout') {
          this.applyMarketStatsDelta(marketId, { timeouts: 1 }, event.timestamp, {
            recordPending: false,
            emitUpdate: false,
            markDirty: false
          });
          applied = true;
        }
      } else if (event.type === 'execution:fill') {
        const marketId = extractMarketId(payload);
        const slippage = extractNumeric(payload.slippage);
        if (marketId && typeof slippage === 'number') {
          this.applyMarketStatsDelta(marketId, { slippageSample: slippage }, event.timestamp, {
            recordPending: false,
            emitUpdate: false,
            markDirty: false
          });
          applied = true;
        }
      }
    }

    this.lastAppliedStatsEventAtMs = Math.max(this.lastAppliedStatsEventAtMs, maxTs);

    if (applied) {
      // The snapshot is now stale (or missing); allow the periodic snapshotter to compact history.
      this.statsDirty = true;
    }
  }

  private pruneMarketStats(nowMs: number, options: { force?: boolean } = {}): void {
    if (!options.force) {
      const intervalMs = Math.max(this.statsPruneIntervalMs, 0);
      if (intervalMs > 0 && nowMs - this.lastPruneAtMs < intervalMs) {
        return;
      }
    }
    this.lastPruneAtMs = nowMs;

    const retentionMs = Math.max(this.statsRetentionMs, 0);
    if (retentionMs > 0) {
      const cutoff = nowMs - retentionMs;
      for (const [marketId, stats] of this.statsByMarket.entries()) {
        if (stats.lastUpdatedMs < cutoff) {
          this.statsByMarket.delete(marketId);
          this.statsDirty = true;
        }
      }
    }

    if (this.statsByMarket.size > this.statsMaxMarkets) {
      const keep = Array.from(this.statsByMarket.entries())
        .sort((a, b) => b[1].lastUpdatedMs - a[1].lastUpdatedMs || a[0].localeCompare(b[0]))
        .slice(0, this.statsMaxMarkets);

      const keepIds = new Set(keep.map(([marketId]) => marketId));
      for (const marketId of this.statsByMarket.keys()) {
        if (!keepIds.has(marketId)) {
          this.statsByMarket.delete(marketId);
          this.statsDirty = true;
        }
      }
    }
  }

  private selectMarketsForPrompt(
    nowMs: number,
    windowMs: number
  ): Array<
    [
      string,
      {
        opportunities: number;
        approvals: number;
        avgEdge: number;
        slippageSamples: number;
        avgSlippage: number;
        timeouts: number;
        lastUpdatedMs: number;
      }
    ]
  > {
    const topN = Math.max(this.promptTopNMarkets, 1);
    const lookback = Math.max(windowMs, 0);
    const cutoff = lookback > 0 ? nowMs - lookback : null;

    let entries = Array.from(this.statsByMarket.entries());
    if (cutoff !== null) {
      const recent = entries.filter(([, stats]) => stats.lastUpdatedMs >= cutoff);
      if (recent.length > 0) {
        entries = recent;
      }
    }

    const score = (stats: (typeof entries)[number][1]): number => {
      const approvals = Math.max(stats.approvals, 0);
      const opportunities = Math.max(stats.opportunities, 0);
      const edge = Number.isFinite(stats.avgEdge) ? Math.abs(stats.avgEdge) : 0;
      const timeouts = Math.max(stats.timeouts, 0);
      return approvals * 1_000_000 + opportunities * 1_000 + Math.floor(edge * 1000) - timeouts;
    };

    entries.sort((a, b) => {
      const diff = score(b[1]) - score(a[1]);
      if (diff !== 0) return diff;
      const recency = b[1].lastUpdatedMs - a[1].lastUpdatedMs;
      if (recency !== 0) return recency;
      return a[0].localeCompare(b[0]);
    });

    return entries.slice(0, topN);
  }

  private maybePersistStatsSnapshot(nowMs: number, options: { force?: boolean } = {}): void {
    if (!this.statsDirty && !options.force) return;

    const intervalMs = Math.max(this.statsSnapshotIntervalMs, 0);
    if (!options.force && intervalMs > 0 && nowMs - this.lastStatsSnapshotAtMs < intervalMs) {
      return;
    }

    this.pruneMarketStats(nowMs, { force: true });

    const stats_by_market: Record<string, unknown> = {};
    for (const [marketId, stats] of this.statsByMarket.entries()) {
      stats_by_market[marketId] = {
        opportunities: stats.opportunities,
        approvals: stats.approvals,
        avg_edge: stats.avgEdge,
        slippage_samples: stats.slippageSamples,
        avg_slippage: stats.avgSlippage,
        timeouts: stats.timeouts,
        last_updated_ms: stats.lastUpdatedMs
      };
    }

    this.store.append({
      id: randomUUID(),
      timestamp: nowMs,
      type: 'learning:market_stats_snapshot',
      payload: {
        schema_version: 2,
        at_ms: nowMs,
        applied_through_ms: this.lastAppliedStatsEventAtMs,
        stats_by_market
      },
      metadata: { agent: 'LearningAgent' }
    });

    this.statsDirty = false;
    this.lastStatsSnapshotAtMs = nowMs;
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function extractNumeric(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function extractMarketId(payload: Record<string, unknown>): string | null {
  const directCandidates = [payload.marketId, payload.market_id, payload.market];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }

  const opportunity = payload.opportunity;
  if (opportunity && typeof opportunity === 'object') {
    const record = opportunity as Record<string, unknown>;
    const nestedCandidates = [record.marketId, record.market_id, record.market];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  }

  return null;
}
