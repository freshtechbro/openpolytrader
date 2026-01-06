import type { HealthCheck, HealthCheckResult } from './OpsAgent.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { LatencyEvent } from '../../telemetry/events.js';
import type { OrderBookState } from '../../domain/orderbook.js';

export function createBookFreshnessCheck(
  getBooks: () => OrderBookState[],
  thresholdMs: number
): HealthCheck {
  return {
    name: 'book_freshness',
    check: async () => {
      const bounded = Math.max(thresholdMs, 0);
      const now = Date.now();
      const books = getBooks();
      if (books.length === 0) {
        return { ok: false, error: 'no_orderbooks' };
      }

      const first = books[0];
      let worst: { tokenId: string; stalenessMs: number } = {
        tokenId: first.tokenId,
        stalenessMs: Math.max(0, now - first.lastUpdateMs)
      };

      for (const book of books.slice(1)) {
        const stalenessMs = Math.max(0, now - book.lastUpdateMs);
        if (stalenessMs > worst.stalenessMs) {
          worst = { tokenId: book.tokenId, stalenessMs };
        }
      }

      if (bounded > 0 && worst.stalenessMs > bounded) {
        return {
          ok: false,
          info: `worst=${worst.tokenId} stalenessMs=${worst.stalenessMs} thresholdMs=${bounded}`
        };
      }

      return {
        ok: true,
        info: `worst=${worst.tokenId} stalenessMs=${worst.stalenessMs}`
      };
    }
  };
}

export function createDelayedAckRateCheck(
  metrics: MetricsStore,
  getMarketIds: () => string[],
  windowMs: number,
  threshold: number
): HealthCheck {
  return {
    name: 'delayed_ack_rate',
    check: async () => {
      const markets = getMarketIds();
      if (markets.length === 0) return { ok: true, info: 'no_markets' };

      const boundedWindow = Math.max(windowMs, 0);
      const boundedThreshold = Math.max(threshold, 0);
      const now = Date.now();

      const first = markets[0];
      let worst: { marketId: string; rate: number } = {
        marketId: first,
        rate: metrics.getDelayedAckRate(first, boundedWindow, now)
      };

      for (const marketId of markets.slice(1)) {
        const rate = metrics.getDelayedAckRate(marketId, boundedWindow, now);
        if (rate > worst.rate) worst = { marketId, rate };
      }

      if (worst.rate > boundedThreshold) {
        return {
          ok: false,
          info: `worst=${worst.marketId} rate=${worst.rate} threshold=${boundedThreshold}`
        };
      }

      return {
        ok: true,
        info: `worst=${worst.marketId} rate=${worst.rate}`
      };
    }
  };
}

export function createLatencyPercentileCheck(input: {
  metrics: MetricsStore;
  stage: LatencyEvent['stage'];
  percentile: number;
  thresholdMs: number;
  windowMs: number;
  limit?: number;
}): HealthCheck {
  return {
    name: `latency_p${Math.round(input.percentile * 100)}_${input.stage}`,
    check: async () => {
      const boundedPercentile = clamp(input.percentile, 0, 1);
      const boundedThreshold = Math.max(input.thresholdMs, 0);
      const boundedWindow = Math.max(input.windowMs, 0);
      const now = Date.now();
      const limit = Math.max(input.limit ?? 1000, 1);

      const events = input.metrics.recent('latency', limit);
      const samples: number[] = [];

      for (const event of events) {
        if (boundedWindow > 0 && now - event.timestamp > boundedWindow) continue;
        const payload = event.data as Partial<LatencyEvent>;
        if (payload.stage !== input.stage) continue;
        const value =
          typeof payload.latencyMs === 'number'
            ? payload.latencyMs
            : typeof payload.cumulativeMs === 'number'
              ? payload.cumulativeMs
              : null;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          samples.push(value);
        }
      }

      if (samples.length === 0) {
        return { ok: true, info: 'no_samples' };
      }

      samples.sort((a, b) => a - b);
      const p = percentileOf(samples, boundedPercentile);
      const result: HealthCheckResult = {
        ok: boundedThreshold === 0 ? true : p <= boundedThreshold,
        info: `p${Math.round(boundedPercentile * 100)}=${p}ms thresholdMs=${boundedThreshold} samples=${samples.length}`
      };
      return result;
    }
  };
}

export function createPairedFillRateCheck(input: {
  metrics: MetricsStore;
  threshold: number;
  windowMs: number;
  limit?: number;
}): HealthCheck {
  return {
    name: 'paired_fill_rate',
    check: async () => {
      const boundedThreshold = clamp(input.threshold, 0, 1);
      const boundedWindow = Math.max(input.windowMs, 0);
      const now = Date.now();
      const limit = Math.max(input.limit ?? 2000, 1);

      const events = input.metrics.recent('execution_lifecycle', limit);
      const terminalByExecution = new Map<string, string>();

      for (const event of events) {
        if (boundedWindow > 0 && now - event.timestamp > boundedWindow) continue;
        const data = event.data as { executionId?: string; state?: string };
        const executionId = typeof data.executionId === 'string' ? data.executionId : null;
        const state = typeof data.state === 'string' ? data.state : null;
        if (!executionId || !state) continue;
        if (!isTerminalExecutionState(state)) continue;
        terminalByExecution.set(executionId, state);
      }

      const total = terminalByExecution.size;
      if (total === 0) {
        return { ok: true, info: 'no_terminal_executions' };
      }

      let successes = 0;
      for (const state of terminalByExecution.values()) {
        if (state === 'complete') successes += 1;
      }

      const rate = successes / total;
      if (rate < boundedThreshold) {
        return { ok: false, info: `rate=${rate} threshold=${boundedThreshold} total=${total}` };
      }
      return { ok: true, info: `rate=${rate} total=${total}` };
    }
  };
}

export function createCircuitBreakerCheck(getOpenMarkets: () => string[]): HealthCheck {
  return {
    name: 'circuit_breakers',
    check: async () => {
      const open = getOpenMarkets();
      if (open.length > 0) {
        return { ok: false, info: `openMarkets=${open.length}` };
      }
      return { ok: true, info: 'ok' };
    }
  };
}

function isTerminalExecutionState(state: string): boolean {
  return state === 'complete' || state === 'failed' || state === 'timeout' || state === 'unwind_failed';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function percentileOf(sortedAscending: number[], percentile: number): number {
  const idx = Math.max(Math.ceil(percentile * sortedAscending.length) - 1, 0);
  return sortedAscending[Math.min(idx, sortedAscending.length - 1)];
}
