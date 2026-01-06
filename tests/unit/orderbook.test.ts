import { describe, it, expect } from 'vitest';

import { coercePositiveNumber, normalizeOrderBook, type OrderBookState } from '../../src/domain/orderbook.js';

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
