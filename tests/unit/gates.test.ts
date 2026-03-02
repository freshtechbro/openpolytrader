import { describe, it, expect } from 'vitest';

import {
  computeExecutableLowerBound,
  evaluateEvGates,
  evaluateFwBasketGates,
  evaluateFwProjectionGates,
  evaluateGates,
  evaluateGatesWithFees
} from '../../src/domain/gates.js';
import type { OrderBookState, OrderBookSnapshot } from '../../src/domain/orderbook.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { OrderBookLevel } from '../../src/domain/types.js';
import { FeeModel } from '../../src/domain/feeModel.js';

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
    const staleOffsetMs = DEFAULT_TRADE_POLICY.maxBookStalenessMs + 1000;
    const yesBook = makeBook(
      'yes',
      { price: 0.47, size: 500 },
      { price: 0.48, size: 500 },
      now - staleOffsetMs
    );
    const noBook = makeBook(
      'no',
      { price: 0.48, size: 500 },
      { price: 0.49, size: 500 },
      now - staleOffsetMs
    );

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_book_stale');
    expect(result.reasons).toContain('no_book_stale');
  });

  it('ignores staleness when requireFreshBook is false and uses fallback freshness', () => {
    const now = Date.now();
    const staleOffsetMs = 10_000;
    const yesBook = makeBook(
      'yes',
      { price: 0.47, size: 500 },
      { price: 0.48, size: 500 },
      now - staleOffsetMs
    );
    const noBook = makeBook(
      'no',
      { price: 0.48, size: 500 },
      { price: 0.49, size: 500 },
      now - staleOffsetMs
    );

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, requireFreshBook: false, maxBookStalenessMs: undefined, orderbookFreshnessMs: 1 },
      nowMs: now
    });

    expect(result.reasons).not.toContain('yes_book_stale');
    expect(result.reasons).not.toContain('no_book_stale');
  });

  it('flags leg sync skew when book updates are too far apart', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook(
      'no',
      { price: 0.48, size: 500 },
      { price: 0.49, size: 500 },
      now - 200
    );

    const policy = { ...DEFAULT_TRADE_POLICY, maxLegSkewMs: 100 };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('leg_sync_skew');
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

  it('fails when a book is crossed', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.6, size: 500 }, { price: 0.5, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_book_crossed');
  });

  it('fails when the NO book is crossed', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.6, size: 500 }, { price: 0.5, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('no_book_crossed');
  });

  it('flags no spread when no book is too wide', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.1, size: 500 }, { price: 0.6, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('no_spread_too_wide');
  });

  it('fails when best asks are missing', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = { ...yesBook, bestAsk: undefined, asks: [] };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing_best_ask');
  });

  it('fails when best ask prices are invalid', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 1.1, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_best_ask_invalid');
    expect(result.reasons).toContain('no_best_ask_invalid');
  });

  it('flags missing spread and top-of-book instability', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now, now);
    const noBook = { ...yesBook, bestBid: undefined };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing_spread');
    expect(result.reasons).toContain('unstable_top_of_book');
  });

  it('flags edge above max and below min order size', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.01, size: 0.001 }, { price: 0.01, size: 0.001 }, now);
    const noBook = makeBook('no', { price: 0.01, size: 0.001 }, { price: 0.01, size: 0.001 }, now);

    const policy = { ...DEFAULT_TRADE_POLICY, maxEdge: 0.5, minDepthLevels: 1, depthHeadroomFraction: 0.5 };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy,
      nowMs: now
    });

    expect(result.reasons).toContain('edge_above_max');
    expect(result.reasons).toContain('below_min_order_size');
  });

  it('flags tick misalignment and depth constraints', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 0.5 }, { price: 0.485, size: 0.5 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 0.5 }, { price: 0.505, size: 0.5 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, minDepthLevels: 1, depthHeadroomFraction: 1 },
      nowMs: now,
      desiredSize: 10
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_tick_misaligned');
    expect(result.reasons).toContain('no_tick_misaligned');
    expect(result.reasons).toContain('desired_size_exceeds_depth');
  });

  it('accounts for fees in gate evaluation', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);
    const feeModel = new FeeModel({ takerFeeBps: { polymarket: 50, kalshi: 50 } });

    const result = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, edgeRequired: 0.02 },
      nowMs: now,
      venue: 'polymarket',
      feeModel
    });

    expect(result.passed).toBe(true);
    expect(result.edge).toBeLessThan(0.03);
  });

  it('returns base decision when base gates fail', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = { ...yesBook, bestAsk: undefined, asks: [] };
    const feeModel = new FeeModel({ takerFeeBps: { polymarket: 50, kalshi: 50 } });

    const result = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now,
      venue: 'polymarket',
      feeModel
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing_best_ask');
  });

  it('flags edge below threshold after fees', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);
    const feeModel = new FeeModel({ takerFeeBps: { polymarket: 50, kalshi: 50 } });

    const result = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, edgeRequired: 0.025 },
      nowMs: now,
      venue: 'polymarket',
      feeModel
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('edge_below_threshold_after_fees');
  });

  it('falls back to base edgeInTicks when tick sizes are invalid', () => {
    const now = Date.now();
    const yesBook = { ...makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now), tickSize: 0 };
    const noBook = { ...makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now), tickSize: 0 };
    const feeModel = new FeeModel({ takerFeeBps: { polymarket: 0, kalshi: 0 } });

    const result = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, fallbackTickSize: 0 },
      nowMs: now,
      venue: 'polymarket',
      feeModel,
      tickSize: 0
    });

    expect(result.edgeInTicks).toBeUndefined();
  });

  it('flags edge above max after fees', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);
    const feeModel = new FeeModel({ takerFeeBps: { polymarket: -100, kalshi: 0 } });

    const result = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, maxEdge: 0.031 },
      nowMs: now,
      venue: 'polymarket',
      feeModel
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('edge_above_max_after_fees');
  });

  it('flags insufficient depth', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 0 }, { price: 0.48, size: 0 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 0 }, { price: 0.49, size: 0 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, minDepthLevels: 1, depthHeadroomFraction: 0.5 },
      nowMs: now
    });

    expect(result.reasons).toContain('insufficient_depth');
  });

  it('flags edge below threshold', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.49, size: 500 }, { price: 0.5, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.49, size: 500 }, { price: 0.5, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now
    });

    expect(result.reasons).toContain('edge_below_threshold');
  });

  it('flags edge below minimum ticks', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.49, size: 500 }, { price: 0.495, size: 500 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, edgeRequired: 0.01, maxEdge: 0.2, minEdgeTicks: 3 },
      nowMs: now
    });

    expect(result.reasons).toContain('edge_below_min_ticks');
  });

  it('flags insufficient depth buffer', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 100 }, { price: 0.48, size: 100 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 100 }, { price: 0.49, size: 100 }, now);

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, depthHeadroomFraction: 1, minDepthLevels: 1, depthBufferMultiplier: 1.5 },
      nowMs: now,
      desiredSize: 90
    });

    expect(result.reasons).toContain('insufficient_depth_buffer');
  });

  it('flags slippage when sweep exceeds tolerance', () => {
    const now = Date.now();
    const yesBook = {
      ...makeBook('yes', { price: 0.47, size: 10 }, { price: 0.48, size: 1 }, now),
      asks: [
        { price: 0.48, size: 1 },
        { price: 0.6, size: 1 }
      ],
      bestAsk: { price: 0.48, size: 1 }
    };
    const noBook = {
      ...makeBook('no', { price: 0.48, size: 10 }, { price: 0.49, size: 1 }, now),
      asks: [
        { price: 0.49, size: 1 },
        { price: 0.6, size: 1 }
      ],
      bestAsk: { price: 0.49, size: 1 }
    };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        depthHeadroomFraction: 1,
        minDepthLevels: 1,
        entrySlippageToleranceBps: 25
      },
      nowMs: now,
      desiredSize: 2
    });

    expect(result.reasons).toContain('yes_slippage_exceeded');
    expect(result.reasons).toContain('no_slippage_exceeded');
  });

  it('handles exhausted depth and tick size fallback', () => {
    const now = Date.now();
    const yesBook = {
      ...makeBook('yes', { price: 0.01, size: 0.1 }, { price: 0.01, size: 0.1 }, now),
      tickSize: 0,
      asks: [{ price: 0.01, size: 0.1 }],
      bestAsk: { price: 0.01, size: 0.1 }
    };
    const noBook = {
      ...makeBook('no', { price: 0.48, size: 0.1 }, { price: 0.49, size: 0.1 }, now),
      tickSize: 0,
      asks: [{ price: 0.49, size: 0.1 }],
      bestAsk: { price: 0.49, size: 0.1 }
    };

    const result = evaluateGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, minDepthLevels: 1, depthHeadroomFraction: 1 },
      nowMs: now,
      desiredSize: 1
    });

    expect(result.reasons).toContain('yes_depth_exhausted');
    expect(result.reasons).toContain('no_depth_exhausted');
    expect(result.edgeInTicks).toBeDefined();
  });
});

describe('computeExecutableLowerBound', () => {
  it('returns component-preserving lower bound arithmetic', () => {
    const result = computeExecutableLowerBound({
      theoreticalEdge: 0.04,
      feeCost: 0.005,
      sweepSlippageCost: 0.002,
      stalenessPenalty: 0.001,
      stabilityPenalty: 0.0005,
      executionRiskBuffer: 0.0015
    });

    expect(result.edgeLowerBound).toBeCloseTo(0.03, 10);
    expect(result.components.theoreticalEdge).toBeCloseTo(0.04, 10);
    expect(result.components.feeCost).toBeCloseTo(0.005, 10);
    expect(result.components.sweepSlippageCost).toBeCloseTo(0.002, 10);
    expect(result.components.stalenessPenalty).toBeCloseTo(0.001, 10);
    expect(result.components.stabilityPenalty).toBeCloseTo(0.0005, 10);
    expect(result.components.executionRiskBuffer).toBeCloseTo(0.0015, 10);
  });

  it('is monotonic with penalties and guards non-finite inputs', () => {
    const base = computeExecutableLowerBound({
      theoreticalEdge: 0.03,
      feeCost: 0.001,
      sweepSlippageCost: 0.001,
      stalenessPenalty: 0,
      stabilityPenalty: 0,
      executionRiskBuffer: 0
    });
    const penalized = computeExecutableLowerBound({
      theoreticalEdge: 0.03,
      feeCost: 0.002,
      sweepSlippageCost: 0.002,
      stalenessPenalty: 0.001,
      stabilityPenalty: 0.001,
      executionRiskBuffer: 0.001
    });
    const nonFinite = computeExecutableLowerBound({
      theoreticalEdge: Number.NaN,
      feeCost: Number.NEGATIVE_INFINITY,
      sweepSlippageCost: Number.POSITIVE_INFINITY,
      stalenessPenalty: Number.NaN,
      stabilityPenalty: Number.NaN,
      executionRiskBuffer: Number.NaN
    });

    expect(penalized.edgeLowerBound).toBeLessThan(base.edgeLowerBound);
    expect(nonFinite.components.theoreticalEdge).toBe(0);
    expect(nonFinite.components.feeCost).toBe(0);
    expect(nonFinite.components.sweepSlippageCost).toBe(0);
    expect(nonFinite.components.stalenessPenalty).toBe(0);
    expect(nonFinite.components.stabilityPenalty).toBe(0);
    expect(nonFinite.components.executionRiskBuffer).toBe(0);
    expect(nonFinite.edgeLowerBound).toBe(0);
  });
});

describe('evaluateFwBasketGates', () => {
  it('passes for valid basket markets', () => {
    const now = Date.now();
    const yes1 = makeBook('yes-1', { price: 0.47, size: 200 }, { price: 0.48, size: 200 }, now);
    const no1 = makeBook('no-1', { price: 0.48, size: 200 }, { price: 0.49, size: 200 }, now);
    const yes2 = makeBook('yes-2', { price: 0.46, size: 200 }, { price: 0.47, size: 200 }, now);
    const no2 = makeBook('no-2', { price: 0.49, size: 200 }, { price: 0.5, size: 200 }, now);
    const orderbooks = new Map<string, OrderBookState>([
      ['yes-1', yes1],
      ['no-1', no1],
      ['yes-2', yes2],
      ['no-2', no2]
    ]);

    const result = evaluateFwBasketGates({
      policy: { ...DEFAULT_TRADE_POLICY, fwBasketMinMarkets: 2, fwBasketMaxMarkets: 3 },
      nowMs: now,
      markets: [
        {
          marketId: 'm1',
          yesTokenId: 'yes-1',
          noTokenId: 'no-1',
          yesPrice: 0.48,
          noPrice: 0.49,
          costPerSet: 0.97,
          projectedEdge: 0.03,
          edgeLowerBound: 0.02,
          maxSizeByDepth: 100,
          minOrderSize: 0.001,
          tickSize: 0.01
        },
        {
          marketId: 'm2',
          yesTokenId: 'yes-2',
          noTokenId: 'no-2',
          yesPrice: 0.47,
          noPrice: 0.5,
          costPerSet: 0.97,
          projectedEdge: 0.03,
          edgeLowerBound: 0.02,
          maxSizeByDepth: 100,
          minOrderSize: 0.001,
          tickSize: 0.01
        }
      ],
      orderbooks,
      aggregateEdgeLowerBound: 0.04,
      projectionAgeMs: 10,
      desiredSize: 1
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.maxSizeByDepth).toBeGreaterThan(0);
  });

  it('fails when a market book is missing', () => {
    const now = Date.now();
    const orderbooks = new Map<string, OrderBookState>();
    const result = evaluateFwBasketGates({
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now,
      markets: [
        {
          marketId: 'm1',
          yesTokenId: 'yes-missing',
          noTokenId: 'no-missing',
          yesPrice: 0.48,
          noPrice: 0.49,
          costPerSet: 0.97,
          projectedEdge: 0.03,
          edgeLowerBound: 0.02,
          maxSizeByDepth: 100,
          minOrderSize: 0.001,
          tickSize: 0.01
        }
      ],
      orderbooks,
      aggregateEdgeLowerBound: 0.02,
      projectionAgeMs: 10
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('missing_orderbook'))).toBe(true);
  });
});

describe('evaluateEvGates', () => {
  it('returns base fatal errors for EV gate evaluation', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = { ...makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now), bestAsk: undefined, asks: [] };

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0 },
      nowMs: now,
      side: 'yes',
      evEdge: 0.1,
      confidence: 0.9
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing_best_ask');
  });

  it('rejects non-finite ev inputs', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0 },
      nowMs: now,
      side: 'yes',
      evEdge: Number.NaN,
      confidence: Number.POSITIVE_INFINITY
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('ev_edge_invalid');
    expect(result.reasons).toContain('ev_confidence_invalid');
  });

  it('enforces min edge ticks for EV', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0, minEdgeTicks: 3 },
      nowMs: now,
      side: 'yes',
      evEdge: 0.02,
      confidence: 0.9
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('edge_below_min_ticks');
  });

  it('enforces maxEdge for EV', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0, evMaxEdge: 0.05 },
      nowMs: now,
      side: 'yes',
      evEdge: 0.2,
      confidence: 0.9
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('ev_edge_above_max');
  });

  it('flags EV slippage and depth exhaustion', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 50 }, { price: 0.48, size: 50 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 50 }, { price: 0.49, size: 50 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0, evConfidenceMin: 0, entrySlippageToleranceBps: 1 },
      nowMs: now,
      side: 'yes',
      evEdge: 0.2,
      confidence: 0.9,
      desiredSize: 400
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('yes_depth_exhausted');
    expect(result.reasons).toContain('yes_slippage_exceeded');
  });

  it('flags EV depth constraints and edge threshold', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 0.0001 }, { price: 0.48, size: 0.0001 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 0.0001 }, { price: 0.49, size: 0.0001 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0.1, evConfidenceMin: 0, depthHeadroomFraction: 0 },
      nowMs: now,
      side: 'yes',
      evEdge: 0.01,
      confidence: 0.9
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('insufficient_depth');
    expect(result.reasons).toContain('below_min_order_size');
    expect(result.reasons).toContain('ev_edge_below_threshold');
  });

  it('handles non-positive no-side ask prices as base validation failures', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 50 }, { price: 0.48, size: 50 }, now);
    const noBook = {
      ...makeBook('no', { price: 0.48, size: 2 }, { price: 0, size: 1 }, now),
      asks: [{ price: 0, size: 1 }],
      bestAsk: { price: 0, size: 1 }
    };

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0, evConfidenceMin: 0, depthHeadroomFraction: 1, minDepthLevels: 1 },
      nowMs: now,
      side: 'no',
      evEdge: 0.1,
      confidence: 0.9,
      desiredSize: 5
    });

    expect(result.reasons).toContain('no_best_ask_invalid');
    expect(result.reasons).not.toContain('yes_best_ask_invalid');
  });

  it('uses no-side depth/slippage reason labels when EV no-side sweeps exceed depth', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 10 }, { price: 0.48, size: 10 }, now);
    const noBook = {
      ...makeBook('no', { price: 0.48, size: 10 }, { price: 0.49, size: 1 }, now),
      asks: [
        { price: 0.49, size: 1 },
        { price: 0.7, size: 1 }
      ],
      bestAsk: { price: 0.49, size: 1 }
    };

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        evEdgeRequired: 0,
        evConfidenceMin: 0,
        depthHeadroomFraction: 1,
        minDepthLevels: 1,
        entrySlippageToleranceBps: 25
      },
      nowMs: now,
      side: 'no',
      evEdge: 0.1,
      confidence: 0.9,
      desiredSize: 3
    });

    expect(result.reasons).toContain('no_depth_exhausted');
    expect(result.reasons).toContain('no_slippage_exceeded');
    expect(result.reasons).not.toContain('yes_depth_exhausted');
    expect(result.reasons).not.toContain('yes_slippage_exceeded');
  });

  it('falls back to maxEdge and confidenceMin when EV max/floor are non-finite', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateEvGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        evEdgeRequired: 0.01,
        evMaxEdge: Number.NaN,
        maxEdge: 0.02,
        evConfidenceMin: 0.3,
        evConfidenceMinFloor: Number.NaN
      },
      nowMs: now,
      side: 'yes',
      evEdge: 0.05,
      confidence: 0.2
    });

    expect(result.reasons).toContain('ev_edge_above_max');
    expect(result.reasons).toContain('ev_confidence_below_min');
  });
});

describe('evaluateFwProjectionGates', () => {
  it('passes when base gates and FW projection checks pass', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy: DEFAULT_TRADE_POLICY,
      nowMs: now,
      projection: {
        projectionId: 'proj-1',
        dependencyMode: 'hybrid',
        dependencyConfidence: 0.9,
        projectedEdge: 0.04,
        edgeLowerBound: 0.02,
        solverRuntimeMs: 20,
        solverStatus: 'feasible',
        projectionAgeMs: 50
      }
    });

    expect(result.passed).toBe(true);
    expect(result.edge).toBeCloseTo(0.02, 6);
  });

  it('uses FW lower bound edge semantics for FW projection diagnostics', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.49, size: 500 }, { price: 0.5, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.49, size: 500 }, { price: 0.5, size: 500 }, now);

    const result = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        edgeRequired: 0.0005,
        fwMinEdgeThreshold: 0.0001,
        topOfBookStabilityMs: 0
      },
      nowMs: now,
      projection: {
        projectionId: 'proj-edge-mismatch',
        dependencyMode: 'deterministic',
        dependencyConfidence: 1,
        projectedEdge: 0.01,
        edgeLowerBound: 0.005,
        solverRuntimeMs: 5,
        solverStatus: 'optimal',
        projectionAgeMs: 10
      }
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).not.toContain('edge_below_threshold');
    expect(result.edge).toBeCloseTo(0.005, 6);
  });

  it('reports FW lower bound when only FW lower bound fails', () => {
    const now = Date.now();
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, now);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, now);

    const result = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        edgeRequired: 0.02,
        fwMinEdgeThreshold: 0.04
      },
      nowMs: now,
      projection: {
        projectionId: 'proj-lower-bound-only',
        dependencyMode: 'deterministic',
        dependencyConfidence: 1,
        projectedEdge: 0.03,
        edgeLowerBound: 0.005,
        solverRuntimeMs: 7,
        solverStatus: 'optimal',
        projectionAgeMs: 5
      }
    });

    expect(result.passed).toBe(false);
    expect(result.edge).toBeCloseTo(0.005, 6);
    expect(result.reasons).toContain('fw_edge_lower_bound_fail');
    expect(result.reasons).not.toContain('edge_below_threshold');
  });

  it('adds FW-specific rejection reasons', () => {
    const now = Date.now();
    const stale = now - (DEFAULT_TRADE_POLICY.maxBookStalenessMs + 1000);
    const yesBook = makeBook('yes', { price: 0.47, size: 500 }, { price: 0.48, size: 500 }, stale);
    const noBook = makeBook('no', { price: 0.48, size: 500 }, { price: 0.49, size: 500 }, stale);

    const result = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwDependencyMinConfidence: 0.8,
        fwMaxProjectionAgeMs: 100,
        fwMinEdgeThreshold: 0.01
      },
      nowMs: now,
      projection: {
        projectionId: 'proj-2',
        dependencyMode: 'hybrid',
        dependencyConfidence: 0.2,
        projectedEdge: 0.02,
        edgeLowerBound: 0.001,
        solverRuntimeMs: 120,
        solverStatus: 'timeout',
        projectionAgeMs: 500
      }
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('fw_dependency_low_confidence');
    expect(result.reasons).toContain('fw_projection_stale');
    expect(result.reasons).toContain('fw_edge_lower_bound_fail');
    expect(result.reasons).toContain('fw_solver_status');
    expect(result.reasons).toContain('yes_book_stale');
    expect(result.reasons).toContain('no_book_stale');
  });

  it('does not enforce base min-edge-ticks rejection for FW projection gates', () => {
    const now = Date.now();
    const yesBook = makeBook(
      'yes',
      { price: 0.48, size: 500 },
      { price: 0.49, size: 500 },
      now
    );
    const noBook = makeBook(
      'no',
      { price: 0.5, size: 500 },
      { price: 0.51, size: 500 },
      now
    );

    const result = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        minEdgeTicks: 3
      },
      nowMs: now,
      projection: {
        projectionId: 'proj-3',
        dependencyMode: 'deterministic',
        dependencyConfidence: 1,
        projectedEdge: 0.02,
        edgeLowerBound: 0.005,
        solverRuntimeMs: 10,
        solverStatus: 'optimal',
        projectionAgeMs: 10
      },
      tickSize: 0.01
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).not.toContain('edge_below_min_ticks');
  });
});
