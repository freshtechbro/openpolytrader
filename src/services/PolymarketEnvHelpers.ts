import type { Env } from '../config/env.js';
import { PolymarketClob, type AuthHeadersProvider } from './PolymarketClob.js';

export function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new Error(`Missing required ${label}`);
  }
  return trimmed;
}

export function createPolymarketClobFromEnv(
  env: Env,
  authProvider?: AuthHeadersProvider
): PolymarketClob {
  return new PolymarketClob({
    baseUrl: env.POLYMARKET_CLOB_BASE_URL,
    requestTimeoutMs: env.POLYMARKET_CLOB_TIMEOUT_MS,
    rateLimitPerSecond: env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
    rateLimitWindowMs: env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
    authProvider,
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
}
