import { describe, it, expect } from 'vitest';

import {
  applyOrderBookDelta,
  coercePositiveNumber,
  normalizeOrderBook,
  type OrderBookState
} from '../../src/domain/orderbook.js';

describe('coercePositiveNumber', () => {
  it('returns numeric values when valid', () => {
    expect(coercePositiveNumber(0.01)).toBe(0.01);
  });

  it('parses numeric strings when valid', () => {
    expect(coercePositiveNumber('0.005')).toBe(0.005);
  });

  it('returns null for invalid or non-positive values', () => {
    expect(coercePositiveNumber('')).toBeNull();
    expect(coercePositiveNumber(-1)).toBeNull();
    expect(coercePositiveNumber('nope')).toBeNull();
  });
});

describe('normalizeOrderBook', () => {
  it('uses fallback defaults when raw and previous values are missing', () => {
    const now = Date.now();
    const normalized = normalizeOrderBook(
      'token-1',
      { bids: [], asks: [] },
      now,
      { tickSize: 0.02, minOrderSize: 0.005 }
    );

    expect(normalized.tickSize).toBe(0.02);
    expect(normalized.minOrderSize).toBe(0.005);
  });

  it('prefers previous values when raw values are missing', () => {
    const now = Date.now();
    const previous: OrderBookState = {
      tokenId: 'token-1',
      bids: [],
      asks: [],
      tickSize: 0.01,
      minOrderSize: 0.001,
      lastUpdateMs: now - 1000,
      stableSinceMs: now - 1000
    };

    const normalized = normalizeOrderBook(
      'token-1',
      { bids: [], asks: [] },
      now,
      { tickSize: 0.02, minOrderSize: 0.005 },
      previous
    );

    expect(normalized.tickSize).toBe(0.01);
    expect(normalized.minOrderSize).toBe(0.001);
  });
});

describe('applyOrderBookDelta', () => {
  const baseBook = (overrides: Partial<OrderBookState> = {}): OrderBookState => ({
    tokenId: 'token-1',
    bids: [
      { price: 0.49, size: 10 },
      { price: 0.48, size: 8 }
    ],
    asks: [
      { price: 0.51, size: 5 },
      { price: 0.52, size: 3 }
    ],
    tickSize: 0.01,
    minOrderSize: 0.001,
    lastUpdateMs: 1000,
    stableSinceMs: 1000,
    bestBid: { price: 0.49, size: 10 },
    bestAsk: { price: 0.51, size: 5 },
    ...overrides
  });

  it('updates non-best levels without resetting stableSinceMs', () => {
    const book = baseBook();
    const next = applyOrderBookDelta(book, {
      side: 'bid',
      price: 0.48,
      size: 7,
      receivedAtMs: 2000
    });

    expect(next.bestBid?.price).toBe(0.49);
    expect(next.bids.find((level) => level.price === 0.48)?.size).toBe(7);
    expect(next.stableSinceMs).toBe(1000);
    expect(next.lastUpdateMs).toBe(2000);
  });

  it('removes a best level and resets stableSinceMs', () => {
    const book = baseBook();
    const next = applyOrderBookDelta(book, {
      side: 'ask',
      price: 0.51,
      size: 0,
      receivedAtMs: 3000
    });

    expect(next.bestAsk?.price).toBe(0.52);
    expect(next.stableSinceMs).toBe(3000);
  });

  it('adds a new best level and updates tick size', () => {
    const book = baseBook();
    const next = applyOrderBookDelta(book, {
      side: 'bid',
      price: 0.5,
      size: 2,
      receivedAtMs: 4000,
      tickSize: 0.02
    });

    expect(next.bestBid?.price).toBe(0.5);
    expect(next.tickSize).toBe(0.02);
    expect(next.stableSinceMs).toBe(4000);
  });
});
