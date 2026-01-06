import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EventStore } from '../../src/core/EventStore.js';
import { computeSloAggregates } from '../../src/agents/ops/sloAggregates.js';

describe('SQLite SLO aggregates', () => {
  it('computes rolling 1h/24h aggregates from persisted metrics', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    const nowMs = 1_700_000_000_000;
    const twoHoursAgo = nowMs - 2 * 60 * 60 * 1000;
    const tenMinutesAgo = nowMs - 10 * 60 * 1000;

    try {
      // Terminal executions: 2 in last hour, 1 older than 1h but within 24h
      store.persistMetric({
        type: 'execution_lifecycle',
        timestamp: tenMinutesAgo,
        data: { executionId: 'e1', state: 'complete' }
      });
      store.persistMetric({
        type: 'execution_lifecycle',
        timestamp: tenMinutesAgo,
        data: { executionId: 'e2', state: 'failed' }
      });
      store.persistMetric({
        type: 'execution_lifecycle',
        timestamp: twoHoursAgo,
        data: { executionId: 'e3', state: 'complete' }
      });

      // Latency samples (submitted stage only)
      for (let i = 1; i <= 20; i += 1) {
        store.persistMetric({
          type: 'latency',
          timestamp: tenMinutesAgo + i,
          data: { stage: 'submitted', timestampMs: tenMinutesAgo + i, latencyMs: i }
        });
      }
      store.persistMetric({
        type: 'latency',
        timestamp: tenMinutesAgo + 999,
        data: { stage: 'acked', timestampMs: tenMinutesAgo + 999, latencyMs: 999 }
      });

      // Delayed ack rate: m1=0.2, m2=1.0 (worst)
      for (let i = 0; i < 10; i += 1) {
        store.persistMetric({
          type: 'order_attempt',
          timestamp: tenMinutesAgo + 2000 + i,
          data: { marketId: 'm1' }
        });
      }
      for (let i = 0; i < 2; i += 1) {
        store.persistMetric({
          type: 'delayed_ack',
          timestamp: tenMinutesAgo + 3000 + i,
          data: { marketId: 'm1' }
        });
      }
      store.persistMetric({
        type: 'order_attempt',
        timestamp: tenMinutesAgo + 4000,
        data: { marketId: 'm2' }
      });
      store.persistMetric({
        type: 'delayed_ack',
        timestamp: tenMinutesAgo + 4001,
        data: { marketId: 'm2' }
      });
      store.persistMetric({
        type: 'order_attempt',
        timestamp: tenMinutesAgo + 4500,
        data: { marketId: 'm3' }
      });

      // Book freshness violation is represented as an OpsAgent incident alert.
      store.persistMetric({
        type: 'incident',
        timestamp: tenMinutesAgo + 5000,
        data: { check: 'book_freshness', result: { ok: false, error: 'stale' }, timestamp: tenMinutesAgo + 5000 }
      });
      store.persistMetric({
        type: 'incident',
        timestamp: tenMinutesAgo + 5001,
        data: { check: 'book_freshness', result: { ok: true, info: 'ok' }, timestamp: tenMinutesAgo + 5001 }
      });

      // Non-matching incidents should not be counted.
      store.persistMetric({
        type: 'incident',
        timestamp: tenMinutesAgo + 6000,
        data: { marketId: 'm3', reason: 'latency_exceeded', timestamp: tenMinutesAgo + 6000 }
      });

      // Events with missing IDs or non-terminal states should be ignored.
      store.persistMetric({
        type: 'execution_lifecycle',
        timestamp: tenMinutesAgo + 7000,
        data: { executionId: 'e4', state: 'submitted' }
      });
      store.persistMetric({
        type: 'execution_lifecycle',
        timestamp: tenMinutesAgo + 7001,
        data: { state: 'complete' }
      });

      // Invalid latency payloads should be ignored.
      store.persistMetric({
        type: 'latency',
        timestamp: tenMinutesAgo + 8000,
        data: { stage: 'submitted', timestampMs: tenMinutesAgo + 8000, latencyMs: 'nope' }
      });

      const response = computeSloAggregates(store, nowMs);
      const oneHour = response.aggregates.find((agg) => agg.window === '1h');
      const oneDay = response.aggregates.find((agg) => agg.window === '24h');

      expect(oneHour).toBeDefined();
      expect(oneDay).toBeDefined();

      expect(oneHour?.pairedFillRate).toBeCloseTo(0.5);
      expect(oneDay?.pairedFillRate).toBeCloseTo(2 / 3);

      // p95 of 1..20 = 19 using ceil(p*n)-1 index rule.
      expect(oneHour?.p95LatencyMs).toBe(19);

      expect(oneHour?.delayedAckRate).toBeCloseTo(1);
      expect(oneHour?.bookFreshnessViolations).toBe(1);
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('returns zeros for empty telemetry and ignores malformed metric payloads', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });
    const nowMs = 1_700_000_000_000;

    try {
      store.persistMetric({ type: 'order_attempt', timestamp: nowMs - 1000, data: { marketId: '' } });
      store.persistMetric({ type: 'delayed_ack', timestamp: nowMs - 900, data: { marketId: 'm1' } });
      store.persistMetric({ type: 'incident', timestamp: nowMs - 800, data: null });

      const response = computeSloAggregates(store, nowMs);
      const oneHour = response.aggregates.find((agg) => agg.window === '1h');

      expect(oneHour).toBeDefined();
      expect(oneHour?.pairedFillRate).toBe(0);
      expect(oneHour?.p95LatencyMs).toBe(0);
      expect(oneHour?.delayedAckRate).toBe(0);
      expect(oneHour?.bookFreshnessViolations).toBe(0);
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('returns zeros when no metrics exist', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });
    const nowMs = 1_700_000_000_000;

    try {
      const response = computeSloAggregates(store, nowMs);
      const oneHour = response.aggregates.find((agg) => agg.window === '1h');
      const oneDay = response.aggregates.find((agg) => agg.window === '24h');

      expect(oneHour).toBeDefined();
      expect(oneDay).toBeDefined();

      expect(oneHour?.pairedFillRate).toBe(0);
      expect(oneHour?.p95LatencyMs).toBe(0);
      expect(oneHour?.delayedAckRate).toBe(0);
      expect(oneHour?.bookFreshnessViolations).toBe(0);
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('supports metric pruning by timestamp', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    try {
      store.persistMetric({ type: 'info', timestamp: 1000, data: { message: 'old' } });
      store.persistMetric({ type: 'info', timestamp: 2000, data: { message: 'new' } });

      expect(store.queryMetrics('info', 10_000, 3000).length).toBe(2);
      expect(store.pruneMetrics(1500)).toBeGreaterThan(0);
      expect(store.queryMetrics('info', 10_000, 3000).length).toBe(1);

      expect(store.queryMetricsByTypes([], 10_000, 3000)).toEqual([]);
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
