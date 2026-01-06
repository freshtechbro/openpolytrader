import { describe, it, expect } from 'vitest';

import { FeeModel, type FeeModelConfig } from '../../src/domain/feeModel.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { marketKey } from '../../src/domain/market.js';
import { opportunityId } from '../../src/domain/opportunity.js';
import {
  normalizeOrderBook,
  normalizeLevels,
  depthAtTopLevels,
  sweepCost,
  spread,
  isAlignedToTick
} from '../../src/domain/orderbook.js';
import { parseExchangeTimestamp, isOutOfSequence } from '../../src/domain/sequence.js';

const DEFAULT_ORDERBOOK = {
  tickSize: DEFAULT_TRADE_POLICY.fallbackTickSize,
  minOrderSize: DEFAULT_TRADE_POLICY.fallbackMinOrderSize
};

describe('domain utils', () => {
  it('computes fee model fractions and net edge', () => {
    const model = new FeeModel({ takerFeeBps: { polymarket: 35, kalshi: 50 } });
    expect(model.takerFeeFraction('polymarket')).toBeCloseTo(0.0035);
    expect(model.netEdge('polymarket', 0.02)).toBeCloseTo(0.013);
    expect(model.takerFeeFraction('kalshi')).toBeCloseTo(0.005);
    expect(model.takerFeeFraction('polymarket')).toBeGreaterThan(0);
  });

  it('defaults fee to zero when venue is missing', () => {
    const config = { takerFeeBps: { polymarket: 35 } } as unknown as FeeModelConfig;
    const model = new FeeModel(config);
    expect(model.takerFeeFraction('kalshi')).toBe(0);
  });

  it('generates market keys and opportunity ids', () => {
    expect(marketKey({ marketId: 'm1', yesTokenId: 'y', noTokenId: 'n' })).toBe('m1');
    expect(opportunityId('m1', 0.5, 0.49, 123)).toBe('m1:0.5000:0.4900:123');
  });

  it('normalizes orderbook levels and snapshots', () => {
    const bids = normalizeLevels(
      [
        { price: '0.4', size: '10' },
        { price: '0.5', size: '5' },
        { price: 'bad', size: '2' }
      ],
      'bid'
    );
    const asks = normalizeLevels(
      [
        { price: '0.6', size: '7' },
        { price: '0.55', size: '3' }
      ],
      'ask'
    );

    expect(bids[0].price).toBe(0.5);
    expect(asks[0].price).toBe(0.55);

    const prev = normalizeOrderBook(
      'token-1',
      { bids: [{ price: '0.5', size: '5' }], asks: [{ price: '0.55', size: '3' }] },
      1000,
      DEFAULT_ORDERBOOK
    );
    const next = normalizeOrderBook(
      'token-1',
      { bids: [{ price: '0.5', size: '5' }], asks: [{ price: '0.55', size: '3' }] },
      1100,
      DEFAULT_ORDERBOOK,
      prev
    );

    expect(next.stableSinceMs).toBe(prev.stableSinceMs);
    expect(next.tickSize).toBe(0.01);
    expect(next.minOrderSize).toBe(0.001);

    const prevMissingStable = { ...prev, stableSinceMs: undefined } as typeof prev;
    const nextWithFallback = normalizeOrderBook(
      'token-1',
      { bids: [{ price: '0.5', size: '5' }], asks: [{ price: '0.55', size: '3' }] },
      1150,
      DEFAULT_ORDERBOOK,
      prevMissingStable
    );
    expect(nextWithFallback.stableSinceMs).toBe(1150);

    const unstable = normalizeOrderBook(
      'token-1',
      { bids: [{ price: '0.49', size: '5' }], asks: [{ price: '0.56', size: '3' }] },
      1200,
      DEFAULT_ORDERBOOK,
      prev
    );
    expect(unstable.stableSinceMs).toBe(1200);

    const empty = normalizeOrderBook('token-1', {}, 1300, DEFAULT_ORDERBOOK, prev);
    expect(empty.bids.length).toBe(0);
    expect(empty.asks.length).toBe(0);
  });

  it('computes depth, sweep cost, and spread', () => {
    const levels = [
      { price: 0.6, size: 5 },
      { price: 0.61, size: 7 },
      { price: 0.62, size: 2 }
    ];

    expect(depthAtTopLevels(levels, 2)).toBe(12);

    const sweep = sweepCost(levels, 10);
    expect(sweep.filledSize).toBe(10);
    expect(sweep.exhausted).toBe(false);
    expect(sweep.averagePrice).toBeGreaterThan(0.6);

    const emptySweep = sweepCost([], 10);
    expect(emptySweep.averagePrice).toBe(0);

    const book = normalizeOrderBook(
      'token-2',
      {
        bids: [{ price: '0.4', size: '2' }],
        asks: [{ price: '0.45', size: '2' }]
      },
      2000,
      DEFAULT_ORDERBOOK
    );
    expect(spread(book)).toBeCloseTo(0.05);
  });

  it('validates tick alignment', () => {
    expect(isAlignedToTick(0.03, 0.01)).toBe(true);
    expect(isAlignedToTick(0.025, 0.01)).toBe(false);
    expect(isAlignedToTick(0.1, 0)).toBe(false);
  });

  it('parses exchange timestamps and detects ordering', () => {
    expect(parseExchangeTimestamp('1700000000')).toBe(1700000000);
    expect(parseExchangeTimestamp('2024-01-01T00:00:00Z')).not.toBeNull();
    expect(parseExchangeTimestamp('')).toBeNull();

    expect(isOutOfSequence('100', '90')).toBe(true);
    expect(isOutOfSequence('100', '110')).toBe(false);
    expect(isOutOfSequence('bad', '110')).toBe(false);
  });
});
