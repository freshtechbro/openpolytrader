import type { Env } from '../config/env.js';
import { type TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import {
  loadRiskProfile,
  persistActiveRiskProfile,
  resolveRiskProfilePathCandidates,
  type RiskProfileId
} from '../config/riskProfile.js';
import { validateP0Config } from '../config/validate.js';
import {
  buildDependencyRelationCatalogEntries,
  loadDependencyRelationCatalog
} from '../agents/dependency/DependencyRelationCatalog.js';
import type { DependencyResolverConfig } from '../agents/dependency/DependencyResolver.js';
import type { MarketPair } from '../domain/market.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { SupervisorPolicyHashes } from '../core/supervisorAssembly.js';
import { deriveBookRefreshSettings } from './config.js';
import { resolveFwOracleBaseUrl } from './fwOracle.js';

type RelationCatalogSnapshot = ReturnType<typeof loadDependencyRelationCatalog>;
type RelationCatalogBuild = ReturnType<typeof buildDependencyRelationCatalogEntries>;
type RefreshSettings = ReturnType<typeof deriveBookRefreshSettings>;

type RiskProfileSelection = {
  id: RiskProfileId;
  source: string;
};

interface ConfigStoreLike {
  getPolicy(): TradePolicy;
  getRisk(): RiskConfig;
  replace(policy: TradePolicy, risk: RiskConfig): {
    policy: TradePolicy;
    risk: RiskConfig;
  };
}

interface SupervisorLike {
  updatePolicyAndRisk(policy: TradePolicy, risk: RiskConfig): void;
  updateBookRefresh(settings: { intervalMs: number; maxStalenessMs: number }): void;
}

interface CatalogRefresherLike {
  updateConfig(config: { refreshIntervalMs: number }): void;
  getPairs(): MarketPair[];
}

interface BookStaleQuarantineLike {
  updateConfig(config: { cooldownMs: number }): void;
}

interface IncidentTrackerLike {
  updateConfig(config: { cooldownMs: number }): void;
}

interface FwOracleClientLike {
  updateConfig(config: {
    baseUrl: string;
    timeoutMs: number;
    apiKey?: string;
    circuitFailureThreshold: number;
    circuitCooldownMs: number;
  }): void;
}

interface FwProjectionAgentLike {
  updateResolverConfig(config: DependencyResolverConfig): void;
}

function toDependencyMarketInputs(pairs: readonly MarketPair[]) {
  return pairs.map((pair) => ({
    marketId: pair.marketId,
    yesTokenId: pair.yesTokenId,
    noTokenId: pair.noTokenId,
    question: pair.question,
    category: pair.category,
    tags: pair.tags
  }));
}

export function createRuntimeRelationCatalogSnapshot(input: {
  pairs: readonly MarketPair[];
  policySnapshot: TradePolicy;
  relationCatalogPath: string;
  currentSnapshotPath: string;
  nowMs?: number;
}): {
  snapshot: RelationCatalogSnapshot;
  source: 'runtime_pairs' | 'file_fallback';
  deterministicRelations: number;
  semanticRelations: number;
  relationTypeCounts: RelationCatalogBuild['relationTypeCounts'];
} {
  const nowMs = input.nowMs ?? Date.now();
  const built = buildDependencyRelationCatalogEntries(toDependencyMarketInputs(input.pairs), {
    nowMs,
    semanticEnabled: input.policySnapshot.fwRelationCatalogSemanticBatchEnabled
  });

  if (built.entries.length > 0) {
    return {
      snapshot: {
        path: input.currentSnapshotPath,
        loadedAtMs: nowMs,
        entries: built.entries,
        malformedEntries: 0
      },
      source: 'runtime_pairs',
      deterministicRelations: built.deterministicRelations,
      semanticRelations: built.semanticRelations,
      relationTypeCounts: built.relationTypeCounts
    };
  }

  const fallback = loadDependencyRelationCatalog(input.relationCatalogPath, nowMs);
  return {
    snapshot: fallback,
    source: 'file_fallback',
    deterministicRelations: 0,
    semanticRelations: 0,
    relationTypeCounts: {
      mutual_exclusive: 0,
      implies: 0,
      complementary: 0,
      partition: 0
    }
  };
}

export function recordRelationCatalogLoaded(
  metrics: MetricsStore,
  reason: 'startup' | 'catalog_refresh' | 'runtime_config',
  snapshot: RelationCatalogSnapshot,
  source: 'runtime_pairs' | 'file_fallback',
  deterministicRelations: number,
  semanticRelations: number,
  relationTypeCounts: RelationCatalogBuild['relationTypeCounts']
): void {
  metrics.record({
    type: 'fw_dependency',
    timestamp: Date.now(),
    data: {
      event: 'relation_catalog_loaded',
      reason,
      source,
      path: snapshot.path,
      entries: snapshot.entries.length,
      malformed: snapshot.malformedEntries,
      loadError: snapshot.loadError ?? 'none',
      deterministicRelations,
      semanticRelations,
      relationTypeCounts
    }
  });
}

export function createFwResolverConfig(
  policySnapshot: TradePolicy,
  relationCatalogEntries: RelationCatalogSnapshot['entries'],
  llmExtractor: DependencyResolverConfig['llmExtractor']
): DependencyResolverConfig {
  return {
    mode: policySnapshot.fwDependencyMode,
    hybridMerge: policySnapshot.fwDependencyHybridMerge,
    minConfidence: policySnapshot.fwDependencyMinConfidence,
    maxEdgesPerMarket: policySnapshot.fwDependencyMaxEdgesPerMarket,
    relationCatalogEnabled: true,
    relationCatalogEntries,
    relationCatalogMinConfidence: policySnapshot.fwRelationCatalogMinConfidence,
    relationCatalogMaxEdgesPerMarket: policySnapshot.fwRelationCatalogMaxEdgesPerMarket,
    cacheTtlMs: policySnapshot.fwDependencyCacheTtlMs,
    cacheGraceMs: policySnapshot.fwDependencyCacheGraceMs,
    cacheMaxEntries: policySnapshot.fwDependencyCacheMaxEntries,
    backoffInvalidMs: policySnapshot.fwDependencyBackoffInvalidMs,
    backoffTimeoutMs: policySnapshot.fwDependencyBackoffTimeoutMs,
    backoffErrorMs: policySnapshot.fwDependencyBackoffErrorMs,
    llmExtractor
  };
}

export function createRuntimeConfigCoordinator(input: {
  env: Env;
  metrics: MetricsStore;
  configStore: ConfigStoreLike;
  supervisor: SupervisorLike;
  bookStaleQuarantine: BookStaleQuarantineLike;
  incidentTracker: IncidentTrackerLike;
  marketPairs: MarketPair[];
  fwOracleClient: FwOracleClientLike;
  policyHashes: SupervisorPolicyHashes;
  refreshLLMPolicyHashes: (
    policyHashes: SupervisorPolicyHashes,
    policy: TradePolicy,
    risk: RiskConfig
  ) => void;
  activeRiskProfile: RiskProfileSelection;
  riskProfileActivePath?: string;
  fwProjectionAgent: FwProjectionAgentLike;
  relationCatalogPath: string;
  initialRelationCatalogSnapshot: RelationCatalogSnapshot;
  initialRefreshSettings: RefreshSettings;
  fwDependencyLlmExtractor: DependencyResolverConfig['llmExtractor'];
}) {
  let relationCatalogSnapshot = input.initialRelationCatalogSnapshot;
  let refreshSettings = input.initialRefreshSettings;
  let catalogRefresher: CatalogRefresherLike | null = null;

  const refreshDependencyRelationCatalog = (
    reason: 'catalog_refresh' | 'runtime_config',
    pairs: readonly MarketPair[]
  ): void => {
    const next = createRuntimeRelationCatalogSnapshot({
      pairs,
      policySnapshot: input.configStore.getPolicy(),
      relationCatalogPath: input.relationCatalogPath,
      currentSnapshotPath: relationCatalogSnapshot.path,
      nowMs: Date.now()
    });
    relationCatalogSnapshot = next.snapshot;
    recordRelationCatalogLoaded(
      input.metrics,
      reason,
      relationCatalogSnapshot,
      next.source,
      next.deterministicRelations,
      next.semanticRelations,
      next.relationTypeCounts
    );
    input.fwProjectionAgent.updateResolverConfig(
      createFwResolverConfig(
        input.configStore.getPolicy(),
        relationCatalogSnapshot.entries,
        input.fwDependencyLlmExtractor
      )
    );
  };

  const syncRuntimeConfig = () => {
    const policySnapshot = input.configStore.getPolicy();
    const riskSnapshot = input.configStore.getRisk();
    input.supervisor.updatePolicyAndRisk(policySnapshot, riskSnapshot);
    refreshSettings = deriveBookRefreshSettings(policySnapshot, input.env);
    input.supervisor.updateBookRefresh({
      intervalMs: refreshSettings.bookRefreshIntervalMs,
      maxStalenessMs: refreshSettings.bookRefreshStaleMs
    });
    input.bookStaleQuarantine.updateConfig({
      cooldownMs:
        input.env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS > 0
          ? input.env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS
          : riskSnapshot.marketCooldownSeconds * 1000
    });
    catalogRefresher?.updateConfig({ refreshIntervalMs: refreshSettings.catalogRefreshMs });
    input.incidentTracker.updateConfig({
      cooldownMs: riskSnapshot.marketCooldownSeconds * 1000
    });
    const currentPairs = catalogRefresher?.getPairs() ?? input.marketPairs;
    refreshDependencyRelationCatalog('runtime_config', currentPairs);
    input.fwOracleClient.updateConfig({
      baseUrl: resolveFwOracleBaseUrl(input.env.FW_ORACLE_BASE_URL),
      timeoutMs: Math.max(1, input.env.FW_ORACLE_TIMEOUT_MS),
      apiKey: input.env.FW_ORACLE_API_KEY,
      circuitFailureThreshold: Math.max(1, input.env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD),
      circuitCooldownMs: Math.max(0, input.env.FW_ORACLE_CIRCUIT_COOLDOWN_MS)
    });
    input.refreshLLMPolicyHashes(input.policyHashes, policySnapshot, riskSnapshot);
  };

  const applyRiskProfile = (profileId: RiskProfileId, overridePath?: string) => {
    const loaded = loadRiskProfile(profileId, overridePath);
    if (!loaded) {
      const candidates = resolveRiskProfilePathCandidates(profileId, overridePath);
      throw new Error(`Risk profile not found: ${profileId} (searched: ${candidates.join(', ')})`);
    }

    const currentPolicy = input.configStore.getPolicy();
    const currentRisk = input.configStore.getRisk();
    const nextPolicy = { ...currentPolicy, ...(loaded.policy ?? {}) };
    const nextRisk = { ...currentRisk, ...(loaded.risk ?? {}) };
    validateP0Config(nextPolicy, nextRisk);

    const snapshot = input.configStore.replace(nextPolicy, nextRisk);
    syncRuntimeConfig();

    input.activeRiskProfile.id = profileId;
    input.activeRiskProfile.source = loaded.source;

    let persisted = true;
    let persistedSelection: ReturnType<typeof persistActiveRiskProfile> | null = null;
    try {
      persistedSelection = persistActiveRiskProfile(
        { id: profileId, source: loaded.source },
        input.riskProfileActivePath
      );
      input.activeRiskProfile.source = persistedSelection.source ?? input.activeRiskProfile.source;
    } catch (error) {
      persisted = false;
      const message = error instanceof Error ? error.message : String(error);
      input.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'risk_profile_persist_failed', error: message, profile: profileId }
      });
    }

    input.metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: {
        message: 'risk_profile_applied',
        profile: profileId,
        source: input.activeRiskProfile.source,
        persisted
      }
    });

    return {
      profile: { id: profileId, source: input.activeRiskProfile.source },
      policy: snapshot.policy,
      risk: snapshot.risk,
      persisted
    };
  };

  return {
    getRefreshSettings: () => refreshSettings,
    getRelationCatalogSnapshot: () => relationCatalogSnapshot,
    setCatalogRefresher(value: CatalogRefresherLike | null): void {
      catalogRefresher = value;
    },
    refreshDependencyRelationCatalog,
    syncRuntimeConfig,
    applyRiskProfile
  };
}
