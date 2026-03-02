import 'dotenv/config';

import type { FastifyInstance } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';

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
import { createBookFreshnessQuarantine, isOpsAlertPayload } from './agents/ops/bookFreshnessQuarantine.js';
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
import { resolvePolymarketL2Creds } from './services/PolymarketApiCreds.js';
import { IncidentTracker } from './services/IncidentTracker.js';
import { ExaClient, FirecrawlClient, WebSearchCache } from './services/websearch/index.js';
import { PortfolioAgent } from './agents/portfolio/PortfolioAgent.js';
import { LearningAgent } from './agents/learning/LearningAgent.js';
import { SignalAggregatorAgent } from './agents/signal/SignalAggregatorAgent.js';
import { createDependencyLLMExtractor } from './agents/dependency/DependencyLLMExtractor.js';
import {
  buildDependencyRelationCatalogEntries,
  loadDependencyRelationCatalog
} from './agents/dependency/DependencyRelationCatalog.js';
import { ensureFwRelationCatalogStartupReady } from './agents/dependency/FwRelationCatalogStartupGuard.js';
import { FwProjectionAgent } from './agents/projection/FwProjectionAgent.js';
import { EventStore } from './core/EventStore.js';
import { messageBus } from './core/MessageBus.js';
import { Supervisor } from './core/Supervisor.js';
import { TradingStateManager } from './core/TradingStateManager.js';
import { createShutdownHandler } from './core/shutdown.js';
import { emitAllowlistSnapshot } from './telemetry/allowlist.js';
import { getInfraConfigSnapshot } from './config/infra.js';
import { LLMClient } from './services/llm/LLMClient.js';
import type { LLMAgentId, LLMRequest } from './services/llm/types.js';
import { RiskAdvisor } from './agents/risk/RiskAdvisor.js';
import { IpOracleClient } from './services/ip-oracle/IpOracleClient.js';
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
let profileId: RiskProfileId = envProfile ?? persistedProfile?.id ?? 'extra_high';
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
  const refreshIntervalOverride = Math.max(env.OPS_BOOK_REFRESH_INTERVAL_MS, 0);
  const refreshStaleOverride = Math.max(env.OPS_BOOK_REFRESH_STALE_MS, 0);
  const bookRefreshIntervalMs =
    refreshIntervalOverride > 0 ? refreshIntervalOverride : Math.max(maxBookStalenessMs, 10000);
  const bookRefreshStaleMs =
    refreshStaleOverride > 0
      ? maxBookStalenessMs > 0
        ? Math.min(refreshStaleOverride, maxBookStalenessMs)
        : refreshStaleOverride
      : maxBookStalenessMs;
  return {
    maxBookStalenessMs,
    bookRefreshIntervalMs,
    bookRefreshStaleMs,
    bookIdleCutoffMs: Math.max(maxBookStalenessMs * 6, 60000),
    catalogRefreshMs: Math.min(Math.max(maxBookStalenessMs * 6, 60000), 300000)
  };
};

const parseDomainList = (value?: string): string[] => {
  if (!value) return [];
  const entries = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(entries));
};

const DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH = 'data/dependency-relations.json';

const normalizeOracleBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const fetchWithTimeout = async (
  url: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  timeoutHandle.unref?.();
  try {
    return await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const ensureFwOracleStartupReady = async (input: {
  tradingEnabled: boolean;
  tradingMode: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  attempts: number;
  retryDelayMs: number;
  metrics: MetricsStore;
}): Promise<void> => {
  if (!input.tradingEnabled || input.tradingMode !== 'paper') return;

  const baseUrl = normalizeOracleBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new Error(
      '[boot] FW oracle base URL is empty in paper mode. Set FW_ORACLE_BASE_URL or use `npm run dev:ops`.'
    );
  }

  const healthUrl = `${baseUrl}/health`;
  const headers: Record<string, string> = {};
  if (input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }

  let lastFailure = 'unknown';
  const attempts = Math.max(1, input.attempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(healthUrl, input.timeoutMs, headers);
      if (response.ok) {
        input.metrics.record({
          type: 'fw_oracle',
          timestamp: Date.now(),
          data: { event: 'startup_healthcheck_ok', healthUrl, attempt }
        });
        return;
      }
      lastFailure = `http_${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await delay(Math.max(50, input.retryDelayMs));
    }
  }

  input.metrics.record({
    type: 'incident',
    timestamp: Date.now(),
    data: {
      reason: 'fw_oracle_unavailable_startup',
      detail: { healthUrl, attempts, lastFailure }
    }
  });
  throw new Error(
    `[boot] FW oracle sidecar is unavailable (${healthUrl}; attempts=${attempts}; last=${lastFailure}). Start the full stack with \`npm run dev:ops\` or bring up the oracle sidecar.`
  );
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

const paperRunId = env.TRADING_MODE === 'paper' ? `paper-${Date.now()}` : null;
let paperRunStopMarkerRecorded = false;
const recordPaperRunMarker = (
  phase: 'start' | 'stop',
  reason: string
): void => {
  if (!paperRunId) return;
  if (phase === 'stop' && paperRunStopMarkerRecorded) return;
  metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: {
      message: 'paper_run_marker',
      phase,
      runId: paperRunId,
      reason,
      mode: env.TRADING_MODE,
      dbPath: env.EVENT_STORE_PATH
    }
  });
  if (phase === 'stop') {
    paperRunStopMarkerRecorded = true;
  }
};

const relationCatalogPath = DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH;
let relationCatalogSnapshot = loadDependencyRelationCatalog(relationCatalogPath);

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
const fwDependencyLlmExtractor = createDependencyLLMExtractor({
  llmConfig,
  llmClient: { call: (agent, request, nowMs) => llmClient.call(agent, request, nowMs) },
  promptVersion: llmPromptVersion,
  policyHashes,
  eventStore: store,
  metrics
});
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
const tokenToMarketId: Record<string, string> = {};
const updateTokenToMarketId = (pairs: typeof marketPairs) => {
  for (const key of Object.keys(tokenToMarketId)) {
    delete tokenToMarketId[key];
  }
  for (const pair of pairs) {
    tokenToMarketId[pair.yesTokenId] = pair.marketId;
    tokenToMarketId[pair.noTokenId] = pair.marketId;
  }
};
updateTokenToMarketId(marketPairs);
const bookStaleQuarantine = createBookFreshnessQuarantine({
  allowlist,
  incidentTracker,
  tokenToMarketId,
  config: {
    threshold: env.OPS_BOOK_STALE_QUARANTINE_THRESHOLD,
    windowMs: env.OPS_BOOK_STALE_QUARANTINE_WINDOW_MS,
    cooldownMs:
      env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS > 0
        ? env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS
        : riskConfig.marketCooldownSeconds * 1000
  }
});
messageBus.on('ops:alert', (payload) => {
  if (isOpsAlertPayload(payload)) {
    bookStaleQuarantine.handle(payload);
  }
});
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
let resolvedCreds: Awaited<ReturnType<typeof resolvePolymarketL2Creds>> | null = null;
try {
  resolvedCreds = await resolvePolymarketL2Creds(env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  metrics.record({
    type: 'error',
    timestamp: Date.now(),
    data: { message: 'polymarket_creds_resolve_failed', error: message }
  });
}

const clobAuthProvider = resolvedCreds
  ? createPolymarketHmacAuthProvider({
      apiKey: resolvedCreds.apiKey,
      secret: resolvedCreds.secret,
      passphrase: resolvedCreds.passphrase,
      address: resolvedCreds.address
    })
  : undefined;
if (resolvedCreds) {
  const positionsUser = env.POLYMARKET_POSITIONS_USER?.trim();
  if (positionsUser && positionsUser.toLowerCase() !== resolvedCreds.address.toLowerCase()) {
    metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: {
        message: 'polymarket_creds_address_mismatch',
        positionsUser,
        signingAddress: resolvedCreds.address
      }
    });
  }
}

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

const userAuthMessage = resolvedCreds
  ? {
      type: 'user',
      auth: {
        apiKey: resolvedCreds.apiKey,
        secret: resolvedCreds.secret,
        passphrase: resolvedCreds.passphrase
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

const webSearchCache = new WebSearchCache();
const webSearchRateLimit = Math.max(env.EV_WEBSEARCH_REQUESTS_PER_MINUTE, 1);
const webSearchRateLimitWindowMs = Math.max(env.EV_WEBSEARCH_RATE_LIMIT_WINDOW_MS, 1000);
const webSearchRetry = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 };
const domainAllowlist = parseDomainList(env.EV_WEBSEARCH_DOMAIN_ALLOWLIST);
const domainDenylist = parseDomainList(env.EV_WEBSEARCH_DOMAIN_DENYLIST);

let exaClient: ExaClient | undefined;
if (env.EXA_API_KEY) {
  exaClient = new ExaClient({
    baseUrl: env.EXA_BASE_URL,
    apiKey: env.EXA_API_KEY,
    timeoutMs: env.EV_WEBSEARCH_TIMEOUT_MS,
    rateLimitPerWindow: webSearchRateLimit,
    rateLimitWindowMs: webSearchRateLimitWindowMs,
    retryMaxRetries: webSearchRetry.maxRetries,
    retryBaseDelayMs: webSearchRetry.baseDelayMs,
    retryMaxDelayMs: webSearchRetry.maxDelayMs,
    maxContentBytes: env.EV_WEBSEARCH_MAX_CONTENT_BYTES,
    searchPath: env.EXA_SEARCH_PATH,
    contentsPath: env.EXA_CONTENTS_PATH,
    cooldownMs: env.EXA_COOLDOWN_MS,
    cooldownFailureThreshold: env.EXA_COOLDOWN_FAILURE_THRESHOLD,
    cache: webSearchCache,
    metrics
  });
} else if (policy.evWebSearchExaEnabled) {
  metrics.record({
    type: 'web_search',
    timestamp: Date.now(),
    data: { event: 'exa_missing_api_key' }
  });
}

let firecrawlClient: FirecrawlClient | undefined;
if (env.FIRECRAWL_API_KEY) {
  firecrawlClient = new FirecrawlClient({
    baseUrl: env.FIRECRAWL_BASE_URL,
    apiKey: env.FIRECRAWL_API_KEY,
    timeoutMs: env.EV_WEBSEARCH_TIMEOUT_MS,
    rateLimitPerWindow: webSearchRateLimit,
    rateLimitWindowMs: webSearchRateLimitWindowMs,
    retryMaxRetries: webSearchRetry.maxRetries,
    retryBaseDelayMs: webSearchRetry.baseDelayMs,
    retryMaxDelayMs: webSearchRetry.maxDelayMs,
    maxContentBytes: env.EV_WEBSEARCH_MAX_CONTENT_BYTES,
    searchPath: env.FIRECRAWL_SEARCH_PATH,
    scrapePath: env.FIRECRAWL_SCRAPE_PATH,
    crawlPath: env.FIRECRAWL_CRAWL_PATH,
    crawlEnabled: env.FIRECRAWL_CRAWL_ENABLED,
    crawlMaxDepth: policy.evWebSearchFirecrawlMaxDepth,
    crawlMaxPages: policy.evWebSearchFirecrawlMaxPages,
    cache: webSearchCache,
    metrics
  });
} else if (policy.evWebSearchFirecrawlEnabled) {
  metrics.record({
    type: 'web_search',
    timestamp: Date.now(),
    data: { event: 'firecrawl_missing_api_key' }
  });
}

const signalAggregator =
  exaClient || firecrawlClient
    ? new SignalAggregatorAgent({
        policy,
        marketPairs,
        allowlist,
        clob,
        exa: exaClient,
        firecrawl: firecrawlClient,
        domainAllowlist,
        domainDenylist,
        metrics
      })
    : undefined;

const fwOracleClient = new IpOracleClient({
  baseUrl: env.FW_ORACLE_BASE_URL,
  timeoutMs: Math.max(1, env.FW_ORACLE_TIMEOUT_MS),
  apiKey: env.FW_ORACLE_API_KEY,
  circuitFailureThreshold: Math.max(1, env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD),
  circuitCooldownMs: Math.max(0, env.FW_ORACLE_CIRCUIT_COOLDOWN_MS)
});

const toDependencyMarketInputs = (pairs: typeof marketPairs) =>
  pairs.map((pair) => ({
    marketId: pair.marketId,
    yesTokenId: pair.yesTokenId,
    noTokenId: pair.noTokenId,
    question: pair.question,
    category: pair.category,
    tags: pair.tags
  }));

const buildRuntimeRelationCatalogSnapshot = (
  pairs: typeof marketPairs,
  policySnapshot: TradePolicy,
  nowMs = Date.now()
) => {
  const built = buildDependencyRelationCatalogEntries(toDependencyMarketInputs(pairs), {
    nowMs,
    semanticEnabled: policySnapshot.fwRelationCatalogSemanticBatchEnabled
  });
  if (built.entries.length > 0) {
    return {
      snapshot: {
        path: relationCatalogSnapshot.path,
        loadedAtMs: nowMs,
        entries: built.entries,
        malformedEntries: 0
      },
      source: 'runtime_pairs' as const,
      deterministicRelations: built.deterministicRelations,
      semanticRelations: built.semanticRelations,
      relationTypeCounts: built.relationTypeCounts
    };
  }

  const fallback = loadDependencyRelationCatalog(relationCatalogPath, nowMs);
  return {
    snapshot: fallback,
    source: 'file_fallback' as const,
    deterministicRelations: 0,
    semanticRelations: 0,
    relationTypeCounts: {
      mutual_exclusive: 0,
      implies: 0,
      complementary: 0,
      partition: 0
    }
  };
};

const startupCatalog = buildRuntimeRelationCatalogSnapshot(marketPairs, policy, Date.now());
relationCatalogSnapshot = startupCatalog.snapshot;
metrics.record({
  type: 'fw_dependency',
  timestamp: Date.now(),
  data: {
    event: 'relation_catalog_loaded',
    reason: 'startup',
    source: startupCatalog.source,
    path: relationCatalogSnapshot.path,
    entries: relationCatalogSnapshot.entries.length,
    malformed: relationCatalogSnapshot.malformedEntries,
    deterministicRelations: startupCatalog.deterministicRelations,
    semanticRelations: startupCatalog.semanticRelations,
    relationTypeCounts: startupCatalog.relationTypeCounts
  }
});

const buildFwResolverConfig = (policySnapshot: TradePolicy) => ({
  mode: policySnapshot.fwDependencyMode,
  hybridMerge: policySnapshot.fwDependencyHybridMerge,
  minConfidence: policySnapshot.fwDependencyMinConfidence,
  maxEdgesPerMarket: policySnapshot.fwDependencyMaxEdgesPerMarket,
  relationCatalogEnabled: true,
  relationCatalogEntries: relationCatalogSnapshot.entries,
  relationCatalogMinConfidence: policySnapshot.fwRelationCatalogMinConfidence,
  relationCatalogMaxEdgesPerMarket: policySnapshot.fwRelationCatalogMaxEdgesPerMarket,
  cacheTtlMs: policySnapshot.fwDependencyCacheTtlMs,
  cacheGraceMs: policySnapshot.fwDependencyCacheGraceMs,
  cacheMaxEntries: policySnapshot.fwDependencyCacheMaxEntries,
  backoffInvalidMs: policySnapshot.fwDependencyBackoffInvalidMs,
  backoffTimeoutMs: policySnapshot.fwDependencyBackoffTimeoutMs,
  backoffErrorMs: policySnapshot.fwDependencyBackoffErrorMs,
  llmExtractor: fwDependencyLlmExtractor
});

ensureFwRelationCatalogStartupReady({
  tradingEnabled: env.TRADING_ENABLED,
  tradingMode: env.TRADING_MODE,
  policy,
  relationCatalogPath: relationCatalogSnapshot.path,
  relationCatalogEntries: relationCatalogSnapshot.entries.length,
  metrics
});

await ensureFwOracleStartupReady({
  tradingEnabled: env.TRADING_ENABLED,
  tradingMode: env.TRADING_MODE,
  baseUrl: env.FW_ORACLE_BASE_URL,
  apiKey: env.FW_ORACLE_API_KEY,
  timeoutMs: Math.max(500, env.FW_ORACLE_TIMEOUT_MS),
  attempts: 10,
  retryDelayMs: 300,
  metrics
});
const fwProjectionAgent = new FwProjectionAgent({
  resolverConfig: buildFwResolverConfig(policy),
  oracleClient: fwOracleClient,
  metrics
});

const tradingStateManager = new TradingStateManager(env.TRADING_ENABLED, env.TRADING_MODE);
const blockTradingUntilCatalogRefresh =
  env.TRADING_ENABLED && (env.TRADING_MODE === 'paper' || env.TRADING_MODE === 'live');
let catalogRefreshReady = !blockTradingUntilCatalogRefresh;
const catalogRefreshBlockStartedAtMs = blockTradingUntilCatalogRefresh ? Date.now() : null;
const resolveEffectiveTradingEnabled = () => tradingStateManager.enabled && catalogRefreshReady;

const supervisor = new Supervisor(
  {
    marketPairs,
    policy,
    riskConfig: risk,
    capital: env.TOTAL_CAPITAL,
    tradingEnabled: resolveEffectiveTradingEnabled(),
    tradingMode: env.TRADING_MODE,
    maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
    maxCapitalInFlight: env.MAX_CAPITAL_IN_FLIGHT,
    bookRefresh: {
      intervalMs: refreshSettings.bookRefreshIntervalMs,
      maxStalenessMs: refreshSettings.bookRefreshStaleMs
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
    riskAdvisor,
    signalAggregator,
    fwProjectionAgent
  }
);

if (!catalogRefreshReady) {
  metrics.record({
    type: 'info',
    timestamp: Date.now(),
    data: { message: 'trading_blocked_pending_catalog_refresh' }
  });
  console.log('[boot] trading execution blocked until first successful catalog refresh');
}

tradingStateManager.onModeChange((event) => {
  console.info(`[trading] mode changed: ${event.previousMode} -> ${event.newMode}`);
  supervisor.updateTradingMode(event.newMode);
});

tradingStateManager.onEnabledChange((event) => {
  const effectiveEnabled = resolveEffectiveTradingEnabled();
  console.info(`[trading] enabled changed: ${event.previousEnabled} -> ${event.newEnabled}`);
  if (event.newEnabled && !catalogRefreshReady) {
    console.info('[trading] execution remains blocked (waiting for first successful catalog refresh)');
  }
  supervisor.updateTradingEnabled(effectiveEnabled);
});

let catalogRefresher: MarketCatalogRefresher | null = null;

const refreshDependencyRelationCatalog = (
  reason: 'catalog_refresh' | 'runtime_config',
  pairs: typeof marketPairs
): void => {
  const next = buildRuntimeRelationCatalogSnapshot(pairs, configStore.getPolicy(), Date.now());
  relationCatalogSnapshot = next.snapshot;
  metrics.record({
    type: 'fw_dependency',
    timestamp: Date.now(),
    data: {
      event: 'relation_catalog_loaded',
      reason,
      source: next.source,
      path: relationCatalogSnapshot.path,
      entries: relationCatalogSnapshot.entries.length,
      malformed: relationCatalogSnapshot.malformedEntries,
      deterministicRelations: next.deterministicRelations,
      semanticRelations: next.semanticRelations,
      relationTypeCounts: next.relationTypeCounts
    }
  });
  fwProjectionAgent.updateResolverConfig(buildFwResolverConfig(configStore.getPolicy()));
};

const syncRuntimeConfig = () => {
  const policySnapshot = configStore.getPolicy();
  const riskSnapshot = configStore.getRisk();
  supervisor.updatePolicyAndRisk(policySnapshot, riskSnapshot);
  const nextRefresh = deriveBookRefreshSettings(policySnapshot);
  refreshSettings = nextRefresh;
  supervisor.updateBookRefresh({
    intervalMs: nextRefresh.bookRefreshIntervalMs,
    maxStalenessMs: nextRefresh.bookRefreshStaleMs
  });
  bookStaleQuarantine.updateConfig({
    cooldownMs:
      env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS > 0
        ? env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS
        : riskSnapshot.marketCooldownSeconds * 1000
  });
  catalogRefresher?.updateConfig({ refreshIntervalMs: nextRefresh.catalogRefreshMs });
  incidentTracker.updateConfig({
    cooldownMs: riskSnapshot.marketCooldownSeconds * 1000
  });
  const currentPairs = catalogRefresher?.getPairs() ?? marketPairs;
  refreshDependencyRelationCatalog('runtime_config', currentPairs);
  fwOracleClient.updateConfig({
    baseUrl: env.FW_ORACLE_BASE_URL,
    timeoutMs: Math.max(1, env.FW_ORACLE_TIMEOUT_MS),
    apiKey: env.FW_ORACLE_API_KEY,
    circuitFailureThreshold: Math.max(1, env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD),
    circuitCooldownMs: Math.max(0, env.FW_ORACLE_CIRCUIT_COOLDOWN_MS)
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
    minVolume24h: env.MARKET_CATALOG_MIN_VOLUME_24H,
    maxSpread: env.MARKET_CATALOG_MAX_SPREAD,
    pageSize: env.MARKET_CATALOG_PAGE_SIZE,
    maxPages: env.MARKET_CATALOG_MAX_PAGES,
    order: env.MARKET_CATALOG_ORDER,
    excludeEndedMarkets: env.MARKET_CATALOG_EXCLUDE_ENDED_MARKETS,
    explorationEnabled: env.MARKET_CATALOG_EXPLORATION_ENABLED,
    explorationMaxPairs: env.MARKET_CATALOG_EXPLORATION_MAX_PAIRS,
    explorationMinVolume24h: env.MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H,
    explorationMaxPages: env.MARKET_CATALOG_EXPLORATION_MAX_PAGES,
    gammaApiBaseUrl: env.GAMMA_API_BASE_URL
  },
  clob,
  metrics
);

catalogRefresher.seed(marketPairs);

catalogRefresher.on('refresh', ({ pairs }: { pairs: typeof marketPairs }) => {
  refreshDependencyRelationCatalog('catalog_refresh', pairs);
  supervisor.updateMarketPairs(pairs);
  allowlist.seed(pairs.map((p) => p.marketId));
  updateTokenToMarketId(pairs);
  if (!catalogRefreshReady) {
    catalogRefreshReady = true;
    supervisor.updateTradingEnabled(resolveEffectiveTradingEnabled());
    const blockedMs =
      catalogRefreshBlockStartedAtMs === null ? 0 : Math.max(0, Date.now() - catalogRefreshBlockStartedAtMs);
    metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: { message: 'trading_unblocked_catalog_refresh_ready', blockedMs }
    });
    console.log(`[boot] trading execution unblocked after catalog refresh (${blockedMs}ms)`);
  }
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
        tradingEnabled: resolveEffectiveTradingEnabled(),
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
        devSessionPrefillEnabled: env.OPS_DEV_SESSION_PREFILL_ENABLED,
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

recordPaperRunMarker('start', 'boot_ready');
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
  recordPaperRunMarker('stop', 'SIGTERM');
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  recordPaperRunMarker('stop', 'SIGINT');
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
