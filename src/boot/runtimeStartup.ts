import { loadEnv } from '../config/env.js';
import { MarketAllowlist } from '../domain/allowlist.js';
import { OpsAgent } from '../agents/ops/OpsAgent.js';
import { createBookFreshnessQuarantine, isOpsAlertPayload } from '../agents/ops/bookFreshnessQuarantine.js';
import { MarketCatalog } from '../services/MarketCatalog.js';
import { MarketCatalogRefresher } from '../services/MarketCatalogRefresher.js';
import { IncidentTracker } from '../services/IncidentTracker.js';
import { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import { LearningAgent } from '../agents/learning/LearningAgent.js';
import { ensureFwRelationCatalogStartupReady } from '../agents/dependency/FwRelationCatalogStartupGuard.js';
import { FwProjectionAgent } from '../agents/projection/FwProjectionAgent.js';
import type { MessageBus } from '../core/MessageBus.js';
import { Supervisor, type SupervisorConfig, type SupervisorDeps } from '../core/Supervisor.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import { buildRuntimeSupervisorAssembly } from '../core/supervisorAssembly.js';
import {
  deriveBookRefreshSettings,
  loadRuntimePolicyState
} from './config.js';
import { ensureFwOracleStartupReady } from './fwOracle.js';
import { createLLMBootstrap, refreshLLMPolicyHashes } from './llm.js';
import {
  createFwResolverConfig,
  createRuntimeConfigCoordinator,
  createRuntimeRelationCatalogSnapshot,
  recordRelationCatalogLoaded
} from './runtimeCatalog.js';
import {
  configureOpsChecks,
  registerCatalogRefresherHandlers
} from './runtimeLifecycle.js';
import { createRuntimeServices } from './runtimeServices.js';
import { createBootTelemetry } from './telemetry.js';

type RuntimeEnv = ReturnType<typeof loadEnv>;
type RuntimePolicyState = ReturnType<typeof loadRuntimePolicyState>;
type BootTelemetryState = ReturnType<typeof createBootTelemetry>;
type RuntimeLlmBootstrap = ReturnType<typeof createLLMBootstrap>;
type MarketPairs = ReturnType<MarketCatalog['loadPairs']>;

function snapshotTokenToMarketId(tokenToMarketId: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(tokenToMarketId);
}

function createCatalogRefresher(input: {
  env: RuntimeEnv;
  refreshSettings: ReturnType<typeof deriveBookRefreshSettings>;
  maxPairs: number;
  clob: Awaited<ReturnType<typeof createRuntimeServices>>['clob'];
  metrics: BootTelemetryState['metrics'];
}): MarketCatalogRefresher {
  return new MarketCatalogRefresher(
    {
      refreshIntervalMs: input.refreshSettings.catalogRefreshMs,
      maxPairs: input.maxPairs,
      minVolume24h: input.env.MARKET_CATALOG_MIN_VOLUME_24H,
      maxSpread: input.env.MARKET_CATALOG_MAX_SPREAD,
      pageSize: input.env.MARKET_CATALOG_PAGE_SIZE,
      maxPages: input.env.MARKET_CATALOG_MAX_PAGES,
      order: input.env.MARKET_CATALOG_ORDER,
      excludeEndedMarkets: input.env.MARKET_CATALOG_EXCLUDE_ENDED_MARKETS,
      explorationEnabled: input.env.MARKET_CATALOG_EXPLORATION_ENABLED,
      explorationMaxPairs: input.env.MARKET_CATALOG_EXPLORATION_MAX_PAIRS,
      explorationMinVolume24h: input.env.MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H,
      explorationMaxPages: input.env.MARKET_CATALOG_EXPLORATION_MAX_PAGES,
      ...(input.env.GAMMA_API_BASE_URL ? { gammaApiBaseUrl: input.env.GAMMA_API_BASE_URL } : {})
    },
    input.clob,
    input.metrics
  );
}

function createRuntimeSupportActors(input: {
  env: RuntimeEnv;
  riskConfig: RuntimePolicyState['riskConfig'];
  messageBus: MessageBus<RuntimeEventMap>;
  metrics: BootTelemetryState['metrics'];
  store: BootTelemetryState['store'];
  allowlist: MarketAllowlist;
  marketPairs: MarketPairs;
  llmBootstrap: RuntimeLlmBootstrap;
}) {
  const opsAgent = new OpsAgent(
    {
      intervalMs: input.env.OPS_HEALTH_INTERVAL_MS,
      checks: [],
      messageBus: input.messageBus,
      alertWebhookUrl: input.env.OPS_ALERT_WEBHOOK_URL,
      eventStore: input.store,
      llm: input.llmBootstrap.llmConfig.enabled
        ? { ...input.llmBootstrap.llmFacade, eventStore: input.store }
        : undefined
    },
    input.metrics
  );
  const incidentTracker = new IncidentTracker(input.allowlist, input.metrics, {
    cooldownMs: input.riskConfig.marketCooldownSeconds * 1000,
    maxIncidents: input.env.INCIDENTS_MAX_EVENTS
  });
  const tokenToMarketId = new Map<string, string>();
  const replaceTokenToMarketId = (pairs: readonly MarketPairs[number][]) => {
    tokenToMarketId.clear();
    for (const pair of pairs) {
      tokenToMarketId.set(pair.yesTokenId, pair.marketId);
      tokenToMarketId.set(pair.noTokenId, pair.marketId);
    }
  };
  replaceTokenToMarketId(input.marketPairs);

  const bookStaleQuarantine = createBookFreshnessQuarantine({
    allowlist: input.allowlist,
    incidentTracker,
    getMarketIdForToken: (tokenId) => tokenToMarketId.get(tokenId),
    config: {
      threshold: input.env.OPS_BOOK_STALE_QUARANTINE_THRESHOLD,
      windowMs: input.env.OPS_BOOK_STALE_QUARANTINE_WINDOW_MS,
      cooldownMs:
        input.env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS > 0
          ? input.env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS
          : input.riskConfig.marketCooldownSeconds * 1000
    }
  });
  input.messageBus.on('ops:alert', (payload) => {
    if (isOpsAlertPayload(payload)) {
      bookStaleQuarantine.handle(payload);
    }
  });

  const portfolio = new PortfolioAgent(input.env.TOTAL_CAPITAL, incidentTracker, {
    tokenToMarketId: snapshotTokenToMarketId(tokenToMarketId),
    metrics: input.metrics,
    messageBus: input.messageBus,
    eventStore: input.store,
    llm: input.llmBootstrap.llmConfig.enabled ? input.llmBootstrap.llmFacade : undefined
  });
  const updateTokenToMarketId = (pairs: readonly MarketPairs[number][]) => {
    replaceTokenToMarketId(pairs);
    portfolio.updateTokenToMarketId(snapshotTokenToMarketId(tokenToMarketId));
  };
  const learning = new LearningAgent(
    {
      enabled: input.env.NODE_ENV !== 'test',
      messageBus: input.messageBus,
      llm: input.llmBootstrap.llmConfig.enabled
        ? {
            ...input.llmBootstrap.llmFacade,
            windowMs: 300000,
            minEventsPerRun: 10
          }
        : undefined
    },
    input.store
  );

  return {
    opsAgent,
    incidentTracker,
    bookStaleQuarantine,
    portfolio,
    learning,
    updateTokenToMarketId
  };
}

function createProjectionDependencies(input: {
  env: RuntimeEnv;
  policy: RuntimePolicyState['policyConfig'];
  relationCatalogPath: string;
  initialRelationCatalogSnapshot: { path: string; entries: unknown[] };
  marketPairs: MarketPairs;
  metrics: BootTelemetryState['metrics'];
  fwDependencyLlmExtractor: RuntimeLlmBootstrap['fwDependencyLlmExtractor'];
  fwOracleClient: Awaited<ReturnType<typeof createRuntimeServices>>['fwOracleClient'];
}) {
  const startupCatalog = createRuntimeRelationCatalogSnapshot({
    pairs: input.marketPairs,
    policySnapshot: input.policy,
    relationCatalogPath: input.relationCatalogPath,
    currentSnapshotPath: input.initialRelationCatalogSnapshot.path,
    nowMs: Date.now()
  });
  recordRelationCatalogLoaded(
    input.metrics,
    'startup',
    startupCatalog.snapshot,
    startupCatalog.source,
    startupCatalog.deterministicRelations,
    startupCatalog.semanticRelations,
    startupCatalog.relationTypeCounts
  );

  ensureFwRelationCatalogStartupReady({
    tradingEnabled: input.env.TRADING_ENABLED,
    tradingMode: input.env.TRADING_MODE,
    policy: input.policy,
    relationCatalogPath: startupCatalog.snapshot.path,
    relationCatalogEntries: startupCatalog.snapshot.entries.length,
    metrics: input.metrics
  });

  return ensureFwOracleStartupReady({
    tradingEnabled: input.env.TRADING_ENABLED,
    tradingMode: input.env.TRADING_MODE,
    baseUrl: input.env.FW_ORACLE_BASE_URL,
    apiKey: input.env.FW_ORACLE_API_KEY,
    timeoutMs: Math.max(500, input.env.FW_ORACLE_TIMEOUT_MS),
    attempts: 10,
    retryDelayMs: 300,
    metrics: input.metrics
  }).then(() => ({
    startupCatalog,
    fwProjectionAgent: new FwProjectionAgent({
      resolverConfig: createFwResolverConfig(
        input.policy,
        startupCatalog.snapshot.entries,
        input.fwDependencyLlmExtractor
      ),
      oracleClient: input.fwOracleClient,
      metrics: input.metrics
    })
  }));
}

function createRuntimeSupervisor(config: SupervisorConfig, deps: SupervisorDeps): Supervisor {
  return new Supervisor(config, deps, buildRuntimeSupervisorAssembly(config, deps));
}

function startRuntimeLifecycle(input: {
  env: RuntimeEnv;
  metrics: BootTelemetryState['metrics'];
  configStore: RuntimePolicyState['configStore'];
  supervisor: Supervisor;
  bookStaleQuarantine: ReturnType<typeof createBookFreshnessQuarantine>;
  incidentTracker: InstanceType<typeof IncidentTracker>;
  marketPairs: MarketPairs;
  fwOracleClient: Awaited<ReturnType<typeof createRuntimeServices>>['fwOracleClient'];
  policyHashes: RuntimeLlmBootstrap['policyHashes'];
  activeRiskProfile: RuntimePolicyState['activeRiskProfile'];
  riskProfileActivePath?: string;
  fwProjectionAgent: InstanceType<typeof FwProjectionAgent>;
  relationCatalogPath: string;
  startupCatalogSnapshot: ReturnType<typeof createRuntimeRelationCatalogSnapshot>['snapshot'];
  refreshSettings: ReturnType<typeof deriveBookRefreshSettings>;
  fwDependencyLlmExtractor: RuntimeLlmBootstrap['fwDependencyLlmExtractor'];
  maxPairs: number;
  clob: Awaited<ReturnType<typeof createRuntimeServices>>['clob'];
  allowlist: MarketAllowlist;
  updateTokenToMarketId: (pairs: readonly MarketPairs[number][]) => void;
  catalogRefreshState: {
    resolveEffectiveTradingEnabled: () => boolean;
    isReady: () => boolean;
    setReady: (value: boolean) => void;
    catalogRefreshBlockStartedAtMs: number | null;
  };
  opsAgent: InstanceType<typeof OpsAgent>;
}) {
  const runtimeConfig = createRuntimeConfigCoordinator({
    env: input.env,
    metrics: input.metrics,
    configStore: input.configStore,
    supervisor: input.supervisor,
    bookStaleQuarantine: input.bookStaleQuarantine,
    incidentTracker: input.incidentTracker,
    marketPairs: input.marketPairs,
    fwOracleClient: input.fwOracleClient,
    policyHashes: input.policyHashes,
    refreshLLMPolicyHashes,
    activeRiskProfile: input.activeRiskProfile,
    riskProfileActivePath: input.riskProfileActivePath,
    fwProjectionAgent: input.fwProjectionAgent,
    relationCatalogPath: input.relationCatalogPath,
    initialRelationCatalogSnapshot: input.startupCatalogSnapshot,
    initialRefreshSettings: input.refreshSettings,
    fwDependencyLlmExtractor: input.fwDependencyLlmExtractor
  });

  const catalogRefresher = createCatalogRefresher({
    env: input.env,
    refreshSettings: input.refreshSettings,
    maxPairs: input.maxPairs,
    clob: input.clob,
    metrics: input.metrics
  });
  catalogRefresher.seed(input.marketPairs);
  runtimeConfig.setCatalogRefresher(catalogRefresher);
  registerCatalogRefresherHandlers({
    catalogRefresher,
    supervisor: input.supervisor,
    allowlist: input.allowlist,
    updateTokenToMarketId: input.updateTokenToMarketId,
    refreshDependencyRelationCatalog: runtimeConfig.refreshDependencyRelationCatalog,
    metrics: input.metrics,
    resolveEffectiveTradingEnabled: input.catalogRefreshState.resolveEffectiveTradingEnabled,
    isCatalogRefreshReady: input.catalogRefreshState.isReady,
    setCatalogRefreshReady: input.catalogRefreshState.setReady,
    catalogRefreshBlockStartedAtMs: input.catalogRefreshState.catalogRefreshBlockStartedAtMs
  });

  configureOpsChecks({
    opsAgent: input.opsAgent,
    configStore: input.configStore,
    env: input.env,
    metrics: input.metrics,
    supervisor: input.supervisor,
    marketPairs: input.marketPairs
  });

  return { runtimeConfig, catalogRefresher };
}

export {
  createProjectionDependencies,
  createRuntimeSupportActors,
  createRuntimeSupervisor,
  startRuntimeLifecycle
};
