import type { FastifyInstance } from 'fastify';

import type { Env, TradingMode } from '../config/env.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { RiskProfileId } from '../config/riskProfile.js';
import type { ConfigStore } from '../config/store.js';
import type { MarketPair } from '../domain/market.js';
import type { MarketAllowlist } from '../domain/allowlist.js';
import type { OrderBookState } from '../domain/orderbook.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { EventStore } from '../core/EventStore.js';
import type { TradingStateManager } from '../core/TradingStateManager.js';
import type { SyntheticOpportunityOptions, SyntheticOpportunityResult } from '../core/Supervisor.js';
import type { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { LearningAgent } from '../agents/learning/LearningAgent.js';
import type { OpsAgent } from '../agents/ops/OpsAgent.js';
import type { PolymarketClob } from '../services/PolymarketClob.js';
import { createBookFreshnessCheck, createCircuitBreakerCheck, createDelayedAckRateCheck, createLatencyPercentileCheck, createPairedFillRateCheck } from '../agents/ops/sloChecks.js';
import { getInfraConfigSnapshot } from '../config/infra.js';
import { startOpsServer } from '../api/server.js';
import { deriveBookRefreshSettings } from './config.js';

interface SupervisorLike {
  getOrderBooks(): OrderBookState[];
  getCircuitBreakerOpenMarkets(): string[];
  updateMarketPairs(pairs: MarketPair[]): void;
  updateTradingMode(mode: TradingMode): void;
  updateTradingEnabled(enabled: boolean): void;
  runSyntheticOpportunityTest(options: SyntheticOpportunityOptions): Promise<SyntheticOpportunityResult>;
  debugMarketDataOutlier(tokenId: string): Promise<{ ok: boolean; error?: string }>;
}

interface TradingStateManagerLike {
  onModeChange(listener: (event: { previousMode: TradingMode; newMode: TradingMode }) => void): void;
  onEnabledChange(listener: (event: { previousEnabled: boolean; newEnabled: boolean }) => void): void;
}

interface CatalogRefresherLike {
  on(event: 'refresh', listener: (payload: { pairs: MarketPair[] }) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  start(): void;
}

interface OpsAgentLike {
  setChecks(checks: unknown[]): void;
  start(): void;
}

export function registerTradingStateHandlers(input: {
  tradingStateManager: TradingStateManagerLike;
  recordRuntimeInfo: (message: string, data?: Record<string, unknown>) => void;
  supervisor: Pick<SupervisorLike, 'updateTradingMode' | 'updateTradingEnabled'>;
  resolveEffectiveTradingEnabled: () => boolean;
  isCatalogRefreshReady: () => boolean;
}): void {
  input.tradingStateManager.onModeChange((event) => {
    input.recordRuntimeInfo('trading_mode_changed', {
      previousMode: event.previousMode,
      newMode: event.newMode
    });
    input.supervisor.updateTradingMode(event.newMode);
  });

  input.tradingStateManager.onEnabledChange((event) => {
    const effectiveEnabled = input.resolveEffectiveTradingEnabled();
    input.recordRuntimeInfo('trading_enabled_changed', {
      previousEnabled: event.previousEnabled,
      newEnabled: event.newEnabled,
      effectiveEnabled
    });
    if (event.newEnabled && !input.isCatalogRefreshReady()) {
      input.recordRuntimeInfo('trading_still_blocked_pending_catalog_refresh', {
        previousEnabled: event.previousEnabled,
        newEnabled: event.newEnabled
      });
    }
    input.supervisor.updateTradingEnabled(effectiveEnabled);
  });
}

export function registerCatalogRefresherHandlers(input: {
  catalogRefresher: CatalogRefresherLike;
  supervisor: Pick<SupervisorLike, 'updateMarketPairs' | 'updateTradingEnabled'>;
  allowlist: { seed(ids: string[]): void };
  updateTokenToMarketId: (pairs: MarketPair[]) => void;
  refreshDependencyRelationCatalog: (reason: 'catalog_refresh', pairs: MarketPair[]) => void;
  metrics: MetricsStore;
  resolveEffectiveTradingEnabled: () => boolean;
  isCatalogRefreshReady: () => boolean;
  setCatalogRefreshReady: (value: boolean) => void;
  catalogRefreshBlockStartedAtMs: number | null;
}): void {
  input.catalogRefresher.on('refresh', ({ pairs }) => {
    input.refreshDependencyRelationCatalog('catalog_refresh', pairs);
    input.supervisor.updateMarketPairs(pairs);
    input.allowlist.seed(pairs.map((pair) => pair.marketId));
    input.updateTokenToMarketId(pairs);
    if (!input.isCatalogRefreshReady()) {
      input.setCatalogRefreshReady(true);
      input.supervisor.updateTradingEnabled(input.resolveEffectiveTradingEnabled());
      const blockedMs =
        input.catalogRefreshBlockStartedAtMs === null
          ? 0
          : Math.max(0, Date.now() - input.catalogRefreshBlockStartedAtMs);
      input.metrics.record({
        type: 'info',
        timestamp: Date.now(),
        data: { message: 'trading_unblocked_catalog_refresh_ready', blockedMs }
      });
    }
  });

  input.catalogRefresher.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    input.metrics.record({
      type: 'error',
      timestamp: Date.now(),
      data: { message: 'catalog_refresher_error', error: message }
    });
  });
}

export function configureOpsChecks(input: {
  opsAgent: OpsAgentLike;
  configStore: { getPolicy(): TradePolicy };
  env: Pick<Env, 'OPS_BOOK_REFRESH_INTERVAL_MS' | 'OPS_BOOK_REFRESH_STALE_MS'>;
  metrics: MetricsStore;
  supervisor: Pick<SupervisorLike, 'getOrderBooks' | 'getCircuitBreakerOpenMarkets'>;
  marketPairs: MarketPair[];
}): void {
  input.opsAgent.setChecks([
    {
      name: 'book_freshness',
      check: () => {
        const refresh = deriveBookRefreshSettings(input.configStore.getPolicy(), input.env);
        return createBookFreshnessCheck(
          () => input.supervisor.getOrderBooks(),
          refresh.maxBookStalenessMs,
          refresh.bookIdleCutoffMs
        ).check();
      }
    },
    {
      name: 'delayed_ack_rate',
      check: () => {
        const policy = input.configStore.getPolicy();
        return createDelayedAckRateCheck(
          input.metrics,
          () => input.marketPairs.map((pair) => pair.marketId),
          policy.orderVelocityWindowMs,
          policy.maxDelayedAckRate
        ).check();
      }
    },
    {
      name: 'decision_latency_p95',
      check: () => {
        const policy = input.configStore.getPolicy();
        return createLatencyPercentileCheck({
          metrics: input.metrics,
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
        const policy = input.configStore.getPolicy();
        return createPairedFillRateCheck({
          metrics: input.metrics,
          threshold: policy.minPairedFillRate,
          windowMs: policy.orderToTradeWindowMs
        }).check();
      }
    },
    createCircuitBreakerCheck(() => input.supervisor.getCircuitBreakerOpenMarkets())
  ]);
}

export function startRuntimeOpsServer(input: {
  env: Env;
  metrics: MetricsStore;
  allowlist: MarketAllowlist;
  opsAgent: OpsAgent;
  eventStore?: EventStore;
  portfolioAgent?: PortfolioAgent;
  learningAgent?: LearningAgent;
  configStore?: ConfigStore;
  tradingMode: TradingMode;
  tradingEnabled: boolean;
  tradingStateManager?: TradingStateManager;
  clobClient?: PolymarketClob;
  supervisor: Pick<SupervisorLike, 'runSyntheticOpportunityTest' | 'debugMarketDataOutlier'>;
  riskProfile: { id: RiskProfileId; source: string };
  applyRiskProfile: (
    profileId: RiskProfileId,
    overridePath?: string
  ) => {
    profile: { id: RiskProfileId; source: string };
    policy: TradePolicy;
    risk: RiskConfig;
    persisted: boolean;
  };
  applyConfigUpdate: (policy: TradePolicy, risk: RiskConfig) => void;
  recordRuntimeInfo: (message: string, data?: Record<string, unknown>) => void;
  recordRuntimeError: (message: string, error: string, data?: Record<string, unknown>) => void;
}): Promise<FastifyInstance | null> {
  if (!input.env.OPS_API_ENABLED) {
    return Promise.resolve(null);
  }

  const infraConfig = getInfraConfigSnapshot(input.env);
  return startOpsServer(
    {
      metrics: input.metrics,
      allowlist: input.allowlist,
      opsAgent: input.opsAgent,
      eventStore: input.eventStore,
      portfolioAgent: input.portfolioAgent,
      learningAgent: input.learningAgent,
      configStore: input.configStore,
      tradingMode: input.tradingMode,
      tradingEnabled: input.tradingEnabled,
      tradingStateManager: input.tradingStateManager,
      infraConfig,
      clobClient: input.clobClient,
      syntheticOpportunity: (options) => input.supervisor.runSyntheticOpportunityTest(options),
      debugMarketDataOutlier: (tokenId) => input.supervisor.debugMarketDataOutlier(tokenId),
      riskProfile: { ...input.riskProfile },
      applyRiskProfile: input.applyRiskProfile,
      applyConfigUpdate: input.applyConfigUpdate
    },
    {
      port: input.env.PORT,
      host: input.env.OPS_API_HOST,
      authToken: input.env.OPS_API_TOKEN,
      devSessionPrefillEnabled: input.env.OPS_DEV_SESSION_PREFILL_ENABLED,
      incidentsLimit: input.env.OPS_INCIDENTS_LIMIT,
      streamHeartbeatMs: input.env.OPS_STREAM_HEARTBEAT_MS
    }
  )
    .then((server) => {
      input.recordRuntimeInfo('ops_api_started', {
        host: input.env.OPS_API_HOST,
        port: input.env.PORT
      });
      return server;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      input.recordRuntimeError('ops_api_start_failed', message, {
        host: input.env.OPS_API_HOST,
        port: input.env.PORT
      });
      return null;
    });
}

export function registerShutdownSignals(input: {
  shutdown: (signal: string) => Promise<void>;
  recordPaperRunMarker: (phase: 'start' | 'stop', reason: string) => void;
}): void {
  process.on('SIGTERM', () => {
    input.recordPaperRunMarker('stop', 'SIGTERM');
    void input.shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    input.recordPaperRunMarker('stop', 'SIGINT');
    void input.shutdown('SIGINT');
  });
}
