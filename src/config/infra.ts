import type { Env } from './env.js';
import {
  resolveAlchemyRpcBaseUrl,
  resolveAlchemyWsBaseUrl,
  resolveAnkrRpcBaseUrl,
  resolveChainstackRpcBaseUrl,
  resolveChainstackWsBaseUrl,
  resolvePrivateRpcBaseUrl,
  resolvePrivateWsBaseUrl
} from './rpcUrls.js';
import { resolvePolymarketClobBaseUrl, resolvePolymarketDataApiBaseUrl } from '../services/PolymarketUrls.js';

export interface InfraConfigSnapshot {
  ops: {
    healthIntervalMs: number;
    shutdownTimeoutMs: number;
    streamHeartbeatMs: number;
    incidentsLimit: number;
    reconciliationIntervalMs: number;
    reconciliationAfterIncidentDelayMs: number;
    reconciliationPositionSizeTolerance: number;
    bookRefreshIntervalMs: number;
    bookRefreshStaleMs: number;
    bookStaleQuarantineThreshold: number;
    bookStaleQuarantineWindowMs: number;
    bookStaleQuarantineCooldownMs: number;
    metricsMaxEvents: number;
    incidentsMaxEvents: number;
  };
  eventStore: {
    path: string;
    metricsRetentionDays: number;
    metricsPruneIntervalMs: number;
  };
  polymarket: {
    clobBaseUrl: string;
    clobTimeoutMs: number;
    clobRateLimitPerSecond: number;
    clobRateLimitWindowMs: number;
    clobActiveOrdersPath: string;
    dataApiBaseUrl: string;
    dataApiTimeoutMs: number;
    wsUrl: string;
    userWsUrl: string;
    wsHeartbeatMs: number;
    wsReconnectBaseMs: number;
    wsReconnectMaxMs: number;
    wsReconnectJitterPct: number;
    positionsUserConfigured: boolean;
  };
  rpc: {
    rateLimitWindowMs: number;
    waitConfirmations: number;
    waitTimeoutMs: number;
    providers: {
      alchemy: { rpcBaseUrl: string; wsBaseUrl: string; apiKeyConfigured: boolean; rps: number };
      quicknode: { rpcBaseUrlConfigured: boolean; rps: number };
      chainstack: { rpcBaseUrl: string; wsBaseUrl: string; rps: number };
      ankr: { rpcBaseUrl: string; rpsPhase1: number; rpsPhase2: number };
      privateNode: { rpcBaseUrl: string; wsBaseUrl: string; rps: number };
    };
  };
}

export function getInfraConfigSnapshot(env: Env): InfraConfigSnapshot {
  return {
    ops: {
      healthIntervalMs: env.OPS_HEALTH_INTERVAL_MS,
      shutdownTimeoutMs: env.OPS_SHUTDOWN_TIMEOUT_MS,
      streamHeartbeatMs: env.OPS_STREAM_HEARTBEAT_MS,
      incidentsLimit: env.OPS_INCIDENTS_LIMIT,
      reconciliationIntervalMs: env.OPS_RECONCILIATION_INTERVAL_MS,
      reconciliationAfterIncidentDelayMs: env.OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS,
      reconciliationPositionSizeTolerance: env.OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE,
      bookRefreshIntervalMs: env.OPS_BOOK_REFRESH_INTERVAL_MS,
      bookRefreshStaleMs: env.OPS_BOOK_REFRESH_STALE_MS,
      bookStaleQuarantineThreshold: env.OPS_BOOK_STALE_QUARANTINE_THRESHOLD,
      bookStaleQuarantineWindowMs: env.OPS_BOOK_STALE_QUARANTINE_WINDOW_MS,
      bookStaleQuarantineCooldownMs: env.OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS,
      metricsMaxEvents: env.METRICS_MAX_EVENTS,
      incidentsMaxEvents: env.INCIDENTS_MAX_EVENTS
    },
    eventStore: {
      path: env.EVENT_STORE_PATH,
      metricsRetentionDays: env.EVENT_STORE_METRICS_RETENTION_DAYS,
      metricsPruneIntervalMs: env.EVENT_STORE_METRICS_PRUNE_INTERVAL_MS
    },
    polymarket: {
      clobBaseUrl: resolvePolymarketClobBaseUrl(env.POLYMARKET_CLOB_BASE_URL),
      clobTimeoutMs: env.POLYMARKET_CLOB_TIMEOUT_MS,
      clobRateLimitPerSecond: env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
      clobRateLimitWindowMs: env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
      clobActiveOrdersPath: env.POLYMARKET_CLOB_ACTIVE_ORDERS_PATH,
      dataApiBaseUrl: resolvePolymarketDataApiBaseUrl(env.POLYMARKET_DATA_API_BASE_URL),
      dataApiTimeoutMs: env.POLYMARKET_DATA_API_TIMEOUT_MS,
      wsUrl: env.POLYMARKET_WS_URL,
      userWsUrl: env.POLYMARKET_USER_WS_URL,
      wsHeartbeatMs: env.POLYMARKET_WS_HEARTBEAT_MS,
      wsReconnectBaseMs: env.POLYMARKET_WS_RECONNECT_BASE_MS,
      wsReconnectMaxMs: env.POLYMARKET_WS_RECONNECT_MAX_MS,
      wsReconnectJitterPct: env.POLYMARKET_WS_RECONNECT_JITTER_PCT,
      positionsUserConfigured: Boolean(env.POLYMARKET_POSITIONS_USER?.trim())
    },
    rpc: {
      rateLimitWindowMs: env.RPC_RATE_LIMIT_WINDOW_MS,
      waitConfirmations: env.RPC_WAIT_CONFIRMATIONS,
      waitTimeoutMs: env.RPC_WAIT_TIMEOUT_MS,
      providers: {
        alchemy: {
          rpcBaseUrl: resolveAlchemyRpcBaseUrl(env.ALCHEMY_RPC_URL),
          wsBaseUrl: resolveAlchemyWsBaseUrl(env.ALCHEMY_WS_URL),
          apiKeyConfigured: Boolean(env.ALCHEMY_API_KEY),
          rps: env.ALCHEMY_RPC_RPS
        },
        quicknode: {
          rpcBaseUrlConfigured: Boolean(env.QUICKNODE_RPC_URL?.trim()),
          rps: env.QUICKNODE_RPC_RPS
        },
        chainstack: {
          rpcBaseUrl: resolveChainstackRpcBaseUrl(env.CHAINSTACK_RPC_URL),
          wsBaseUrl: resolveChainstackWsBaseUrl(env.CHAINSTACK_WS_URL),
          rps: env.CHAINSTACK_RPC_RPS
        },
        ankr: {
          rpcBaseUrl: resolveAnkrRpcBaseUrl(env.ANKR_RPC_URL),
          rpsPhase1: env.ANKR_RPC_RPS_PHASE1,
          rpsPhase2: env.ANKR_RPC_RPS_PHASE2
        },
        privateNode: {
          rpcBaseUrl: resolvePrivateRpcBaseUrl(env.PRIVATE_RPC_URL),
          wsBaseUrl: resolvePrivateWsBaseUrl(env.PRIVATE_WS_URL),
          rps: env.PRIVATE_RPC_RPS
        }
      }
    }
  };
}
