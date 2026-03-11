import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildDependencyRelationCatalogEntries: vi.fn(),
  loadDependencyRelationCatalog: vi.fn(),
  loadRiskProfile: vi.fn(),
  persistActiveRiskProfile: vi.fn(),
  resolveRiskProfilePathCandidates: vi.fn(() => ['/tmp/high.json']),
  validateP0Config: vi.fn(),
  deriveBookRefreshSettings: vi.fn(),
  resolveFwOracleBaseUrl: vi.fn((value?: string) => value?.trim() || 'https://oracle.default')
}));

vi.mock('../../src/agents/dependency/DependencyRelationCatalog.js', () => ({
  buildDependencyRelationCatalogEntries: mocks.buildDependencyRelationCatalogEntries,
  loadDependencyRelationCatalog: mocks.loadDependencyRelationCatalog
}));
vi.mock('../../src/config/riskProfile.js', () => ({
  loadRiskProfile: mocks.loadRiskProfile,
  persistActiveRiskProfile: mocks.persistActiveRiskProfile,
  resolveRiskProfilePathCandidates: mocks.resolveRiskProfilePathCandidates
}));
vi.mock('../../src/config/validate.js', () => ({
  validateP0Config: mocks.validateP0Config
}));
vi.mock('../../src/boot/config.js', () => ({
  deriveBookRefreshSettings: mocks.deriveBookRefreshSettings
}));
vi.mock('../../src/boot/fwOracle.js', () => ({
  resolveFwOracleBaseUrl: mocks.resolveFwOracleBaseUrl
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtimeCatalog helpers', () => {
  it('prefers runtime-built relation snapshots and falls back to file snapshots when build output is empty', async () => {
    const {
      createRuntimeRelationCatalogSnapshot,
      createFwResolverConfig,
      recordRelationCatalogLoaded
    } = await import('../../src/boot/runtimeCatalog.js');

    mocks.buildDependencyRelationCatalogEntries.mockReturnValueOnce({
      entries: [{ sourceMarketId: 'market-1', targetMarketId: 'market-2', relationType: 'implies', confidence: 0.9 }],
      deterministicRelations: 1,
      semanticRelations: 0,
      relationTypeCounts: { mutual_exclusive: 0, implies: 1, complementary: 0, partition: 0 }
    });

    const runtimeSnapshot = createRuntimeRelationCatalogSnapshot({
      pairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1', question: 'Question 1' }],
      policySnapshot: { fwRelationCatalogSemanticBatchEnabled: true },
      relationCatalogPath: '/tmp/catalog.json',
      currentSnapshotPath: '/tmp/current.json',
      nowMs: 1_700_000_000_000
    });

    expect(runtimeSnapshot.source).toBe('runtime_pairs');
    expect(runtimeSnapshot.snapshot.entries).toHaveLength(1);

    const metrics = { record: vi.fn() };
    recordRelationCatalogLoaded(
      metrics as never,
      'startup',
      runtimeSnapshot.snapshot,
      runtimeSnapshot.source,
      runtimeSnapshot.deterministicRelations,
      runtimeSnapshot.semanticRelations,
      runtimeSnapshot.relationTypeCounts
    );
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({
          event: 'relation_catalog_loaded',
          source: 'runtime_pairs',
          entries: 1
        })
      })
    );

    mocks.buildDependencyRelationCatalogEntries.mockReturnValueOnce({
      entries: [],
      deterministicRelations: 0,
      semanticRelations: 0,
      relationTypeCounts: { mutual_exclusive: 0, implies: 0, complementary: 0, partition: 0 }
    });
    mocks.loadDependencyRelationCatalog.mockReturnValueOnce({
      path: '/tmp/catalog.json',
      loadedAtMs: 1_700_000_000_500,
      entries: [{ sourceMarketId: 'fallback', targetMarketId: 'other', relationType: 'partition', confidence: 0.6 }],
      malformedEntries: 0
    });

    const fallbackSnapshot = createRuntimeRelationCatalogSnapshot({
      pairs: [],
      policySnapshot: { fwRelationCatalogSemanticBatchEnabled: false },
      relationCatalogPath: '/tmp/catalog.json',
      currentSnapshotPath: '/tmp/current.json',
      nowMs: 1_700_000_000_500
    });

    expect(fallbackSnapshot.source).toBe('file_fallback');
    expect(fallbackSnapshot.snapshot.entries).toHaveLength(1);

    expect(
      createFwResolverConfig(
        {
          fwDependencyMode: 'hybrid',
          fwDependencyHybridMerge: 'union',
          fwDependencyMinConfidence: 0.7,
          fwDependencyMaxEdgesPerMarket: 8,
          fwRelationCatalogMinConfidence: 0.55,
          fwRelationCatalogMaxEdgesPerMarket: 5,
          fwDependencyCacheTtlMs: 60_000,
          fwDependencyCacheGraceMs: 5_000,
          fwDependencyCacheMaxEntries: 250,
          fwDependencyBackoffInvalidMs: 1000,
          fwDependencyBackoffTimeoutMs: 2000,
          fwDependencyBackoffErrorMs: 3000
        } as never,
        fallbackSnapshot.snapshot.entries,
        { kind: 'extractor' } as never
      )
    ).toEqual(
      expect.objectContaining({
        mode: 'hybrid',
        relationCatalogEntries: fallbackSnapshot.snapshot.entries,
        relationCatalogEnabled: true,
        llmExtractor: { kind: 'extractor' }
      })
    );
  });

  it('syncs runtime config and applies risk profiles through the coordinator', async () => {
    const { createRuntimeConfigCoordinator } = await import('../../src/boot/runtimeCatalog.js');

    mocks.buildDependencyRelationCatalogEntries.mockReturnValue({
      entries: [{ sourceMarketId: 'market-1', targetMarketId: 'market-2', relationType: 'implies', confidence: 0.9 }],
      deterministicRelations: 1,
      semanticRelations: 0,
      relationTypeCounts: { mutual_exclusive: 0, implies: 1, complementary: 0, partition: 0 }
    });
    mocks.deriveBookRefreshSettings.mockReturnValue({
      bookRefreshIntervalMs: 1500,
      bookRefreshStaleMs: 6000,
      catalogRefreshMs: 30_000
    });
    mocks.loadRiskProfile.mockReturnValue({
      source: 'persisted',
      policy: { marketCatalogRefreshMs: 45_000, fwRequireConverged: false },
      risk: { marketCooldownSeconds: 90 }
    });
    mocks.persistActiveRiskProfile.mockReturnValue({ source: 'persisted' });

    const currentPolicy = {
      fwRelationCatalogSemanticBatchEnabled: true,
      fwDependencyMode: 'hybrid',
      fwDependencyHybridMerge: 'union',
      fwDependencyMinConfidence: 0.7,
      fwDependencyMaxEdgesPerMarket: 8,
      fwRelationCatalogMinConfidence: 0.55,
      fwRelationCatalogMaxEdgesPerMarket: 5,
      fwDependencyCacheTtlMs: 60_000,
      fwDependencyCacheGraceMs: 5_000,
      fwDependencyCacheMaxEntries: 250,
      fwDependencyBackoffInvalidMs: 1000,
      fwDependencyBackoffTimeoutMs: 2000,
      fwDependencyBackoffErrorMs: 3000,
      fwRequireConverged: true
    };
    const currentRisk = { marketCooldownSeconds: 60 };
    const configStore = {
      getPolicy: vi.fn(() => currentPolicy),
      getRisk: vi.fn(() => currentRisk),
      replace: vi.fn((policy, risk) => ({ policy, risk }))
    };
    const supervisor = {
      updatePolicyAndRisk: vi.fn(),
      updateBookRefresh: vi.fn()
    };
    const catalogRefresher = {
      updateConfig: vi.fn(),
      getPairs: vi.fn(() => [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1', question: 'Question 1' }])
    };
    const metrics = { record: vi.fn() };
    const coordinator = createRuntimeConfigCoordinator({
      env: {
        OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS: 0,
        FW_ORACLE_BASE_URL: '',
        FW_ORACLE_TIMEOUT_MS: 2000,
        FW_ORACLE_API_KEY: 'oracle-key',
        FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD: 3,
        FW_ORACLE_CIRCUIT_COOLDOWN_MS: 4000
      } as never,
      metrics: metrics as never,
      configStore,
      supervisor,
      bookStaleQuarantine: { updateConfig: vi.fn() },
      incidentTracker: { updateConfig: vi.fn() },
      marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1', question: 'Question 1' }],
      fwOracleClient: { updateConfig: vi.fn() },
      policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' },
      refreshLLMPolicyHashes: vi.fn(),
      activeRiskProfile: { id: 'near_zero', source: 'defaults' },
      riskProfileActivePath: '/tmp/active-risk.json',
      fwProjectionAgent: { updateResolverConfig: vi.fn() },
      relationCatalogPath: '/tmp/catalog.json',
      initialRelationCatalogSnapshot: {
        path: '/tmp/catalog.json',
        loadedAtMs: 1_700_000_000_000,
        entries: [],
        malformedEntries: 0
      },
      initialRefreshSettings: {
        bookRefreshIntervalMs: 1000,
        bookRefreshStaleMs: 5000,
        catalogRefreshMs: 20_000
      },
      fwDependencyLlmExtractor: { kind: 'extractor' } as never
    });

    coordinator.setCatalogRefresher(catalogRefresher);
    coordinator.syncRuntimeConfig();

    expect(supervisor.updatePolicyAndRisk).toHaveBeenCalledWith(currentPolicy, currentRisk);
    expect(supervisor.updateBookRefresh).toHaveBeenCalledWith({
      intervalMs: 1500,
      maxStalenessMs: 6000
    });
    expect(catalogRefresher.updateConfig).toHaveBeenCalledWith({ refreshIntervalMs: 30_000 });

    const applied = coordinator.applyRiskProfile('high', '/tmp/high.json');
    expect(applied).toEqual(
      expect.objectContaining({
        profile: { id: 'high', source: 'persisted' },
        policy: expect.objectContaining({ fwRequireConverged: false }),
        persisted: true
      })
    );
    expect(mocks.validateP0Config).toHaveBeenCalledOnce();
    expect(configStore.replace).toHaveBeenCalledWith(
      expect.objectContaining({ fwRequireConverged: false }),
      expect.objectContaining({ marketCooldownSeconds: 90 })
    );
    expect(mocks.persistActiveRiskProfile).toHaveBeenCalledWith(
      { id: 'high', source: 'persisted' },
      '/tmp/active-risk.json'
    );
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        data: expect.objectContaining({
          message: 'risk_profile_applied',
          profile: 'high'
        })
      })
    );
  });
});
