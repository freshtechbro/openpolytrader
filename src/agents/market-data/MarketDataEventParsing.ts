import {
  coercePositiveNumber,
  type OrderBookDelta,
  type RawOrderBookSnapshot
} from '../../domain/orderbook.js';

interface RoutedMarketDataEvent {
  kind: 'book' | 'price_change' | 'tick_size_change' | 'best_bid_ask';
  payload: Record<string, unknown>;
}

interface PriceChangeUpdate {
  tokenId: string;
  delta: OrderBookDelta;
  expectedBest?: { bestBid?: number; bestAsk?: number };
}

const ROUTED_EVENT_KINDS = {
  price_change: 'price_change',
  tick_size_change: 'tick_size_change',
  best_bid_ask: 'best_bid_ask'
} as const;
const TOKEN_ID_KEYS = ['asset_id', 'token_id', 'market_id', 'marketId'] as const;
const PRICE_CHANGE_KEYS = ['price_changes', 'priceChanges', 'changes'] as const;
const BOOK_LEVEL_KEYS = {
  bid: {
    price: 'best_bid_price',
    size: 'best_bid_size',
    alt: 'best_bid'
  },
  ask: {
    price: 'best_ask_price',
    size: 'best_ask_size',
    alt: 'best_ask'
  }
} as const;

function toPayloadRecord(message: Record<string, unknown>): Record<string, unknown> {
  return message.payload && typeof message.payload === 'object'
    ? (message.payload as Record<string, unknown>)
    : message;
}

function toEventType(payload: Record<string, unknown>, envelopeType: unknown): string | undefined {
  const eventTypeRaw = payload.event_type ?? payload.type ?? envelopeType;
  return typeof eventTypeRaw === 'string' ? eventTypeRaw.toLowerCase() : undefined;
}

function toOptionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

function extractBookSides(
  payload: Record<string, unknown>
): Pick<RawOrderBookSnapshot, 'bids' | 'asks'> {
  const bids = Array.isArray(payload.buys)
    ? payload.buys
    : Array.isArray(payload.bids)
      ? payload.bids
      : [];
  const asks = Array.isArray(payload.sells)
    ? payload.sells
    : Array.isArray(payload.asks)
      ? payload.asks
      : [];
  return {
    bids: bids as RawOrderBookSnapshot['bids'],
    asks: asks as RawOrderBookSnapshot['asks']
  };
}

function parsePriceChangeEntry(
  entry: Record<string, unknown>,
  payload: Record<string, unknown>,
  fallbackTokenId: string | null,
  receivedAtMs: number
): PriceChangeUpdate | null {
  const tokenId = extractTokenId(entry) ?? fallbackTokenId;
  if (!tokenId) return null;

  const side = normalizeSide(entry.side ?? entry.book_side ?? entry.order_side);
  const price = coerceNumber(entry.price);
  const size = coerceNumber(entry.size);
  if (!side || price === null || size === null) return null;

  return {
    tokenId,
    delta: {
      side,
      price,
      size,
      receivedAtMs,
      exchangeTimestamp: coerceTimestampString(entry.timestamp ?? entry.ts ?? payload.timestamp ?? payload.ts),
      tickSize: coercePositiveNumber(entry.tick_size ?? entry.tickSize ?? payload.tick_size ?? payload.tickSize) ?? undefined,
      minOrderSize:
        coercePositiveNumber(entry.min_order_size ?? entry.minOrderSize ?? payload.min_order_size ?? payload.minOrderSize) ??
        undefined
    },
    expectedBest: buildExpectedBest(entry, payload)
  };
}

function extractAltBestLevel(value: unknown): { price: number; size: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const price = coerceNumber(record.price);
  const size = coerceNumber(record.size);
  return price !== null && size !== null ? { price, size } : null;
}

export function routeMarketDataMessage(message: Record<string, unknown>): RoutedMarketDataEvent | null {
  const payload = toPayloadRecord(message);
  const eventType = toEventType(payload, message.type);

  if (isBookEvent(eventType, payload)) {
    return { kind: 'book', payload };
  }

  if (eventType && eventType in ROUTED_EVENT_KINDS) {
    return {
      kind: ROUTED_EVENT_KINDS[eventType as keyof typeof ROUTED_EVENT_KINDS],
      payload
    };
  }
  return null;
}

export function extractTokenId(payload: Record<string, unknown>): string | null {
  for (const key of TOKEN_ID_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function normalizeWsBook(payload: Record<string, unknown>): RawOrderBookSnapshot {
  const { bids, asks } = extractBookSides(payload);

  return {
    bids,
    asks,
    timestamp: toOptionalString(coerceString(payload.timestamp ?? payload.ts)),
    hash: toOptionalString(coerceString(payload.hash)),
    tick_size: toOptionalString(coerceString(payload.tick_size ?? payload.tickSize)),
    min_order_size: toOptionalString(coerceString(payload.min_order_size ?? payload.minOrderSize))
  };
}

function extractPriceChanges(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of PRICE_CHANGE_KEYS) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
    }
  }
  return [];
}

export function extractPriceChangeUpdates(payload: Record<string, unknown>, receivedAtMs: number): PriceChangeUpdate[] {
  const changes = extractPriceChanges(payload);
  const entries = changes.length > 0 ? changes : [payload];
  const fallbackTokenId = extractTokenId(payload);
  const updates: PriceChangeUpdate[] = [];

  for (const entry of entries) {
    const update = parsePriceChangeEntry(entry, payload, fallbackTokenId, receivedAtMs);
    if (update) {
      updates.push(update);
    }
  }

  return updates;
}

export function normalizeSide(value: unknown): 'bid' | 'ask' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'buy' || normalized === 'bid') return 'bid';
  if (normalized === 'sell' || normalized === 'ask') return 'ask';
  return null;
}

export function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function coerceString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function coerceTimestampString(value: unknown): string | undefined {
  return coerceString(value) ?? undefined;
}

export function extractBestLevel(
  payload: Record<string, unknown>,
  side: 'bid' | 'ask'
): { price: number; size: number } | null {
  const keys = BOOK_LEVEL_KEYS[side];

  const price = coerceNumber(payload[keys.price] ?? payload[`${side}_price`]);
  const size = coerceNumber(payload[keys.size] ?? payload[`${side}_size`]);
  if (price !== null && size !== null) {
    return { price, size };
  }

  return extractAltBestLevel(payload[keys.alt]);
}

function buildExpectedBest(
  change: Record<string, unknown>,
  payload: Record<string, unknown>
): { bestBid?: number; bestAsk?: number } | undefined {
  const bestBid = coerceNumber(change.best_bid ?? change.best_bid_price ?? payload.best_bid ?? payload.best_bid_price);
  const bestAsk = coerceNumber(change.best_ask ?? change.best_ask_price ?? payload.best_ask ?? payload.best_ask_price);
  if (bestBid === null && bestAsk === null) return undefined;
  return {
    bestBid: bestBid ?? undefined,
    bestAsk: bestAsk ?? undefined
  };
}

function isBookEvent(eventType: string | undefined, payload: Record<string, unknown>): boolean {
  if (eventType === 'book' || eventType === 'agg_orderbook') {
    return true;
  }
  return (
    Array.isArray(payload.bids) ||
    Array.isArray(payload.asks) ||
    Array.isArray(payload.buys) ||
    Array.isArray(payload.sells)
  );
}
