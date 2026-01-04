import type { OrderBookResponse } from '../services/PolymarketClob.js';
import type { OrderBookLevel } from './types.js';

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tickSize: number;
  minOrderSize: number;
  exchangeTimestamp?: string;
  hash?: string;
}

export interface OrderBookState extends OrderBookSnapshot {
  tokenId: string;
  lastUpdateMs: number;
  stableSinceMs: number;
  bestBid?: OrderBookLevel;
  bestAsk?: OrderBookLevel;
}

export function normalizeOrderBook(
  tokenId: string,
  raw: OrderBookResponse,
  receivedAtMs: number,
  previous?: OrderBookState
): OrderBookState {
  const bids = normalizeLevels(raw.bids ?? [], 'bid');
  const asks = normalizeLevels(raw.asks ?? [], 'ask');
  const bestBid = bids[0];
  const bestAsk = asks[0];

  const tickSize = Number(raw.tick_size ?? previous?.tickSize ?? 0.01);
  const minOrderSize = Number(raw.min_order_size ?? previous?.minOrderSize ?? 0.001);

  const previousBestBid = previous?.bestBid;
  const previousBestAsk = previous?.bestAsk;

  const isStable =
    previousBestBid?.price === bestBid?.price &&
    previousBestBid?.size === bestBid?.size &&
    previousBestAsk?.price === bestAsk?.price &&
    previousBestAsk?.size === bestAsk?.size;

  const stableSinceMs = isStable ? previous?.stableSinceMs ?? receivedAtMs : receivedAtMs;

  return {
    tokenId,
    bids,
    asks,
    tickSize,
    minOrderSize,
    exchangeTimestamp: raw.timestamp,
    hash: raw.hash,
    lastUpdateMs: receivedAtMs,
    stableSinceMs,
    bestBid,
    bestAsk
  };
}

export function normalizeLevels(
  levels: Array<{ price: string; size: string }>,
  side: 'bid' | 'ask'
): OrderBookLevel[] {
  const parsed = levels
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size)
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0);

  return parsed.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
}

export function depthAtTopLevels(levels: OrderBookLevel[], count = 3): number {
  return levels.slice(0, count).reduce((sum, level) => sum + level.size, 0);
}

export function sweepCost(asks: OrderBookLevel[], size: number): {
  totalCost: number;
  filledSize: number;
  averagePrice: number;
  exhausted: boolean;
} {
  let remaining = size;
  let totalCost = 0;
  let filled = 0;

  for (const level of asks) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    totalCost += take * level.price;
    filled += take;
    remaining -= take;
  }

  return {
    totalCost,
    filledSize: filled,
    averagePrice: filled > 0 ? totalCost / filled : 0,
    exhausted: remaining > 0
  };
}

export function spread(book: OrderBookState): number | null {
  if (!book.bestBid || !book.bestAsk) {
    return null;
  }
  return Math.max(book.bestAsk.price - book.bestBid.price, 0);
}

export function isAlignedToTick(price: number, tickSize: number): boolean {
  if (tickSize <= 0) return false;
  const remainder = price % tickSize;
  return remainder < 1e-9 || Math.abs(remainder - tickSize) < 1e-9;
}
