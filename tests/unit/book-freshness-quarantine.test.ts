import { describe, expect, it } from 'vitest';

import {
  createBookFreshnessQuarantine,
  isOpsAlertPayload,
  parseBookFreshnessInfo
} from '../../src/agents/ops/bookFreshnessQuarantine.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { IncidentTracker } from '../../src/services/IncidentTracker.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

function makeAlert(tokenId: string, stalenessMs: number, timestamp: number) {
  return {
    check: 'book_freshness',
    result: {
      ok: false,
      info: `worst=${tokenId} stalenessMs=${stalenessMs} thresholdMs=15000`
    },
    timestamp
  };
}

describe('book freshness quarantine', () => {
  it('parses info payloads', () => {
    const parsed = parseBookFreshnessInfo('worst=token123 stalenessMs=20456 thresholdMs=15000');
    expect(parsed.tokenId).toBe('token123');
    expect(parsed.stalenessMs).toBe(20456);
  });

  it('parses missing token info payloads', () => {
    const parsed = parseBookFreshnessInfo('stalenessMs=20456 thresholdMs=15000');
    expect(parsed.tokenId).toBeNull();
  });

  it('parses undefined info payloads', () => {
    const parsed = parseBookFreshnessInfo();
    expect(parsed.tokenId).toBeNull();
  });

  it('guards ops alert payload shape', () => {
    expect(isOpsAlertPayload(null)).toBe(false);
    expect(isOpsAlertPayload({})).toBe(false);
    expect(isOpsAlertPayload({ check: 'book_freshness' })).toBe(false);
    expect(isOpsAlertPayload({ check: 'book_freshness', timestamp: 1, result: null })).toBe(false);
    expect(
      isOpsAlertPayload({ check: 'book_freshness', timestamp: 1, result: { ok: true, info: 123 } })
    ).toBe(false);
    expect(
      isOpsAlertPayload({
        check: 'book_freshness',
        timestamp: 1,
        result: { ok: true, error: 123 }
      })
    ).toBe(false);
    expect(
      isOpsAlertPayload({
        check: 'book_freshness',
        timestamp: 1,
        result: { ok: true, latencyMs: 'fast' }
      })
    ).toBe(false);
    expect(
      isOpsAlertPayload({
        check: 'book_freshness',
        timestamp: 1,
        result: { ok: 'false' }
      })
    ).toBe(false);
    expect(
      isOpsAlertPayload({ check: 'book_freshness', timestamp: 1, result: { ok: true } })
    ).toBe(true);
    expect(
      isOpsAlertPayload({
        check: 'book_freshness',
        timestamp: 1,
        result: { ok: false, info: 'worst=t1 stalenessMs=10' }
      })
    ).toBe(true);
  });

  it('quarantines after threshold within window', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 3, windowMs: 300000, cooldownMs: 60000 }
    });

    handler.handle(makeAlert('t1', 20000, 1000));
    handler.handle(makeAlert('t1', 21000, 2000));
    expect(allowlist.getStatus('m1')?.status).toBe('allowed');

    handler.handle(makeAlert('t1', 22000, 3000));
    expect(allowlist.getStatus('m1')?.status).toBe('quarantined');
  });

  it('skips non-book freshness alerts and ok results', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 1, windowMs: 300000, cooldownMs: 60000 }
    });

    handler.handle({ check: 'other_check', result: { ok: false }, timestamp: 1000 });
    handler.handle({ check: 'book_freshness', result: { ok: true }, timestamp: 1001 });
    handler.handle({ check: 'book_freshness', result: { ok: false }, timestamp: 1002 });
    expect(incidentTracker.recent(10)).toHaveLength(0);
  });

  it('resets the counter outside the window', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 2, windowMs: 1000, cooldownMs: 60000 }
    });

    handler.handle(makeAlert('t1', 20000, 1000));
    handler.handle(makeAlert('t1', 21000, 4000));
    expect(allowlist.getStatus('m1')?.status).toBe('allowed');
  });

  it('respects cooldown before re-quarantining', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 2, windowMs: 300000, cooldownMs: 60000 }
    });

    handler.handle(makeAlert('t1', 20000, 1000));
    handler.handle(makeAlert('t1', 20000, 1001));
    expect(incidentTracker.recent(10)).toHaveLength(1);

    allowlist.allow('m1');
    handler.handle(makeAlert('t1', 20000, 2000));
    handler.handle(makeAlert('t1', 20000, 2001));
    expect(incidentTracker.recent(10)).toHaveLength(1);

    handler.handle(makeAlert('t1', 20000, 62000));
    handler.handle(makeAlert('t1', 20000, 62001));
    expect(incidentTracker.recent(10)).toHaveLength(2);
  });

  it('skips when token is unmapped or market already quarantined', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: {},
      config: { threshold: 1, windowMs: 300000, cooldownMs: 0 }
    });

    handler.handle(makeAlert('missing', 20000, 1000));
    expect(incidentTracker.recent(10)).toHaveLength(0);

    allowlist.quarantine('m1', 60000, 'book_stale');
    const handler2 = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 1, windowMs: 300000, cooldownMs: 0 }
    });
    handler2.handle(makeAlert('t1', 20000, 1000));
    expect(incidentTracker.recent(10)).toHaveLength(0);
  });

  it('updates config and honors disabled window', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 2, windowMs: 300000, cooldownMs: 0 }
    });

    handler.updateConfig({ threshold: 1, windowMs: 0 });
    handler.handle(makeAlert('t1', 20000, 1000));
    expect(incidentTracker.recent(10)).toHaveLength(0);

    handler.updateConfig({ windowMs: 300000 });
    handler.handle(makeAlert('t1', 20000, 2000));
    expect(incidentTracker.recent(10)).toHaveLength(1);
  });

  it('uses now() fallback for invalid timestamps and records null staleness', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 1, windowMs: 300000, cooldownMs: 0 },
      now: () => 5555
    });

    handler.handle({
      check: 'book_freshness',
      result: { ok: false, info: 'worst=t1' },
      timestamp: Number.NaN
    });

    const incident = incidentTracker.recent(1)[0];
    expect(incident.timestamp).toBe(5555);
    expect(incident.detail?.stalenessMs).toBeNull();
  });

  it('skips alerts that do not include a token id in info', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.seed(['m1']);
    const metrics = new MetricsStore(100);
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 60000,
      maxIncidents: 100
    });
    const handler = createBookFreshnessQuarantine({
      allowlist,
      incidentTracker,
      tokenToMarketId: { t1: 'm1' },
      config: { threshold: 1, windowMs: 300000, cooldownMs: 0 }
    });

    handler.handle({
      check: 'book_freshness',
      result: { ok: false, info: 'stalenessMs=99999 thresholdMs=15000' },
      timestamp: 1000
    });

    expect(incidentTracker.recent(10)).toHaveLength(0);
  });
});
