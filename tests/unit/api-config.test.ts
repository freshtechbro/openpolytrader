import { describe, it, expect, vi } from 'vitest';

import { createOpsServer, startOpsServer } from '../../src/api/server.js';
import { ConfigStore } from '../../src/config/store.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { loadEnv } from '../../src/config/env.js';
import { getInfraConfigSnapshot } from '../../src/config/infra.js';
import { EventStore } from '../../src/core/EventStore.js';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;
const DEFAULT_ALLOWLIST_CONFIG = { autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME };

const incidentsLimit = 100;
const defaultStreamHeartbeatMs = 15000;

function buildServer(options?: {
  configStore?: ConfigStore | null;
  portfolioAgent?: PortfolioAgent;
  infraConfig?: ReturnType<typeof getInfraConfigSnapshot> | null;
  streamHeartbeatMs?: number;
}) {
  const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
  const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
  const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
  const configStore =
    options?.configStore === null
      ? undefined
      : options?.configStore ??
        new ConfigStore({ ...DEFAULT_TRADE_POLICY }, { ...DEFAULT_RISK_CONFIG });

  const app = createOpsServer(
    {
      metrics,
      allowlist,
      opsAgent,
      configStore,
      portfolioAgent: options?.portfolioAgent,
      tradingMode: 'shadow',
      tradingEnabled: false,
      infraConfig:
        options?.infraConfig === null
          ? undefined
          : options?.infraConfig ?? getInfraConfigSnapshot(DEFAULT_ENV)
    },
    { incidentsLimit, streamHeartbeatMs: options?.streamHeartbeatMs ?? defaultStreamHeartbeatMs }
  );

  return { app, metrics, allowlist };
}

describe('ops config endpoints', () => {
  it('returns config snapshots', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/config' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.policy).toBeDefined();
    expect(body.risk).toBeDefined();
    expect(body.tradingMode).toBe('shadow');
    expect(body.tradingEnabled).toBe(false);

    await app.close();
  });

  it('returns config schema', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/config/schema' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sections?.length).toBeGreaterThan(0);

    await app.close();
  });

  it('returns infra config snapshot when configured', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/config/infra' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.ops).toBeDefined();
    expect(body.rpc).toBeDefined();
    expect(body.polymarket).toBeDefined();

    await app.close();
  });

  it('returns 503 when SLO endpoint is missing event store', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/slo' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'event_store_not_configured' });

    await app.close();
  });

  it('returns SLO aggregates when event store is configured', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    try {
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
      const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

      const app = createOpsServer(
        { metrics, allowlist, opsAgent, eventStore: store },
        { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
      );

      const response = await app.inject({ method: 'GET', url: '/slo' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { aggregates?: unknown };
      expect(Array.isArray(body.aggregates)).toBe(true);

      await app.close();
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('returns 500 when SLO aggregation fails', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const eventStore = {
      queryMetricsByTypes: () => {
        throw new Error('boom');
      }
    } as unknown as EventStore;

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, eventStore },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'GET', url: '/slo' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe('slo_compute_failed');

    await app.close();
  });

  it('returns 503 when infra config is not configured', async () => {
    const { app } = buildServer({ infraConfig: null });
    const response = await app.inject({ method: 'GET', url: '/config/infra' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'infra_config_not_configured' });

    await app.close();
  });

  it('updates policy and risk', async () => {
    const { app } = buildServer();

    const policyResponse = await app.inject({
      method: 'PATCH',
      url: '/config/policy',
      payload: { maxDecisionLatencyMs: 300 }
    });
    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json().policy.maxDecisionLatencyMs).toBe(300);

    const riskResponse = await app.inject({
      method: 'PATCH',
      url: '/config/risk',
      payload: { maxPerTradeLossDollars: 30 }
    });
    expect(riskResponse.statusCode).toBe(200);
    expect(riskResponse.json().risk.maxPerTradeLossDollars).toBe(30);

    await app.close();
  });

  it('rejects invalid policy updates', async () => {
    const { app } = buildServer();

    const response = await app.inject({
      method: 'PATCH',
      url: '/config/policy',
      payload: { maxDecisionLatencyMs: -1 }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects policy updates that violate validation', async () => {
    const { app } = buildServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/policy',
      payload: { edgeRequired: 0.5, maxEdge: 0.4 }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects invalid risk updates', async () => {
    const { app } = buildServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/risk',
      payload: { maxPerTradeLossDollars: -5 }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('accepts empty risk updates', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'PATCH', url: '/config/risk' });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('returns 503 when config store is missing', async () => {
    const { app } = buildServer({ configStore: null });
    const response = await app.inject({ method: 'GET', url: '/config' });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('returns portfolio error when not configured', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/portfolio' });

    expect(response.statusCode).toBe(200);
    expect(response.json().error).toBe('portfolio agent not configured');
    await app.close();
  });

  it('returns portfolio snapshots when configured', async () => {
    const { app } = buildServer({ portfolioAgent: new PortfolioAgent(1000) });
    const response = await app.inject({ method: 'GET', url: '/portfolio' });

    expect(response.statusCode).toBe(200);
    expect(response.json().totalCapital).toBe(1000);
    await app.close();
  });

  it('returns metrics and allowlist snapshots', async () => {
    const { app } = buildServer();
    const health = await app.inject({ method: 'GET', url: '/health' });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    const allowlist = await app.inject({ method: 'GET', url: '/allowlist' });

    expect(health.statusCode).toBe(200);
    expect(live.statusCode).toBe(200);
    expect(live.json().live).toBe(true);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ready).toBe(true);
    expect(metrics.statusCode).toBe(200);
    expect(Array.isArray(allowlist.json())).toBe(true);

    await app.close();
  });

  it('returns 503 readiness when checks fail', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({
      intervalMs: 1000,
      checks: [{ name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }]
    });

    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().ready).toBe(false);

    await app.close();
  });

  it('enforces auth token when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const configStore = new ConfigStore(
      { ...DEFAULT_TRADE_POLICY },
      { ...DEFAULT_RISK_CONFIG }
    );

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, configStore },
      { authToken: '  secret ' }
    );

    const unauthorized = await app.inject({ method: 'GET', url: '/health' });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-ops-token': 'secret' }
    });
    expect(authorized.statusCode).toBe(200);

    await app.close();
  });

  it('rejects missing market id', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'POST', url: '/allowlist/%20/resume' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('missing_market_id');
    await app.close();
  });

  it('returns recent incidents', async () => {
    const { app, metrics } = buildServer();
    metrics.record({ type: 'incident', timestamp: 1, data: { message: 'incident' } });

    const response = await app.inject({ method: 'GET', url: '/incidents' });
    expect(response.statusCode).toBe(200);
    expect(response.json().length).toBe(1);
    await app.close();
  });

  it('streams once when requested', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/stream?once=1' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('stream_connected');
    await app.close();
  });

  it('parses maxPings query values without breaking stream', async () => {
    const { app } = buildServer();

    const values = ['2', '0', 'abc', ''];
    for (const value of values) {
      const url = value.length > 0 ? `/stream?once=1&maxPings=${value}` : '/stream?once=1&maxPings=';
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }

    await app.close();
  });

  it('streams and cleans up on close', async () => {
    vi.useFakeTimers();
    try {
      const { app, metrics } = buildServer({ streamHeartbeatMs: 10 });

      const responsePromise = app.inject({ method: 'GET', url: '/stream?maxPings=1' });

      await vi.advanceTimersByTimeAsync(10);
      const response = await responsePromise;

      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('stream_connected');
      expect(metrics.listenerCount('event')).toBe(0);

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends heartbeat pings on stream', async () => {
    vi.useFakeTimers();
    try {
      const { app } = buildServer({ streamHeartbeatMs: 10 });
      const responsePromise = app.inject({ method: 'GET', url: '/stream?maxPings=1' });

      await vi.advanceTimersByTimeAsync(10);
      const response = await responsePromise;
      await app.close();

      expect(response.payload).toContain(': ping');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts ops server with startOpsServer', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const server = await startOpsServer(
      { metrics, allowlist, opsAgent },
      { port: 0, host: '127.0.0.1', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs },
      async (appInstance) => {
        await appInstance.ready();
      }
    );

    await server.close();
  });

  it('returns 503 on policy update when config store is missing', async () => {
    const { app } = buildServer({ configStore: null });
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/policy',
      payload: { maxDecisionLatencyMs: 250 }
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('returns 503 on risk update when config store is missing', async () => {
    const { app } = buildServer({ configStore: null });
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/risk',
      payload: { maxPerTradeLossDollars: 25 }
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('handles config store update errors', async () => {
    const failingStore = {
      snapshot: () => ({ policy: DEFAULT_TRADE_POLICY, risk: DEFAULT_RISK_CONFIG }),
      updatePolicy: () => DEFAULT_TRADE_POLICY,
      updateRisk: () => {
        throw new Error('boom');
      }
    } as unknown as ConfigStore;

    const { app } = buildServer({ configStore: failingStore });
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/risk',
      payload: { maxPerTradeLossDollars: 30 }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('boom');
    await app.close();
  });

  it('handles non-error update exceptions', async () => {
    const failingStore = {
      snapshot: () => ({ policy: DEFAULT_TRADE_POLICY, risk: DEFAULT_RISK_CONFIG }),
      updatePolicy: () => DEFAULT_TRADE_POLICY,
      updateRisk: () => {
        throw 'boom';
      }
    } as unknown as ConfigStore;

    const { app } = buildServer({ configStore: failingStore });
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/risk',
      payload: { maxPerTradeLossDollars: 30 }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('boom');
    await app.close();
  });
});
