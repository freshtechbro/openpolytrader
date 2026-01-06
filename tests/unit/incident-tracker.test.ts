import { describe, it, expect } from 'vitest';

import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { IncidentTracker } from '../../src/services/IncidentTracker.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;

describe('IncidentTracker', () => {
  it('records incidents and quarantines markets', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.allow('m1');

    const tracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1000,
      maxIncidents: 10
    });

    tracker.record({
      marketId: 'm1',
      reason: 'order_failed',
      timestamp: 123
    });

    expect(allowlist.getStatus('m1')?.status).toBe('quarantined');
    expect(metrics.recent('incident', 1)[0].data).toMatchObject({
      marketId: 'm1',
      reason: 'order_failed',
      severity: 'high',
      recoveryAction: 'quarantine'
    });
  });

  it('caps incident history', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const tracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1000,
      maxIncidents: 1
    });

    tracker.record({ marketId: 'm1', reason: 'order_failed', timestamp: 1 });
    tracker.record({ marketId: 'm2', reason: 'order_failed', timestamp: 2 });

    const recent = tracker.recent(5);
    expect(recent.length).toBe(1);
    expect(recent[0].marketId).toBe('m2');
  });

  it('does not quarantine for alert-only incidents', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.allow('m1');
    const tracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1000,
      maxIncidents: 10
    });

    tracker.record({ marketId: 'm1', reason: 'unknown', timestamp: 1 });

    expect(allowlist.getStatus('m1')?.status).toBe('allowed');
  });
});
