import { describe, it, expect } from 'vitest';

import { evaluateEvGates, evaluateGates, evaluateGatesWithFees } from '../../src/domain/gates.js';
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

describe('evaluateEvGates', () => {
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
});
