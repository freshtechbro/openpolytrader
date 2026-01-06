import 'dotenv/config';

import type { FastifyInstance } from 'fastify';

import { loadEnv } from './config/env.js';
import { DEFAULT_RISK_CONFIG } from './config/risk.js';
import { DEFAULT_TRADE_POLICY } from './config/policy.js';
import { ConfigStore } from './config/store.js';
import { validateP0Config } from './config/validate.js';
import { MarketAllowlist } from './domain/allowlist.js';
import { OpsAgent } from './agents/ops/OpsAgent.js';
import {
  createBookFreshnessCheck,
  createCircuitBreakerCheck,
  createDelayedAckRateCheck,
  createLatencyPercentileCheck,
  createPairedFillRateCheck
} from './agents/ops/sloChecks.js';
import { type MetricEvent, MetricsStore } from './telemetry/metrics.js';
import { startOpsServer } from './api/server.js';
import { MarketCatalog } from './services/MarketCatalog.js';
import { PolymarketClob } from './services/PolymarketClob.js';
import { PolymarketDataApi } from './services/PolymarketDataApi.js';
import { PolymarketRealtime } from './services/PolymarketRealtime.js';
import { IncidentTracker } from './services/IncidentTracker.js';
import { PortfolioAgent } from './agents/portfolio/PortfolioAgent.js';
import { LearningAgent } from './agents/learning/LearningAgent.js';
import { EventStore } from './core/EventStore.js';
import { Supervisor } from './core/Supervisor.js';
import { emitAllowlistSnapshot } from './telemetry/allowlist.js';
import { getInfraConfigSnapshot } from './config/infra.js';

const env = loadEnv();
const policyConfig = { ...DEFAULT_TRADE_POLICY };
const riskConfig = { ...DEFAULT_RISK_CONFIG };
validateP0Config(policyConfig, riskConfig);
const configStore = new ConfigStore(policyConfig, riskConfig);

console.log('[boot] openpolytrader starting');
console.log(
  `[boot] env=${env.NODE_ENV} trading=${env.TRADING_ENABLED} mode=${env.TRADING_MODE}`
);
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
const marketPairs = catalog.loadPairs();
allowlist.seed(marketPairs.map((pair) => pair.marketId));
metrics.record({
  type: 'info',
  timestamp: Date.now(),
  data: { allowlistSeeded: marketPairs.length }
});
emitAllowlistSnapshot(metrics, allowlist);
const opsAgent = new OpsAgent(
  { intervalMs: env.OPS_HEALTH_INTERVAL_MS, checks: [], alertWebhookUrl: env.OPS_ALERT_WEBHOOK_URL },
  metrics
);

let opsServer: FastifyInstance | null = null;
if (env.OPS_API_ENABLED) {
  const infraConfig = getInfraConfigSnapshot(env);
  try {
    opsServer = await startOpsServer(
    {
      metrics,
      allowlist,
      opsAgent,
      eventStore: store,
      configStore,
      tradingMode: env.TRADING_MODE,
      tradingEnabled: env.TRADING_ENABLED,
      infraConfig
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

const incidentTracker = new IncidentTracker(allowlist, metrics, {
  cooldownMs: riskConfig.marketCooldownSeconds * 1000,
  maxIncidents: env.INCIDENTS_MAX_EVENTS
});
const tokenToMarketId = marketPairs.reduce<Record<string, string>>((acc, pair) => {
  acc[pair.yesTokenId] = pair.marketId;
  acc[pair.noTokenId] = pair.marketId;
  return acc;
}, {});
const portfolio = new PortfolioAgent(env.TOTAL_CAPITAL, incidentTracker, { tokenToMarketId });
const learning = new LearningAgent({ enabled: env.NODE_ENV !== 'test' }, store);
learning.start();
const clob = new PolymarketClob({
  baseUrl: env.POLYMARKET_CLOB_BASE_URL,
  requestTimeoutMs: env.POLYMARKET_CLOB_TIMEOUT_MS,
  rateLimitPerSecond: env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
  rateLimitWindowMs: env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
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
const supervisor = new Supervisor(
  {
    marketPairs,
    policy,
    riskConfig: risk,
    capital: env.TOTAL_CAPITAL,
    tradingEnabled: env.TRADING_ENABLED,
    tradingMode: env.TRADING_MODE,
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
    eventStore: store
  }
);

opsAgent.setChecks([
  {
    name: 'book_freshness',
    check: () => createBookFreshnessCheck(() => supervisor.getOrderBooks(), configStore.getPolicy().maxBookStalenessMs).check()
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

void supervisor.start();

let shutdownInFlight: Promise<void> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shutdownInFlight) return shutdownInFlight;

  shutdownInFlight = (async () => {
    const startedAt = Date.now();
    const timeoutMs = env.OPS_SHUTDOWN_TIMEOUT_MS;
    console.log(`[shutdown] received ${signal}, beginning shutdown`);

    const timeout = setTimeout(() => {
      console.error(`[shutdown] timeout after ${timeoutMs}ms, forcing exit`);
      process.exit(1);
    }, timeoutMs);

    try {
      opsAgent.stop();

      metrics.record({
        type: 'info',
        timestamp: Date.now(),
        data: { message: 'shutdown_started', signal }
      });

      try {
        await supervisor.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        metrics.record({
          type: 'error',
          timestamp: Date.now(),
          data: { message: 'shutdown_supervisor_failed', error: message }
        });
      }

      if (env.TRADING_ENABLED && env.TRADING_MODE === 'live') {
        try {
          await clob.cancelAll();
          metrics.record({
            type: 'info',
            timestamp: Date.now(),
            data: { message: 'shutdown_cancel_all_ok' }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          metrics.record({
            type: 'error',
            timestamp: Date.now(),
            data: { message: 'shutdown_cancel_all_failed', error: message }
          });
        }
      }

      realtime.close();
      userRealtime?.close();

      if (opsServer) {
        try {
          await opsServer.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          metrics.record({
            type: 'error',
            timestamp: Date.now(),
            data: { message: 'shutdown_ops_server_failed', error: message }
          });
        }
      }

      if (pruneTimer) clearInterval(pruneTimer);
      metrics.off('event', persistMetric);
      store.close();

      console.log(`[shutdown] complete in ${Date.now() - startedAt}ms`);
      process.exit(0);
    } finally {
      clearTimeout(timeout);
    }
  })();

  return shutdownInFlight;
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
