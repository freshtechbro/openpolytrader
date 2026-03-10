import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { createBasketLegOpportunity, parseBatchOutcome } from '../../src/agents/execution/ExecutionBasketUtils.js';
import {
  recordBookParameterMetrics,
  recordFallbackMetrics
} from '../../src/agents/market-data/MarketDataMetrics.js';
import {
  createInitialBasketExecutionState,
  transitionBasketExecutionState
} from '../../src/domain/basketExecution.js';
import {
  computeExecutableLowerBound,
  evaluateBaseGates,
  resolveTickSize
} from '../../src/domain/gateSupport.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

function makeOrderBook(overrides: Partial<OrderBookState> = {}): OrderBookState {
  const bids = overrides.bids ?? [{ price: 0.45, size: 150 }];
  const asks = overrides.asks ?? [{ price: 0.49, size: 120 }];
  return {
    tokenId: overrides.tokenId ?? 'token-1',
    bids,
    asks,
    tickSize: overrides.tickSize ?? 0.01,
    minOrderSize: overrides.minOrderSize ?? 5,
    exchangeTimestamp: overrides.exchangeTimestamp,
    hash: overrides.hash,
    lastUpdateMs: overrides.lastUpdateMs ?? 1_000,
    stableSinceMs: overrides.stableSinceMs ?? 900,
    bestBid: overrides.bestBid ?? bids[0],
    bestAsk: overrides.bestAsk ?? asks[0]
  };
}

function makeBasketOpportunity(): ArbitrageOpportunity {
  return {
    id: 'basket-1',
    marketId: 'market-1',
    yesTokenId: 'yes-1',
    noTokenId: 'no-1',
    yesPrice: 0.42,
    noPrice: 0.5,
    costPerSet: 0.92,
    edge: 0.08,
    tickSize: 0.01,
    maxSizeByDepth: 100,
    minOrderSize: 5,
    detectedAt: 1_000,
    gateReasons: [],
    pair: {
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1'
    },
    type: 'fw_basket',
    fw: {
      projectionId: 'projection-1',
      dependencyMode: 'deterministic',
      dependencyConfidence: 0.9,
      projectedEdge: 0.1,
      edgeLowerBound: 0.08,
      solverRuntimeMs: 12,
      solverStatus: 'optimal',
      projectionAgeMs: 20
    }
  };
}

describe('helper modules direct coverage', () => {
  it('records book parameter updates and fallback metrics directly', () => {
    const metrics = new MetricsStore(16);
    const previous = makeOrderBook();
    const next = makeOrderBook({ tickSize: 0.02, minOrderSize: 10 });

    recordBookParameterMetrics(metrics, 'token-1', previous, next, 2_000, 0.02, 10);
    recordFallbackMetrics(
      metrics,
      DEFAULT_TRADE_POLICY,
      'token-1',
      next,
      2_001,
      true,
      false,
      null,
      10
    );

    expect(metrics.recent('info', 1)[0]).toMatchObject({
      data: expect.objectContaining({
        message: 'book_params_updated',
        tokenId: 'token-1',
        resolvedTickSize: 0.02,
        resolvedMinOrderSize: 10
      })
    });
    expect(metrics.recent('book_fallback', 1)[0]).toMatchObject({
      data: expect.objectContaining({
        tokenId: 'token-1',
        usedTickFallback: true,
        usedMinOrderFallback: false
      })
    });
  });

  it('creates and transitions basket execution state directly', () => {
    const initial = createInitialBasketExecutionState({
      id: 'exec-1',
      opportunityId: 'opp-1',
      markets: [
        { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1', idempotencyKey: 'idem-1' },
        { marketId: 'market-2', yesTokenId: 'yes-2', noTokenId: 'no-2' }
      ],
      createdAtMs: 100
    });

    const submitted = transitionBasketExecutionState(initial, {
      type: 'LEG_SUBMITTED',
      atMs: 110,
      marketId: 'market-1'
    });
    const partial = transitionBasketExecutionState(submitted, {
      type: 'PARTIAL_FILL',
      atMs: 120,
      reason: 'one_leg_missed'
    });
    const complete = transitionBasketExecutionState(partial, {
      type: 'UNWIND_COMPLETE',
      atMs: 130
    });
    const cancelled = transitionBasketExecutionState(complete, {
      type: 'LEG_CANCELLED',
      atMs: 131,
      marketId: 'market-2',
      reason: 'cancelled_by_user'
    });
    const failedLeg = transitionBasketExecutionState(cancelled, {
      type: 'LEG_FAILED',
      atMs: 132,
      marketId: 'market-2'
    });
    const unwinding = transitionBasketExecutionState(failedLeg, {
      type: 'START_UNWIND',
      atMs: 133
    });
    const unwindFailed = transitionBasketExecutionState(unwinding, {
      type: 'UNWIND_FAILED',
      atMs: 134
    });
    const basketFailed = transitionBasketExecutionState(unwindFailed, {
      type: 'FAILED',
      atMs: 135
    });
    const completed = transitionBasketExecutionState(basketFailed, {
      type: 'COMPLETE',
      atMs: 136
    });

    expect(initial.legs[0]).toMatchObject({ marketId: 'market-1', state: 'pending', idempotencyKey: 'idem-1' });
    expect(submitted.legs[0]?.state).toBe('submitted');
    expect(partial).toMatchObject({ state: 'partial_fill', error: 'one_leg_missed' });
    expect(complete).toMatchObject({ state: 'complete', error: undefined });
    expect(cancelled.legs[1]).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_user' });
    expect(failedLeg).toMatchObject({ state: 'failed', error: 'leg_failed' });
    expect(unwinding.state).toBe('unwinding');
    expect(unwindFailed).toMatchObject({ state: 'failed', error: 'unwind_failed' });
    expect(basketFailed).toMatchObject({ state: 'failed', error: 'basket_failed' });
    expect(completed).toMatchObject({ state: 'complete', error: undefined });
  });

  it('evaluates lower bounds and direct gate helper branches', () => {
    const lowerBound = computeExecutableLowerBound({
      theoreticalEdge: 0.12,
      feeCost: 0.01,
      sweepSlippageCost: Number.NaN,
      stalenessPenalty: 0.02,
      stabilityPenalty: -1,
      executionRiskBuffer: 0.03
    });
    const gates = evaluateBaseGates({
      yesBook: makeOrderBook({ bestAsk: { price: 0, size: 10 } }),
      noBook: makeOrderBook({ tokenId: 'token-2' }),
      policy: DEFAULT_TRADE_POLICY,
      nowMs: 1_500
    });

    expect(lowerBound).toMatchObject({
      edgeLowerBound: 0.06,
      components: expect.objectContaining({
        theoreticalEdge: 0.12,
        sweepSlippageCost: 0,
        stabilityPenalty: 0
      })
    });
    expect(resolveTickSize(undefined, 0.01, 0.005, -1)).toBe(0.01);
    expect(gates).toMatchObject({
      fatal: true,
      reasons: ['yes_best_ask_invalid']
    });
  });

  it('builds basket leg opportunities and parses batch submission outcomes directly', () => {
    const basketOpportunity = makeBasketOpportunity();
    const leg = {
      marketId: 'market-2',
      yesTokenId: 'yes-2',
      noTokenId: 'no-2',
      yesPrice: 0.41,
      noPrice: 0.48,
      costPerSet: 0.89,
      projectedEdge: 0.11,
      edgeLowerBound: 0.09,
      maxSizeByDepth: 75,
      minOrderSize: 3,
      tickSize: 0.01
    };

    const opportunity = createBasketLegOpportunity(basketOpportunity, leg, 2_000);
    const partialOutcome = parseBatchOutcome(
      [{ status: 'LIVE' }, { status: 'DELAYED' }, { status: 'rejected' }],
      3
    );
    const submittedOutcome = parseBatchOutcome({ acceptedCount: 2 }, 2);
    const fallbackOutcome = parseBatchOutcome({ acceptedCount: 0 }, 2);
    const successOnlyOutcome = parseBatchOutcome({ success: true }, 4);
    const rejectedArrayOutcome = parseBatchOutcome([{ status: 'rejected' }], 1);
    const ordersOutcome = parseBatchOutcome({ orders: [{ status: 'LIVE' }] }, 1);
    const resultsOutcome = parseBatchOutcome({ results: [{ status: 'LIVE' }, { status: 'DELAYED' }] }, 2);
    const acceptedAliasOutcome = parseBatchOutcome({ accepted: 1.8 }, 2);
    const successFalseOutcome = parseBatchOutcome({ success: false }, 1);
    const nullOutcome = parseBatchOutcome(null, 1);

    expect(opportunity).toMatchObject({
      marketId: 'market-2',
      edge: 0.09,
      type: 'fw_projection',
      pair: {
        marketId: 'market-2',
        yesTokenId: 'yes-2',
        noTokenId: 'no-2'
      }
    });
    expect(opportunity.id).toContain('market-2:fw:');
    expect(partialOutcome).toMatchObject({
      outcome: 'partial',
      acceptedIndices: [0]
    });
    expect(submittedOutcome).toMatchObject({
      outcome: 'submitted',
      acceptedIndices: [0, 1]
    });
    expect(fallbackOutcome).toMatchObject({
      outcome: 'fallback',
      acceptedIndices: []
    });
    expect(successOnlyOutcome).toMatchObject({
      outcome: 'partial',
      acceptedIndices: []
    });
    expect(rejectedArrayOutcome).toMatchObject({
      outcome: 'fallback',
      acceptedIndices: []
    });
    expect(ordersOutcome).toMatchObject({
      outcome: 'submitted',
      acceptedIndices: [0]
    });
    expect(resultsOutcome).toMatchObject({
      outcome: 'partial',
      acceptedIndices: [0]
    });
    expect(acceptedAliasOutcome).toMatchObject({
      outcome: 'partial',
      acceptedIndices: [0]
    });
    expect(successFalseOutcome).toMatchObject({
      outcome: 'fallback',
      acceptedIndices: []
    });
    expect(nullOutcome).toMatchObject({
      outcome: 'fallback',
      acceptedIndices: []
    });
  });
});
