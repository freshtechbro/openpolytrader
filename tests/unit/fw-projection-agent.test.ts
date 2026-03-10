import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { DependencyMarketInput } from '../../src/domain/dependency.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { FwProjectionAgent } from '../../src/agents/projection/FwProjectionAgent.js';
import { IpOracleClient } from '../../src/services/ip-oracle/IpOracleClient.js';

function makeProjectionBook(tokenId: string, ask: number, bid: number, nowMs: number): OrderBookState {
  return {
    tokenId,
    bids: [{ price: bid, size: 100 }],
    asks: [{ price: ask, size: 100 }],
    tickSize: 0.001,
    minOrderSize: 1,
    lastUpdateMs: nowMs,
    stableSinceMs: nowMs - 1_000,
    bestBid: { price: bid, size: 100 },
    bestAsk: { price: ask, size: 100 }
  };
}

function buildAgent(options?: {
  metrics?: MetricsStore;
  assignment?: Record<string, number>;
}) {
  const oracle = new IpOracleClient({
    timeoutMs: 100,
    circuitFailureThreshold: 3,
    circuitCooldownMs: 1000,
    fallbackSolver: async (request) => ({
      requestId: request.requestId,
      loopId: request.loopId,
      iteration: request.iteration,
      status: 'optimal',
      objectiveValue: 0.1,
      assignment: options?.assignment ?? { 'x_m-1': 1, 'x_m-2': 1, 'x_m-3': 1 },
      runtimeMs: 3,
      gap: 0,
      relativeGap: 0,
      bestBound: 0
    })
  });

  return new FwProjectionAgent({
    resolverConfig: {
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    },
    oracleClient: oracle,
    metrics: options?.metrics
  });
}

function buildUniverse(now: number): {
  orderbooks: Map<string, OrderBookState>;
  marketUniverse: DependencyMarketInput[];
} {
  return {
    orderbooks: new Map<string, OrderBookState>([
      ['yes-1', makeProjectionBook('yes-1', 0.48, 0.47, now)],
      ['no-1', makeProjectionBook('no-1', 0.48, 0.47, now)],
      ['yes-2', makeProjectionBook('yes-2', 0.479, 0.469, now)],
      ['no-2', makeProjectionBook('no-2', 0.479, 0.469, now)],
      ['yes-3', makeProjectionBook('yes-3', 0.478, 0.468, now)],
      ['no-3', makeProjectionBook('no-3', 0.478, 0.468, now)]
    ]),
    marketUniverse: [
      {
        marketId: 'm-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        category: 'election',
        tags: ['usa', 'state-a'],
        question: 'Will candidate A win state A?'
      },
      {
        marketId: 'm-2',
        yesTokenId: 'yes-2',
        noTokenId: 'no-2',
        category: 'election',
        tags: ['usa', 'state-b'],
        question: 'Will candidate B win state A?'
      },
      {
        marketId: 'm-3',
        yesTokenId: 'yes-3',
        noTokenId: 'no-3',
        category: 'election',
        tags: ['usa', 'turnout'],
        question: 'Will turnout exceed 60% in state A?'
      }
    ]
  };
}

describe('FwProjectionAgent', () => {
  it('returns single-market fallback when basket is disabled', async () => {
    const agent = buildAgent({ assignment: { 'x_m-1': 1 } });
    const now = Date.now();
    const { orderbooks, marketUniverse } = buildUniverse(now);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 1,
        fwSelectionWeightFloor: 0,
        fwMinEdgeThreshold: 0.0001
      },
      nowMs: now,
      orderbooks,
      marketUniverse,
      allowBasket: false
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.type).toBe('fw_projection');
  });

  it('returns basket when executable candidates satisfy basket minimum', async () => {
    const agent = buildAgent({ assignment: { 'x_m-1': 1, 'x_m-2': 1, 'x_m-3': 1 } });
    const now = Date.now();
    const { orderbooks, marketUniverse } = buildUniverse(now);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 3,
        fwSelectionWeightFloor: 0,
        fwMinEdgeThreshold: 0.0001,
        fwBasketMinMarkets: 1,
        fwBasketMaxMarkets: 1
      },
      nowMs: now,
      orderbooks,
      marketUniverse,
      allowBasket: true
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.type).toBe('fw_basket');
    expect(result.opportunities[0]?.fwBasket?.markets.length).toBe(1);
  });

  it('rejects when no positive lower bound candidates exist', async () => {
    const metrics = new MetricsStore(200);
    const agent = buildAgent({ metrics, assignment: { 'x_m-1': 1 } });
    const now = Date.now();

    const result = await agent.projectPair({
      pair: {
        marketId: 'm-fw',
        yesTokenId: 'yes-fw',
        noTokenId: 'no-fw'
      },
      yesBook: makeProjectionBook('yes-fw', 0.75, 0.74, now),
      noBook: makeProjectionBook('no-fw', 0.31, 0.3, now),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 0,
        fwSelectionWeightFloor: 1.1,
        fwMinEdgeThreshold: 0.0001
      },
      nowMs: now
    });

    expect(result.opportunity).toBeNull();
    expect(result.reason).toBe('no_positive_lower_bound');
    const rejection = metrics
      .recent('fw_projection', 40)
      .find(
        (event) =>
          event.data &&
          typeof event.data === 'object' &&
          (event.data as { event?: string; reason?: string }).event === 'projection_rejected' &&
          (event.data as { reason?: string }).reason === 'no_positive_lower_bound'
      );
    expect(rejection).toBeDefined();
  });

  it('uses inferred semantic relations when explicit graph coverage is sparse', async () => {
    const agent = buildAgent({ assignment: { 'x_m-1': 1 } });
    const now = Date.now();
    const { orderbooks, marketUniverse } = buildUniverse(now);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 1,
        fwSelectionWeightFloor: 0,
        fwMinEdgeThreshold: 0.0001
      },
      nowMs: now,
      orderbooks,
      marketUniverse,
      allowBasket: false
    });

    expect(result.opportunities).toHaveLength(1);
    const relationIds = result.opportunities[0]?.fw?.relationIds ?? [];
    expect(relationIds.some((id) => id.startsWith('inferred:'))).toBe(true);
  });

  it('falls back to no_executable_candidates when basket-filtered candidates are empty', async () => {
    const metrics = new MetricsStore(200);
    const agent = buildAgent({ metrics, assignment: { 'x_m-1': 1, 'x_m-2': 1 } });
    const now = Date.now();

    const stale = now - (DEFAULT_TRADE_POLICY.maxBookStalenessMs + 5000);
    const orderbooks = new Map<string, OrderBookState>([
      ['yes-1', makeProjectionBook('yes-1', 0.7, 0.69, stale)],
      ['no-1', makeProjectionBook('no-1', 0.29, 0.28, stale)],
      ['yes-2', makeProjectionBook('yes-2', 0.69, 0.68, stale)],
      ['no-2', makeProjectionBook('no-2', 0.3, 0.29, stale)]
    ]);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 2,
        fwSelectionWeightFloor: 0,
        fwMinEdgeThreshold: 0.0001,
        fwBasketMinMarkets: 2,
        fwBasketMaxMarkets: 2,
        requireFreshBook: true
      },
      nowMs: now,
      orderbooks,
      marketUniverse: [
        {
          marketId: 'm-1',
          yesTokenId: 'yes-1',
          noTokenId: 'no-1',
          category: 'election',
          question: 'A?',
          tags: ['usa']
        },
        {
          marketId: 'm-2',
          yesTokenId: 'yes-2',
          noTokenId: 'no-2',
          category: 'election',
          question: 'B?',
          tags: ['usa']
        }
      ],
      allowBasket: true
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.reason).toBe('no_executable_candidates');

    const filterSummary = metrics
      .recent('fw_projection', 50)
      .find(
        (event) =>
          event.data &&
          typeof event.data === 'object' &&
          (event.data as { event?: string }).event === 'basket_leg_filter_summary'
      );
    const rejected = (filterSummary?.data as { rejected_non_executable?: number }).rejected_non_executable;
    expect((rejected ?? 0) > 0).toBe(true);
  });
});
