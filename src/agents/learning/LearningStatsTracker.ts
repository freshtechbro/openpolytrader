import { randomUUID } from 'node:crypto';

import type { EventStore, StoredEvent } from '../../core/EventStore.js';

interface MarketStats {
  opportunities: number;
  approvals: number;
  avgEdge: number;
  slippageSamples: number;
  avgSlippage: number;
  timeouts: number;
  lastUpdatedMs: number;
}

export class LearningStatsTracker {
  private readonly statsByMarket = new Map<string, MarketStats>();
  private pendingEvents = 0;
  private statsDirty = false;
  private lastStatsSnapshotAtMs = 0;
  private lastAppliedStatsEventAtMs = 0;
  private lastPruneAtMs = 0;
  private readonly statsSnapshotIntervalMs = 60000;
  private readonly statsPruneIntervalMs = 60000;

  constructor(
    private readonly statsRetentionMs: number,
    private readonly statsMaxMarkets: number,
    private readonly promptTopNMarkets: number
  ) {}

  get size(): number {
    return this.statsByMarket.size;
  }

  update(
    marketId: string,
    delta: {
      opportunities?: number;
      approvals?: number;
      edge?: number;
      slippageSample?: number;
      timeouts?: number;
    },
    nowMs: number,
    options: { recordPending: boolean; markDirty: boolean }
  ): void {
    const existing = this.statsByMarket.get(marketId) ?? createEmptyMarketStats(nowMs);
    const next = { ...existing, lastUpdatedMs: nowMs };

    if (delta.opportunities) next.opportunities += delta.opportunities;
    if (delta.approvals) next.approvals += delta.approvals;
    if (delta.timeouts) next.timeouts += delta.timeouts;

    if (typeof delta.edge === 'number' && Number.isFinite(delta.edge)) {
      const opportunities = next.opportunities;
      next.avgEdge =
        opportunities <= 1 ? delta.edge : (existing.avgEdge * (opportunities - 1) + delta.edge) / opportunities;
    }

    if (typeof delta.slippageSample === 'number' && Number.isFinite(delta.slippageSample)) {
      next.slippageSamples += 1;
      const slippageSamples = next.slippageSamples;
      next.avgSlippage =
        slippageSamples <= 1
          ? delta.slippageSample
          : (existing.avgSlippage * (slippageSamples - 1) + delta.slippageSample) / slippageSamples;
    }

    this.statsByMarket.set(marketId, next);
    this.lastAppliedStatsEventAtMs = Math.max(this.lastAppliedStatsEventAtMs, nowMs);

    if (options.recordPending) this.pendingEvents += 1;
    if (options.markDirty) this.statsDirty = true;
  }

  shouldSynthesize(minEvents: number): boolean {
    return this.pendingEvents >= Math.max(minEvents, 1);
  }

  resetPendingEvents(): void {
    this.pendingEvents = 0;
  }

  restore(store: EventStore): void {
    const latest = store.getLatestEventByType('learning:market_stats_snapshot');
    const payload = latest?.payload;

    if (!payload || typeof payload !== 'object') {
      this.replayFromStore(store, 0);
      this.prune(Date.now(), { force: true });
      return;
    }

    const anyPayload = payload as {
      schema_version?: number;
      at_ms?: number;
      applied_through_ms?: number;
      stats_by_market?: Record<string, unknown>;
    };

    if ((anyPayload.schema_version !== 1 && anyPayload.schema_version !== 2) || !isObjectRecord(anyPayload.stats_by_market)) {
      this.replayFromStore(store, 0);
      this.prune(Date.now(), { force: true });
      return;
    }

    this.statsByMarket.clear();
    for (const [marketId, statsValue] of Object.entries(anyPayload.stats_by_market)) {
      const stats = normalizeSnapshotStats(statsValue);
      if (!stats || marketId.length === 0) continue;
      this.statsByMarket.set(marketId, stats);
    }

    if (this.statsByMarket.size === 0) return;

    this.statsDirty = false;
    const atMs = typeof anyPayload.at_ms === 'number' ? anyPayload.at_ms : Date.now();
    this.lastStatsSnapshotAtMs = atMs;
    this.lastAppliedStatsEventAtMs =
      typeof anyPayload.applied_through_ms === 'number' && Number.isFinite(anyPayload.applied_through_ms)
        ? Math.max(0, anyPayload.applied_through_ms)
        : atMs;

    this.replayFromStore(store, this.lastAppliedStatsEventAtMs);
    this.prune(Date.now(), { force: true });
  }

  prune(nowMs: number, options: { force?: boolean } = {}): void {
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
      const keepIds = new Set(
        Array.from(this.statsByMarket.entries())
          .sort((a, b) => b[1].lastUpdatedMs - a[1].lastUpdatedMs || a[0].localeCompare(b[0]))
          .slice(0, this.statsMaxMarkets)
          .map(([marketId]) => marketId)
      );

      for (const marketId of this.statsByMarket.keys()) {
        if (!keepIds.has(marketId)) {
          this.statsByMarket.delete(marketId);
          this.statsDirty = true;
        }
      }
    }
  }

  maybePersist(store: EventStore, nowMs: number, options: { force?: boolean } = {}): void {
    if (!this.statsDirty && !options.force) return;

    const intervalMs = Math.max(this.statsSnapshotIntervalMs, 0);
    if (!options.force && intervalMs > 0 && nowMs - this.lastStatsSnapshotAtMs < intervalMs) {
      return;
    }

    this.prune(nowMs, { force: true });

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

    store.append({
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

  selectMarketsForPrompt(nowMs: number, windowMs: number): Array<[string, MarketStats]> {
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

    entries.sort((a, b) => {
      const diff = scoreMarketStats(b[1]) - scoreMarketStats(a[1]);
      if (diff !== 0) return diff;
      const recency = b[1].lastUpdatedMs - a[1].lastUpdatedMs;
      if (recency !== 0) return recency;
      return a[0].localeCompare(b[0]);
    });

    return entries.slice(0, topN);
  }

  private replayFromStore(store: EventStore, sinceExclusiveMs: number): void {
    const events = store.listEventsByTypes({
      types: ['opportunity:detected', 'risk:approved', 'execution:outcome', 'execution:fill'],
      sinceExclusiveMs
    });

    let maxTimestamp = sinceExclusiveMs;
    let applied = false;

    for (const event of events) {
      maxTimestamp = Math.max(maxTimestamp, event.timestamp);
      const payload = asPayloadRecord(event);
      if (!payload) continue;

      if (event.type === 'opportunity:detected') {
        const marketId = extractMarketId(payload);
        const edge =
          typeof payload.edge === 'number'
            ? extractNumeric(payload.edge)
            : extractNumeric(asObjectRecord(payload.opportunity)?.edge);
        if (marketId) {
          this.update(marketId, { opportunities: 1, edge: edge ?? undefined }, event.timestamp, {
            recordPending: false,
            markDirty: false
          });
          applied = true;
        }
        continue;
      }

      if (event.type === 'risk:approved') {
        const marketId = extractMarketId(payload);
        if (marketId) {
          this.update(marketId, { approvals: 1 }, event.timestamp, {
            recordPending: false,
            markDirty: false
          });
          applied = true;
        }
        continue;
      }

      if (event.type === 'execution:outcome') {
        const marketId = extractMarketId(payload);
        const status = typeof payload.status === 'string' ? payload.status : undefined;
        if (marketId && status === 'timeout') {
          this.update(marketId, { timeouts: 1 }, event.timestamp, {
            recordPending: false,
            markDirty: false
          });
          applied = true;
        }
        continue;
      }

      if (event.type === 'execution:fill') {
        const marketId = extractMarketId(payload);
        const slippage = extractNumeric(payload.slippage);
        if (marketId && typeof slippage === 'number') {
          this.update(marketId, { slippageSample: slippage }, event.timestamp, {
            recordPending: false,
            markDirty: false
          });
          applied = true;
        }
      }
    }

    this.lastAppliedStatsEventAtMs = Math.max(this.lastAppliedStatsEventAtMs, maxTimestamp);
    if (applied) this.statsDirty = true;
  }
}

function createEmptyMarketStats(nowMs: number): MarketStats {
  return {
    opportunities: 0,
    approvals: 0,
    avgEdge: 0,
    slippageSamples: 0,
    avgSlippage: 0,
    timeouts: 0,
    lastUpdatedMs: nowMs
  };
}

function normalizeSnapshotStats(value: unknown): MarketStats | null {
  if (!isObjectRecord(value)) return null;

  return {
    opportunities: typeof value.opportunities === 'number' ? Math.max(0, value.opportunities) : 0,
    approvals: typeof value.approvals === 'number' ? Math.max(0, value.approvals) : 0,
    avgEdge: typeof value.avg_edge === 'number' && Number.isFinite(value.avg_edge) ? value.avg_edge : 0,
    slippageSamples: typeof value.slippage_samples === 'number' ? Math.max(0, value.slippage_samples) : 0,
    avgSlippage:
      typeof value.avg_slippage === 'number' && Number.isFinite(value.avg_slippage) ? value.avg_slippage : 0,
    timeouts: typeof value.timeouts === 'number' ? Math.max(0, value.timeouts) : 0,
    lastUpdatedMs:
      typeof value.last_updated_ms === 'number' && Number.isFinite(value.last_updated_ms)
        ? Math.max(0, value.last_updated_ms)
        : 0
  };
}

function scoreMarketStats(stats: MarketStats): number {
  const approvals = Math.max(stats.approvals, 0);
  const opportunities = Math.max(stats.opportunities, 0);
  const edge = Number.isFinite(stats.avgEdge) ? Math.abs(stats.avgEdge) : 0;
  const timeouts = Math.max(stats.timeouts, 0);
  return approvals * 1_000_000 + opportunities * 1_000 + Math.floor(edge * 1000) - timeouts;
}

function asPayloadRecord(event: StoredEvent): Record<string, unknown> | null {
  return asObjectRecord(event.payload);
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function extractNumeric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function extractMarketId(payload: Record<string, unknown>): string | null {
  for (const candidate of [payload.marketId, payload.market_id, payload.market]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }

  const opportunity = isObjectRecord(payload.opportunity) ? payload.opportunity : null;
  if (!opportunity) return null;

  for (const candidate of [opportunity.marketId, opportunity.market_id, opportunity.market]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }

  return null;
}
