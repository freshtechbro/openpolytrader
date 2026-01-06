import { describe, it, expect, vi } from 'vitest';

import { MetricsStore } from '../../src/telemetry/metrics.js';
import { emitAllowlistSnapshot } from '../../src/telemetry/allowlist.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;
const DEFAULT_ALLOWLIST_CONFIG = { autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME };

describe('MetricsStore', () => {
  it('records events and snapshots counts', () => {
    const store = new MetricsStore(2);
    store.record({ type: 'health', timestamp: 1, data: {} });
    store.record({ type: 'incident', timestamp: 2, data: {} });
    store.record({ type: 'incident', timestamp: 3, data: {} });

    const snapshot = store.snapshot();
    expect(snapshot.counts.health).toBe(0);
    expect(snapshot.counts.incident).toBe(2);
    expect(snapshot.lastEventAt).toBe(3);
  });

  it('filters recent events by type', () => {
    const store = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    store.record({ type: 'info', timestamp: 10, data: {} });
    store.record({ type: 'error', timestamp: 20, data: {} });

    expect(store.recent('info', 5).length).toBe(1);
    expect(store.recent(undefined, 5).length).toBe(2);
  });

  it('tracks latency, order velocity, and OTR windows', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const store = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    store.recordLatency({
      stage: 'detected',
      opportunityId: 'opp-1',
      marketId: 'm1',
      timestampMs: now
    });

    store.recordOrderAttempt('m1', now);
    store.recordOrderAttempt('m1', now);
    store.recordFill('m1', now);

    expect(store.recent('latency', 1)[0].type).toBe('latency');
    expect(store.getOrderVelocity(60000, now)).toBe(2);
    expect(store.getOTR('m1', 60000, now)).toBeCloseTo(2);
    expect(store.getOrderVelocity(0, now)).toBe(0);
    expect(store.getOrderStats('m1', 0, now)).toEqual({ orders: 0, fills: 0 });

    vi.setSystemTime(now + 60001);
    expect(store.getOrderVelocity(60000)).toBe(0);

    vi.useRealTimers();
  });

  it('computes delayed ack rates and handles empty windows', () => {
    const store = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const now = Date.now();

    expect(store.getDelayedAckRate('m1', 60000, now)).toBe(0);
    expect(store.getDelayedAckRate('m1', 0, now)).toBe(0);

    store.recordOrderAttempt('m1', now);
    store.recordDelayedAck('m1', now);
    expect(store.getDelayedAckRate('m1', 60000, now)).toBeCloseTo(1);
  });
});

describe('emitAllowlistSnapshot', () => {
  it('records allowlist state into metrics', () => {
    const store = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    allowlist.allow('m1');

    emitAllowlistSnapshot(store, allowlist);
    const event = store.recent('info', 1)[0];

    expect(event.data).toEqual({ allowlist: [{ key: 'm1', entry: { status: 'allowed' } }] });
  });
});
