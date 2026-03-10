import { loadEnv, resolveRiskProfileEnvFlags } from '../config/env.js';
import { MarketAllowlist } from '../domain/allowlist.js';
import { MarketCatalog } from '../services/MarketCatalog.js';
import { loadDependencyRelationCatalog } from '../agents/dependency/DependencyRelationCatalog.js';
import { createMessageBus } from '../core/MessageBus.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import type { SupervisorDeps } from '../core/Supervisor.js';
import { buildSupervisorRuntimeConfig } from '../core/supervisorAssembly.js';
import { TradingStateManager } from '../core/TradingStateManager.js';
import { createShutdownHandler } from '../core/shutdown.js';
import { emitAllowlistSnapshot } from '../telemetry/allowlist.js';
import {
  DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH,
  deriveBookRefreshSettings,
  loadRuntimePolicyState
} from './config.js';
import { createLLMBootstrap } from './llm.js';
import {
  registerShutdownSignals,
  registerTradingStateHandlers,
  startRuntimeOpsServer
} from './runtimeLifecycle.js';
import { createRuntimeServices } from './runtimeServices.js';
import {
  createProjectionDependencies,
  createRuntimeSupportActors,
  createRuntimeSupervisor,
  startRuntimeLifecycle
} from './runtimeStartup.js';
import { createBootTelemetry } from './telemetry.js';

type RuntimeEnv = ReturnType<typeof loadEnv>;
type RuntimePolicyState = ReturnType<typeof loadRuntimePolicyState>;
type BootTelemetryState = ReturnType<typeof createBootTelemetry>;
type MarketPairs = ReturnType<MarketCatalog['loadPairs']>;
type RuntimeServices = Awaited<ReturnType<typeof createRuntimeServices>>;

function resolveRiskProfileActivePath(env: RuntimeEnv): string | undefined {
  if (typeof env.RISK_PROFILE_ACTIVE_PATH !== 'string') {
    return undefined;
  }
  const trimmed = env.RISK_PROFILE_ACTIVE_PATH.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveRuntimePolicy(
  env: RuntimeEnv,
  rawEnv?: NodeJS.ProcessEnv
): RuntimePolicyState & { riskProfileActivePath?: string } {
  const { profileSet, profilePathSet } = resolveRiskProfileEnvFlags(rawEnv);
  const riskProfileActivePath = resolveRiskProfileActivePath(env);
  return {
    ...loadRuntimePolicyState({
      env,
      envProfile: profileSet || profilePathSet ? env.RISK_PROFILE : null,
      envProfilePath: profilePathSet ? env.RISK_PROFILE_PATH : undefined,
      riskProfileActivePath
    }),
    riskProfileActivePath
  };
}

function createRuntimeRecorders(metrics: BootTelemetryState['metrics']) {
  return {
    recordRuntimeInfo(message: string, data: Record<string, unknown> = {}): void {
      metrics.record({ type: 'info', timestamp: Date.now(), data: { message, ...data } });
    },
    recordRuntimeError(message: string, error: string, data: Record<string, unknown> = {}): void {
      metrics.record({ type: 'error', timestamp: Date.now(), data: { message, error, ...data } });
    }
  };
}

function recordRuntimeStarted(input: {
  env: RuntimeEnv;
  policyConfig: RuntimePolicyState['policyConfig'];
  riskConfig: RuntimePolicyState['riskConfig'];
  activeRiskProfile: RuntimePolicyState['activeRiskProfile'];
  recordRuntimeInfo: (message: string, data?: Record<string, unknown>) => void;
}): void {
  input.recordRuntimeInfo('runtime_started', {
    env: input.env.NODE_ENV,
    tradingEnabled: input.env.TRADING_ENABLED,
    tradingMode: input.env.TRADING_MODE,
    riskProfileId: input.activeRiskProfile.id,
    riskProfileSource: input.activeRiskProfile.source,
    capital: input.env.TOTAL_CAPITAL,
    policyEdgeRequired: input.policyConfig.edgeRequired,
    depthHeadroomFraction: input.policyConfig.depthHeadroomFraction,
    maxDecisionLatencyMs: input.policyConfig.maxDecisionLatencyMs,
    targetTradeFraction: input.riskConfig.targetTradeFraction,
    maxDailyDrawdownFraction: input.riskConfig.maxDailyDrawdownFraction
  });
}

function cleanupFailedRuntimeStart(input: {
  metrics: BootTelemetryState['metrics'];
  persistMetric: BootTelemetryState['persistMetric'];
  pruneTimer: BootTelemetryState['pruneTimer'];
  store: BootTelemetryState['store'];
  realtime: Awaited<ReturnType<typeof createRuntimeServices>>['realtime'];
  userRealtime?: Awaited<ReturnType<typeof createRuntimeServices>>['userRealtime'];
}): void {
  input.realtime.close();
  input.userRealtime?.close();
  if (input.pruneTimer) {
    clearInterval(input.pruneTimer);
  }
  input.metrics.off('event', input.persistMetric);
  input.store.close();
}

function createAllowlistAndMarketPairs(input: {
  env: RuntimeEnv;
  metrics: BootTelemetryState['metrics'];
}): {
  allowlist: MarketAllowlist;
  marketPairs: MarketPairs;
  maxPairs: number;
} {
  const allowlist = new MarketAllowlist({ autoResume: input.env.ALLOWLIST_AUTO_RESUME });
  const catalog = new MarketCatalog({ filePath: input.env.MARKET_CATALOG_PATH });
  const maxPairs = Math.max(input.env.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS, 1);
  const marketPairs = catalog.loadPairs().slice(0, maxPairs);
  allowlist.seed(marketPairs.map((pair) => pair.marketId));
  input.metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: { allowlistSeeded: marketPairs.length }
  });
  emitAllowlistSnapshot(input.metrics, allowlist);
  return { allowlist, marketPairs, maxPairs };
}

function createCatalogRefreshState(env: RuntimeEnv, tradingStateManager: TradingStateManager) {
  const blockTradingUntilCatalogRefresh =
    env.TRADING_ENABLED && (env.TRADING_MODE === 'paper' || env.TRADING_MODE === 'live');
  let catalogRefreshReady = !blockTradingUntilCatalogRefresh;
  return {
    catalogRefreshBlockStartedAtMs: blockTradingUntilCatalogRefresh ? Date.now() : null,
    isReady: () => catalogRefreshReady,
    setReady(value: boolean) {
      catalogRefreshReady = value;
    },
    resolveEffectiveTradingEnabled: () => tradingStateManager.enabled && catalogRefreshReady
  };
}

function recordCatalogRefreshBlock(
  metrics: BootTelemetryState['metrics'],
  catalogRefreshState: ReturnType<typeof createCatalogRefreshState>
): void {
  if (catalogRefreshState.isReady()) {
    return;
  }
  metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: { message: 'trading_blocked_pending_catalog_refresh' }
  });
}

function createRuntimeBootstrap(rawEnv?: NodeJS.ProcessEnv) {
  const env = loadEnv(rawEnv);
  const messageBus = createMessageBus<RuntimeEventMap>();
  const { policyConfig, riskConfig, configStore, activeRiskProfile, riskProfileActivePath } =
    resolveRuntimePolicy(env, rawEnv);

  const { store, metrics, persistMetric, pruneTimer, recordPaperRunMarker } = createBootTelemetry({
    dbPath: env.EVENT_STORE_PATH,
    metricsMaxEvents: env.METRICS_MAX_EVENTS,
    metricsRetentionDays: env.EVENT_STORE_METRICS_RETENTION_DAYS,
    metricsPruneIntervalMs: env.EVENT_STORE_METRICS_PRUNE_INTERVAL_MS,
    tradingMode: env.TRADING_MODE,
    messageBus
  });
  const { recordRuntimeInfo, recordRuntimeError } = createRuntimeRecorders(metrics);
  recordRuntimeStarted({
    env,
    policyConfig,
    riskConfig,
    activeRiskProfile,
    recordRuntimeInfo
  });

  const llmBootstrap = createLLMBootstrap({
    env,
    policy: policyConfig,
    risk: riskConfig,
    metrics,
    store,
    messageBus
  });
  const { llmConfig, policyHashes, llmFacade, fwDependencyLlmExtractor, executionAdvisor, riskAdvisor } =
    llmBootstrap;
  const { allowlist, marketPairs, maxPairs } = createAllowlistAndMarketPairs({ env, metrics });
  const { opsAgent, incidentTracker, bookStaleQuarantine, portfolio, learning, updateTokenToMarketId } =
    createRuntimeSupportActors({
      env,
      riskConfig,
      messageBus,
      metrics,
      store,
      allowlist,
      marketPairs,
      llmBootstrap
    });

  const policy = configStore.getPolicy();
  const risk = configStore.getRisk();
  const refreshSettings = deriveBookRefreshSettings(policy, env);
  const relationCatalogPath = DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH;
  const initialRelationCatalogSnapshot = loadDependencyRelationCatalog(relationCatalogPath);

  return {
    env,
    messageBus,
    policyConfig,
    riskConfig,
    configStore,
    activeRiskProfile,
    riskProfileActivePath,
    store,
    metrics,
    persistMetric,
    pruneTimer,
    recordPaperRunMarker,
    recordRuntimeInfo,
    recordRuntimeError,
    llmConfig,
    policyHashes,
    llmFacade,
    fwDependencyLlmExtractor,
    executionAdvisor,
    riskAdvisor,
    allowlist,
    marketPairs,
    maxPairs,
    opsAgent,
    incidentTracker,
    bookStaleQuarantine,
    portfolio,
    learning,
    updateTokenToMarketId,
    policy,
    risk,
    refreshSettings,
    relationCatalogPath,
    initialRelationCatalogSnapshot
  };
}

function createRuntimeContext(
  bootstrap: ReturnType<typeof createRuntimeBootstrap>
): Promise<{
  services: RuntimeServices;
  supervisor: ReturnType<typeof createRuntimeSupervisor>;
  tradingStateManager: TradingStateManager;
  catalogRefreshState: ReturnType<typeof createCatalogRefreshState>;
  runtimeConfig: Awaited<ReturnType<typeof startRuntimeLifecycle>>['runtimeConfig'];
  catalogRefresher: Awaited<ReturnType<typeof startRuntimeLifecycle>>['catalogRefresher'];
}> {
  return createRuntimeServices({
    env: bootstrap.env,
    policy: bootstrap.policy,
    marketPairs: bootstrap.marketPairs,
    messageBus: bootstrap.messageBus,
    allowlist: bootstrap.allowlist,
    metrics: bootstrap.metrics
  }).then((services) =>
    createProjectionDependencies({
      env: bootstrap.env,
      policy: bootstrap.policy,
      relationCatalogPath: bootstrap.relationCatalogPath,
      initialRelationCatalogSnapshot: bootstrap.initialRelationCatalogSnapshot,
      marketPairs: bootstrap.marketPairs,
      metrics: bootstrap.metrics,
      fwDependencyLlmExtractor: bootstrap.fwDependencyLlmExtractor,
      fwOracleClient: services.fwOracleClient
    }).then(({ startupCatalog, fwProjectionAgent }) => {
      const tradingStateManager = new TradingStateManager(
        bootstrap.env.TRADING_ENABLED,
        bootstrap.env.TRADING_MODE
      );
      const catalogRefreshState = createCatalogRefreshState(bootstrap.env, tradingStateManager);
      const supervisorConfig = buildSupervisorRuntimeConfig({
        marketPairs: bootstrap.marketPairs,
        policy: bootstrap.policy,
        riskConfig: bootstrap.risk,
        capital: bootstrap.env.TOTAL_CAPITAL,
        tradingEnabled: catalogRefreshState.resolveEffectiveTradingEnabled(),
        tradingMode: bootstrap.env.TRADING_MODE,
        maxConcurrentMarkets: bootstrap.env.MAX_CONCURRENT_MARKETS,
        maxCapitalInFlight: bootstrap.env.MAX_CAPITAL_IN_FLIGHT,
        bookRefresh: {
          intervalMs: bootstrap.refreshSettings.bookRefreshIntervalMs,
          maxStalenessMs: bootstrap.refreshSettings.bookRefreshStaleMs
        },
        reconciliation: {
          intervalMs: bootstrap.env.OPS_RECONCILIATION_INTERVAL_MS,
          afterIncidentDelayMs: bootstrap.env.OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS,
          positionSizeTolerance: bootstrap.env.OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE,
          positionsUser: bootstrap.env.POLYMARKET_POSITIONS_USER,
          positionsSizeThreshold: bootstrap.env.POLYMARKET_POSITIONS_SIZE_THRESHOLD,
          positionsLimit: bootstrap.env.POLYMARKET_POSITIONS_LIMIT,
          positionsOffset: bootstrap.env.POLYMARKET_POSITIONS_OFFSET
        }
      });
      const supervisorDeps: SupervisorDeps = {
        messageBus: bootstrap.messageBus,
        clob: services.clob,
        dataApi: services.dataApi,
        realtime: services.realtime,
        userRealtime: services.userRealtime,
        allowlist: bootstrap.allowlist,
        metrics: bootstrap.metrics,
        incidentTracker: bootstrap.incidentTracker,
        portfolio: bootstrap.portfolio,
        eventStore: bootstrap.store,
        llm: bootstrap.llmConfig.enabled ? bootstrap.llmFacade : undefined,
        executionAdvisor: bootstrap.executionAdvisor,
        riskAdvisor: bootstrap.riskAdvisor,
        signalAggregator: services.signalAggregator,
        fwProjectionAgent
      };

      const supervisor = createRuntimeSupervisor(supervisorConfig, supervisorDeps);

      recordCatalogRefreshBlock(bootstrap.metrics, catalogRefreshState);

      registerTradingStateHandlers({
        tradingStateManager,
        recordRuntimeInfo: bootstrap.recordRuntimeInfo,
        supervisor,
        resolveEffectiveTradingEnabled: catalogRefreshState.resolveEffectiveTradingEnabled,
        isCatalogRefreshReady: catalogRefreshState.isReady
      });

      const { runtimeConfig, catalogRefresher } = startRuntimeLifecycle({
        env: bootstrap.env,
        metrics: bootstrap.metrics,
        configStore: bootstrap.configStore,
        supervisor,
        bookStaleQuarantine: bootstrap.bookStaleQuarantine,
        incidentTracker: bootstrap.incidentTracker,
        marketPairs: bootstrap.marketPairs,
        fwOracleClient: services.fwOracleClient,
        policyHashes: bootstrap.policyHashes,
        activeRiskProfile: bootstrap.activeRiskProfile,
        riskProfileActivePath: bootstrap.riskProfileActivePath,
        fwProjectionAgent,
        relationCatalogPath: bootstrap.relationCatalogPath,
        startupCatalogSnapshot: startupCatalog.snapshot,
        refreshSettings: bootstrap.refreshSettings,
        fwDependencyLlmExtractor: bootstrap.fwDependencyLlmExtractor,
        maxPairs: bootstrap.maxPairs,
        clob: services.clob,
        allowlist: bootstrap.allowlist,
        updateTokenToMarketId: bootstrap.updateTokenToMarketId,
        catalogRefreshState,
        opsAgent: bootstrap.opsAgent
      });

      return {
        services,
        supervisor,
        tradingStateManager,
        catalogRefreshState,
        runtimeConfig,
        catalogRefresher
      };
    })
  );
}

async function startRuntimeProcesses(
  bootstrap: ReturnType<typeof createRuntimeBootstrap>,
  context: Awaited<ReturnType<typeof createRuntimeContext>>
): Promise<void> {
  const { clob, realtime, userRealtime } = context.services;

  try {
    await context.supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootstrap.recordRuntimeError('supervisor_start_failed', message);
    cleanupFailedRuntimeStart({
      metrics: bootstrap.metrics,
      persistMetric: bootstrap.persistMetric,
      pruneTimer: bootstrap.pruneTimer,
      store: bootstrap.store,
      realtime,
      userRealtime
    });
    throw error;
  }

  context.catalogRefresher.start();
  bootstrap.recordRuntimeInfo('catalog_refresher_started');
  bootstrap.opsAgent.start();
  bootstrap.learning.start();
  const opsServer = await startRuntimeOpsServer({
    env: bootstrap.env,
    metrics: bootstrap.metrics,
    allowlist: bootstrap.allowlist,
    opsAgent: bootstrap.opsAgent,
    eventStore: bootstrap.store,
    portfolioAgent: bootstrap.portfolio,
    learningAgent: bootstrap.learning,
    configStore: bootstrap.configStore,
    tradingMode: bootstrap.env.TRADING_MODE,
    tradingEnabled: context.catalogRefreshState.resolveEffectiveTradingEnabled(),
    tradingStateManager: context.tradingStateManager,
    clobClient: clob,
    supervisor: context.supervisor,
    riskProfile: { ...bootstrap.activeRiskProfile },
    applyRiskProfile: context.runtimeConfig.applyRiskProfile,
    applyConfigUpdate: () => {
      context.runtimeConfig.syncRuntimeConfig();
    },
    recordRuntimeInfo: bootstrap.recordRuntimeInfo,
    recordRuntimeError: bootstrap.recordRuntimeError
  });
  bootstrap.recordPaperRunMarker('start', 'boot_ready');

  const shutdown = createShutdownHandler({
    learning: bootstrap.learning,
    opsAgent: bootstrap.opsAgent,
    supervisor: context.supervisor,
    clob,
    tradingStateManager: context.tradingStateManager,
    metrics: bootstrap.metrics,
    realtime,
    userRealtime,
    opsServer,
    store: bootstrap.store,
    pruneTimer: bootstrap.pruneTimer,
    persistMetric: bootstrap.persistMetric,
    shutdownTimeoutMs: bootstrap.env.OPS_SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    logger: console
  });

  registerShutdownSignals({
    shutdown,
    recordPaperRunMarker: bootstrap.recordPaperRunMarker
  });
}

export async function startRuntime(rawEnv?: NodeJS.ProcessEnv): Promise<void> {
  const bootstrap = createRuntimeBootstrap(rawEnv);
  const context = await createRuntimeContext(bootstrap);
  await startRuntimeProcesses(bootstrap, context);
}
