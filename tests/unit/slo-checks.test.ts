import { describe, expect, it, vi } from 'vitest';

import { MetricsStore } from '../../src/telemetry/metrics.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import {
  createBookFreshnessCheck,
  createCircuitBreakerCheck,
  createDelayedAckRateCheck,
  createLatencyPercentileCheck,
  createPairedFillRateCheck
} from '../../src/agents/ops/sloChecks.js';

describe('sloChecks', () => {
  it('flags stale books', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const check = createBookFreshnessCheck(
      () => [{ tokenId: 'token-1', lastUpdateMs: now - 1000 } as unknown as OrderBookState],
      500
    );
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('treats negative thresholdMs as unbounded for book freshness', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const check = createBookFreshnessCheck(
      () =>
        [
          { tokenId: 'fresh', lastUpdateMs: now + 100 } as unknown as OrderBookState,
          { tokenId: 'stale', lastUpdateMs: now - 10_000 } as unknown as OrderBookState
        ],
      -1
    );

    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('worst=stale');
  });

  it('keeps first worst book when later books are fresher', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const check = createBookFreshnessCheck(
      () =>
        [
          { tokenId: 'worst', lastUpdateMs: now - 2000 } as unknown as OrderBookState,
          { tokenId: 'fresh', lastUpdateMs: now - 100 } as unknown as OrderBookState
        ],
      5000
    );
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('worst=worst');
  });

  it('passes when books are fresh', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const check = createBookFreshnessCheck(
      () => [{ tokenId: 'token-1', lastUpdateMs: now - 100 } as unknown as OrderBookState],
      500
    );
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('fails when there are no books', async () => {
    const check = createBookFreshnessCheck(() => [], 500);
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('returns no_active_orderbooks when idle cutoff filters all books', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const check = createBookFreshnessCheck(
      () => [{ tokenId: 'stale', lastUpdateMs: now - 10_000 } as unknown as OrderBookState],
      500,
      100
    );
    const result = await check.check();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_active_orderbooks');
  });

  it('evaluates delayed ack rate', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordOrderAttempt('market-1', now);
    metrics.recordDelayedAck('market-1', now);

    const check = createDelayedAckRateCheck(metrics, () => ['market-1'], 60000, 0.5);
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('selects the worst delayed ack rate across markets', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordOrderAttempt('market-2', now);
    metrics.recordDelayedAck('market-2', now);

    const check = createDelayedAckRateCheck(metrics, () => ['market-1', 'market-2'], 60000, 0.5);
    const result = await check.check();
    expect(result.ok).toBe(false);
    expect(result.info).toContain('worst=market-2');
  });

  it('keeps initial worst delayed ack rate when later market is lower', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordOrderAttempt('market-1', now);
    metrics.recordDelayedAck('market-1', now);
    metrics.recordOrderAttempt('market-2', now);

    const check = createDelayedAckRateCheck(metrics, () => ['market-1', 'market-2'], 60000, 0.5);
    const result = await check.check();
    expect(result.ok).toBe(false);
    expect(result.info).toContain('worst=market-1');
  });

  it('treats negative delayed ack thresholds as zero and passes when rate is zero', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    const check = createDelayedAckRateCheck(metrics, () => ['market-1'], -1, -1);
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('worst=market-1');
  });

  it('treats missing markets as ok for delayed ack rate', async () => {
    const metrics = new MetricsStore(1000);
    const check = createDelayedAckRateCheck(metrics, () => [], 60000, 0.5);
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('passes delayed ack rate when below threshold', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordOrderAttempt('market-1', now);

    const check = createDelayedAckRateCheck(metrics, () => ['market-1'], 60000, 0.5);
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('worst=market-1');
  });

  it('computes latency percentiles from telemetry', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordLatency({
      stage: 'submitted',
      opportunityId: 'opp-1',
      marketId: 'market-1',
      timestampMs: now,
      latencyMs: 200
    });
    metrics.recordLatency({
      stage: 'submitted',
      opportunityId: 'opp-2',
      marketId: 'market-1',
      timestampMs: now + 1,
      latencyMs: 100
    });

    const check = createLatencyPercentileCheck({
      metrics,
      stage: 'submitted',
      percentile: 0.95,
      thresholdMs: 150,
      windowMs: 60000
    });
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('clamps invalid percentiles and ignores out-of-window/mismatched latency events', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordLatency({
      stage: 'submitted',
      opportunityId: 'opp-old',
      marketId: 'market-1',
      timestampMs: now - 120_000,
      latencyMs: 999
    });
    metrics.recordLatency({
      stage: 'detected',
      opportunityId: 'opp-wrong-stage',
      marketId: 'market-1',
      timestampMs: now,
      latencyMs: 5
    });
    metrics.recordLatency({
      stage: 'submitted',
      opportunityId: 'opp-bad',
      marketId: 'market-1',
      timestampMs: now,
      latencyMs: -1
    });
    metrics.record({
      type: 'latency',
      timestamp: now,
      data: { stage: 'submitted', timestampMs: now, latencyMs: 10 }
    });
    metrics.record({
      type: 'latency',
      timestamp: now,
      data: { stage: 'submitted', timestampMs: now, cumulativeMs: 20 }
    });

    const check = createLatencyPercentileCheck({
      metrics,
      stage: 'submitted',
      percentile: Number.NaN,
      thresholdMs: 0,
      windowMs: 60_000,
      limit: 10
    });

    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('p0=');
  });

  it('returns ok when no latency samples exist', async () => {
    const metrics = new MetricsStore(1000);
    const check = createLatencyPercentileCheck({
      metrics,
      stage: 'submitted',
      percentile: 0.95,
      thresholdMs: 150,
      windowMs: 60000
    });
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('ignores latency events without numeric samples', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.record({
      type: 'latency',
      timestamp: now,
      data: { stage: 'submitted', timestampMs: now }
    });

    const check = createLatencyPercentileCheck({
      metrics,
      stage: 'submitted',
      percentile: 0.5,
      thresholdMs: 50,
      windowMs: 60000
    });
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('no_samples');
  });

  it('uses cumulativeMs when latencyMs is missing', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.recordLatency({
      stage: 'submitted',
      opportunityId: 'opp-1',
      marketId: 'market-1',
      timestampMs: now,
      cumulativeMs: 120
    });

    const check = createLatencyPercentileCheck({
      metrics,
      stage: 'submitted',
      percentile: 1,
      thresholdMs: 200,
      windowMs: 60000
    });
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('computes paired fill rate from execution lifecycle', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-1', state: 'complete' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-2', state: 'failed' }
    });

    const check = createPairedFillRateCheck({ metrics, threshold: 0.9, windowMs: 60000 });
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('filters paired fill events to terminal states and within window', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(1000);
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now - 120_000,
      data: { executionId: 'exec-old', state: 'complete' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-1', state: 'in_flight' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-2', state: 'timeout' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-3', state: 'unwind_failed' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-4', state: 'failed' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-5', state: 'complete' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 123, state: 'complete' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-missing-state' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { state: 'complete' }
    });
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: now,
      data: { executionId: 'exec-bad-state', state: 123 }
    });

    const check = createPairedFillRateCheck({ metrics, threshold: 0.2, windowMs: 60_000 });
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(result.info).toContain('total=4');
  });

  it('returns ok when no terminal executions exist', async () => {
    const metrics = new MetricsStore(1000);
    const check = createPairedFillRateCheck({ metrics, threshold: 0.9, windowMs: 60000 });
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('passes when paired fill rate meets threshold', async () => {
    const metrics = new MetricsStore(1000);
    metrics.record({
      type: 'execution_lifecycle',
      timestamp: Date.now(),
      data: { executionId: 'exec-1', state: 'complete' }
    });
    const check = createPairedFillRateCheck({ metrics, threshold: 0.5, windowMs: 60000 });
    const result = await check.check();
    expect(result.ok).toBe(true);
  });

  it('flags open circuit breakers', async () => {
    const check = createCircuitBreakerCheck(() => ['market-1']);
    const result = await check.check();
    expect(result.ok).toBe(false);
  });

  it('passes when no circuit breakers are open', async () => {
    const check = createCircuitBreakerCheck(() => []);
    const result = await check.check();
    expect(result.ok).toBe(true);
  });
});
