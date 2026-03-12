import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { FwProjectionAgent } from '../../src/agents/projection/FwProjectionAgent.js';
import { IpOracleClient } from '../../src/services/ip-oracle/IpOracleClient.js';

function makeBook(tokenId: string, ask: number, bid: number, nowMs: number): OrderBookState {
  return {
    tokenId,
    bids: [{ price: bid, size: 100 }],
    asks: [{ price: ask, size: 100 }],
    tickSize: 0.001,
    minOrderSize: 1,
    lastUpdateMs: nowMs,
    stableSinceMs: nowMs,
    bestBid: { price: bid, size: 100 },
    bestAsk: { price: ask, size: 100 }
  };
}

describe('FW projection remediation telemetry', () => {
  it('emits explicit rejection split for non-positive theoretical edges', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        assignment: { 'x_m-fw': 1 },
        runtimeMs: 3
      })
    });
    const metrics = new MetricsStore(200);
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle,
      metrics
    });

    const now = Date.now();
    const result = await agent.projectPair({
      pair: {
        marketId: 'm-fw',
        yesTokenId: 'yes-fw',
        noTokenId: 'no-fw'
      },
      yesBook: makeBook('yes-fw', 0.72, 0.71, now),
      noBook: makeBook('no-fw', 0.31, 0.3, now),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwRequireConverged: false,
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

    const telemetry = (rejection?.data as {
      lower_bound_telemetry?: {
        rejectionSplit?: {
          theoreticalEdgeNonPositive?: number;
          theoreticalEdgeBelowThreshold?: number;
          penaltyDrivenLowerBound?: number;
        };
      };
    })?.lower_bound_telemetry;

    expect(telemetry?.rejectionSplit).toBeDefined();
    expect(telemetry?.rejectionSplit?.theoreticalEdgeNonPositive ?? 0).toBeGreaterThan(0);
  });

  it('adds inferred complementary relation signal when explicit coverage is sparse', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: 0.1,
        assignment: { 'x_m-1': 1, 'x_m-2': 1, 'x_m-3': 1 },
        runtimeMs: 4
      })
    });

    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const orderbooks = new Map<string, OrderBookState>([
      ['yes-1', makeBook('yes-1', 0.7, 0.69, now)],
      ['no-1', makeBook('no-1', 0.31, 0.3, now)],
      ['yes-2', makeBook('yes-2', 0.69, 0.68, now)],
      ['no-2', makeBook('no-2', 0.32, 0.31, now)],
      ['yes-3', makeBook('yes-3', 0.68, 0.67, now)],
      ['no-3', makeBook('no-3', 0.33, 0.32, now)]
    ]);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwMinEdgeThreshold: 0.0001,
        fwSelectionTopK: 1,
        fwSelectionWeightFloor: 0
      },
      nowMs: now,
      orderbooks,
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
      ],
      allowBasket: false
    });

    expect(result.opportunities).toHaveLength(1);
    const relationIds = result.opportunities[0]?.fw?.relationIds ?? [];
    expect(relationIds.some((id) => id.startsWith('inferred:'))).toBe(true);
  });

  it('infers relations from question overlap even when category and tags are missing', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: 0.1,
        assignment: { 'x_m-10': 1, 'x_m-11': 1, 'x_m-12': 1 },
        runtimeMs: 4
      })
    });

    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const orderbooks = new Map<string, OrderBookState>([
      ['yes-10', makeBook('yes-10', 0.51, 0.5, now)],
      ['no-10', makeBook('no-10', 0.48, 0.47, now)],
      ['yes-11', makeBook('yes-11', 0.5, 0.49, now)],
      ['no-11', makeBook('no-11', 0.49, 0.48, now)],
      ['yes-12', makeBook('yes-12', 0.49, 0.48, now)],
      ['no-12', makeBook('no-12', 0.5, 0.49, now)]
    ]);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwMinEdgeThreshold: 0.0001,
        fwSelectionTopK: 1,
        fwSelectionWeightFloor: 0
      },
      nowMs: now,
      orderbooks,
      marketUniverse: [
        {
          marketId: 'm-10',
          yesTokenId: 'yes-10',
          noTokenId: 'no-10',
          question: 'Will inflation rise in June?'
        },
        {
          marketId: 'm-11',
          yesTokenId: 'yes-11',
          noTokenId: 'no-11',
          question: 'Will inflation rise in July?'
        },
        {
          marketId: 'm-12',
          yesTokenId: 'yes-12',
          noTokenId: 'no-12',
          question: 'Will inflation fall in August?'
        }
      ],
      allowBasket: false
    });

    expect(result.opportunities).toHaveLength(1);
    const relationIds = result.opportunities[0]?.fw?.relationIds ?? [];
    expect(relationIds.some((id) => id.startsWith('inferred:'))).toBe(true);
  });
});
