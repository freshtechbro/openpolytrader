import 'dotenv/config';

import { loadEnv } from '../src/config/env.js';
import { MarketCatalog } from '../src/services/MarketCatalog.js';
import { PolymarketClob } from '../src/services/PolymarketClob.js';
import { PolymarketRealtime } from '../src/services/PolymarketRealtime.js';

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new Error(`Missing required ${label}`);
  }
  return trimmed;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const catalog = new MarketCatalog({ filePath: env.MARKET_CATALOG_PATH });
  const pairs = catalog.loadPairs();

  if (pairs.length === 0) {
    throw new Error('Market catalog contained no pairs');
  }

  const { marketId, yesTokenId, noTokenId } = pairs[0]!;
  const tokenId = requireNonEmpty(yesTokenId, 'yesTokenId');

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

  const book = await clob.getOrderBook(tokenId);
  const topBid = book.bids[0];
  const topAsk = book.asks[0];

  console.log('[polymarket] catalog ok', {
    marketId,
    yesTokenId,
    noTokenId
  });
  console.log('[polymarket] clob ok', {
    tokenId,
    bid: topBid ? { price: topBid.price, size: topBid.size } : null,
    ask: topAsk ? { price: topAsk.price, size: topAsk.size } : null,
    tick_size: book.tick_size ?? null,
    min_order_size: book.min_order_size ?? null,
    timestamp: book.timestamp ?? null
  });

  const realtime = new PolymarketRealtime({
    url: env.POLYMARKET_WS_URL,
    heartbeatIntervalMs: env.POLYMARKET_WS_HEARTBEAT_MS,
    reconnectBaseDelayMs: env.POLYMARKET_WS_RECONNECT_BASE_MS,
    reconnectMaxDelayMs: env.POLYMARKET_WS_RECONNECT_MAX_MS,
    reconnectJitterPct: env.POLYMARKET_WS_RECONNECT_JITTER_PCT
  });

  const wsTimeoutMs = 15000;
  const firstMessagePromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Polymarket WS message')), wsTimeoutMs);
    const onMessage = (payload: unknown) => {
      clearTimeout(timer);
      realtime.off('message', onMessage);
      resolve(payload);
    };
    realtime.on('message', onMessage);
  });

  await realtime.connect();
  realtime.subscribeMarkets([tokenId]);

  const firstMessage = await firstMessagePromise;
  const wsSummary = Array.isArray(firstMessage)
    ? { kind: 'array', length: firstMessage.length, head: firstMessage[0] }
    : firstMessage && typeof firstMessage === 'object'
      ? {
          kind: 'object',
          type: typeof (firstMessage as { type?: unknown }).type === 'string' ? (firstMessage as { type: string }).type : null,
          keys: Object.keys(firstMessage as Record<string, unknown>).slice(0, 20)
        }
      : { kind: typeof firstMessage, value: String(firstMessage).slice(0, 200) };

  console.log('[polymarket] ws ok', wsSummary);

  realtime.close();
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[polymarket] check failed: ${message}`);
  process.exitCode = 1;
});
