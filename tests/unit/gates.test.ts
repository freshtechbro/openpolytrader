import { describe, it, expect } from 'vitest';

import { evaluateGates } from '../../src/domain/gates.js';
import type { OrderBookState, OrderBookSnapshot } from '../../src/domain/orderbook.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { OrderBookLevel } from '../../src/domain/types.js';

function makeBook(
  tokenId: string,
  bid: OrderBookLevel,
  ask: OrderBookLevel,
  nowMs: number,
  stableSinceMs = nowMs - 500
): OrderBookState {
  const snapshot: OrderBookSnapshot = {
    bids: [bid, { price: bid.price - 0.01, size: 200 }],
    asks: [ask, { price: ask.price + 0.01, size: 200 }],
    tickSize: 0.01,
    minOrderSize: 0.001
  };

  return {
    tokenId,
    ...snapshot,
    lastUpdateMs: nowMs,
    stableSinceMs,
    bestBid: bid,
    bestAsk: ask
  };
}

describe('evaluateGates', () => {
  it('passes when books are fresh, stable, and edge clears threshold', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(true);
    expect(result.edge).toBeCloseTo(0.03, 5);
  });

  it('fails when orderbooks are stale', () => {
    const now = Date.now();
    const yesBook = makeBook(
      'yes',
      { price: 0.47, size: 500 },
      { price: 0.48, size: 500 },
      now - 1000
    );
    const noBook = makeBook(
      'no',
      { price: 0.48, size: 500 },
      { price: 0.49, size: 500 },
      now - 1000
    );

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('stale_orderbook');
  });

  it('fails when spread is too wide', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.1, size: 500 }, { price: 0.6, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_spread_too_wide');
  });
});
