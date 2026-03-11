import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

type ResolvedCreds = {
  apiKey: string;
  secret: string;
  passphrase: string;
  address: string;
};

function createMetricsStore(): MetricsStore {
  return new MetricsStore(128);
}

function createMarketPairs() {
  return [
    { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1', question: 'Question 1' },
    { marketId: 'market-2', yesTokenId: 'yes-2', noTokenId: 'no-2', question: 'Question 2' }
  ];
}

function importFreshRuntimeServices() {
  vi.resetModules();
  return import('../../src/boot/runtimeServices.ts');
}

function mockRuntimeDependencies(options: { resolvedCreds?: ResolvedCreds; resolveError?: unknown } = {}) {
  const resolvePolymarketL2Creds = vi.fn();
  if (options.resolveError) {
    resolvePolymarketL2Creds.mockRejectedValue(options.resolveError);
  } else {
    resolvePolymarketL2Creds.mockResolvedValue(options.resolvedCreds ?? null);
  }

  const createPolymarketHmacAuthProvider = vi
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({ kind: 'authProvider', input }));
  const polymarketClobCtor = vi.fn(function MockPolymarketClob(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'clob';
    this.options = options;
  });
  const polymarketDataApiCtor = vi.fn(function MockPolymarketDataApi(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'dataApi';
    this.options = options;
  });
  const polymarketRealtimeCtor = vi.fn(function MockPolymarketRealtime(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'realtime';
    this.options = options;
  });
  const webSearchCacheCtor = vi.fn(function MockWebSearchCache(this: { kind: string }) {
    this.kind = 'cache';
  });
  const exaClientCtor = vi.fn(function MockExaClient(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'exa';
    this.options = options;
  });
  const firecrawlClientCtor = vi.fn(function MockFirecrawlClient(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'firecrawl';
    this.options = options;
  });
  const serperClientCtor = vi.fn(function MockSerperClient(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'serper';
    this.options = options;
  });
  const gdeltHeartbeatCtor = vi.fn(function MockGdeltHeartbeatService(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'gdeltHeartbeat';
    this.options = options;
  });
  const signalAggregatorCtor = vi.fn(function MockSignalAggregatorAgent(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'signalAggregator';
    this.options = options;
  });
  const ipOracleClientCtor = vi.fn(function MockIpOracleClient(
    this: { kind: string; options: Record<string, unknown> },
    options: Record<string, unknown>
  ) {
    this.kind = 'fwOracleClient';
    this.options = options;
  });
  const parseDomainList = vi.fn((value?: string) =>
    typeof value === 'string'
      ? [...new Set(value.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))]
      : []
  );
  const resolveFwOracleBaseUrl = vi.fn((value?: string) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'https://oracle.default'
  );

  vi.doMock('../../src/services/PolymarketApiCreds.js', () => ({
    resolvePolymarketL2Creds
  }));
  vi.doMock('../../src/services/PolymarketAuth.js', () => ({
    createPolymarketHmacAuthProvider
  }));
  vi.doMock('../../src/services/PolymarketClob.js', () => ({
    PolymarketClob: polymarketClobCtor
  }));
  vi.doMock('../../src/services/PolymarketDataApi.js', () => ({
    PolymarketDataApi: polymarketDataApiCtor
  }));
  vi.doMock('../../src/services/PolymarketRealtime.js', () => ({
    PolymarketRealtime: polymarketRealtimeCtor
  }));
  vi.doMock('../../src/services/websearch/WebSearchCache.js', () => ({
    WebSearchCache: webSearchCacheCtor
  }));
  vi.doMock('../../src/services/websearch/ExaClient.js', () => ({
    ExaClient: exaClientCtor
  }));
  vi.doMock('../../src/services/websearch/FirecrawlClient.js', () => ({
    FirecrawlClient: firecrawlClientCtor
  }));
  vi.doMock('../../src/services/websearch/SerperClient.js', () => ({
    SerperClient: serperClientCtor
  }));
  vi.doMock('../../src/services/websearch/GdeltHeartbeatService.js', () => ({
    GdeltHeartbeatService: gdeltHeartbeatCtor
  }));
  vi.doMock('../../src/agents/signal/SignalAggregatorAgent.js', () => ({
    SignalAggregatorAgent: signalAggregatorCtor
  }));
  vi.doMock('../../src/services/ip-oracle/IpOracleClient.js', () => ({
    IpOracleClient: ipOracleClientCtor
  }));
  vi.doMock('../../src/boot/config.js', () => ({
    parseDomainList
  }));
  vi.doMock('../../src/boot/fwOracle.js', () => ({
    resolveFwOracleBaseUrl
  }));

  return {
    resolvePolymarketL2Creds,
    createPolymarketHmacAuthProvider,
    polymarketClobCtor,
    polymarketDataApiCtor,
    polymarketRealtimeCtor,
    webSearchCacheCtor,
    exaClientCtor,
    firecrawlClientCtor,
    serperClientCtor,
    gdeltHeartbeatCtor,
    signalAggregatorCtor,
    ipOracleClientCtor,
    parseDomainList,
    resolveFwOracleBaseUrl
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('createRuntimeServices', () => {
  it('builds authenticated realtime, search, and oracle services when credentials and providers exist', async () => {
    const deps = mockRuntimeDependencies({
      resolvedCreds: {
        apiKey: 'key',
        secret: 'secret',
        passphrase: 'passphrase',
        address: '0xabc'
      }
    });
    const metrics = createMetricsStore();
    const recordSpy = vi.spyOn(metrics, 'record');
    const { createRuntimeServices } = await importFreshRuntimeServices();
    const env = loadEnv({
      POLYMARKET_POSITIONS_USER: '0xdef',
      EXA_API_KEY: 'exa-key',
      SERPER_API_KEY: 'serper-key',
      FIRECRAWL_API_KEY: 'firecrawl-key',
      EV_WEBSEARCH_DOMAIN_ALLOWLIST: 'Example.com, markets.example.com example.com',
      EV_WEBSEARCH_DOMAIN_DENYLIST: 'blocked.example.com'
    });
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: true,
      evWebSearchSerperEnabled: true,
      evWebSearchGdeltEnabled: true,
      evWebSearchFirecrawlMaxDepth: 4,
      evWebSearchFirecrawlMaxPages: 9
    };

    const services = await createRuntimeServices({
      env,
      policy,
      marketPairs: createMarketPairs(),
      messageBus: createMessageBus(),
      allowlist: new MarketAllowlist(),
      metrics
    });

    expect(deps.resolvePolymarketL2Creds).toHaveBeenCalledWith(env);
    expect(deps.createPolymarketHmacAuthProvider).toHaveBeenCalledWith({
      apiKey: 'key',
      secret: 'secret',
      passphrase: 'passphrase',
      address: '0xabc'
    });
    expect(deps.polymarketClobCtor).toHaveBeenCalledWith(
      expect.objectContaining({ authProvider: expect.objectContaining({ kind: 'authProvider' }) })
    );
    expect(deps.polymarketRealtimeCtor).toHaveBeenCalledTimes(2);
    expect(deps.polymarketRealtimeCtor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authMessage: {
          type: 'user',
          auth: {
            apiKey: 'key',
            secret: 'secret',
            passphrase: 'passphrase'
          },
          markets: ['market-1', 'market-2']
        }
      })
    );
    expect(deps.webSearchCacheCtor).toHaveBeenCalledTimes(1);
    expect(deps.exaClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'exa-key',
        cache: expect.objectContaining({ kind: 'cache' }),
        metrics
      })
    );
    expect(deps.firecrawlClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'firecrawl-key',
        crawlMaxDepth: 4,
        crawlMaxPages: 9,
        cache: expect.objectContaining({ kind: 'cache' }),
        metrics
      })
    );
    expect(deps.serperClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'serper-key',
        cache: expect.objectContaining({ kind: 'cache' }),
        metrics
      })
    );
    expect(deps.gdeltHeartbeatCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        policy,
        baseUrl: env.GDELT_BASE_URL,
        metrics
      })
    );
    expect(deps.parseDomainList).toHaveBeenCalledWith('Example.com, markets.example.com example.com');
    expect(deps.parseDomainList).toHaveBeenCalledWith('blocked.example.com');
    expect(deps.signalAggregatorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        exa: expect.objectContaining({ kind: 'exa' }),
        serper: expect.objectContaining({ kind: 'serper' }),
        firecrawl: expect.objectContaining({ kind: 'firecrawl' }),
        gdeltHeartbeat: expect.objectContaining({ kind: 'gdeltHeartbeat' }),
        domainAllowlist: ['example.com', 'markets.example.com'],
        domainDenylist: ['blocked.example.com'],
        metrics
      })
    );
    expect(deps.resolveFwOracleBaseUrl).toHaveBeenCalledWith(env.FW_ORACLE_BASE_URL);
    expect(deps.ipOracleClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://oracle.default',
        timeoutMs: env.FW_ORACLE_TIMEOUT_MS
      })
    );
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        data: expect.objectContaining({
          message: 'polymarket_creds_address_mismatch',
          positionsUser: '0xdef',
          signingAddress: '0xabc'
        })
      })
    );
    expect(services).toMatchObject({
      resolvedCreds: expect.objectContaining({ address: '0xabc' }),
      clob: expect.objectContaining({ kind: 'clob' }),
      dataApi: expect.objectContaining({ kind: 'dataApi' }),
      realtime: expect.objectContaining({ kind: 'realtime' }),
      userRealtime: expect.objectContaining({ kind: 'realtime' }),
      signalAggregator: expect.objectContaining({ kind: 'signalAggregator' }),
      fwOracleClient: expect.objectContaining({ kind: 'fwOracleClient' })
    });
  }, 15000);

  it('records credential and provider failures without creating optional authenticated services', async () => {
    const deps = mockRuntimeDependencies({
      resolveError: new Error('bad creds')
    });
    const metrics = createMetricsStore();
    const recordSpy = vi.spyOn(metrics, 'record');
    const { createRuntimeServices } = await importFreshRuntimeServices();
    const env = {
      ...loadEnv({}),
      FW_ORACLE_TIMEOUT_MS: 0,
      FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD: 0,
      FW_ORACLE_CIRCUIT_COOLDOWN_MS: -1
    };
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: true,
      evWebSearchSerperEnabled: true,
      evWebSearchGdeltEnabled: true
    };

    const services = await createRuntimeServices({
      env,
      policy,
      marketPairs: createMarketPairs(),
      messageBus: createMessageBus(),
      allowlist: new MarketAllowlist(),
      metrics
    });

    expect(deps.createPolymarketHmacAuthProvider).not.toHaveBeenCalled();
    expect(deps.polymarketClobCtor).toHaveBeenCalledWith(
      expect.objectContaining({ authProvider: undefined })
    );
    expect(deps.polymarketRealtimeCtor).toHaveBeenCalledTimes(1);
    expect(deps.exaClientCtor).not.toHaveBeenCalled();
    expect(deps.firecrawlClientCtor).not.toHaveBeenCalled();
    expect(deps.serperClientCtor).not.toHaveBeenCalled();
    expect(deps.gdeltHeartbeatCtor).toHaveBeenCalledTimes(1);
    expect(deps.signalAggregatorCtor).not.toHaveBeenCalled();
    expect(deps.ipOracleClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1,
        circuitFailureThreshold: 1,
        circuitCooldownMs: 0
      })
    );
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          message: 'polymarket_creds_resolve_failed',
          error: 'bad creds'
        })
      })
    );
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'web_search',
        data: { event: 'exa_missing_api_key' }
      })
    );
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'web_search',
        data: { event: 'firecrawl_missing_api_key' }
      })
    );
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'web_search',
        data: { event: 'serper_missing_api_key' }
      })
    );
    expect(services.userRealtime).toBeUndefined();
    expect(services.signalAggregator).toBeUndefined();
    expect(services.fwOracleClient).toMatchObject({ kind: 'fwOracleClient' });
  });

  it('stringifies non-Error credential failures before recording them', async () => {
    const deps = mockRuntimeDependencies({
      resolveError: 'credential lookup unavailable'
    });
    const metrics = createMetricsStore();
    const recordSpy = vi.spyOn(metrics, 'record');
    const { createRuntimeServices } = await importFreshRuntimeServices();

    await createRuntimeServices({
      env: loadEnv({}),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        evWebSearchExaEnabled: false,
        evWebSearchFirecrawlEnabled: false,
        evWebSearchSerperEnabled: false,
        evWebSearchGdeltEnabled: false
      },
      marketPairs: createMarketPairs(),
      messageBus: createMessageBus(),
      allowlist: new MarketAllowlist(),
      metrics
    });

    expect(deps.createPolymarketHmacAuthProvider).not.toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          message: 'polymarket_creds_resolve_failed',
          error: 'credential lookup unavailable'
        })
      })
    );
  });

  it('skips optional-provider warnings when providers are disabled and preserves matching positions users', async () => {
    const deps = mockRuntimeDependencies({
      resolvedCreds: {
        apiKey: 'key',
        secret: 'secret',
        passphrase: 'passphrase',
        address: '0xabc'
      }
    });
    const metrics = createMetricsStore();
    const recordSpy = vi.spyOn(metrics, 'record');
    const { createRuntimeServices } = await importFreshRuntimeServices();
    const env = loadEnv({
      POLYMARKET_POSITIONS_USER: '0xAbC'
    });
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      evWebSearchExaEnabled: false,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchSerperEnabled: false,
      evWebSearchGdeltEnabled: false
    };

    const services = await createRuntimeServices({
      env,
      policy,
      marketPairs: createMarketPairs(),
      messageBus: createMessageBus(),
      allowlist: new MarketAllowlist(),
      metrics
    });

    expect(deps.exaClientCtor).not.toHaveBeenCalled();
    expect(deps.firecrawlClientCtor).not.toHaveBeenCalled();
    expect(deps.serperClientCtor).not.toHaveBeenCalled();
    expect(deps.gdeltHeartbeatCtor).not.toHaveBeenCalled();
    expect(deps.signalAggregatorCtor).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: 'exa_missing_api_key' })
      })
    );
    expect(recordSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: 'firecrawl_missing_api_key' })
      })
    );
    expect(recordSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event: 'serper_missing_api_key' })
      })
    );
    expect(recordSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'polymarket_creds_address_mismatch' })
      })
    );
    expect(services.userRealtime).toMatchObject({ kind: 'realtime' });
    expect(services.signalAggregator).toBeUndefined();
  });

  it('does not construct disabled secondary websearch providers just because credentials exist', async () => {
    const deps = mockRuntimeDependencies({
      resolvedCreds: {
        apiKey: 'key',
        secret: 'secret',
        passphrase: 'passphrase',
        address: '0xabc'
      }
    });
    const metrics = createMetricsStore();
    const { createRuntimeServices } = await importFreshRuntimeServices();
    const env = loadEnv({
      EXA_API_KEY: 'exa-key',
      FIRECRAWL_API_KEY: 'firecrawl-key',
      SERPER_API_KEY: 'serper-key'
    });

    await createRuntimeServices({
      env,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        evWebSearchExaEnabled: true,
        evWebSearchFirecrawlEnabled: false,
        evWebSearchSerperEnabled: false,
        evWebSearchGdeltEnabled: false
      },
      marketPairs: createMarketPairs(),
      messageBus: createMessageBus(),
      allowlist: new MarketAllowlist(),
      metrics
    });

    expect(deps.exaClientCtor).toHaveBeenCalledTimes(1);
    expect(deps.firecrawlClientCtor).not.toHaveBeenCalled();
    expect(deps.serperClientCtor).not.toHaveBeenCalled();
    expect(deps.signalAggregatorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        exa: expect.objectContaining({ kind: 'exa' }),
        serper: undefined,
        firecrawl: undefined
      })
    );
  });
});
