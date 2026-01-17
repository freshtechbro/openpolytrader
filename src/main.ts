import 'dotenv/config';

import type { FastifyInstance } from 'fastify';

import { loadEnv, resolveRiskProfileEnvFlags } from './config/env.js';
import { loadLLMConfig } from './config/llm.js';
import { DEFAULT_RISK_CONFIG } from './config/risk.js';
import { DEFAULT_TRADE_POLICY, type TradePolicy } from './config/policy.js';
import {
  loadActiveRiskProfile,
  loadRiskProfile,
  persistActiveRiskProfile,
  resolveRiskProfilePathCandidates,
  type RiskProfileId
} from './config/riskProfile.js';
import { ConfigStore } from './config/store.js';
import { validateP0Config } from './config/validate.js';
import { MarketAllowlist } from './domain/allowlist.js';
import { OpsAgent } from './agents/ops/OpsAgent.js';
import { ExecutionAdvisor } from './agents/execution/ExecutionAdvisor.js';
import {
  createBookFreshnessCheck,
  createCircuitBreakerCheck,
  createDelayedAckRateCheck,
  createLatencyPercentileCheck,
  createPairedFillRateCheck
} from './agents/ops/sloChecks.js';
import { type MetricEvent, MetricsStore } from './telemetry/metrics.js';
import { attachLLMDecisionStream } from './telemetry/llmDecisionStream.js';
import { startOpsServer } from './api/server.js';
import { MarketCatalog } from './services/MarketCatalog.js';
import { MarketCatalogRefresher } from './services/MarketCatalogRefresher.js';
import { PolymarketClob } from './services/PolymarketClob.js';
import { PolymarketDataApi } from './services/PolymarketDataApi.js';
import { PolymarketRealtime } from './services/PolymarketRealtime.js';
import { createPolymarketHmacAuthProvider } from './services/PolymarketAuth.js';
import { IncidentTracker } from './services/IncidentTracker.js';
import { PortfolioAgent } from './agents/portfolio/PortfolioAgent.js';
import { LearningAgent } from './agents/learning/LearningAgent.js';
import { EventStore } from './core/EventStore.js';
import { Supervisor } from './core/Supervisor.js';
import { TradingStateManager } from './core/TradingStateManager.js';
import { createShutdownHandler } from './core/shutdown.js';
import { emitAllowlistSnapshot } from './telemetry/allowlist.js';
import { getInfraConfigSnapshot } from './config/infra.js';
import { LLMClient } from './services/llm/LLMClient.js';
import type { LLMAgentId, LLMRequest } from './services/llm/types.js';
import { RiskAdvisor } from './agents/risk/RiskAdvisor.js';
import { sha256 as sha256Hex } from './utils/crypto.js';

const env = loadEnv();

const { profileSet, profilePathSet } = resolveRiskProfileEnvFlags();
const envProfile = profileSet || profilePathSet ? env.RISK_PROFILE : null;
const envProfilePath = profilePathSet ? env.RISK_PROFILE_PATH : undefined;
const riskProfileActivePath =
  typeof env.RISK_PROFILE_ACTIVE_PATH === 'string' && env.RISK_PROFILE_ACTIVE_PATH.trim().length > 0
    ? env.RISK_PROFILE_ACTIVE_PATH.trim()
    : undefined;

let persistedProfile: ReturnType<typeof loadActiveRiskProfile> = null;
try {
  persistedProfile = loadActiveRiskProfile(riskProfileActivePath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[boot] failed to load active risk profile: ${message}`);
}

// Env overrides (profile or path) win; otherwise fall back to persisted selection.
let profileId: RiskProfileId = envProfile ?? persistedProfile?.id ?? 'near_zero';
let profilePath = envProfile ? envProfilePath : persistedProfile?.source;
let loadedProfile: ReturnType<typeof loadRiskProfile> = null;

try {
  loadedProfile = loadRiskProfile(profileId, profilePath);
} catch (error) {
  if (envProfile || envProfilePath) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[boot] failed to load risk profile; falling back to defaults: ${message}`);
  loadedProfile = loadRiskProfile(profileId);
  if (loadedProfile) {
    profilePath = undefined;
  }
}

if (!loadedProfile) {
  if (profileId !== 'near_zero') {
    console.warn(`[boot] risk profile missing for ${profileId}; falling back to near_zero`);
  }
  profileId = 'near_zero';
  profilePath = undefined;
  loadedProfile = loadRiskProfile(profileId);
}

const policyConfig = { ...DEFAULT_TRADE_POLICY, ...(loadedProfile?.policy ?? {}) };
const riskConfig = { ...DEFAULT_RISK_CONFIG, ...(loadedProfile?.risk ?? {}) };
validateP0Config(policyConfig, riskConfig);
const configStore = new ConfigStore(policyConfig, riskConfig);
const activeRiskProfile = {
  id: profileId,
  source: loadedProfile?.source ?? profilePath ?? 'defaults'
};

const deriveBookRefreshSettings = (policy: TradePolicy) => {
  const maxBookStalenessMs = Math.max(policy.maxBookStalenessMs, 0);
  return {
    maxBookStalenessMs,
    bookRefreshIntervalMs: Math.max(maxBookStalenessMs, 10000),
    bookIdleCutoffMs: Math.max(maxBookStalenessMs * 6, 60000),
    catalogRefreshMs: Math.min(Math.max(maxBookStalenessMs * 6, 60000), 300000)
  };
};

console.log('[boot] openpolytrader starting');
console.log(
  `[boot] env=${env.NODE_ENV} trading=${env.TRADING_ENABLED} mode=${env.TRADING_MODE}`
);
console.log(`[boot] risk profile=${activeRiskProfile.id} source=${activeRiskProfile.source}`);
console.log(`[boot] capital=${env.TOTAL_CAPITAL}`);
console.log(
  `[boot] policy edge>=${policyConfig.edgeRequired.toFixed(3)} depthHeadroom=${policyConfig.depthHeadroomFraction} decisionLatencyMs=${policyConfig.maxDecisionLatencyMs}`
);
console.log(
  `[boot] risk targetTradeFraction=${riskConfig.targetTradeFraction} maxDailyDrawdown=${riskConfig.maxDailyDrawdownFraction}`
);

const store = new EventStore({ dbPath: env.EVENT_STORE_PATH });
const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);
const persistMetric = (event: MetricEvent) => store.persistMetric(event);
metrics.on('event', persistMetric);
attachLLMDecisionStream(metrics);

const llmConfig = loadLLMConfig(env);
const llmPromptVersion = 'llm-v1';
const policyHashes = {
  tradePolicyHash: sha256(stableStringify(policyConfig)),
  riskConfigHash: sha256(stableStringify(riskConfig))
};
const llmClient = new LLMClient(llmConfig, { metrics });
const llmFacade = {
  config: llmConfig,
  client: { call: (agent: LLMAgentId, request: LLMRequest, nowMs?: number) => llmClient.call(agent, request, nowMs) },
  promptVersion: llmPromptVersion,
  policyHashes
};
const executionAdvisor =
  llmConfig.enabled && llmConfig.agents.ExecutionAgent.mode !== 'disabled'
    ? new ExecutionAdvisor({ enabled: true })
    : undefined;
const riskAdvisor =
  llmConfig.enabled && llmConfig.agents.RiskAgent.mode !== 'disabled'
    ? new RiskAdvisor({
        llmConfig,
        llmClient: { call: (agent, request) => llmClient.call(agent, request) },
        promptVersion: llmPromptVersion,
        policyHashes,
        eventStore: store,
        metrics
      })
    : undefined;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const metricsRetentionDays = env.EVENT_STORE_METRICS_RETENTION_DAYS;
const metricsPruneIntervalMs = env.EVENT_STORE_METRICS_PRUNE_INTERVAL_MS;

const pruneMetrics = () => {
  const now = Date.now();
  const cutoff = now - metricsRetentionDays * MS_PER_DAY;
  const pruned = store.pruneMetrics(cutoff);
  if (pruned > 0) {
    metrics.record({
      type: 'info',
      timestamp: now,
      data: { message: 'metrics_pruned', pruned, retentionDays: metricsRetentionDays }
    });
  }
};

pruneMetrics();
const pruneTimer = metricsPruneIntervalMs > 0 ? setInterval(pruneMetrics, metricsPruneIntervalMs) : null;
const allowlist = new MarketAllowlist({ autoResume: env.ALLOWLIST_AUTO_RESUME });
const catalog = new MarketCatalog({ filePath: env.MARKET_CATALOG_PATH });
const maxPairs = Math.max(env.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS, 1);
const marketPairs = catalog.loadPairs().slice(0, maxPairs);
allowlist.seed(marketPairs.map((pair) => pair.marketId));
metrics.record({
  type: 'info',
  timestamp: Date.now(),
  data: { allowlistSeeded: marketPairs.length }
});
emitAllowlistSnapshot(metrics, allowlist);
const opsAgent = new OpsAgent(
  {
    intervalMs: env.OPS_HEALTH_INTERVAL_MS,
    checks: [],
    alertWebhookUrl: env.OPS_ALERT_WEBHOOK_URL,
    eventStore: store,
    llm: llmConfig.enabled
      ? {
          config: llmConfig,
          client: { call: (agent, request) => llmClient.call(agent, request) },
          promptVersion: llmPromptVersion,
          policyHashes,
          eventStore: store
        }
      : undefined
  },
  metrics
);

let opsServer: FastifyInstance | null = null;

const incidentTracker = new IncidentTracker(allowlist, metrics, {
  cooldownMs: riskConfig.marketCooldownSeconds * 1000,
  maxIncidents: env.INCIDENTS_MAX_EVENTS
});
const tokenToMarketId = marketPairs.reduce<Record<string, string>>((acc, pair) => {
  acc[pair.yesTokenId] = pair.marketId;
  acc[pair.noTokenId] = pair.marketId;
  return acc;
}, {});
const portfolio = new PortfolioAgent(env.TOTAL_CAPITAL, incidentTracker, {
  tokenToMarketId,
  metrics,
  eventStore: store,
  llm: llmConfig.enabled
    ? {
        config: llmConfig,
        client: { call: (agent, request) => llmClient.call(agent, request) },
        promptVersion: llmPromptVersion,
        policyHashes
      }
    : undefined
});

const learning = new LearningAgent(
  {
    enabled: env.NODE_ENV !== 'test',
    llm: llmConfig.enabled
      ? {
          config: llmConfig,
          client: { call: (agent, request) => llmClient.call(agent, request) },
          promptVersion: llmPromptVersion,
          windowMs: 300000,
          minEventsPerRun: 10,
          policyHashes
        }
      : undefined
  },
  store
);
learning.start();
const clobAuthProvider =
  env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_PASSPHRASE && env.POLYMARKET_POSITIONS_USER
    ? createPolymarketHmacAuthProvider({
        apiKey: env.POLYMARKET_API_KEY,
        secret: env.POLYMARKET_API_SECRET,
        passphrase: env.POLYMARKET_PASSPHRASE,
        address: env.POLYMARKET_POSITIONS_USER
      })
    : undefined;

const clob = new PolymarketClob({
  baseUrl: env.POLYMARKET_CLOB_BASE_URL,
  requestTimeoutMs: env.POLYMARKET_CLOB_TIMEOUT_MS,
  rateLimitPerSecond: env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
  rateLimitWindowMs: env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
  authProvider: clobAuthProvider,
  orderPath: env.POLYMARKET_CLOB_ORDER_PATH,
  batchOrderPath: env.POLYMARKET_CLOB_BATCH_ORDER_PATH,
  cancelOrderPath: env.POLYMARKET_CLOB_CANCEL_ORDER_PATH,
  cancelOrdersPath: env.POLYMARKET_CLOB_CANCEL_ORDERS_PATH,
  cancelAllPath: env.POLYMARKET_CLOB_CANCEL_ALL_PATH,
  cancelMarketOrdersPath: env.POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH,
  activeOrdersPath: env.POLYMARKET_CLOB_ACTIVE_ORDERS_PATH,
  retryMaxRetries: env.POLYMARKET_CLOB_RETRY_MAX_RETRIES,
  retryBaseDelayMs: env.POLYMARKET_CLOB_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: env.POLYMARKET_CLOB_RETRY_MAX_DELAY_MS
});
const dataApi = new PolymarketDataApi({
  baseUrl: env.POLYMARKET_DATA_API_BASE_URL,
  requestTimeoutMs: env.POLYMARKET_DATA_API_TIMEOUT_MS,
  rateLimitPerSecond: env.POLYMARKET_DATA_API_RATE_LIMIT_PER_SEC,
  rateLimitWindowMs: env.POLYMARKET_DATA_API_RATE_LIMIT_WINDOW_MS,
  positionsPath: env.POLYMARKET_DATA_API_POSITIONS_PATH,
  retryMaxRetries: env.POLYMARKET_DATA_API_RETRY_MAX_RETRIES,
  retryBaseDelayMs: env.POLYMARKET_DATA_API_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: env.POLYMARKET_DATA_API_RETRY_MAX_DELAY_MS
});
const realtime = new PolymarketRealtime({
  url: env.POLYMARKET_WS_URL,
  heartbeatIntervalMs: env.POLYMARKET_WS_HEARTBEAT_MS,
  reconnectBaseDelayMs: env.POLYMARKET_WS_RECONNECT_BASE_MS,
  reconnectMaxDelayMs: env.POLYMARKET_WS_RECONNECT_MAX_MS,
  reconnectJitterPct: env.POLYMARKET_WS_RECONNECT_JITTER_PCT
});

const userAuthMessage =
  env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_PASSPHRASE
    ? {
        type: 'user',
        auth: {
          apiKey: env.POLYMARKET_API_KEY,
          secret: env.POLYMARKET_API_SECRET,
          passphrase: env.POLYMARKET_PASSPHRASE
        },
        markets: marketPairs.map((pair) => pair.marketId)
      }
    : undefined;

const userRealtime = userAuthMessage
  ? new PolymarketRealtime({
      url: env.POLYMARKET_USER_WS_URL,
      heartbeatIntervalMs: env.POLYMARKET_WS_HEARTBEAT_MS,
      reconnectBaseDelayMs: env.POLYMARKET_WS_RECONNECT_BASE_MS,
      reconnectMaxDelayMs: env.POLYMARKET_WS_RECONNECT_MAX_MS,
      reconnectJitterPct: env.POLYMARKET_WS_RECONNECT_JITTER_PCT,
      authMessage: userAuthMessage
    })
  : undefined;
const policy = configStore.getPolicy();
const risk = configStore.getRisk();
let refreshSettings = deriveBookRefreshSettings(policy);

const tradingStateManager = new TradingStateManager(env.TRADING_ENABLED, env.TRADING_MODE);

const supervisor = new Supervisor(
  {
    marketPairs,
    policy,
    riskConfig: risk,
    capital: env.TOTAL_CAPITAL,
    tradingEnabled: env.TRADING_ENABLED,
    tradingMode: env.TRADING_MODE,
    maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
    maxCapitalInFlight: env.MAX_CAPITAL_IN_FLIGHT,
    bookRefresh: {
      intervalMs: refreshSettings.bookRefreshIntervalMs,
      maxStalenessMs: refreshSettings.maxBookStalenessMs
    },
    reconciliation: {
      intervalMs: env.OPS_RECONCILIATION_INTERVAL_MS,
      afterIncidentDelayMs: env.OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS,
      positionSizeTolerance: env.OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE,
      positionsUser: env.POLYMARKET_POSITIONS_USER,
      positionsSizeThreshold: env.POLYMARKET_POSITIONS_SIZE_THRESHOLD,
      positionsLimit: env.POLYMARKET_POSITIONS_LIMIT,
      positionsOffset: env.POLYMARKET_POSITIONS_OFFSET
    }
  },
  {
    clob,
    dataApi,
    realtime,
    userRealtime,
    allowlist,
    metrics,
    incidentTracker,
    portfolio,
    eventStore: store,
    llm: llmConfig.enabled ? llmFacade : undefined,
    executionAdvisor,
    riskAdvisor
  }
);

tradingStateManager.onModeChange((event) => {
  console.info(`[trading] mode changed: ${event.previousMode} -> ${event.newMode}`);
  supervisor.updateTradingMode(event.newMode);
});

tradingStateManager.onEnabledChange((event) => {
  console.info(`[trading] enabled changed: ${event.previousEnabled} -> ${event.newEnabled}`);
  supervisor.updateTradingEnabled(event.newEnabled);
});

let catalogRefresher: MarketCatalogRefresher | null = null;

const syncRuntimeConfig = () => {
  const policySnapshot = configStore.getPolicy();
  const riskSnapshot = configStore.getRisk();
  supervisor.updatePolicyAndRisk(policySnapshot, riskSnapshot);
  const nextRefresh = deriveBookRefreshSettings(policySnapshot);
  refreshSettings = nextRefresh;
  supervisor.updateBookRefresh({
    intervalMs: nextRefresh.bookRefreshIntervalMs,
    maxStalenessMs: nextRefresh.maxBookStalenessMs
  });
  catalogRefresher?.updateConfig({ refreshIntervalMs: nextRefresh.catalogRefreshMs });
  incidentTracker.updateConfig({
    cooldownMs: riskSnapshot.marketCooldownSeconds * 1000
  });
  policyHashes.tradePolicyHash = sha256(stableStringify(policySnapshot));
  policyHashes.riskConfigHash = sha256(stableStringify(riskSnapshot));
};

const applyRiskProfile = (profileId: RiskProfileId, overridePath?: string) => {
  const loaded = loadRiskProfile(profileId, overridePath);
  if (!loaded) {
    const candidates = resolveRiskProfilePathCandidates(profileId, overridePath);
    throw new Error(`Risk profile not found: ${profileId} (searched: ${candidates.join(', ')})`);
  }

  const currentPolicy = configStore.getPolicy();
  const currentRisk = configStore.getRisk();
  const nextPolicy = { ...currentPolicy, ...(loaded.policy ?? {}) };
  const nextRisk = { ...currentRisk, ...(loaded.risk ?? {}) };
  validateP0Config(nextPolicy, nextRisk);

  const snapshot = configStore.replace(nextPolicy, nextRisk);
  syncRuntimeConfig();

  activeRiskProfile.id = profileId;
  activeRiskProfile.source = loaded.source;

  let persisted = true;
  let persistedSelection: ReturnType<typeof persistActiveRiskProfile> | null = null;
  try {
    persistedSelection = persistActiveRiskProfile(
      { id: profileId, source: loaded.source },
      riskProfileActivePath
    );
    activeRiskProfile.source = persistedSelection.source ?? activeRiskProfile.source;
  } catch (error) {
    persisted = false;
    const message = error instanceof Error ? error.message : String(error);
    metrics.record({
      type: 'error',
      timestamp: Date.now(),
      data: { message: 'risk_profile_persist_failed', error: message, profile: profileId }
    });
  }

  metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: {
      message: 'risk_profile_applied',
      profile: profileId,
      source: activeRiskProfile.source,
      persisted
    }
  });

  return {
    profile: { id: profileId, source: activeRiskProfile.source },
    policy: snapshot.policy,
    risk: snapshot.risk,
    persisted
  };
};

catalogRefresher = new MarketCatalogRefresher(
  {
    refreshIntervalMs: refreshSettings.catalogRefreshMs,
    maxPairs,
    minVolume24h: 50000,
    maxSpread: 0.02,
    gammaApiBaseUrl: env.GAMMA_API_BASE_URL
  },
  clob,
  metrics
);

catalogRefresher.seed(marketPairs);

catalogRefresher.on('refresh', ({ pairs }: { pairs: typeof marketPairs }) => {
  supervisor.updateMarketPairs(pairs);
  allowlist.seed(pairs.map((p) => p.marketId));
});

catalogRefresher.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  metrics.record({
    type: 'error',
    timestamp: Date.now(),
    data: { message: 'catalog_refresher_error', error: message }
  });
});

catalogRefresher.start();
console.log('[boot] market catalog refresher started');

opsAgent.setChecks([
  {
    name: 'book_freshness',
    check: () => {
      const current = deriveBookRefreshSettings(configStore.getPolicy());
      return createBookFreshnessCheck(
        () => supervisor.getOrderBooks(),
        current.maxBookStalenessMs,
        current.bookIdleCutoffMs
      ).check();
    }
  },
  {
    name: 'delayed_ack_rate',
    check: () => {
      const policy = configStore.getPolicy();
      return createDelayedAckRateCheck(
        metrics,
        () => marketPairs.map((pair) => pair.marketId),
        policy.orderVelocityWindowMs,
        policy.maxDelayedAckRate
      ).check();
    }
  },
  {
    name: 'decision_latency_p95',
    check: () => {
      const policy = configStore.getPolicy();
      return createLatencyPercentileCheck({
        metrics,
        stage: 'submitted',
        percentile: 0.95,
        thresholdMs: policy.maxDecisionLatencyMs,
        windowMs: policy.orderToTradeWindowMs
      }).check();
    }
  },
  {
    name: 'paired_fill_rate',
    check: () => {
      const policy = configStore.getPolicy();
      return createPairedFillRateCheck({
        metrics,
        threshold: policy.minPairedFillRate,
        windowMs: policy.orderToTradeWindowMs
      }).check();
    }
  },
  createCircuitBreakerCheck(() => supervisor.getCircuitBreakerOpenMarkets())
]);
opsAgent.start();

if (env.OPS_API_ENABLED) {
  const infraConfig = getInfraConfigSnapshot(env);
  try {
    opsServer = await startOpsServer(
      {
        metrics,
        allowlist,
        opsAgent,
        eventStore: store,
        portfolioAgent: portfolio,
        learningAgent: learning,
        configStore,
        tradingMode: env.TRADING_MODE,
        tradingEnabled: env.TRADING_ENABLED,
        tradingStateManager,
        infraConfig,
        clobClient: clob,
        syntheticOpportunity: (options) => supervisor.runSyntheticOpportunityTest(options),
        debugMarketDataOutlier: (tokenId) => supervisor.debugMarketDataOutlier(tokenId),
        riskProfile: { ...activeRiskProfile },
        applyRiskProfile,
        applyConfigUpdate: () => syncRuntimeConfig()
      },
      {
        port: env.PORT,
        host: env.OPS_API_HOST,
        authToken: env.OPS_API_TOKEN,
        incidentsLimit: env.OPS_INCIDENTS_LIMIT,
        streamHeartbeatMs: env.OPS_STREAM_HEARTBEAT_MS
      }
    );
    console.log(`[boot] ops api listening on ${env.OPS_API_HOST}:${env.PORT}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[boot] ops api failed to start: ${message}`);
  }
}

void supervisor.start();

const shutdown = createShutdownHandler({
  opsAgent,
  supervisor,
  clob,
  tradingStateManager,
  metrics,
  realtime,
  userRealtime,
  opsServer,
  store,
  pruneTimer,
  persistMetric,
  shutdownTimeoutMs: env.OPS_SHUTDOWN_TIMEOUT_MS,
  exit: (code) => process.exit(code),
  logger: console
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

function sha256(input: string): string {
  return sha256Hex(input);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => normalizeForStableStringify(v));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = normalizeForStableStringify(record[key]);
    }
    return out;
  }
  return value;
}
