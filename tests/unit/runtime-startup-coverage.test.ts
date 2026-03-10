import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { loadEnv } from '../../src/config/env.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('startRuntimeLifecycle behavior', () => {
  it('wires real catalog refresh behavior through lifecycle setup without module mocks', async () => {
    const { startRuntimeLifecycle } = await import('../../src/boot/runtimeStartup.js');
    const env = loadEnv({
      NODE_ENV: 'test',
      GAMMA_API_BASE_URL: 'https://gamma.example',
      OPS_API_ENABLED: 'false'
    });
    const metrics = new MetricsStore(64);
    const policy = { ...DEFAULT_TRADE_POLICY };
    const risk = { ...DEFAULT_RISK_CONFIG };
    const configStore = {
      getPolicy: vi.fn(() => policy),
      getRisk: vi.fn(() => risk),
      replace: vi.fn(() => ({ policy, risk }))
    };
    const supervisor = {
      updatePolicyAndRisk: vi.fn(),
      updateBookRefresh: vi.fn(),
      updateTradingEnabled: vi.fn(),
      updateTradingMode: vi.fn(),
      updateMarketPairs: vi.fn(),
      getOrderBooks: vi.fn(() => []),
      getCircuitBreakerOpenMarkets: vi.fn(() => [])
    };
    const allowlist = { seed: vi.fn() };
    const updateTokenToMarketId = vi.fn();
    const opsAgent = { setChecks: vi.fn(), start: vi.fn() };
    let catalogReady = false;

    const result = await startRuntimeLifecycle({
      env,
      metrics,
      configStore,
      supervisor,
      bookStaleQuarantine: { handle: vi.fn(), updateConfig: vi.fn() },
      incidentTracker: { updateConfig: vi.fn() } as never,
      marketPairs: [
        {
          marketId: 'market-1',
          yesTokenId: 'yes-1',
          noTokenId: 'no-1',
          question: 'Will gamma stay explicit?'
        }
      ],
      fwOracleClient: { updateConfig: vi.fn() } as never,
      policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' },
      activeRiskProfile: { id: 'extra_high', source: '/tmp/extra_high.json' },
      fwProjectionAgent: { updateResolverConfig: vi.fn() } as never,
      relationCatalogPath: '/tmp/relation-catalog.json',
      startupCatalogSnapshot: {
        path: '/tmp/relation-catalog.json',
        loadedAtMs: Date.now(),
        entries: [],
        malformedEntries: 0
      },
      refreshSettings: {
        maxBookStalenessMs: 15000,
        bookRefreshIntervalMs: 15000,
        bookRefreshStaleMs: 15000,
        bookIdleCutoffMs: 60000,
        catalogRefreshMs: 60000
      },
      fwDependencyLlmExtractor: vi.fn(),
      maxPairs: 20,
      clob: { getOrderBook: vi.fn() } as never,
      allowlist: allowlist as never,
      updateTokenToMarketId,
      catalogRefreshState: {
        resolveEffectiveTradingEnabled: () => true,
        isReady: () => catalogReady,
        setReady: (value) => {
          catalogReady = value;
        },
        catalogRefreshBlockStartedAtMs: Date.now() - 250
      },
      opsAgent: opsAgent as never
    });

    const refreshedPairs = [
      {
        marketId: 'market-2',
        yesTokenId: 'yes-2',
        noTokenId: 'no-2',
        question: 'Will the real refresh wiring stay covered?'
      }
    ];
    result.catalogRefresher.emit('refresh', { pairs: refreshedPairs });

    expect(result.runtimeConfig).toBeDefined();
    expect(supervisor.updateMarketPairs).toHaveBeenCalledWith(refreshedPairs);
    expect(allowlist.seed).toHaveBeenCalledWith(['market-2']);
    expect(updateTokenToMarketId).toHaveBeenCalledWith(refreshedPairs);
    expect(supervisor.updateTradingEnabled).toHaveBeenCalledWith(true);

    const checks = opsAgent.setChecks.mock.calls[0]?.[0] as Array<{ name?: string }>;
    expect(checks.map((check) => check.name ?? 'circuit_breakers')).toEqual([
      'book_freshness',
      'delayed_ack_rate',
      'decision_latency_p95',
      'paired_fill_rate',
      'circuit_breakers'
    ]);
    expect(
      metrics
        .recent('info', 10)
        .some((event) => (event.data as { message?: string }).message === 'trading_unblocked_catalog_refresh_ready')
    ).toBe(true);
  }, 15000);
});
