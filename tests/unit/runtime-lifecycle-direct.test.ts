import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtimeLifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('../../src/api/server.js');
    vi.unmock('../../src/config/infra.js');
  });

  it('registers trading and catalog lifecycle handlers and configures ops checks', async () => {
    const {
      configureOpsChecks,
      registerCatalogRefresherHandlers,
      registerTradingStateHandlers
    } = await import('../../src/boot/runtimeLifecycle.js');
    const { DEFAULT_TRADE_POLICY } = await import('../../src/config/policy.js');

    let modeListener: ((event: { previousMode: 'paper'; newMode: 'live' }) => void) | undefined;
    let enabledListener:
      | ((event: { previousEnabled: false; newEnabled: true }) => void)
      | undefined;
    const tradingStateManager = {
      onModeChange: vi.fn((listener) => {
        modeListener = listener;
      }),
      onEnabledChange: vi.fn((listener) => {
        enabledListener = listener;
      })
    };
    const recordRuntimeInfo = vi.fn();
    const supervisor = {
      updateTradingMode: vi.fn(),
      updateTradingEnabled: vi.fn(),
      updateMarketPairs: vi.fn(),
      getOrderBooks: vi.fn(() => []),
      getCircuitBreakerOpenMarkets: vi.fn(() => ['market-1'])
    };

    registerTradingStateHandlers({
      tradingStateManager,
      recordRuntimeInfo,
      supervisor,
      resolveEffectiveTradingEnabled: () => false,
      isCatalogRefreshReady: () => false
    });

    modeListener?.({ previousMode: 'paper', newMode: 'live' });
    enabledListener?.({ previousEnabled: false, newEnabled: true });

    expect(supervisor.updateTradingMode).toHaveBeenCalledWith('live');
    expect(supervisor.updateTradingEnabled).toHaveBeenCalledWith(false);
    expect(recordRuntimeInfo).toHaveBeenCalledWith('trading_still_blocked_pending_catalog_refresh', {
      previousEnabled: false,
      newEnabled: true
    });

    type CatalogPairs = Array<{ marketId: string; yesTokenId: string; noTokenId: string }>;
    type CatalogListener = ((payload: { pairs: CatalogPairs }) => void) | ((error: unknown) => void);
    const listeners = new Map<string, CatalogListener>();
    const allowlist = { seed: vi.fn() };
    const updateTokenToMarketId = vi.fn();
    const refreshDependencyRelationCatalog = vi.fn();
    const metrics = { record: vi.fn() };
    let catalogReady = false;

    const catalogRefresher = {
      on: vi.fn((event, listener) => {
        listeners.set(event, listener);
      }),
      start: vi.fn()
    };

    registerCatalogRefresherHandlers({
      catalogRefresher,
      supervisor,
      allowlist,
      updateTokenToMarketId,
      refreshDependencyRelationCatalog,
      metrics: metrics as never,
      resolveEffectiveTradingEnabled: () => true,
      isCatalogRefreshReady: () => catalogReady,
      setCatalogRefreshReady: (value) => {
        catalogReady = value;
      },
      catalogRefreshBlockStartedAtMs: Date.now() - 250
    });

    const pairs: CatalogPairs = [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }];
    (listeners.get('refresh') as (payload: { pairs: typeof pairs }) => void)?.({ pairs });
    (listeners.get('error') as (error: unknown) => void)?.(new Error('boom'));

    expect(refreshDependencyRelationCatalog).toHaveBeenCalledWith('catalog_refresh', pairs);
    expect(supervisor.updateMarketPairs).toHaveBeenCalledWith(pairs);
    expect(allowlist.seed).toHaveBeenCalledWith(['market-1']);
    expect(updateTokenToMarketId).toHaveBeenCalledWith(pairs);
    expect(supervisor.updateTradingEnabled).toHaveBeenCalledWith(true);
    expect(catalogRefresher.start).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ message: 'catalog_refresher_error', error: 'boom' })
      })
    );

    const opsAgent = {
      setChecks: vi.fn(),
      start: vi.fn()
    };
    configureOpsChecks({
      opsAgent,
      configStore: { getPolicy: () => DEFAULT_TRADE_POLICY },
      env: { OPS_BOOK_REFRESH_INTERVAL_MS: 0, OPS_BOOK_REFRESH_STALE_MS: 0 },
      metrics: metrics as never,
      supervisor,
      marketPairs: pairs
    });

    const configuredChecks = opsAgent.setChecks.mock.calls[0]?.[0] as Array<{ name?: string }>;
    expect(configuredChecks).toHaveLength(5);
    expect(configuredChecks.map((check) => check.name ?? 'circuit_breaker')).toEqual([
      'book_freshness',
      'delayed_ack_rate',
      'decision_latency_p95',
      'paired_fill_rate',
      'circuit_breakers'
    ]);
    expect(opsAgent.start).not.toHaveBeenCalled();
  }, 30000);

  it('starts the ops server when enabled and registers shutdown signal handlers', async () => {
    const startOpsServer = vi.fn().mockResolvedValue({ close: vi.fn() });
    const getInfraConfigSnapshot = vi.fn(() => ({ oracle: 'ready' }));
    vi.doMock('../../src/api/server.js', () => ({ startOpsServer }));
    vi.doMock('../../src/config/infra.js', () => ({ getInfraConfigSnapshot }));

    const { registerShutdownSignals, startRuntimeOpsServer } = await import(
      '../../src/boot/runtimeLifecycle.js'
    );

    const recordRuntimeInfo = vi.fn();
    const recordRuntimeError = vi.fn();
    const env = {
      OPS_API_ENABLED: true,
      OPS_API_HOST: '127.0.0.1',
      OPS_API_TOKEN: 'ops-token',
      OPS_DEV_SESSION_PREFILL_ENABLED: false,
      OPS_INCIDENTS_LIMIT: 50,
      OPS_STREAM_HEARTBEAT_MS: 1_000,
      PORT: 3_000
    };

    const server = await startRuntimeOpsServer({
      env: env as never,
      metrics: {} as never,
      allowlist: {} as never,
      opsAgent: {} as never,
      supervisor: {
        runSyntheticOpportunityTest: vi.fn(),
        debugMarketDataOutlier: vi.fn()
      },
      tradingMode: 'paper',
      tradingEnabled: true,
      riskProfile: { id: 'high', source: 'persisted' },
      applyRiskProfile: vi.fn(),
      applyConfigUpdate: vi.fn(),
      recordRuntimeInfo,
      recordRuntimeError
    });

    expect(server).toEqual({ close: expect.any(Function) });
    expect(getInfraConfigSnapshot).toHaveBeenCalledWith(env);
    expect(startOpsServer).toHaveBeenCalledWith(
      expect.objectContaining({
        infraConfig: { oracle: 'ready' },
        tradingMode: 'paper',
        tradingEnabled: true
      }),
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3_000,
        authToken: 'ops-token'
      })
    );
    expect(recordRuntimeInfo).toHaveBeenCalledWith('ops_api_started', {
      host: '127.0.0.1',
      port: 3_000
    });
    expect(recordRuntimeError).not.toHaveBeenCalled();

    const onSpy = vi.spyOn(process, 'on');
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const recordPaperRunMarker = vi.fn();

    registerShutdownSignals({ shutdown, recordPaperRunMarker });

    const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    const sigintHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGINT')?.[1];
    expect(sigtermHandler).toBeTypeOf('function');
    expect(sigintHandler).toBeTypeOf('function');

    (sigtermHandler as () => void)?.();
    (sigintHandler as () => void)?.();

    expect(recordPaperRunMarker).toHaveBeenNthCalledWith(1, 'stop', 'SIGTERM');
    expect(recordPaperRunMarker).toHaveBeenNthCalledWith(2, 'stop', 'SIGINT');
    expect(shutdown).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(shutdown).toHaveBeenNthCalledWith(2, 'SIGINT');
  });
});
