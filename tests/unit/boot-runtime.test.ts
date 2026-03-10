import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveBookRefreshSettings,
  loadRuntimePolicyState,
  parseDomainList
} from '../../src/boot/config.js';
import { ensureFwOracleStartupReady } from '../../src/boot/fwOracle.js';
import { createLLMBootstrap, refreshLLMPolicyHashes } from '../../src/boot/llm.js';
import { createBootTelemetry } from '../../src/boot/telemetry.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { loadEnv } from '../../src/config/env.js';
import { EventStore } from '../../src/core/EventStore.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('boot config helpers', () => {
  it('falls back cleanly when the persisted active profile file is unreadable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = loadEnv({});
    const dir = createTempDir('boot-config-invalid-active-');
    const activePath = join(dir, 'active.json');
    writeFileSync(activePath, '{not-json', 'utf8');

    const state = loadRuntimePolicyState({
      env,
      envProfile: null,
      riskProfileActivePath: activePath
    });

    expect(state.activeRiskProfile.id).toBe('extra_high');
    expect(state.activeRiskProfile.source).toMatch(/extra_high\.json$/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load active risk profile:')
    );
  });

  it('falls back from a stale persisted override path to the default profile file', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = loadEnv({});
    const dir = createTempDir('boot-config-stale-profile-');
    const activePath = join(dir, 'active.json');
    writeFileSync(
      activePath,
      JSON.stringify({ id: 'high', source: join(dir, 'missing-high.json') }),
      'utf8'
    );

    const state = loadRuntimePolicyState({
      env,
      envProfile: null,
      riskProfileActivePath: activePath
    });

    expect(state.activeRiskProfile.id).toBe('high');
    expect(state.activeRiskProfile.source).toMatch(/high\.json$/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load risk profile; falling back to defaults:')
    );
  });

  it('falls back to near_zero when the selected profile does not exist', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = loadRuntimePolicyState({
      env: loadEnv({}),
      envProfile: 'ghost' as never
    });

    expect(state.activeRiskProfile.id).toBe('near_zero');
    expect(state.activeRiskProfile.source).toMatch(/near_zero\.json$/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Risk profile missing for ghost; falling back to near_zero')
    );
  });

  it('falls back to near_zero after a stale persisted path and a missing persisted profile id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = createTempDir('boot-config-ghost-profile-');
    const settingsDir = join(dir, 'settings', 'risk-gates');
    const activePath = join(settingsDir, 'active.json');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'near_zero.json'),
      JSON.stringify({}),
      'utf8'
    );
    writeFileSync(
      activePath,
      JSON.stringify({ id: 'high', source: join(dir, 'missing-high.json') }),
      'utf8'
    );
    process.chdir(dir);

    const state = loadRuntimePolicyState({
      env: loadEnv({}),
      envProfile: null,
      riskProfileActivePath: activePath
    });

    expect(state.activeRiskProfile.id).toBe('near_zero');
    expect(state.activeRiskProfile.source).toMatch(/near_zero\.json$/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load risk profile; falling back to defaults:')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Risk profile missing for high; falling back to near_zero')
    );
  });

  it('rethrows explicit risk profile override failures', () => {
    const dir = createTempDir('boot-config-explicit-profile-');

    expect(() =>
      loadRuntimePolicyState({
        env: loadEnv({}),
        envProfile: 'high',
        envProfilePath: join(dir, 'missing-high.json')
      })
    ).toThrow(/Risk profile path not found/);
  });

  it('derives refresh settings from policy and env overrides and dedupes domain lists', () => {
    const defaulted = deriveBookRefreshSettings(
      { ...DEFAULT_TRADE_POLICY, maxBookStalenessMs: 5_000 },
      { OPS_BOOK_REFRESH_INTERVAL_MS: 2_000, OPS_BOOK_REFRESH_STALE_MS: 9_000 }
    );
    const zeroStaleness = deriveBookRefreshSettings(
      { ...DEFAULT_TRADE_POLICY, maxBookStalenessMs: 0 },
      { OPS_BOOK_REFRESH_INTERVAL_MS: 0, OPS_BOOK_REFRESH_STALE_MS: 2_500 }
    );
    const noOverrides = deriveBookRefreshSettings(
      { ...DEFAULT_TRADE_POLICY, maxBookStalenessMs: 12_000 },
      { OPS_BOOK_REFRESH_INTERVAL_MS: 0, OPS_BOOK_REFRESH_STALE_MS: 0 }
    );

    expect(defaulted).toMatchObject({
      maxBookStalenessMs: 5_000,
      bookRefreshIntervalMs: 2_000,
      bookRefreshStaleMs: 5_000,
      bookIdleCutoffMs: 60_000,
      catalogRefreshMs: 60_000
    });
    expect(zeroStaleness).toMatchObject({
      maxBookStalenessMs: 0,
      bookRefreshIntervalMs: 10_000,
      bookRefreshStaleMs: 2_500
    });
    expect(noOverrides).toMatchObject({
      maxBookStalenessMs: 12_000,
      bookRefreshIntervalMs: 12_000,
      bookRefreshStaleMs: 12_000
    });
    expect(parseDomainList()).toEqual([]);
    expect(parseDomainList(' Example.com, test.com example.com TEST.com ')).toEqual([
      'example.com',
      'test.com'
    ]);
  });
});

describe('FW oracle startup readiness', () => {
  it('skips checks when trading is disabled or not in paper mode', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const metrics = { record: vi.fn() };

    await ensureFwOracleStartupReady({
      tradingEnabled: false,
      tradingMode: 'paper',
      baseUrl: 'http://oracle.local',
      timeoutMs: 200,
      attempts: 1,
      retryDelayMs: 0,
      metrics
    });
    await ensureFwOracleStartupReady({
      tradingEnabled: true,
      tradingMode: 'shadow',
      baseUrl: 'http://oracle.local',
      timeoutMs: 200,
      attempts: 1,
      retryDelayMs: 0,
      metrics
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty base url and records successful health checks with auth headers', async () => {
    await expect(
      ensureFwOracleStartupReady({
        tradingEnabled: true,
        tradingMode: 'paper',
        baseUrl: '   ',
        timeoutMs: 200,
        attempts: 1,
        retryDelayMs: 0,
        metrics: { record: vi.fn() }
      })
    ).rejects.toThrow(/FW oracle base URL is empty/);

    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const metrics = { record: vi.fn() };
    vi.stubGlobal('fetch', fetchSpy);

    await ensureFwOracleStartupReady({
      tradingEnabled: true,
      tradingMode: 'paper',
      baseUrl: 'http://oracle.local///',
      apiKey: 'secret',
      timeoutMs: 200,
      attempts: 0,
      retryDelayMs: 0,
      metrics
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://oracle.local/health',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer secret' }
      })
    );
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_oracle',
        data: expect.objectContaining({ event: 'startup_healthcheck_ok', attempt: 1 })
      })
    );
  });

  it('records incidents and surfaces the final failure after retries', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('oracle offline'))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }));
    const metrics = { record: vi.fn() };
    vi.stubGlobal('fetch', fetchSpy);

    const pending = ensureFwOracleStartupReady({
      tradingEnabled: true,
      tradingMode: 'paper',
      baseUrl: 'http://oracle.local',
      timeoutMs: 200,
      attempts: 2,
      retryDelayMs: 0,
      metrics
    });

    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrow(/FW oracle sidecar is unavailable/);
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'incident',
        data: expect.objectContaining({
          reason: 'fw_oracle_unavailable_startup',
          detail: expect.objectContaining({
            attempts: 2,
            lastFailure: 'http_503'
          })
        })
      })
    );
  });

  it('stringifies non-Error fetch failures in the recorded incident detail', async () => {
    const fetchSpy = vi.fn().mockRejectedValue('timed out');
    const metrics = { record: vi.fn() };
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      ensureFwOracleStartupReady({
        tradingEnabled: true,
        tradingMode: 'paper',
        baseUrl: 'http://oracle.local',
        timeoutMs: 200,
        attempts: 1,
        retryDelayMs: 0,
        metrics
      })
    ).rejects.toThrow(/last=timed out/);

    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'incident',
        data: expect.objectContaining({
          detail: expect.objectContaining({ lastFailure: 'timed out' })
        })
      })
    );
  });
});

describe('LLM bootstrap helpers', () => {
  it('creates advisors only when LLM is actually enabled', () => {
    const disabledStore = new EventStore({ dbPath: join(createTempDir('boot-llm-disabled-'), 'events.db') });
    const disabled = createLLMBootstrap({
      env: loadEnv({}),
      policy: { ...DEFAULT_TRADE_POLICY },
      risk: { ...DEFAULT_RISK_CONFIG },
      metrics: new MetricsStore(10),
      store: disabledStore,
      messageBus: createMessageBus()
    });

    expect(disabled.llmConfig.enabled).toBe(false);
    expect(disabled.executionAdvisor).toBeUndefined();
    expect(disabled.riskAdvisor).toBeUndefined();
    expect(typeof disabled.fwDependencyLlmExtractor).toBe('function');
    disabledStore.close();

    const enabledStore = new EventStore({ dbPath: join(createTempDir('boot-llm-enabled-'), 'events.db') });
    const enabled = createLLMBootstrap({
      env: loadEnv({
        LLM_PRIMARY_API_KEY: 'primary-key',
        LLM_FALLBACK_API_KEY: 'fallback-key',
        LLM_OPENROUTER_HTTP_REFERER: 'https://openpolytrader.local',
        LLM_OPENROUTER_X_TITLE: 'OpenPolyTrader'
      }),
      policy: { ...DEFAULT_TRADE_POLICY },
      risk: { ...DEFAULT_RISK_CONFIG },
      metrics: new MetricsStore(10),
      store: enabledStore,
      messageBus: createMessageBus()
    });

    expect(enabled.llmConfig.enabled).toBe(true);
    expect(enabled.executionAdvisor).toBeDefined();
    expect(enabled.riskAdvisor).toBeDefined();
    expect(enabled.llmConfig.providers.openrouter.defaultHeaders).toMatchObject({
      'HTTP-Referer': 'https://openpolytrader.local',
      'X-Title': 'OpenPolyTrader'
    });
    enabled.executionAdvisor?.stop();
    enabledStore.close();
  });

  it('keeps policy hashes stable across key ordering and refreshes them in place', () => {
    const firstStore = new EventStore({ dbPath: join(createTempDir('boot-llm-hash-a-'), 'events.db') });
    const secondStore = new EventStore({ dbPath: join(createTempDir('boot-llm-hash-b-'), 'events.db') });
    const env = loadEnv({});
    const first = createLLMBootstrap({
      env,
      policy: { nested: { beta: 2, alpha: 1 }, list: [{ y: 2, x: 1 }] } as never,
      risk: { thresholds: { high: 2, low: 1 }, tags: ['b', 'a'] } as never,
      metrics: new MetricsStore(10),
      store: firstStore,
      messageBus: createMessageBus()
    });
    const second = createLLMBootstrap({
      env,
      policy: { list: [{ x: 1, y: 2 }], nested: { alpha: 1, beta: 2 } } as never,
      risk: { tags: ['b', 'a'], thresholds: { low: 1, high: 2 } } as never,
      metrics: new MetricsStore(10),
      store: secondStore,
      messageBus: createMessageBus()
    });

    expect(first.policyHashes).toEqual(second.policyHashes);

    const mutableHashes = { tradePolicyHash: 'old-trade', riskConfigHash: 'old-risk' };
    refreshLLMPolicyHashes(
      mutableHashes,
      { nested: { gamma: 3, alpha: 1 } } as never,
      { limits: [{ hard: true, cap: 5 }] } as never
    );

    expect(mutableHashes.tradePolicyHash).not.toBe('old-trade');
    expect(mutableHashes.riskConfigHash).not.toBe('old-risk');

    firstStore.close();
    secondStore.close();
  });
});

describe('boot telemetry', () => {
  it('prunes retained metrics and records paper markers once per stop', () => {
    const dir = createTempDir('boot-telemetry-paper-');
    const dbPath = join(dir, 'metrics.db');
    const seedStore = new EventStore({ dbPath });
    const now = Date.now();
    seedStore.persistMetric({
      type: 'info',
      timestamp: now - 3 * 24 * 60 * 60 * 1000,
      data: { message: 'stale_metric' }
    });
    seedStore.close();

    const telemetry = createBootTelemetry({
      dbPath,
      metricsMaxEvents: 20,
      metricsRetentionDays: 1,
      metricsPruneIntervalMs: 0,
      tradingMode: 'paper',
      messageBus: createMessageBus()
    });

    telemetry.recordPaperRunMarker('start', 'boot');
    telemetry.recordPaperRunMarker('stop', 'shutdown');
    telemetry.recordPaperRunMarker('stop', 'duplicate');

    const infoEvents = telemetry.metrics.recent('info', 10);
    const markerEvents = infoEvents.filter(
      (event) => (event.data as { message?: string }).message === 'paper_run_marker'
    );

    expect(infoEvents[0]?.data).toMatchObject({
      message: 'metrics_pruned',
      pruned: 1,
      retentionDays: 1
    });
    expect(markerEvents).toHaveLength(2);
    expect(telemetry.store.queryMetrics('info', 10 * 24 * 60 * 60 * 1000, now + 1)).toHaveLength(3);

    telemetry.metrics.off('event', telemetry.persistMetric);
    telemetry.store.close();
  });

  it('creates a prune timer and ignores paper markers outside paper mode', () => {
    vi.useFakeTimers();
    const telemetry = createBootTelemetry({
      dbPath: join(createTempDir('boot-telemetry-shadow-'), 'metrics.db'),
      metricsMaxEvents: 10,
      metricsRetentionDays: 1,
      metricsPruneIntervalMs: 1_000,
      tradingMode: 'shadow',
      messageBus: createMessageBus()
    });

    telemetry.recordPaperRunMarker('start', 'ignored');

    expect(telemetry.pruneTimer).not.toBeNull();
    expect(telemetry.metrics.recent('info', 10)).toEqual([]);

    clearInterval(telemetry.pruneTimer!);
    telemetry.metrics.off('event', telemetry.persistMetric);
    telemetry.store.close();
  });
});

describe('runtime bootstrap entrypoint', () => {
  it('directly boots the runtime with mocked collaborators', async () => {
    vi.resetModules();

    const rawEnv = { NODE_ENV: 'test', OPS_API_ENABLED: 'true', RISK_PROFILE: 'high' } as NodeJS.ProcessEnv;
    const env = loadEnv({ NODE_ENV: 'test', OPS_API_ENABLED: 'true' });
    const marketPairs = [
      {
        marketId: 'market-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        question: 'Will event A happen?',
        category: 'news',
        tags: ['tag-a']
      }
    ];
    const policy = { ...DEFAULT_TRADE_POLICY };
    const risk = { ...DEFAULT_RISK_CONFIG };
    const configStore = {
      getPolicy: vi.fn(() => policy),
      getRisk: vi.fn(() => risk),
      replace: vi.fn(() => ({ policy, risk }))
    };
    const activeRiskProfile = { id: 'extra_high', source: '/tmp/extra_high.json' };
    const messageBus = { on: vi.fn() };
    const metrics = { record: vi.fn(), off: vi.fn() };
    const store = { close: vi.fn() };
    const persistMetric = vi.fn();
    const recordPaperRunMarker = vi.fn();
    const refreshLLMPolicyHashes = vi.fn();
    const createRuntimeServices = vi.fn().mockResolvedValue({
      clob: {},
      dataApi: {},
      realtime: { close: vi.fn() },
      userRealtime: { close: vi.fn() },
      signalAggregator: undefined,
      fwOracleClient: { updateConfig: vi.fn() }
    });
    const learningStart = vi.fn();
    const opsAgentStart = vi.fn();
    const opsAgentSetChecks = vi.fn();
    const allowlistSeed = vi.fn();
    const supervisorStart = vi.fn().mockResolvedValue(undefined);
    const shutdownHandler = vi.fn().mockResolvedValue(undefined);
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const startOpsServer = vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    const resolveRiskProfileEnvFlags = vi.fn(() => ({ profileSet: false, profilePathSet: false }));

    vi.doMock('../../src/config/env.js', () => ({
      loadEnv: vi.fn(() => env),
      resolveRiskProfileEnvFlags
    }));
    vi.doMock('../../src/config/riskProfile.js', () => ({
      loadRiskProfile: vi.fn(),
      persistActiveRiskProfile: vi.fn(),
      resolveRiskProfilePathCandidates: vi.fn(() => [])
    }));
    vi.doMock('../../src/config/validate.js', () => ({
      validateP0Config: vi.fn()
    }));
    vi.doMock('../../src/domain/allowlist.js', () => ({
      MarketAllowlist: vi.fn(function MockMarketAllowlist() {
        return { seed: allowlistSeed };
      })
    }));
    vi.doMock('../../src/agents/ops/OpsAgent.js', () => ({
      OpsAgent: vi.fn(function MockOpsAgent() {
        return { setChecks: opsAgentSetChecks, start: opsAgentStart, stop: vi.fn() };
      })
    }));
    vi.doMock('../../src/agents/ops/bookFreshnessQuarantine.js', () => ({
      createBookFreshnessQuarantine: vi.fn(() => ({
        handle: vi.fn(),
        updateConfig: vi.fn()
      })),
      isOpsAlertPayload: vi.fn(() => false)
    }));
    vi.doMock('../../src/agents/ops/sloChecks.js', () => ({
      createBookFreshnessCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createCircuitBreakerCheck: vi.fn(() => ({ name: 'circuit_breaker', check: vi.fn(() => ({ ok: true })) })),
      createDelayedAckRateCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createLatencyPercentileCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createPairedFillRateCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) }))
    }));
    vi.doMock('../../src/api/server.js', () => ({
      startOpsServer
    }));
    vi.doMock('../../src/services/MarketCatalog.js', () => ({
      MarketCatalog: vi.fn(function MockMarketCatalog() {
        return { loadPairs: vi.fn(() => marketPairs) };
      })
    }));
    vi.doMock('../../src/services/MarketCatalogRefresher.js', () => ({
      MarketCatalogRefresher: vi.fn(function MockMarketCatalogRefresher() {
        return {
          seed: vi.fn(),
          on: vi.fn(),
          start: vi.fn(),
          updateConfig: vi.fn(),
          getPairs: vi.fn(() => marketPairs)
        };
      })
    }));
    vi.doMock('../../src/services/IncidentTracker.js', () => ({
      IncidentTracker: vi.fn(function MockIncidentTracker() {
        return { updateConfig: vi.fn() };
      })
    }));
    vi.doMock('../../src/agents/portfolio/PortfolioAgent.js', () => ({
      PortfolioAgent: vi.fn(function MockPortfolioAgent() {
        return {};
      })
    }));
    vi.doMock('../../src/agents/learning/LearningAgent.js', () => ({
      LearningAgent: vi.fn(function MockLearningAgent() {
        return { start: learningStart };
      })
    }));
    vi.doMock('../../src/agents/dependency/DependencyRelationCatalog.js', () => ({
      buildDependencyRelationCatalogEntries: vi.fn(() => ({
        entries: [],
        deterministicRelations: 0,
        semanticRelations: 0,
        relationTypeCounts: {
          mutual_exclusive: 0,
          implies: 0,
          complementary: 0,
          partition: 0
        }
      })),
      loadDependencyRelationCatalog: vi.fn(() => ({
        path: '/tmp/dependency-relations.json',
        loadedAtMs: Date.now(),
        entries: [],
        malformedEntries: 0
      }))
    }));
    vi.doMock('../../src/agents/dependency/FwRelationCatalogStartupGuard.js', () => ({
      ensureFwRelationCatalogStartupReady: vi.fn()
    }));
    vi.doMock('../../src/agents/projection/FwProjectionAgent.js', () => ({
      FwProjectionAgent: vi.fn(function MockFwProjectionAgent() {
        return { updateResolverConfig: vi.fn() };
      })
    }));
    vi.doMock('../../src/core/MessageBus.js', () => ({
      createMessageBus: vi.fn(() => messageBus)
    }));
    vi.doMock('../../src/core/supervisorAssembly.js', () => ({
      buildSupervisorRuntimeConfig: vi.fn((input) => ({
        marketPairs: input.marketPairs,
        policy: input.policy,
        riskConfig: input.riskConfig,
        capital: input.capital,
        tradingEnabled: input.tradingEnabled,
        tradingMode: input.tradingMode,
        maxConcurrentMarkets: input.maxConcurrentMarkets,
        maxCapitalInFlight: input.maxCapitalInFlight,
        bookRefresh: input.bookRefresh,
        reconciliation: input.reconciliation
      })),
      buildRuntimeSupervisorAssembly: vi.fn(() => ({ mocked: true }))
    }));
    vi.doMock('../../src/core/Supervisor.js', () => ({
      Supervisor: vi.fn(function MockSupervisor() {
        return {
          start: supervisorStart,
          updateTradingMode: vi.fn(),
          updateTradingEnabled: vi.fn(),
          updatePolicyAndRisk: vi.fn(),
          updateBookRefresh: vi.fn(),
          updateMarketPairs: vi.fn(),
          getOrderBooks: vi.fn(() => []),
          getCircuitBreakerOpenMarkets: vi.fn(() => []),
          runSyntheticOpportunityTest: vi.fn(),
          debugMarketDataOutlier: vi.fn(),
          shutdown: vi.fn().mockResolvedValue(undefined)
        };
      })
    }));
    vi.doMock('../../src/core/TradingStateManager.js', () => ({
      TradingStateManager: vi.fn(function MockTradingStateManager(enabled: boolean, tradingMode: string) {
        return {
          enabled,
          tradingMode,
          onModeChange: vi.fn(),
          onEnabledChange: vi.fn(),
          isLiveTrading: vi.fn(() => false)
        };
      })
    }));
    vi.doMock('../../src/core/shutdown.js', () => ({
      createShutdownHandler: vi.fn(() => shutdownHandler)
    }));
    vi.doMock('../../src/telemetry/allowlist.js', () => ({
      emitAllowlistSnapshot: vi.fn()
    }));
    vi.doMock('../../src/config/infra.js', () => ({
      getInfraConfigSnapshot: vi.fn(() => ({ infra: 'snapshot' }))
    }));
    vi.doMock('../../src/boot/config.js', () => ({
      DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH: '/tmp/dependency-relations.json',
      deriveBookRefreshSettings: vi.fn(() => ({
        maxBookStalenessMs: 5_000,
        bookRefreshIntervalMs: 1_000,
        bookRefreshStaleMs: 5_000,
        bookIdleCutoffMs: 60_000,
        catalogRefreshMs: 60_000
      })),
      loadRuntimePolicyState: vi.fn(() => ({
        policyConfig: policy,
        riskConfig: risk,
        configStore,
        activeRiskProfile
      }))
    }));
    vi.doMock('../../src/boot/fwOracle.js', () => ({
      ensureFwOracleStartupReady: vi.fn().mockResolvedValue(undefined),
      resolveFwOracleBaseUrl: vi.fn(() => 'https://oracle.example')
    }));
    vi.doMock('../../src/boot/llm.js', () => ({
      createLLMBootstrap: vi.fn(() => ({
        llmConfig: { enabled: false },
        policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' },
        llmFacade: { complete: vi.fn() },
        fwDependencyLlmExtractor: undefined,
        executionAdvisor: undefined,
        riskAdvisor: undefined
      })),
      refreshLLMPolicyHashes
    }));
    vi.doMock('../../src/boot/runtimeServices.js', () => ({
      createRuntimeServices
    }));
    vi.doMock('../../src/boot/telemetry.js', () => ({
      createBootTelemetry: vi.fn(() => ({
        store,
        metrics,
        persistMetric,
        pruneTimer: null,
        recordPaperRunMarker
      }))
    }));

    const { startRuntime } = await import('../../src/boot/runtime.js');

    await startRuntime(rawEnv);

    expect(createRuntimeServices).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        policy,
        marketPairs,
        messageBus,
        metrics
      })
    );
    expect(allowlistSeed).toHaveBeenCalledWith(['market-1']);
    expect(resolveRiskProfileEnvFlags).toHaveBeenCalledWith(rawEnv);
    expect(supervisorStart.mock.invocationCallOrder[0]).toBeLessThan(opsAgentStart.mock.invocationCallOrder[0]);
    expect(supervisorStart.mock.invocationCallOrder[0]).toBeLessThan(learningStart.mock.invocationCallOrder[0]);
    expect(supervisorStart.mock.invocationCallOrder[0]).toBeLessThan(startOpsServer.mock.invocationCallOrder[0]);
    expect(learningStart).toHaveBeenCalledTimes(1);
    expect(opsAgentSetChecks).toHaveBeenCalledTimes(1);
    expect(opsAgentStart).toHaveBeenCalledTimes(1);
    expect(startOpsServer).toHaveBeenCalledTimes(1);
    expect(supervisorStart).toHaveBeenCalledTimes(1);
    expect(recordPaperRunMarker).toHaveBeenCalledWith('start', 'boot_ready');
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('cleans up boot resources and keeps background actors stopped when supervisor start fails', async () => {
    vi.resetModules();

    const rawEnv = { NODE_ENV: 'test', OPS_API_ENABLED: 'true', RISK_PROFILE: 'high' } as NodeJS.ProcessEnv;
    const env = loadEnv({ NODE_ENV: 'test', OPS_API_ENABLED: 'true' });
    const marketPairs = [
      {
        marketId: 'market-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        question: 'Will event A happen?'
      }
    ];
    const policy = { ...DEFAULT_TRADE_POLICY };
    const risk = { ...DEFAULT_RISK_CONFIG };
    const configStore = {
      getPolicy: vi.fn(() => policy),
      getRisk: vi.fn(() => risk),
      replace: vi.fn(() => ({ policy, risk }))
    };
    const activeRiskProfile = { id: 'extra_high', source: '/tmp/extra_high.json' };
    const messageBus = { on: vi.fn() };
    const metrics = { record: vi.fn(), off: vi.fn() };
    const store = { close: vi.fn() };
    const persistMetric = vi.fn();
    const pruneTimer = {} as NodeJS.Timeout;
    const createRuntimeServices = vi.fn().mockResolvedValue({
      clob: {},
      dataApi: {},
      realtime: { close: vi.fn() },
      userRealtime: { close: vi.fn() },
      signalAggregator: undefined,
      fwOracleClient: { updateConfig: vi.fn() }
    });
    const learningStart = vi.fn();
    const learningStop = vi.fn();
    const opsAgentStart = vi.fn();
    const opsAgentStop = vi.fn();
    const supervisorStart = vi.fn().mockRejectedValue(new Error('supervisor down'));
    const startOpsServer = vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    const shutdownFactory = vi.fn();
    const resolveRiskProfileEnvFlags = vi.fn(() => ({ profileSet: false, profilePathSet: false }));

    vi.doMock('../../src/config/env.js', () => ({
      loadEnv: vi.fn(() => env),
      resolveRiskProfileEnvFlags
    }));
    vi.doMock('../../src/config/riskProfile.js', () => ({
      loadRiskProfile: vi.fn(),
      persistActiveRiskProfile: vi.fn(),
      resolveRiskProfilePathCandidates: vi.fn(() => [])
    }));
    vi.doMock('../../src/config/validate.js', () => ({
      validateP0Config: vi.fn()
    }));
    vi.doMock('../../src/domain/allowlist.js', () => ({
      MarketAllowlist: vi.fn(function MockMarketAllowlist() {
        return { seed: vi.fn() };
      })
    }));
    vi.doMock('../../src/agents/ops/OpsAgent.js', () => ({
      OpsAgent: vi.fn(function MockOpsAgent() {
        return { setChecks: vi.fn(), start: opsAgentStart, stop: opsAgentStop };
      })
    }));
    vi.doMock('../../src/agents/ops/bookFreshnessQuarantine.js', () => ({
      createBookFreshnessQuarantine: vi.fn(() => ({
        handle: vi.fn(),
        updateConfig: vi.fn()
      })),
      isOpsAlertPayload: vi.fn(() => false)
    }));
    vi.doMock('../../src/agents/ops/sloChecks.js', () => ({
      createBookFreshnessCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createCircuitBreakerCheck: vi.fn(() => ({ name: 'circuit_breaker', check: vi.fn(() => ({ ok: true })) })),
      createDelayedAckRateCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createLatencyPercentileCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) })),
      createPairedFillRateCheck: vi.fn(() => ({ check: vi.fn(() => ({ ok: true })) }))
    }));
    vi.doMock('../../src/api/server.js', () => ({
      startOpsServer
    }));
    vi.doMock('../../src/services/MarketCatalog.js', () => ({
      MarketCatalog: vi.fn(function MockMarketCatalog() {
        return { loadPairs: vi.fn(() => marketPairs) };
      })
    }));
    vi.doMock('../../src/services/MarketCatalogRefresher.js', () => ({
      MarketCatalogRefresher: vi.fn(function MockMarketCatalogRefresher() {
        return {
          seed: vi.fn(),
          on: vi.fn(),
          start: vi.fn(),
          updateConfig: vi.fn(),
          getPairs: vi.fn(() => marketPairs)
        };
      })
    }));
    vi.doMock('../../src/services/IncidentTracker.js', () => ({
      IncidentTracker: vi.fn(function MockIncidentTracker() {
        return { updateConfig: vi.fn() };
      })
    }));
    vi.doMock('../../src/agents/portfolio/PortfolioAgent.js', () => ({
      PortfolioAgent: vi.fn(function MockPortfolioAgent() {
        return { updateTokenToMarketId: vi.fn() };
      })
    }));
    vi.doMock('../../src/agents/learning/LearningAgent.js', () => ({
      LearningAgent: vi.fn(function MockLearningAgent() {
        return { start: learningStart, stop: learningStop };
      })
    }));
    vi.doMock('../../src/agents/dependency/DependencyRelationCatalog.js', () => ({
      buildDependencyRelationCatalogEntries: vi.fn(() => ({
        entries: [],
        deterministicRelations: 0,
        semanticRelations: 0,
        relationTypeCounts: {
          mutual_exclusive: 0,
          implies: 0,
          complementary: 0,
          partition: 0
        }
      })),
      loadDependencyRelationCatalog: vi.fn(() => ({
        path: '/tmp/dependency-relations.json',
        loadedAtMs: Date.now(),
        entries: [],
        malformedEntries: 0
      }))
    }));
    vi.doMock('../../src/agents/dependency/FwRelationCatalogStartupGuard.js', () => ({
      ensureFwRelationCatalogStartupReady: vi.fn()
    }));
    vi.doMock('../../src/agents/projection/FwProjectionAgent.js', () => ({
      FwProjectionAgent: vi.fn(function MockFwProjectionAgent() {
        return { updateResolverConfig: vi.fn() };
      })
    }));
    vi.doMock('../../src/core/MessageBus.js', () => ({
      createMessageBus: vi.fn(() => messageBus)
    }));
    vi.doMock('../../src/core/supervisorAssembly.js', () => ({
      buildSupervisorRuntimeConfig: vi.fn((input) => ({
        marketPairs: input.marketPairs,
        policy: input.policy,
        riskConfig: input.riskConfig,
        capital: input.capital,
        tradingEnabled: input.tradingEnabled,
        tradingMode: input.tradingMode,
        maxConcurrentMarkets: input.maxConcurrentMarkets,
        maxCapitalInFlight: input.maxCapitalInFlight,
        bookRefresh: input.bookRefresh,
        reconciliation: input.reconciliation
      })),
      buildRuntimeSupervisorAssembly: vi.fn(() => ({ mocked: true }))
    }));
    vi.doMock('../../src/core/Supervisor.js', () => ({
      Supervisor: vi.fn(function MockSupervisor() {
        return {
          start: supervisorStart,
          updateTradingMode: vi.fn(),
          updateTradingEnabled: vi.fn(),
          updatePolicyAndRisk: vi.fn(),
          updateBookRefresh: vi.fn(),
          updateMarketPairs: vi.fn(),
          getOrderBooks: vi.fn(() => []),
          getCircuitBreakerOpenMarkets: vi.fn(() => []),
          runSyntheticOpportunityTest: vi.fn(),
          debugMarketDataOutlier: vi.fn(),
          shutdown: vi.fn().mockResolvedValue(undefined)
        };
      })
    }));
    vi.doMock('../../src/core/TradingStateManager.js', () => ({
      TradingStateManager: vi.fn(function MockTradingStateManager(enabled: boolean, tradingMode: string) {
        return {
          enabled,
          tradingMode,
          onModeChange: vi.fn(),
          onEnabledChange: vi.fn(),
          isLiveTrading: vi.fn(() => false)
        };
      })
    }));
    vi.doMock('../../src/core/shutdown.js', () => ({
      createShutdownHandler: shutdownFactory
    }));
    vi.doMock('../../src/telemetry/allowlist.js', () => ({
      emitAllowlistSnapshot: vi.fn()
    }));
    vi.doMock('../../src/config/infra.js', () => ({
      getInfraConfigSnapshot: vi.fn(() => ({ infra: 'snapshot' }))
    }));
    vi.doMock('../../src/boot/config.js', () => ({
      DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH: '/tmp/dependency-relations.json',
      deriveBookRefreshSettings: vi.fn(() => ({
        maxBookStalenessMs: 5_000,
        bookRefreshIntervalMs: 1_000,
        bookRefreshStaleMs: 5_000,
        bookIdleCutoffMs: 60_000,
        catalogRefreshMs: 60_000
      })),
      loadRuntimePolicyState: vi.fn(() => ({
        policyConfig: policy,
        riskConfig: risk,
        configStore,
        activeRiskProfile
      }))
    }));
    vi.doMock('../../src/boot/fwOracle.js', () => ({
      ensureFwOracleStartupReady: vi.fn().mockResolvedValue(undefined),
      resolveFwOracleBaseUrl: vi.fn(() => 'https://oracle.example')
    }));
    vi.doMock('../../src/boot/llm.js', () => ({
      createLLMBootstrap: vi.fn(() => ({
        llmConfig: { enabled: false },
        policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' },
        llmFacade: { complete: vi.fn() },
        fwDependencyLlmExtractor: undefined,
        executionAdvisor: undefined,
        riskAdvisor: undefined
      })),
      refreshLLMPolicyHashes: vi.fn()
    }));
    vi.doMock('../../src/boot/runtimeServices.js', () => ({
      createRuntimeServices
    }));
    vi.doMock('../../src/boot/telemetry.js', () => ({
      createBootTelemetry: vi.fn(() => ({
        store,
        metrics,
        persistMetric,
        pruneTimer,
        recordPaperRunMarker: vi.fn()
      }))
    }));

    const { startRuntime } = await import('../../src/boot/runtime.js');

    await expect(startRuntime(rawEnv)).rejects.toThrow('supervisor down');

    expect(resolveRiskProfileEnvFlags).toHaveBeenCalledWith(rawEnv);
    expect(supervisorStart).toHaveBeenCalledTimes(1);
    expect(learningStart).not.toHaveBeenCalled();
    expect(opsAgentStart).not.toHaveBeenCalled();
    expect(startOpsServer).not.toHaveBeenCalled();
    expect(shutdownFactory).not.toHaveBeenCalled();
    expect(createRuntimeServices.mock.results[0]?.value).toBeDefined();
    const createdServices = await createRuntimeServices.mock.results[0]!.value;
    expect(createdServices.realtime.close).toHaveBeenCalledTimes(1);
    expect(createdServices.userRealtime.close).toHaveBeenCalledTimes(1);
    expect(metrics.off).toHaveBeenCalledWith('event', persistMetric);
    expect(store.close).toHaveBeenCalledTimes(1);
  });
});
