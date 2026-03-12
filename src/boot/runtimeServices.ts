import type { Env } from '../config/env.js';
import type { TradePolicy } from '../config/policy.js';
import type { MarketPair } from '../domain/market.js';
import { MarketAllowlist } from '../domain/allowlist.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { RuntimeEventMap } from '../core/runtimeEvents.js';
import { IpOracleClient } from '../services/ip-oracle/IpOracleClient.js';
import { createPolymarketHmacAuthProvider } from '../services/PolymarketAuth.js';
import { resolvePolymarketL2Creds } from '../services/PolymarketApiCreds.js';
import { PolymarketClob } from '../services/PolymarketClob.js';
import { PolymarketDataApi } from '../services/PolymarketDataApi.js';
import { PolymarketRealtime } from '../services/PolymarketRealtime.js';
import { SignalAggregatorAgent } from '../agents/signal/SignalAggregatorAgent.js';
import { ExaClient } from '../services/websearch/ExaClient.js';
import { FirecrawlClient } from '../services/websearch/FirecrawlClient.js';
import { GdeltHeartbeatService } from '../services/websearch/GdeltHeartbeatService.js';
import { SerperClient } from '../services/websearch/SerperClient.js';
import { WebSearchCache } from '../services/websearch/WebSearchCache.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import { parseDomainList } from './config.js';
import { resolveFwOracleBaseUrl } from './fwOracle.js';

type ResolvedCreds = Awaited<ReturnType<typeof resolvePolymarketL2Creds>>;

interface RuntimeServices {
  resolvedCreds: ResolvedCreds | null;
  clob: PolymarketClob;
  dataApi: PolymarketDataApi;
  realtime: PolymarketRealtime;
  userRealtime?: PolymarketRealtime;
  signalAggregator?: SignalAggregatorAgent;
  fwOracleClient: IpOracleClient;
}

function resolveRuntimeCreds(input: { env: Env; metrics: MetricsStore }): Promise<ResolvedCreds | null> {
  return resolvePolymarketL2Creds(input.env).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    input.metrics.record({
      type: 'error',
      timestamp: Date.now(),
      data: { message: 'polymarket_creds_resolve_failed', error: message }
    });
    return null;
  });
}

export function createRuntimeServices(input: {
  env: Env;
  policy: TradePolicy;
  marketPairs: MarketPair[];
  messageBus: MessageBus<RuntimeEventMap>;
  allowlist: MarketAllowlist;
  metrics: MetricsStore;
}): Promise<RuntimeServices> {
  return resolveRuntimeCreds(input).then((resolvedCreds) => {
    const clobAuthProvider = resolvedCreds
      ? createPolymarketHmacAuthProvider({
          apiKey: resolvedCreds.apiKey,
          secret: resolvedCreds.secret,
          passphrase: resolvedCreds.passphrase,
          address: resolvedCreds.address
        })
      : undefined;
    if (resolvedCreds) {
      const positionsUser = input.env.POLYMARKET_POSITIONS_USER?.trim();
      if (positionsUser && positionsUser.toLowerCase() !== resolvedCreds.address.toLowerCase()) {
        input.metrics.record({
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
      baseUrl: input.env.POLYMARKET_CLOB_BASE_URL,
      requestTimeoutMs: input.env.POLYMARKET_CLOB_TIMEOUT_MS,
      rateLimitPerSecond: input.env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
      rateLimitWindowMs: input.env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
      authProvider: clobAuthProvider,
      orderPath: input.env.POLYMARKET_CLOB_ORDER_PATH,
      batchOrderPath: input.env.POLYMARKET_CLOB_BATCH_ORDER_PATH,
      cancelOrderPath: input.env.POLYMARKET_CLOB_CANCEL_ORDER_PATH,
      cancelOrdersPath: input.env.POLYMARKET_CLOB_CANCEL_ORDERS_PATH,
      cancelAllPath: input.env.POLYMARKET_CLOB_CANCEL_ALL_PATH,
      cancelMarketOrdersPath: input.env.POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH,
      activeOrdersPath: input.env.POLYMARKET_CLOB_ACTIVE_ORDERS_PATH,
      retryMaxRetries: input.env.POLYMARKET_CLOB_RETRY_MAX_RETRIES,
      retryBaseDelayMs: input.env.POLYMARKET_CLOB_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: input.env.POLYMARKET_CLOB_RETRY_MAX_DELAY_MS
    });
    const dataApi = new PolymarketDataApi({
      baseUrl: input.env.POLYMARKET_DATA_API_BASE_URL,
      requestTimeoutMs: input.env.POLYMARKET_DATA_API_TIMEOUT_MS,
      rateLimitPerSecond: input.env.POLYMARKET_DATA_API_RATE_LIMIT_PER_SEC,
      rateLimitWindowMs: input.env.POLYMARKET_DATA_API_RATE_LIMIT_WINDOW_MS,
      positionsPath: input.env.POLYMARKET_DATA_API_POSITIONS_PATH,
      retryMaxRetries: input.env.POLYMARKET_DATA_API_RETRY_MAX_RETRIES,
      retryBaseDelayMs: input.env.POLYMARKET_DATA_API_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: input.env.POLYMARKET_DATA_API_RETRY_MAX_DELAY_MS
    });
    const realtime = new PolymarketRealtime({
      url: input.env.POLYMARKET_WS_URL,
      heartbeatIntervalMs: input.env.POLYMARKET_WS_HEARTBEAT_MS,
      reconnectBaseDelayMs: input.env.POLYMARKET_WS_RECONNECT_BASE_MS,
      reconnectMaxDelayMs: input.env.POLYMARKET_WS_RECONNECT_MAX_MS,
      reconnectJitterPct: input.env.POLYMARKET_WS_RECONNECT_JITTER_PCT
    });
    const userRealtime = resolvedCreds
      ? new PolymarketRealtime({
          url: input.env.POLYMARKET_USER_WS_URL,
          heartbeatIntervalMs: input.env.POLYMARKET_WS_HEARTBEAT_MS,
          reconnectBaseDelayMs: input.env.POLYMARKET_WS_RECONNECT_BASE_MS,
          reconnectMaxDelayMs: input.env.POLYMARKET_WS_RECONNECT_MAX_MS,
          reconnectJitterPct: input.env.POLYMARKET_WS_RECONNECT_JITTER_PCT,
          authMessage: {
            type: 'user',
            auth: {
              apiKey: resolvedCreds.apiKey,
              secret: resolvedCreds.secret,
              passphrase: resolvedCreds.passphrase
            },
            markets: input.marketPairs.map((pair) => pair.marketId)
          }
        })
      : undefined;

    const webSearchCache = new WebSearchCache();
    const webSearchRateLimit = Math.max(input.env.EV_WEBSEARCH_REQUESTS_PER_MINUTE, 1);
    const webSearchRateLimitWindowMs = Math.max(input.env.EV_WEBSEARCH_RATE_LIMIT_WINDOW_MS, 1000);
    const webSearchRetry = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 };

    let exaClient: ExaClient | undefined;
    if (input.policy.evWebSearchExaEnabled) {
      if (input.env.EXA_API_KEY) {
        exaClient = new ExaClient({
          baseUrl: input.env.EXA_BASE_URL,
          apiKey: input.env.EXA_API_KEY,
          timeoutMs: input.env.EV_WEBSEARCH_TIMEOUT_MS,
          rateLimitPerWindow: webSearchRateLimit,
          rateLimitWindowMs: webSearchRateLimitWindowMs,
          retryMaxRetries: webSearchRetry.maxRetries,
          retryBaseDelayMs: webSearchRetry.baseDelayMs,
          retryMaxDelayMs: webSearchRetry.maxDelayMs,
          maxContentBytes: input.env.EV_WEBSEARCH_MAX_CONTENT_BYTES,
          searchPath: input.env.EXA_SEARCH_PATH,
          contentsPath: input.env.EXA_CONTENTS_PATH,
          cooldownMs: input.env.EXA_COOLDOWN_MS,
          cooldownFailureThreshold: input.env.EXA_COOLDOWN_FAILURE_THRESHOLD,
          inlineContentsEnabled: input.policy.evWebSearchExaInlineContentsEnabled,
          inlineContentsMaxResults: input.policy.evWebSearchExaInlineContentsMaxResults,
          cache: webSearchCache,
          metrics: input.metrics
        });
      } else {
        input.metrics.record({
          type: 'web_search',
          timestamp: Date.now(),
          data: { event: 'exa_missing_api_key' }
        });
      }
    }

    let serperClient: SerperClient | undefined;
    if (input.policy.evWebSearchSerperEnabled) {
      if (input.env.SERPER_API_KEY) {
        serperClient = new SerperClient({
          baseUrl: input.env.SERPER_BASE_URL,
          apiKey: input.env.SERPER_API_KEY,
          timeoutMs: input.env.EV_WEBSEARCH_TIMEOUT_MS,
          rateLimitPerWindow: webSearchRateLimit,
          rateLimitWindowMs: webSearchRateLimitWindowMs,
          retryMaxRetries: webSearchRetry.maxRetries,
          retryBaseDelayMs: webSearchRetry.baseDelayMs,
          retryMaxDelayMs: webSearchRetry.maxDelayMs,
          maxContentBytes: input.env.EV_WEBSEARCH_MAX_CONTENT_BYTES,
          searchPath: input.env.SERPER_SEARCH_PATH,
          newsPath: input.env.SERPER_NEWS_PATH,
          cache: webSearchCache,
          metrics: input.metrics
        });
      } else {
        input.metrics.record({
          type: 'web_search',
          timestamp: Date.now(),
          data: { event: 'serper_missing_api_key' }
        });
      }
    }

    let firecrawlClient: FirecrawlClient | undefined;
    if (input.policy.evWebSearchFirecrawlEnabled) {
      if (input.env.FIRECRAWL_API_KEY) {
        firecrawlClient = new FirecrawlClient({
          baseUrl: input.env.FIRECRAWL_BASE_URL,
          apiKey: input.env.FIRECRAWL_API_KEY,
          timeoutMs: input.env.EV_WEBSEARCH_TIMEOUT_MS,
          rateLimitPerWindow: webSearchRateLimit,
          rateLimitWindowMs: webSearchRateLimitWindowMs,
          retryMaxRetries: webSearchRetry.maxRetries,
          retryBaseDelayMs: webSearchRetry.baseDelayMs,
          retryMaxDelayMs: webSearchRetry.maxDelayMs,
          maxContentBytes: input.env.EV_WEBSEARCH_MAX_CONTENT_BYTES,
          searchPath: input.env.FIRECRAWL_SEARCH_PATH,
          scrapePath: input.env.FIRECRAWL_SCRAPE_PATH,
          crawlPath: input.env.FIRECRAWL_CRAWL_PATH,
          crawlEnabled: input.env.FIRECRAWL_CRAWL_ENABLED,
          crawlMaxDepth: input.policy.evWebSearchFirecrawlMaxDepth,
          crawlMaxPages: input.policy.evWebSearchFirecrawlMaxPages,
          cache: webSearchCache,
          metrics: input.metrics
        });
      } else {
        input.metrics.record({
          type: 'web_search',
          timestamp: Date.now(),
          data: { event: 'firecrawl_missing_api_key' }
        });
      }
    }

    const gdeltHeartbeat = input.policy.evWebSearchGdeltEnabled
      ? new GdeltHeartbeatService({
          policy: input.policy,
          baseUrl: input.env.GDELT_BASE_URL,
          timeoutMs: input.env.EV_WEBSEARCH_TIMEOUT_MS,
          rateLimitPerWindow: webSearchRateLimit,
          rateLimitWindowMs: webSearchRateLimitWindowMs,
          retryMaxRetries: webSearchRetry.maxRetries,
          retryBaseDelayMs: webSearchRetry.baseDelayMs,
          retryMaxDelayMs: webSearchRetry.maxDelayMs,
          metrics: input.metrics
        })
      : undefined;

    const signalAggregator =
      exaClient || serperClient || firecrawlClient
        ? new SignalAggregatorAgent({
            policy: input.policy,
            marketPairs: input.marketPairs,
            messageBus: input.messageBus,
            allowlist: input.allowlist,
            clob,
            exa: exaClient,
            serper: serperClient,
            firecrawl: firecrawlClient,
            gdeltHeartbeat,
            domainAllowlist: parseDomainList(input.env.EV_WEBSEARCH_DOMAIN_ALLOWLIST),
            domainDenylist: parseDomainList(input.env.EV_WEBSEARCH_DOMAIN_DENYLIST),
            metrics: input.metrics
          })
        : undefined;

    const fwOracleClient = new IpOracleClient({
      baseUrl: resolveFwOracleBaseUrl(input.env.FW_ORACLE_BASE_URL),
      timeoutMs: Math.max(1, input.env.FW_ORACLE_TIMEOUT_MS),
      apiKey: input.env.FW_ORACLE_API_KEY,
      circuitFailureThreshold: Math.max(1, input.env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD),
      circuitCooldownMs: Math.max(0, input.env.FW_ORACLE_CIRCUIT_COOLDOWN_MS)
    });

    return {
      resolvedCreds,
      clob,
      dataApi,
      realtime,
      userRealtime,
      signalAggregator,
      fwOracleClient
    };
  });
}
