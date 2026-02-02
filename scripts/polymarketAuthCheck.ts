import 'dotenv/config';

import { loadEnv } from '../src/config/env.js';
import { ApiError, PolymarketClob } from '../src/services/PolymarketClob.js';
import { createPolymarketHmacAuthProvider } from '../src/services/PolymarketAuth.js';
import { resolvePolymarketL2Creds } from '../src/services/PolymarketApiCreds.js';

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new Error(`Missing required ${label}`);
  }
  return trimmed;
}

async function main(): Promise<void> {
  const env = loadEnv();

  const resolved = await resolvePolymarketL2Creds(env);
  if (!resolved) {
    requireNonEmpty(env.POLYMARKET_API_KEY, 'POLYMARKET_API_KEY');
    requireNonEmpty(env.POLYMARKET_API_SECRET, 'POLYMARKET_API_SECRET');
    requireNonEmpty(env.POLYMARKET_PASSPHRASE, 'POLYMARKET_PASSPHRASE');
    requireNonEmpty(env.POLYMARKET_POSITIONS_USER, 'POLYMARKET_POSITIONS_USER');
    throw new Error('Missing Polymarket credentials (set API key + secret + passphrase + address or L1 private key)');
  }

  console.log('[polymarket] creds resolved', {
    derived: resolved.derived,
    address: resolved.address
  });

  const authProvider = createPolymarketHmacAuthProvider({
    apiKey: resolved.apiKey,
    secret: resolved.secret,
    passphrase: resolved.passphrase,
    address: resolved.address
  });

  const clob = new PolymarketClob({
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

  const orders = await clob.getActiveOrders();
  console.log('[polymarket] auth ok', {
    activeOrders: orders.length
  });
}

await main().catch((error) => {
  if (error instanceof ApiError) {
    console.error('[polymarket] auth check failed', {
      status: error.status,
      body: error.body ?? null
    });
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[polymarket] auth check failed: ${message}`);
  process.exitCode = 1;
});
