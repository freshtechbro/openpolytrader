import type { LatencyEvent } from '../../telemetry/events.js';
import type { MetricEvent, MetricEventType } from '../../telemetry/metrics.js';

type SloMetricStore = Pick<
  import('../../core/EventStore.js').EventStore,
  'queryMetricsByTypes'
>;

interface SLOAggregate {
  window: '1h' | '24h';
  pairedFillRate: number;
  p95LatencyMs: number;
  p95AckLatencyMs: number;
  delayedAckRate: number;
  bookFreshnessViolations: number;
  samples: {
    terminalExecutions: number;
    latencySamples: number;
    delayedAckMarketsConsidered: number;
    delayedAckOrders: number;
    delayedAckEvents: number;
  };
}

interface SLOAggregatesResponse {
  generatedAtMs: number;
  aggregates: SLOAggregate[];
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const SLO_TYPES: MetricEventType[] = [
  'execution_lifecycle',
  'latency',
  'order_attempt',
  'delayed_ack',
  'incident'
];

export function computeSloAggregates(store: SloMetricStore, nowMs = Date.now()): SLOAggregatesResponse {
  return {
    generatedAtMs: nowMs,
    aggregates: [
      computeWindow(store, { window: '1h', windowMs: ONE_HOUR_MS, nowMs }),
      computeWindow(store, { window: '24h', windowMs: ONE_DAY_MS, nowMs })
    ]
  };
}

function computeWindow(
  store: SloMetricStore,
  input: { window: '1h' | '24h'; windowMs: number; nowMs: number }
): SLOAggregate {
  const events = store.queryMetricsByTypes(SLO_TYPES, input.windowMs, input.nowMs);

  const terminalByExecution = new Map<string, string>();
  const latencySamples: number[] = [];
  const ackLatencySamples: number[] = [];
  const orderAttemptsByMarket = new Map<string, number>();
  const delayedAcksByMarket = new Map<string, number>();
  let bookFreshnessViolations = 0;

  for (const event of events) {
    if (event.type === 'execution_lifecycle') {
      const data = event.data as { executionId?: string; state?: string };
      const executionId = typeof data.executionId === 'string' ? data.executionId : null;
      const state = typeof data.state === 'string' ? data.state : null;
      if (!executionId || !state) continue;
      if (!isTerminalExecutionState(state)) continue;
      terminalByExecution.set(executionId, state);
      continue;
    }

    if (event.type === 'latency') {
      const payload = event.data as Partial<LatencyEvent>;
      const value =
        typeof payload.latencyMs === 'number'
          ? payload.latencyMs
          : typeof payload.cumulativeMs === 'number'
            ? payload.cumulativeMs
            : null;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        if (payload.stage === 'submitted') latencySamples.push(value);
        if (payload.stage === 'acked') ackLatencySamples.push(value);
      }
      continue;
    }

    if (event.type === 'order_attempt') {
      const marketId = extractMarketId(event);
      if (!marketId) continue;
      orderAttemptsByMarket.set(marketId, (orderAttemptsByMarket.get(marketId) ?? 0) + 1);
      continue;
    }

    if (event.type === 'delayed_ack') {
      const marketId = extractMarketId(event);
      if (!marketId) continue;
      delayedAcksByMarket.set(marketId, (delayedAcksByMarket.get(marketId) ?? 0) + 1);
      continue;
    }

    if (event.type === 'incident') {
      if (isBookFreshnessViolation(event)) {
        bookFreshnessViolations += 1;
      }
    }
  }

  const terminalExecutions = terminalByExecution.size;
  const pairedFillRate =
    terminalExecutions === 0
      ? 0
      : Array.from(terminalByExecution.values()).filter((state) => state === 'complete').length /
        terminalExecutions;

  const p95LatencyMs = percentile(latencySamples, 0.95);
  const p95AckLatencyMs = percentile(ackLatencySamples, 0.95);

  const delayedAckRate = computeWorstDelayedAckRate(orderAttemptsByMarket, delayedAcksByMarket);

  const delayedAckOrders = sumValues(orderAttemptsByMarket);
  const delayedAckEvents = sumValues(delayedAcksByMarket);

  return {
    window: input.window,
    pairedFillRate,
    p95LatencyMs,
    p95AckLatencyMs,
    delayedAckRate,
    bookFreshnessViolations,
    samples: {
      terminalExecutions,
      latencySamples: latencySamples.length,
      delayedAckMarketsConsidered: orderAttemptsByMarket.size,
      delayedAckOrders,
      delayedAckEvents
    }
  };
}

function extractMarketId(event: MetricEvent): string | null {
  const data = event.data as { marketId?: unknown } | undefined;
  const marketId = data?.marketId;
  if (typeof marketId === 'string' && marketId.trim().length > 0) return marketId.trim();
  return null;
}

function isBookFreshnessViolation(event: MetricEvent): boolean {
  const data = event.data as { check?: unknown; result?: unknown } | undefined;
  if (!data || data.check !== 'book_freshness') return false;
  const result = data.result as { ok?: unknown } | undefined;
  return Boolean(result && result.ok === false);
}

function isTerminalExecutionState(state: string): boolean {
  return state === 'complete' || state === 'failed' || state === 'timeout' || state === 'unwind_failed';
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const boundedP = Math.min(Math.max(p, 0), 1);
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(Math.ceil(boundedP * sorted.length) - 1, 0);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeWorstDelayedAckRate(
  ordersByMarket: Map<string, number>,
  delayedByMarket: Map<string, number>
): number {
  const markets = new Set<string>([...ordersByMarket.keys(), ...delayedByMarket.keys()]);
  if (markets.size === 0) return 0;
  let worst = 0;
  for (const marketId of markets) {
    const orders = ordersByMarket.get(marketId) ?? 0;
    const delayed = delayedByMarket.get(marketId) ?? 0;
    if (orders <= 0) continue;
    const rate = delayed / orders;
    if (rate > worst) worst = rate;
  }
  return worst;
}

function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}
