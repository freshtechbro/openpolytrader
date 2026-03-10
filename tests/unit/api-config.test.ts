import { describe, it, expect, vi } from 'vitest';

import { createOpsServer, startOpsServer, type OpsServerDeps } from '../../src/api/server.js';
import { ConfigStore } from '../../src/config/store.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { RISK_PROFILE_IDS } from '../../src/config/riskProfile.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { loadEnv } from '../../src/config/env.js';
import { getInfraConfigSnapshot } from '../../src/config/infra.js';
import { EventStore } from '../../src/core/EventStore.js';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { TradingStateManager } from '../../src/core/TradingStateManager.js';

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
  applyRiskProfile?: OpsServerDeps['applyRiskProfile'];
  riskProfile?: OpsServerDeps['riskProfile'];
  debugMarketDataOutlier?: OpsServerDeps['debugMarketDataOutlier'];
  opsAgent?: OpsAgent;
}) {
  const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
  const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
  const opsAgent = options?.opsAgent ?? new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
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
      applyRiskProfile: options?.applyRiskProfile,
      riskProfile: options?.riskProfile,
      debugMarketDataOutlier: options?.debugMarketDataOutlier,
      infraConfig:
        options?.infraConfig === null
          ? undefined
          : options?.infraConfig ?? getInfraConfigSnapshot(DEFAULT_ENV)
    },
    { incidentsLimit, streamHeartbeatMs: options?.streamHeartbeatMs ?? defaultStreamHeartbeatMs }
  );

  return { app, metrics, allowlist };
}

function expectOpsErrorResponse(
  body: unknown,
  code: string,
  options?: { message?: string; details?: unknown }
): void {
  expect(body).toMatchObject({
    error: {
      code,
      ...(options?.message ? { message: options.message } : {}),
      ...(options && 'details' in options ? { details: options.details } : {})
    }
  });
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

  it('returns trading state from manager when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const configStore = new ConfigStore({ ...DEFAULT_TRADE_POLICY }, { ...DEFAULT_RISK_CONFIG });
    const tradingStateManager = new TradingStateManager(false, 'shadow');
    tradingStateManager.setMode('paper');
    tradingStateManager.setEnabled(true);

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, configStore, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.tradingMode).toBe('paper');
    expect(body.tradingEnabled).toBe(true);
    expect(body.tradingStateChangedAt).toBeDefined();
    expect(body.tradingStateChangedBy).toBe('api');

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

  it('returns readiness when checks pass', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const opsAgent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          {
            name: 'ok-check',
            check: async () => ({ ok: true })
          }
        ]
      },
      metrics
    );
    const { app } = buildServer({ opsAgent });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ready: true });

    await app.close();
  });

  it('returns 503 readiness when checks fail', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const opsAgent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          {
            name: 'fail-check',
            check: async () => ({ ok: false, error: 'boom' })
          }
        ]
      },
      metrics
    );
    const { app } = buildServer({ opsAgent });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ready: false });

    await app.close();
  });

  it('returns risk profile snapshot', async () => {
    const { app } = buildServer({
      riskProfile: { id: 'moderate', source: 'defaults' }
    });

    const response = await app.inject({ method: 'GET', url: '/config/risk-profiles' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activeProfile: 'moderate',
      activeProfileSource: 'defaults'
    });

    await app.close();
  });

  it('returns default risk profile snapshot when no profile state is provided', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'GET', url: '/config/risk-profiles' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activeProfile: 'extra_high',
      activeProfileSource: 'defaults'
    });

    await app.close();
  });

  it('applies risk profile when configured', async () => {
    const applyRiskProfile = vi.fn().mockReturnValue({
      profile: { id: 'high', source: 'test' },
      policy: { ...DEFAULT_TRADE_POLICY },
      risk: { ...DEFAULT_RISK_CONFIG },
      persisted: true
    });
    const { app, metrics } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: { id: 'high', source: 'test' },
      persisted: true
    });
    expect(applyRiskProfile).toHaveBeenCalledWith('high', undefined);
    expect(metrics.recent('info', 1)[0]?.data).toMatchObject({
      message: 'privileged_mutation_applied',
      action: 'risk_profile_applied',
      profile: 'high',
      persisted: true
    });

    await app.close();
  });

  it('returns 503 when risk profile apply is not configured', async () => {
    const { app } = buildServer({
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high' }
    });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'risk_profile_not_configured');

    await app.close();
  });

  it('trims empty risk profile path', async () => {
    const applyRiskProfile = vi.fn().mockReturnValue({
      profile: { id: 'high', source: 'test' },
      policy: { ...DEFAULT_TRADE_POLICY },
      risk: { ...DEFAULT_RISK_CONFIG },
      persisted: true
    });
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high', path: '   ' }
    });

    expect(response.statusCode).toBe(200);
    expect(applyRiskProfile).toHaveBeenCalledWith('high', undefined);

    await app.close();
  });

  it('passes risk profile override path when provided', async () => {
    const applyRiskProfile = vi.fn().mockReturnValue({
      profile: { id: 'high', source: 'test' },
      policy: { ...DEFAULT_TRADE_POLICY },
      risk: { ...DEFAULT_RISK_CONFIG },
      persisted: true
    });
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high', path: 'settings/risk-gates/high.json' }
    });

    expect(response.statusCode).toBe(200);
    expect(applyRiskProfile).toHaveBeenCalledWith('high', 'settings/risk-gates/high.json');

    await app.close();
  });

  it('returns apply error when risk profile apply fails', async () => {
    const applyRiskProfile = vi.fn(() => {
      throw new Error('boom');
    });
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'risk_profile_apply_failed', { message: 'boom' });

    await app.close();
  });

  it('returns apply error when risk profile apply throws a non-error value', async () => {
    const applyRiskProfile = vi.fn(() => {
      throw 'boom';
    });
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'high' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'risk_profile_apply_failed', { message: 'boom' });

    await app.close();
  });

  it('rejects invalid risk profile', async () => {
    const applyRiskProfile = vi.fn();
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 'invalid_profile' }
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expectOpsErrorResponse(body, 'invalid_profile', { details: { validProfiles: RISK_PROFILE_IDS } });
    expect(applyRiskProfile).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects risk profile requests when body is missing', async () => {
    const applyRiskProfile = vi.fn();
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile'
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'invalid_profile', { details: { validProfiles: RISK_PROFILE_IDS } });
    expect(applyRiskProfile).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects risk profile requests when profile is not a string', async () => {
    const applyRiskProfile = vi.fn();
    const { app } = buildServer({
      applyRiskProfile,
      riskProfile: { id: 'near_zero', source: 'defaults' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/config/risk-profile',
      payload: { profile: 123 }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'invalid_profile', { details: { validProfiles: RISK_PROFILE_IDS } });
    expect(applyRiskProfile).not.toHaveBeenCalled();

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

  it('returns 503 when infra config is missing', async () => {
    const { app } = buildServer({ infraConfig: null });
    const response = await app.inject({ method: 'GET', url: '/config/infra' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'infra_config_not_configured');

    await app.close();
  });

  it('returns 503 when SLO endpoint is missing event store', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/slo' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'event_store_not_configured');

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

  it('returns 503 when decisions endpoint is missing event store', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'GET', url: '/decisions' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'event_store_not_configured');

    await app.close();
  });

  it('returns decisions when event store is configured', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    try {
      store.persistDecision({
        id: 'dec-1',
        subjectId: 'opp-1',
        timestampMs: 1,
        agent: 'risk',
        decisionJson: { ok: true },
        reasoningJson: { confidence: 0.5 }
      });

      store.persistDecision({
        id: 'dec-2',
        subjectId: 'opp-2',
        timestampMs: 2,
        agent: 'ops',
        decisionJson: { status: 'healthy' },
        reasoningJson: { confidence: 0.9 }
      });

      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
      const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

      const app = createOpsServer(
        { metrics, allowlist, opsAgent, eventStore: store },
        { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
      );

      const response = await app.inject({ method: 'GET', url: '/decisions?limit=10' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          id: 'dec-2',
          subjectId: 'opp-2',
          timestamp: 2,
          agent: 'ops',
          decision: { status: 'healthy' },
          reasoning: { confidence: 0.9 }
        },
        {
          id: 'dec-1',
          subjectId: 'opp-1',
          timestamp: 1,
          agent: 'risk',
          decision: { ok: true },
          reasoning: { confidence: 0.5 }
        }
      ]);

      await app.close();
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('filters decisions by agent, subject, and time bounds', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    try {
      store.persistDecision({
        id: 'dec-1',
        subjectId: 'opp-1',
        timestampMs: 1,
        agent: 'risk',
        decisionJson: { ok: true },
        reasoningJson: { confidence: 0.2 }
      });

      store.persistDecision({
        id: 'dec-2',
        subjectId: 'opp-2',
        timestampMs: 2,
        agent: 'ops',
        decisionJson: { status: 'healthy' },
        reasoningJson: { confidence: 0.9 }
      });

      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
      const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

      const app = createOpsServer(
        { metrics, allowlist, opsAgent, eventStore: store },
        { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
      );

      const response = await app.inject({
        method: 'GET',
        url: '/decisions?agent=ops&subjectId=opp-2&sinceMs=2&untilMs=2&limit=5'
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as Array<{ subjectId: string; agent: string; timestamp: number }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ subjectId: 'opp-2', agent: 'ops', timestamp: 2 });

      await app.close();
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('filters decisions and ignores invalid query params', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    const store = new EventStore({ dbPath });

    try {
      store.persistDecision({
        id: 'dec-10',
        subjectId: 'opp-10',
        timestampMs: 100,
        agent: 'risk',
        decisionJson: { ok: true },
        reasoningJson: { confidence: 0.1 }
      });

      store.persistDecision({
        id: 'dec-11',
        subjectId: 'opp-11',
        timestampMs: 200,
        agent: 'ops',
        decisionJson: { status: 'degraded' },
        reasoningJson: { confidence: 0.2 }
      });

      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
      const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

      const app = createOpsServer(
        { metrics, allowlist, opsAgent, eventStore: store },
        { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
      );

      const filtered = await app.inject({
        method: 'GET',
        url: '/decisions?agent=%20risk%20&subjectId=%20opp-10%20&sinceMs=50&untilMs=150'
      });

      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toEqual([
        {
          id: 'dec-10',
          subjectId: 'opp-10',
          timestamp: 100,
          agent: 'risk',
          decision: { ok: true },
          reasoning: { confidence: 0.1 }
        }
      ]);

      const invalidQuery = await app.inject({
        method: 'GET',
        url: '/decisions?sinceMs=-1&untilMs=abc&sinceMs=1&sinceMs=2'
      });

      expect(invalidQuery.statusCode).toBe(200);
      expect(invalidQuery.json().length).toBe(2);

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
    expectOpsErrorResponse(response.json(), 'slo_compute_failed', { message: 'boom' });

    await app.close();
  });

  it('returns 500 with stringified message when SLO aggregation throws non-error', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const eventStore = {
      queryMetricsByTypes: () => {
        throw 'boom';
      }
    } as unknown as EventStore;

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, eventStore },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'GET', url: '/slo' });
    expect(response.statusCode).toBe(500);
    expectOpsErrorResponse(response.json(), 'slo_compute_failed', { message: 'boom' });

    await app.close();
  });

  it('returns 503 when infra config is not configured', async () => {
    const { app } = buildServer({ infraConfig: null });
    const response = await app.inject({ method: 'GET', url: '/config/infra' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'infra_config_not_configured');

    await app.close();
  });

  it('updates policy and risk', async () => {
    const { app, metrics } = buildServer();

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
    expect(metrics.recent('info', 2).map((event) => event.data)).toEqual([
      expect.objectContaining({
        message: 'privileged_mutation_applied',
        action: 'policy_updated',
        fields: ['maxDecisionLatencyMs']
      }),
      expect.objectContaining({
        message: 'privileged_mutation_applied',
        action: 'risk_updated',
        fields: ['maxPerTradeLossDollars']
      })
    ]);

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

  it('accepts empty policy updates', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'PATCH', url: '/config/policy' });

    expect(response.statusCode).toBe(200);
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

  it('handles non-error policy update exceptions', async () => {
    const failingStore = {
      snapshot: () => ({ policy: DEFAULT_TRADE_POLICY, risk: DEFAULT_RISK_CONFIG }),
      updatePolicy: () => {
        throw 'boom';
      },
      updateRisk: () => DEFAULT_RISK_CONFIG
    } as unknown as ConfigStore;

    const { app } = buildServer({ configStore: failingStore });
    const response = await app.inject({
      method: 'PATCH',
      url: '/config/policy',
      payload: { maxDecisionLatencyMs: 300 }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'invalid_policy_update', { message: 'boom' });
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

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'portfolio_agent_not_configured');
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
    const { app, metrics: metricsStore } = buildServer();
    metricsStore.record({ type: 'fw_iteration', timestamp: Date.now(), data: { event: 'iter' } });
    metricsStore.record({ type: 'fw_gap', timestamp: Date.now(), data: { event: 'gap' } });
    metricsStore.record({ type: 'fw_active_set', timestamp: Date.now(), data: { event: 'active_set' } });
    metricsStore.record({ type: 'fw_contraction', timestamp: Date.now(), data: { event: 'contraction' } });
    metricsStore.record({ type: 'fw_basket', timestamp: Date.now(), data: { event: 'basket' } });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const metricsResponse = await app.inject({ method: 'GET', url: '/metrics' });
    const allowlist = await app.inject({ method: 'GET', url: '/allowlist' });

    expect(health.statusCode).toBe(200);
    expect(live.statusCode).toBe(200);
    expect(live.json().live).toBe(true);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ready).toBe(true);
    expect(metricsResponse.statusCode).toBe(200);
    const metricsBody = metricsResponse.json() as { counts: Record<string, number> };
    expect(metricsBody.counts.fw_iteration).toBeGreaterThan(0);
    expect(metricsBody.counts.fw_gap).toBeGreaterThan(0);
    expect(metricsBody.counts.fw_active_set).toBeGreaterThan(0);
    expect(metricsBody.counts.fw_contraction).toBeGreaterThan(0);
    expect(metricsBody.counts.fw_basket).toBeGreaterThan(0);
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
      { authToken: '  secret ', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
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

  it('limits query token auth to the stream route when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const health = await app.inject({ method: 'GET', url: '/health?token=secret' });
    const sessionStatus = await app.inject({ method: 'GET', url: '/ops/session?token=secret' });
    const stream = await app.inject({ method: 'GET', url: '/stream?once=1&token=secret' });

    expect(health.statusCode).toBe(401);
    expect(sessionStatus.statusCode).toBe(200);
    expect(sessionStatus.json()).toMatchObject({ authenticated: false, authRequired: true });
    expect(stream.statusCode).toBe(200);
    expect(stream.payload).toContain('stream_connected');

    await app.close();
  });

  it('returns unauthenticated session status without credentials', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const status = await app.inject({ method: 'GET', url: '/ops/session' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: false, authRequired: true });

    await app.close();
  });

  it('accepts bearer token for session status checks', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session',
      headers: { authorization: 'Bearer secret' }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: true, authRequired: true });

    await app.close();
  });

  it('returns prefill token only when dev prefill is enabled on localhost', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: { host: 'localhost:3000' }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      authenticated: false,
      authRequired: true,
      prefillToken: 'secret'
    });

    await app.close();
  });

  it('returns prefill token for authorized localhost session checks', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: {
        authorization: 'Bearer secret',
        host: 'localhost:3000'
      },
      remoteAddress: '::ffff:127.0.0.1'
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      authenticated: true,
      authRequired: true,
      prefillToken: 'secret'
    });

    await app.close();
  });

  it('does not return prefill token when request ip is not loopback', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: { host: 'localhost:3000' },
      remoteAddress: '203.0.113.10'
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: false, authRequired: true });
    expect((status.json() as Record<string, unknown>).prefillToken).toBeUndefined();

    await app.close();
  });

  it('returns prefill token for bracketed IPv6 localhost host headers', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: { host: '[::1]:3000' }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      authenticated: false,
      authRequired: true,
      prefillToken: 'secret'
    });

    await app.close();
  });

  it('does not return prefill token for malformed bracketed host headers', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: { host: '[::1' }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: false, authRequired: true });
    expect((status.json() as Record<string, unknown>).prefillToken).toBeUndefined();

    await app.close();
  });

  it('does not return prefill token for non-localhost requests', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      {
        authToken: 'secret',
        devSessionPrefillEnabled: true,
        incidentsLimit,
        streamHeartbeatMs: defaultStreamHeartbeatMs
      }
    );

    const status = await app.inject({
      method: 'GET',
      url: '/ops/session?prefill=1',
      headers: { host: 'example.com' }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: false, authRequired: true });
    expect((status.json() as Record<string, unknown>).prefillToken).toBeUndefined();

    await app.close();
  });

  it('creates session cookies for valid ops tokens', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      payload: { token: 'secret' }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(typeof cookie === 'string' || Array.isArray(cookie)).toBe(true);

    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    const health = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { cookie: cookieHeader ?? '' }
    });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it('rejects session login with empty request body', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session'
    });

    expect(login.statusCode).toBe(401);
    expectOpsErrorResponse(login.json(), 'unauthorized');

    await app.close();
  });

  it('sets secure session cookies when forwarded proto is https', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { token: 'secret' }
    });

    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toContain('Secure');

    await app.close();
  });

  it('rejects invalid token when creating sessions', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      payload: { token: 'wrong' }
    });
    expect(login.statusCode).toBe(401);
    expectOpsErrorResponse(login.json(), 'unauthorized');

    await app.close();
  });

  it('rejects empty session token payloads', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      payload: {}
    });
    expect(login.statusCode).toBe(401);
    expectOpsErrorResponse(login.json(), 'unauthorized');

    await app.close();
  });

  it('clears session cookies and invalidates server-side session', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      payload: { token: 'secret' }
    });
    const cookie = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;

    const logout = await app.inject({
      method: 'DELETE',
      url: '/ops/session',
      headers: { cookie: cookieHeader ?? '' }
    });
    expect(logout.statusCode).toBe(200);
    const logoutCookie = logout.headers['set-cookie'];
    expect(String(logoutCookie)).toContain('Max-Age=0');

    const status = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { cookie: cookieHeader ?? '' }
    });
    expect(status.statusCode).toBe(401);

    await app.close();
  });

  it('supports session endpoints when auth is disabled', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const status = await app.inject({ method: 'GET', url: '/ops/session' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ authenticated: true, authRequired: false });

    const login = await app.inject({
      method: 'POST',
      url: '/ops/session',
      payload: { token: 'ignored' }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: true, authRequired: false });

    await app.close();
  });

  it('clears session cookies even when no session cookie is present', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: 'secret', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const logout = await app.inject({ method: 'DELETE', url: '/ops/session' });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

    await app.close();
  });

  it('rejects missing market id', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'POST', url: '/allowlist/%20/resume' });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'missing_market_id');
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

  it('echoes origin header on stream responses', async () => {
    const { app } = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: '/stream?once=1',
      headers: { origin: 'http://localhost:5173' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
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

  it('starts ops server with default listen', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const server = await startOpsServer(
      { metrics, allowlist, opsAgent },
      { port: 0, host: '127.0.0.1', incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
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
    expectOpsErrorResponse(response.json(), 'invalid_risk_update', { message: 'boom' });
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
    expectOpsErrorResponse(response.json(), 'invalid_risk_update', { message: 'boom' });
    await app.close();
  });

  it('returns 503 when trading-mode endpoint is called without tradingStateManager', async () => {
    const { app } = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode',
      payload: { mode: 'shadow' }
    });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'trading_state_manager_not_configured');
    await app.close();
  });

  it('returns 400 for invalid trading mode', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const tradingStateManager = new TradingStateManager(false, 'shadow');

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode',
      payload: { mode: 'invalid_mode' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'invalid_mode', {
      details: { validModes: ['off', 'shadow', 'paper', 'live'] }
    });
    await app.close();
  });

  it('returns 400 for live mode without confirmation', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const tradingStateManager = new TradingStateManager(false, 'shadow');

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode',
      payload: { mode: 'live' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'live_mode_requires_confirmation', {
      message: 'Add ?confirm=true to enable live trading'
    });
    await app.close();
  });

  it('allows live mode with confirmation', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const tradingStateManager = new TradingStateManager(false, 'shadow');

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode?confirm=true',
      payload: { mode: 'live' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state.mode).toBe('live');
    await app.close();
  });

  it('changes trading enabled state', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const tradingStateManager = new TradingStateManager(false, 'shadow');

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode',
      payload: { enabled: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state.enabled).toBe(true);
    await app.close();
  });

  it('updates trading mode and enabled together', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const tradingStateManager = new TradingStateManager(false, 'shadow');

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, tradingStateManager },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/config/trading-mode',
      payload: { mode: 'paper', enabled: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toMatchObject({ mode: 'paper', enabled: true });
    await app.close();
  });

  it('returns markets with null question when clobClient is not provided', async () => {
    const { app, allowlist } = buildServer();
    allowlist.allow('market-1');

    const response = await app.inject({ method: 'GET', url: '/markets' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ key: string; question: string | null }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].key).toBe('market-1');
    expect(body[0].question).toBeNull();

    await app.close();
  });

  it('returns markets with enriched data when clobClient is provided', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const mockClobClient = {
      getMarket: vi.fn().mockResolvedValue({
        condition_id: 'market-1',
        question: 'Will it rain tomorrow?',
        description: 'Weather prediction market'
      })
    };

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, clobClient: mockClobClient as never },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    allowlist.allow('market-1');

    const response = await app.inject({ method: 'GET', url: '/markets' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ key: string; question: string | null; description: string | null }>;
    expect(body[0].question).toBe('Will it rain tomorrow?');
    expect(body[0].description).toBe('Weather prediction market');

    await app.close();
  });

  it('reuses cached market info on subsequent requests', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const mockClobClient = {
      getMarket: vi.fn().mockResolvedValue({
        condition_id: 'market-1',
        question: 'Will it rain tomorrow?',
        description: 'Weather prediction market'
      })
    };

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, clobClient: mockClobClient as never },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    allowlist.allow('market-1');

    await app.inject({ method: 'GET', url: '/markets' });
    await app.inject({ method: 'GET', url: '/markets' });

    expect(mockClobClient.getMarket).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns markets with null question when clobClient throws error', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    const mockClobClient = {
      getMarket: vi.fn().mockRejectedValue(new Error('API error'))
    };

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, clobClient: mockClobClient as never },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    allowlist.allow('market-error');

    const response = await app.inject({ method: 'GET', url: '/markets' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ key: string; question: string | null }>;
    expect(body[0].question).toBeNull();

    await app.close();
  });
});

describe('allowlist endpoints', () => {
  it('returns 400 when resume is called without a market id', async () => {
    const { app } = buildServer();
    const response = await app.inject({ method: 'POST', url: '/allowlist/%20/resume' });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'missing_market_id');

    await app.close();
  });

  it('resumes allowlist entries by market id', async () => {
    const { app, allowlist, metrics } = buildServer();
    allowlist.quarantine('market-1', 'testing', 60_000);

    const response = await app.inject({ method: 'POST', url: '/allowlist/market-1/resume' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ marketId: 'market-1' });
    expect(metrics.recent('info', 1)[0]?.data).toMatchObject({
      message: 'privileged_mutation_applied',
      action: 'allowlist_resumed',
      marketId: 'market-1'
    });

    await app.close();
  });
});

describe('ops stream endpoint', () => {
  it('returns a one-off stream event when once flag is set', async () => {
    const { app } = buildServer({ streamHeartbeatMs: 5 });

    const response = await app.inject({ method: 'GET', url: '/stream?once=true' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('stream_connected');

    await app.close();
  });

  it('closes the stream after max pings', async () => {
    const { app } = buildServer({ streamHeartbeatMs: 1 });

    const response = await app.inject({ method: 'GET', url: '/stream?maxPings=1' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain(': ping');

    await app.close();
  });

  it('keeps the stream open until maxPings is reached', async () => {
    const { app } = buildServer({ streamHeartbeatMs: 1 });

    const response = await app.inject({ method: 'GET', url: '/stream?maxPings=2' });

    expect(response.statusCode).toBe(200);
    expect(response.payload.match(/: ping/g)?.length).toBe(2);

    await app.close();
  });

  it('maps error metrics to metric_error SSE event names', async () => {
    vi.useFakeTimers();
    try {
      const { app, metrics } = buildServer({ streamHeartbeatMs: 10 });
      const responsePromise = app.inject({ method: 'GET', url: '/stream?maxPings=1' });

      await vi.advanceTimersByTimeAsync(1);
      metrics.record({ type: 'error', timestamp: Date.now(), data: { message: 'boom' } });
      await vi.advanceTimersByTimeAsync(10);

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('event: metric_error');

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps non-error metric event names unchanged in SSE stream', async () => {
    vi.useFakeTimers();
    try {
      const { app, metrics } = buildServer({ streamHeartbeatMs: 10 });
      const responsePromise = app.inject({ method: 'GET', url: '/stream?maxPings=1' });

      await vi.advanceTimersByTimeAsync(1);
      metrics.record({ type: 'info', timestamp: Date.now(), data: { message: 'ping' } });
      await vi.advanceTimersByTimeAsync(10);

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('event: info');

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ops debug endpoints', () => {
  it('returns 503 when learning agent is missing', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'POST', url: '/debug/learning/synthesize' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'learning_agent_not_configured');

    await app.close();
  });

  it('runs learning synth when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const learningAgent = { synthesizeNow: vi.fn().mockResolvedValue(undefined) };

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, learningAgent: learningAgent as never },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'POST', url: '/debug/learning/synthesize' });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(learningAgent.synthesizeNow).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns 503 when portfolio agent is missing', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'POST', url: '/debug/portfolio/analyze' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'portfolio_agent_not_configured');

    await app.close();
  });

  it('runs portfolio analysis when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const portfolioAgent = { analyzeAnomalies: vi.fn().mockResolvedValue(undefined) };

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, portfolioAgent: portfolioAgent as never },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({ method: 'POST', url: '/debug/portfolio/analyze' });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(portfolioAgent.analyzeAnomalies).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns 503 when marketdata debug is not configured', async () => {
    const { app } = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: 'token-1' }
    });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'marketdata_debug_not_configured');

    await app.close();
  });

  it('returns 400 when marketdata debug tokenId is missing', async () => {
    const debugMarketDataOutlier = vi.fn().mockResolvedValue({ ok: true });
    const { app } = buildServer({ debugMarketDataOutlier });

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: '  ' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'missing_token_id');

    await app.close();
  });

  it('returns 400 when marketdata debug tokenId is not a string', async () => {
    const debugMarketDataOutlier = vi.fn().mockResolvedValue({ ok: true });
    const { app } = buildServer({ debugMarketDataOutlier });

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: 123 }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'missing_token_id');

    await app.close();
  });

  it('returns 400 when marketdata debug reports failure', async () => {
    const debugMarketDataOutlier = vi.fn().mockResolvedValue({ ok: false, error: 'orderbook_missing' });
    const { app } = buildServer({ debugMarketDataOutlier });

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: 'token-1' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'orderbook_missing');

    await app.close();
  });

  it('returns fallback marketdata debug error when failure has no explicit error', async () => {
    const debugMarketDataOutlier = vi.fn().mockResolvedValue({ ok: false });
    const { app } = buildServer({ debugMarketDataOutlier });

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: 'token-1' }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'marketdata_outlier_failed');

    await app.close();
  });

  it('returns 200 when marketdata debug succeeds', async () => {
    const debugMarketDataOutlier = vi.fn().mockResolvedValue({ ok: true });
    const { app } = buildServer({ debugMarketDataOutlier });

    const response = await app.inject({
      method: 'POST',
      url: '/debug/marketdata/outlier',
      payload: { tokenId: 'token-1' }
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(debugMarketDataOutlier).toHaveBeenCalledWith('token-1');

    await app.close();
  });

  it('returns 503 when synthetic opportunity is not configured', async () => {
    const { app } = buildServer();

    const response = await app.inject({ method: 'POST', url: '/debug/synthetic-opportunity' });

    expect(response.statusCode).toBe(503);
    expectOpsErrorResponse(response.json(), 'synthetic_opportunity_not_configured');

    await app.close();
  });

  it('returns 400 when synthetic opportunity returns ok=false', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const syntheticOpportunity = vi.fn().mockResolvedValue({ ok: false, message: 'no-op' });

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, syntheticOpportunity },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/debug/synthetic-opportunity',
      payload: { execute: false }
    });

    expect(response.statusCode).toBe(400);
    expectOpsErrorResponse(response.json(), 'synthetic_opportunity_failed', {
      message: 'no-op',
      details: { ok: false, message: 'no-op' }
    });

    await app.close();
  });

  it('returns 200 when synthetic opportunity succeeds', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const syntheticOpportunity = vi.fn().mockResolvedValue({ ok: true, marketId: 'm-1' });

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, syntheticOpportunity },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/debug/synthetic-opportunity',
      payload: { execute: false }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ marketId: 'm-1' });

    await app.close();
  });

  it('passes empty synthetic opportunity options when body is missing', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const syntheticOpportunity = vi.fn().mockResolvedValue({ ok: true });

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, syntheticOpportunity },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    const response = await app.inject({
      method: 'POST',
      url: '/debug/synthetic-opportunity'
    });

    expect(response.statusCode).toBe(200);
    expect(syntheticOpportunity).toHaveBeenCalledTimes(1);
    expect(syntheticOpportunity.mock.calls[0][0]).toMatchObject({
      marketId: undefined,
      executionMode: undefined,
      execute: false
    });

    await app.close();
  });

  it('parses synthetic opportunity inputs and execution mode', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const syntheticOpportunity = vi.fn().mockResolvedValue({ ok: true });

    const app = createOpsServer(
      { metrics, allowlist, opsAgent, syntheticOpportunity },
      { incidentsLimit, streamHeartbeatMs: defaultStreamHeartbeatMs }
    );

    await app.inject({
      method: 'POST',
      url: '/debug/synthetic-opportunity',
      payload: {
        marketId: 'm-1',
        yesPrice: 0.55,
        noPrice: 0.45,
        edge: 0.02,
        tickSize: 0.01,
        minOrderSize: 5,
        maxSizeByDepth: 10,
        executionMode: 'paper',
        execute: false
      }
    });

    await app.inject({
      method: 'POST',
      url: '/debug/synthetic-opportunity',
      payload: {
        marketId: '  ',
        yesPrice: '0.55',
        minOrderSize: '5',
        executionMode: 'invalid'
      }
    });

    expect(syntheticOpportunity).toHaveBeenCalledTimes(2);
    expect(syntheticOpportunity.mock.calls[0][0]).toMatchObject({
      marketId: 'm-1',
      executionMode: 'paper'
    });
    expect(syntheticOpportunity.mock.calls[1][0]).toMatchObject({
      marketId: undefined,
      yesPrice: undefined,
      minOrderSize: undefined,
      executionMode: undefined
    });

    await app.close();
  });
});
