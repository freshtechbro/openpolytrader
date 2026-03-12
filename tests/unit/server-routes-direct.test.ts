import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { registerDecisionAndConfigRoutes } from '../../src/api/serverRoutesDecisionConfig.js';
import { registerHealthAndMetricsRoutes } from '../../src/api/serverRoutesHealth.js';
import { registerMarketAndDebugRoutes } from '../../src/api/serverRoutesMarketDebug.js';
import { registerEventStreamRoute } from '../../src/api/serverRoutesStream.js';
import { registerOpsServerRoutes } from '../../src/api/serverRoutes.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

afterEach(() => {
  vi.useRealTimers();
});

function buildRouteContext() {
  const metrics = new MetricsStore(32);
  const allowlist = new MarketAllowlist({ autoResume: false });
  const opsAgent = new OpsAgent({ intervalMs: 1_000, checks: [] }, metrics);
  const deps = {
    metrics,
    allowlist,
    opsAgent
  };
  const sendError: Parameters<typeof registerOpsServerRoutes>[1]['healthAndMetrics']['sendError'] = (
    reply,
    status,
    code,
    options
  ) => {
    const payload = {
      error: {
        code,
        ...(options?.message ? { message: options.message } : {}),
        ...(options && 'details' in options ? { details: options.details } : {})
      }
    };
    reply.code(status);
    return payload;
  };

  const contexts: Parameters<typeof registerOpsServerRoutes>[1] = {
    healthAndMetrics: {
      deps,
      incidentsLimit: 50,
      sendError
    },
    marketAndDebug: {
      deps,
      recordPrivilegedMutation() {},
      sendError
    },
    decisionAndConfig: {
      deps,
      riskProfileStateRef: {},
      policyUpdateSchema: z.object({}),
      riskUpdateSchema: z.object({}),
      sendError,
      toConfigSectionValues(values) {
        return values as Record<string, boolean | number | string>;
      },
      serializeTradingState(state) {
        return state;
      },
      recordPrivilegedMutation() {},
      queryPositiveInt() {
        return null;
      },
      queryNonNegativeInt() {
        return null;
      }
    },
    eventStream: {
      metrics,
      streamHeartbeatMs: 15_000,
      queryPositiveInt() {
        return null;
      }
    }
  };

  return { metrics, allowlist, opsAgent, deps, contexts };
}

describe('registerOpsServerRoutes', () => {
  it('serves metrics and allowlist routes from the direct route harness', async () => {
    const app = fastify();
    const { metrics, allowlist, opsAgent, contexts } = buildRouteContext();
    allowlist.seed(['market-1']);
    metrics.record({ type: 'info', timestamp: 1_000, data: { message: 'hello' } });
    registerOpsServerRoutes(app, contexts);

    try {
      const metricsResponse = await app.inject({ method: 'GET', url: '/metrics' });
      const marketsResponse = await app.inject({ method: 'GET', url: '/markets' });

      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.json()).toMatchObject({
        counts: expect.objectContaining({ info: 1 }),
        lastEventAt: 1_000
      });
      expect(marketsResponse.statusCode).toBe(200);
      expect(marketsResponse.json()).toEqual([
        expect.objectContaining({
          key: 'market-1',
          question: null,
          description: null
        })
      ]);
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('covers health routes directly', async () => {
    const app = fastify();
    const { deps, opsAgent, contexts } = buildRouteContext();
    deps.portfolioAgent = { snapshot: () => ({ positions: [], totals: {} }) } as never;
    registerHealthAndMetricsRoutes(app, contexts.healthAndMetrics);

    try {
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      const slo = await app.inject({ method: 'GET', url: '/slo' });
      const portfolio = await app.inject({ method: 'GET', url: '/portfolio' });

      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ live: true });
      expect(slo.statusCode).toBe(503);
      expect(portfolio.statusCode).toBe(200);
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('covers market and debug routes directly', async () => {
    const app = fastify();
    const { allowlist, deps, opsAgent, contexts } = buildRouteContext();
    allowlist.seed(['market-1']);
    deps.clobClient = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Question?', description: 'Desc' })
    } as never;
    deps.syntheticOpportunity = vi.fn().mockResolvedValue({
      ok: true,
      marketId: 'market-1',
      opportunityId: 'opp-1'
    });
    registerMarketAndDebugRoutes(app, contexts.marketAndDebug);

    try {
      const markets = await app.inject({ method: 'GET', url: '/markets' });
      const synthetic = await app.inject({
        method: 'POST',
        url: '/debug/synthetic-opportunity',
        payload: { marketId: 'market-1', execute: true }
      });

      expect(markets.statusCode).toBe(200);
      expect(markets.json()).toEqual([
        expect.objectContaining({ question: 'Question?', description: 'Desc' })
      ]);
      expect(synthetic.statusCode).toBe(200);
      expect(synthetic.json()).toMatchObject({ marketId: 'market-1', opportunityId: 'opp-1' });
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('reuses cached market summaries and falls back to null metadata on lookup failure', async () => {
    const app = fastify();
    const { allowlist, deps, opsAgent, contexts } = buildRouteContext();
    const getMarket = vi
      .fn()
      .mockResolvedValueOnce({ question: 'Market one?', description: 'Alpha' })
      .mockRejectedValueOnce(new Error('boom'));

    allowlist.seed(['market-1', 'market-2']);
    deps.clobClient = { getMarket } as never;
    registerMarketAndDebugRoutes(app, contexts.marketAndDebug);

    try {
      const firstMarkets = await app.inject({ method: 'GET', url: '/markets' });
      const secondMarkets = await app.inject({ method: 'GET', url: '/markets' });

      expect(firstMarkets.statusCode).toBe(200);
      expect(firstMarkets.json()).toEqual([
        expect.objectContaining({ key: 'market-1', question: 'Market one?', description: 'Alpha' }),
        expect.objectContaining({ key: 'market-2', question: null, description: null })
      ]);
      expect(secondMarkets.statusCode).toBe(200);
      expect(secondMarkets.json()).toEqual(firstMarkets.json());
      expect(getMarket).toHaveBeenCalledTimes(2);
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('covers debug route errors and optional synthetic response fields', async () => {
    const app = fastify();
    const { deps, opsAgent, contexts } = buildRouteContext();
    const synthesizeNow = vi.fn().mockResolvedValue(undefined);
    const analyzeAnomalies = vi.fn().mockResolvedValue(undefined);
    const debugMarketDataOutlier = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'outlier_failed' })
      .mockResolvedValueOnce({ ok: true });
    const syntheticOpportunity = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'synthetic failed' })
      .mockResolvedValueOnce({
        ok: true,
        marketId: 'market-1',
        opportunityId: 'opp-2',
        message: 'synthetic ok',
        opportunity: { id: 'opp-2' },
        riskDecision: { approved: true },
        execution: { status: 'queued' },
        orderedIds: ['market-1', 'market-2']
      });

    deps.debugMarketDataOutlier = debugMarketDataOutlier as never;
    deps.syntheticOpportunity = syntheticOpportunity as never;
    registerMarketAndDebugRoutes(app, contexts.marketAndDebug);

    try {
      const learningUnavailable = await app.inject({ method: 'POST', url: '/debug/learning/synthesize' });
      const portfolioUnavailable = await app.inject({ method: 'POST', url: '/debug/portfolio/analyze' });
      expect(learningUnavailable.statusCode).toBe(503);
      expect(portfolioUnavailable.statusCode).toBe(503);

      deps.learningAgent = { synthesizeNow } as never;
      deps.portfolioAgent = { analyzeAnomalies } as never;

      const learningReady = await app.inject({ method: 'POST', url: '/debug/learning/synthesize' });
      const portfolioReady = await app.inject({ method: 'POST', url: '/debug/portfolio/analyze' });
      expect(learningReady.statusCode).toBe(204);
      expect(portfolioReady.statusCode).toBe(204);
      expect(synthesizeNow).toHaveBeenCalledTimes(1);
      expect(analyzeAnomalies).toHaveBeenCalledTimes(1);

      const outlierMissingToken = await app.inject({
        method: 'POST',
        url: '/debug/marketdata/outlier',
        payload: {}
      });
      const outlierFailed = await app.inject({
        method: 'POST',
        url: '/debug/marketdata/outlier',
        payload: { tokenId: 'token-1' }
      });
      const outlierSucceeded = await app.inject({
        method: 'POST',
        url: '/debug/marketdata/outlier',
        payload: { tokenId: 'token-2' }
      });
      expect(outlierMissingToken.statusCode).toBe(400);
      expect(outlierFailed.statusCode).toBe(400);
      expect(outlierFailed.json()).toMatchObject({ error: { code: 'outlier_failed' } });
      expect(outlierSucceeded.statusCode).toBe(204);
      expect(debugMarketDataOutlier).toHaveBeenNthCalledWith(1, 'token-1');
      expect(debugMarketDataOutlier).toHaveBeenNthCalledWith(2, 'token-2');

      const syntheticFailed = await app.inject({
        method: 'POST',
        url: '/debug/synthetic-opportunity',
        payload: { marketId: 'market-1' }
      });
      const syntheticSucceeded = await app.inject({
        method: 'POST',
        url: '/debug/synthetic-opportunity',
        payload: { marketId: 'market-1', execute: true, executionMode: 'paper' }
      });
      expect(syntheticFailed.statusCode).toBe(400);
      expect(syntheticFailed.json()).toMatchObject({
        error: {
          code: 'synthetic_opportunity_failed',
          message: 'synthetic failed'
        }
      });
      expect(syntheticSucceeded.statusCode).toBe(200);
      expect(syntheticSucceeded.json()).toMatchObject({
        marketId: 'market-1',
        opportunityId: 'opp-2',
        message: 'synthetic ok',
        opportunity: { id: 'opp-2' },
        riskDecision: { approved: true },
        execution: { status: 'queued' },
        orderedIds: ['market-1', 'market-2']
      });
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('covers decision and config routes directly', async () => {
    const app = fastify();
    const { deps, opsAgent, contexts } = buildRouteContext();
    const state = {
      enabled: false,
      mode: 'paper' as const,
      changedAt: new Date('2026-03-09T00:00:00.000Z'),
      changedBy: 'test'
    };
    deps.configStore = {
      snapshot: () => ({ policy: { submitTimeoutMs: 1 }, risk: { maxOpenOrders: 2 } }),
      updatePolicy: vi.fn((payload) => ({ submitTimeoutMs: Number(payload.submitTimeoutMs ?? 1) })),
      updateRisk: vi.fn((payload) => ({ maxOpenOrders: Number(payload.maxOpenOrders ?? 2) })),
      getPolicy: () => ({ submitTimeoutMs: 1 }),
      getRisk: () => ({ maxOpenOrders: 2 })
    } as never;
    deps.tradingStateManager = {
      state,
      setMode: vi.fn((mode) => {
        state.mode = mode;
      }),
      setEnabled: vi.fn((enabled) => {
        state.enabled = enabled;
      })
    } as never;
    contexts.decisionAndConfig.queryPositiveInt = (request, key) =>
      key === 'limit' ? 5 : (request.query as Record<string, string | undefined> | undefined)?.[key] ? 1 : null;
    deps.eventStore = {
      listDecisions: vi.fn().mockReturnValue([{ id: 'd1' }])
    } as never;
    registerDecisionAndConfigRoutes(app, contexts.decisionAndConfig);

    try {
      const decisions = await app.inject({ method: 'GET', url: '/decisions?limit=5' });
      const config = await app.inject({ method: 'GET', url: '/config' });
      const tradingMode = await app.inject({
        method: 'POST',
        url: '/config/trading-mode?confirm=true',
        payload: { mode: 'live', enabled: true }
      });

      expect(decisions.statusCode).toBe(200);
      expect(decisions.json()).toEqual([{ id: 'd1' }]);
      expect(config.statusCode).toBe(200);
      expect(config.json()).toMatchObject({ tradingMode: 'paper', tradingEnabled: false });
      expect(tradingMode.statusCode).toBe(200);
      expect(tradingMode.json()).toMatchObject({ state: { mode: 'live', enabled: true } });
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });

  it('covers the event stream route directly', async () => {
    vi.useFakeTimers();
    const app = fastify();
    const { metrics, opsAgent, contexts } = buildRouteContext();
    contexts.eventStream.streamHeartbeatMs = 1;
    contexts.eventStream.queryPositiveInt = (_request, key) => (key === 'maxPings' ? 1 : null);
    registerEventStreamRoute(app, contexts.eventStream);

    try {
      const responsePromise = app.inject({ method: 'GET', url: '/stream?maxPings=1' });
      await vi.advanceTimersByTimeAsync(0);
      metrics.record({ type: 'info', timestamp: Date.now(), data: { message: 'hello' } });
      await vi.runAllTimersAsync();
      const response = await responsePromise;

      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('stream_connected');
      expect(response.payload).toContain('stream_ping');
    } finally {
      opsAgent.stop();
      await app.close();
    }
  });
});
