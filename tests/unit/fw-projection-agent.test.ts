import { describe, expect, it } from 'vitest';

import { FwProjectionAgent } from '../../src/agents/projection/FwProjectionAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import { IpOracleClient } from '../../src/services/ip-oracle/IpOracleClient.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

const PAIR = { marketId: 'm-fw', yesTokenId: 'yes-fw', noTokenId: 'no-fw' };

function makeBook(tokenId: string, askPrice: number, bidPrice: number, nowMs: number): OrderBookState {
  return {
    tokenId,
    bids: [{ price: bidPrice, size: 100 }],
    asks: [{ price: askPrice, size: 100 }],
    tickSize: 0.01,
    minOrderSize: 1,
    lastUpdateMs: nowMs,
    stableSinceMs: nowMs - 1_000,
    bestBid: { price: bidPrice, size: 100 },
    bestAsk: { price: askPrice, size: 100 }
  };
}

describe('FwProjectionAgent', () => {
  it('supports resolver config updates and rejects when best asks are missing', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'feasible',
        runtimeMs: 5
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0.1,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    agent.updateResolverConfig({
      mode: 'llm',
      hybridMerge: 'consensus',
      minConfidence: 0.2,
      maxEdgesPerMarket: 5
    });

    const now = Date.now();
    const badYesBook = {
      ...makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      asks: [],
      bestAsk: undefined
    };
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: badYesBook,
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now
    });
    expect(result.opportunity).toBeNull();
    expect(result.reason).toBe('no_markets_with_books');

    const badNoBook = {
      ...makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      asks: [],
      bestAsk: undefined
    };
    const second = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: badNoBook,
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now
    });
    expect(second.opportunity).toBeNull();
    expect(second.reason).toBe('no_markets_with_books');
  });

  it('emits fw_projection opportunities for feasible oracle outputs', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'feasible',
        objectiveValue: -0.01,
        assignment: { 'x_m-fw': 1 },
        runtimeMs: 5
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0.1,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now
    });

    expect(result.opportunity?.type).toBe('fw_projection');
    expect(result.opportunity?.fw?.solverStatus).toBe('optimal');
    expect(result.opportunity?.edge).toBeGreaterThan(0);
  });

  it('uses dependency confidence from resolved edges when market universe provides overlaps', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: -0.01,
        assignment: { 'x_m-fw': 1, 'x_m-2': 0 },
        runtimeMs: 5
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle,
      metrics: new MetricsStore(200)
    });

    const now = Date.now();
    const orderbooks = new Map<string, OrderBookState>([
      [PAIR.yesTokenId, makeBook(PAIR.yesTokenId, 0.45, 0.44, now)],
      [PAIR.noTokenId, makeBook(PAIR.noTokenId, 0.5, 0.49, now)],
      ['yes-2', makeBook('yes-2', 0.47, 0.46, now)],
      ['no-2', makeBook('no-2', 0.51, 0.5, now)]
    ]);
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      orderbooks,
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now,
      marketUniverse: [
        { marketId: PAIR.marketId, question: 'Will rain tomorrow?', category: 'weather', tags: ['rain', 'weather'] },
        { marketId: 'm-2', question: 'Will not rain tomorrow?', category: 'weather', tags: ['rain', 'weather'] }
      ]
    });

    const dependencyConfidence = result.opportunity?.fw?.dependencyConfidence;
    expect(dependencyConfidence ?? 0).toBeGreaterThanOrEqual(0);
    expect(dependencyConfidence ?? 1).toBeLessThanOrEqual(1);
  });

  it('rejects projection when solver status is not feasible', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'timeout',
        runtimeMs: 100
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0.1,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now
    });

    expect(result.opportunity).toBeNull();
    expect(result.reason).toBe('oracle_timeout');
  });

  it('rejects projection when lower bound is below threshold', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: -0.001,
        assignment: { 'x_m-fw': 1 },
        runtimeMs: 5
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0.1,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.495, 0.494, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.499, now),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwExecutionRiskBufferBps: 100,
        fwMinEdgeThreshold: 0.01
      },
      nowMs: now
    });

    expect(result.opportunity).toBeNull();
    expect(result.reason).toBe('no_positive_lower_bound');
  });

  it('handles zero fwMaxProjectionAgeMs by skipping staleness penalty branch', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: -0.02,
        assignment: { 'x_m-fw': 1 },
        runtimeMs: 5
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
    const result = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwMaxProjectionAgeMs: 0,
        fwMinEdgeThreshold: 0.0001
      },
      nowMs: now
    });

    expect(result.opportunity?.type).toBe('fw_projection');
  });

  it('builds combinatorial oracle objective/constraints for dependency-linked markets', async () => {
    let capturedRequest:
      | {
          objective: { variables: string[]; coefficients: number[]; sense: 'min' | 'max' };
          constraints: { rows: Array<{ coefficients: number[]; op: '<=' | '>=' | '='; rhs: number }> };
        }
      | undefined;

    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => {
        capturedRequest = {
          objective: request.objective,
          constraints: { rows: request.constraints.rows }
        };
        return {
          requestId: request.requestId,
          status: 'optimal',
          objectiveValue: 0.02,
          assignment: { 'x_m-fw': 1, 'x_m-2': 0 },
          runtimeMs: 5
        };
      }
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
    const yesBook = makeBook(PAIR.yesTokenId, 0.45, 0.44, now);
    const noBook = makeBook(PAIR.noTokenId, 0.5, 0.49, now);
    const orderbooks = new Map<string, OrderBookState>([
      [PAIR.yesTokenId, yesBook],
      [PAIR.noTokenId, noBook],
      ['yes-2', makeBook('yes-2', 0.47, 0.46, now)],
      ['no-2', makeBook('no-2', 0.51, 0.5, now)]
    ]);

    const result = await agent.projectPair({
      pair: PAIR,
      yesBook,
      noBook,
      orderbooks,
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now,
      marketUniverse: [
        {
          marketId: 'm-fw',
          yesTokenId: 'yes-fw',
          noTokenId: 'no-fw',
          question: 'Will rain tomorrow?',
          category: 'weather',
          tags: ['rain', 'weather']
        },
        {
          marketId: 'm-2',
          yesTokenId: 'yes-2',
          noTokenId: 'no-2',
          question: 'Will not rain tomorrow?',
          category: 'weather',
          tags: ['rain', 'weather']
        }
      ]
    });

    expect(result.opportunity?.type).toBe('fw_projection');
    expect(capturedRequest?.objective.sense).toBe('max');
    expect(capturedRequest?.objective.variables).toEqual(['x_m-fw', 'x_m-2']);
    expect(capturedRequest?.objective.coefficients).toHaveLength(2);
    const mutualExclusiveRow = capturedRequest?.constraints.rows.find(
      (row) => row.op === '<=' && row.rhs === 1 && row.coefficients.join(',') === '1,1'
    );
    expect(mutualExclusiveRow).toBeDefined();
  });

  it('maps implies and complementary dependency relations into oracle constraints', async () => {
    let capturedRows: Array<{ coefficients: number[]; op: '<=' | '>=' | '='; rhs: number }> = [];

    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => {
        capturedRows = request.constraints.rows;
        return {
          requestId: request.requestId,
          status: 'optimal',
          objectiveValue: 0.03,
          assignment: { 'x_m-fw': 1, 'x_m-2': 1, 'x_m-3': 1 },
          runtimeMs: 5
        };
      }
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'llm',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10,
        llmExtractor: async () => [
          {
            marketA: 'm-fw',
            marketB: 'm-2',
            relationType: 'implies',
            confidence: 0.9,
            source: 'llm',
            evidence: 'llm:implies',
            extractedAtMs: 0
          },
          {
            marketA: 'm-fw',
            marketB: 'm-3',
            relationType: 'complementary',
            confidence: 0.85,
            source: 'llm',
            evidence: 'llm:complementary',
            extractedAtMs: 0
          }
        ]
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const yesBook = makeBook(PAIR.yesTokenId, 0.45, 0.44, now);
    const noBook = makeBook(PAIR.noTokenId, 0.5, 0.49, now);
    const orderbooks = new Map<string, OrderBookState>([
      [PAIR.yesTokenId, yesBook],
      [PAIR.noTokenId, noBook],
      ['yes-2', makeBook('yes-2', 0.47, 0.46, now)],
      ['no-2', makeBook('no-2', 0.51, 0.5, now)],
      ['yes-3', makeBook('yes-3', 0.44, 0.43, now)],
      ['no-3', makeBook('no-3', 0.52, 0.51, now)]
    ]);

    const result = await agent.projectPair({
      pair: PAIR,
      yesBook,
      noBook,
      orderbooks,
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now,
      marketUniverse: [
        { marketId: 'm-fw', yesTokenId: 'yes-fw', noTokenId: 'no-fw', question: 'Will rain tomorrow?' },
        { marketId: 'm-2', yesTokenId: 'yes-2', noTokenId: 'no-2', question: 'Will ground be wet tomorrow?' },
        { marketId: 'm-3', yesTokenId: 'yes-3', noTokenId: 'no-3', question: 'Will umbrellas be needed?' }
      ]
    });

    expect(result.opportunity?.type).toBe('fw_projection');
    expect(capturedRows.some((row) => row.op === '<=' && row.rhs === 0)).toBe(true);
    expect(capturedRows.some((row) => row.op === '=' && row.rhs === 0)).toBe(true);
  });

  it('skips invalid auxiliary markets and emits warm-start hints for non-positive projected edges', async () => {
    let captured:
      | {
          warmStartValues: number[];
          rows: Array<{ coefficients: number[]; op: '<=' | '>=' | '='; rhs: number }>;
        }
      | undefined;

    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => {
        captured = {
          warmStartValues: request.warmStartHint.values,
          rows: request.constraints.rows
        };
        return {
          requestId: request.requestId,
          status: 'optimal',
          objectiveValue: 0.01,
          assignment: { 'x_m-fw': 1, 'x_m-3': 1 },
          runtimeMs: 5
        };
      }
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'llm',
        hybridMerge: 'consensus',
        minConfidence: 0,
        maxEdgesPerMarket: 10,
        llmExtractor: async () => [
          {
            marketA: 'm-fw',
            marketB: 'm-2',
            relationType: 'implies',
            confidence: 0.9,
            source: 'llm',
            evidence: 'llm:skip-missing-orderbook',
            extractedAtMs: 0
          },
          {
            marketA: 'm-fw',
            marketB: 'm-3',
            relationType: 'partition',
            confidence: 0.9,
            source: 'llm',
            evidence: 'llm:partition',
            extractedAtMs: 0
          },
          {
            marketA: 'm-fw',
            marketB: 'm-3',
            relationType: 'implies',
            confidence: 0.85,
            source: 'llm',
            evidence: 'llm:implies',
            extractedAtMs: 0
          },
          {
            marketA: 'm-fw',
            marketB: 'm-3',
            relationType: 'complementary',
            confidence: 0.8,
            source: 'llm',
            evidence: 'llm:complementary',
            extractedAtMs: 0
          }
        ]
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const yesBook = makeBook(PAIR.yesTokenId, 0.45, 0.44, now);
    const noBook = makeBook(PAIR.noTokenId, 0.5, 0.49, now);
    const orderbooks = new Map<string, OrderBookState>([
      [PAIR.yesTokenId, yesBook],
      [PAIR.noTokenId, noBook],
      ['no-2', makeBook('no-2', 0.52, 0.51, now)],
      ['yes-3', makeBook('yes-3', 0.8, 0.79, now)],
      ['no-3', makeBook('no-3', 0.35, 0.34, now)]
    ]);

    const result = await agent.projectPair({
      pair: PAIR,
      yesBook,
      noBook,
      orderbooks,
      policy: { ...DEFAULT_TRADE_POLICY, fwMinEdgeThreshold: -1 },
      nowMs: now,
      marketUniverse: [
        { marketId: 'm-fw', yesTokenId: 'yes-fw', noTokenId: 'no-fw', question: 'Will rain tomorrow?' },
        { marketId: 'm-2', yesTokenId: 'yes-2', noTokenId: 'no-2', question: 'Will lightning strike?' },
        { marketId: 'm-3', yesTokenId: 'yes-3', noTokenId: 'no-3', question: 'Will humidity exceed 80%?' },
        { marketId: 'm-4', question: 'Will weather be unusual?' }
      ]
    });

    if (result.opportunity) {
      expect(result.opportunity.type).toBe('fw_projection');
    }
    if (captured) {
      expect(captured.warmStartValues).toHaveLength(2);
      expect(captured.warmStartValues.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(captured.rows.some((row) => row.op === '<=' && row.rhs === 1)).toBe(true);
      expect(captured.rows.some((row) => row.op === '<=' && row.rhs === 0)).toBe(true);
      expect(captured.rows.some((row) => row.op === '=' && row.rhs === 0)).toBe(true);
    }
  });

  it('rejects projection when combinatorial assignment excludes target market', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        objectiveValue: 0.02,
        assignment: { 'x_m-fw': 0, 'x_m-2': 1 },
        runtimeMs: 5
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
    const yesBook = makeBook(PAIR.yesTokenId, 0.45, 0.44, now);
    const noBook = makeBook(PAIR.noTokenId, 0.5, 0.49, now);
    const orderbooks = new Map<string, OrderBookState>([
      [PAIR.yesTokenId, yesBook],
      [PAIR.noTokenId, noBook],
      ['yes-2', makeBook('yes-2', 0.47, 0.46, now)],
      ['no-2', makeBook('no-2', 0.51, 0.5, now)]
    ]);

    const result = await agent.projectPair({
      pair: PAIR,
      yesBook,
      noBook,
      orderbooks,
      policy: { ...DEFAULT_TRADE_POLICY },
      nowMs: now,
      marketUniverse: [
        { marketId: 'm-fw', yesTokenId: 'yes-fw', noTokenId: 'no-fw', question: 'Will rain tomorrow?' },
        { marketId: 'm-2', yesTokenId: 'yes-2', noTokenId: 'no-2', question: 'Will not rain tomorrow?' }
      ]
    });

    expect(result.opportunity?.type).toBe('fw_projection');
    expect(result.opportunity?.marketId).toBe('m-2');
  });

  it('enforces fwOracleMaxConcurrency and emits oracle_concurrency_limited', async () => {
    let solveCalls = 0;
    let releaseFirstSolve: (() => void) | undefined;
    let firstSolveStarted: (() => void) | undefined;
    const firstSolveStartedPromise = new Promise<void>((resolve) => {
      firstSolveStarted = resolve;
    });
    const blockFirstSolvePromise = new Promise<void>((resolve) => {
      releaseFirstSolve = resolve;
    });

    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => {
        solveCalls += 1;
        if (solveCalls === 1) {
          firstSolveStarted?.();
          await blockFirstSolvePromise;
        }
        return {
          requestId: request.requestId,
          status: 'optimal',
          objectiveValue: 0.02,
          assignment: { 'x_m-fw': 1 },
          runtimeMs: 5
        };
      }
    });
    const metrics = new MetricsStore(50);
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
    const firstProjectionPromise = agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: { ...DEFAULT_TRADE_POLICY, fwOracleMaxConcurrency: 1 },
      nowMs: now
    });

    await firstSolveStartedPromise;

    const secondProjection = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now + 1),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now + 1),
      policy: { ...DEFAULT_TRADE_POLICY, fwOracleMaxConcurrency: 1 },
      nowMs: now + 1
    });

    expect(secondProjection.opportunity).toBeNull();
    expect(secondProjection.reason).toBe('oracle_concurrency_limited');
    expect(
      metrics
        .recent('fw_oracle', 10)
        .some(
          (event) =>
            event.data &&
            typeof event.data === 'object' &&
            (event.data as { error?: string }).error === 'oracle_concurrency_limited'
        )
    ).toBe(true);

    releaseFirstSolve?.();
    const firstProjection = await firstProjectionPromise;
    expect(firstProjection.opportunity?.type).toBe('fw_projection');
  });

  it('emits fw_basket opportunities when basket mode is enabled', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        assignment: Object.fromEntries(request.objective.variables.map((variable) => [variable, 1])),
        runtimeMs: 5
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
      ['yes-1', makeBook('yes-1', 0.45, 0.44, now)],
      ['no-1', makeBook('no-1', 0.5, 0.49, now)],
      ['yes-2', makeBook('yes-2', 0.46, 0.45, now)],
      ['no-2', makeBook('no-2', 0.49, 0.48, now)]
    ]);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwBasketMinMarkets: 2,
        fwBasketMaxMarkets: 3
      },
      nowMs: now,
      orderbooks,
      marketUniverse: [
        { marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        { marketId: 'm2', yesTokenId: 'yes-2', noTokenId: 'no-2' }
      ]
    });

    expect(result.opportunities[0]?.type).toBe('fw_basket');
    expect(result.opportunities[0]?.fwBasket?.markets.length).toBe(2);
  });

  it('rejects non-converged loop outputs', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          requestId: request.requestId,
          status: 'feasible',
          assignment: Object.fromEntries(request.objective.variables.map((variable) => [variable, 1])),
          runtimeMs: 5
        };
      }
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
    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwMaxLoopRuntimeMs: 1
      },
      nowMs: now,
      orderbooks: new Map<string, OrderBookState>([
        ['yes-1', makeBook('yes-1', 0.45, 0.44, now)],
        ['no-1', makeBook('no-1', 0.5, 0.49, now)]
      ]),
      marketUniverse: [{ marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1' }]
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.reason).toBe('fw_loop_runtime_exceeded');
  });

  it('emits per-filter candidate diagnostics with explicit rejection counts', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        assignment: { x_m1: 1, x_m2: 0 },
        runtimeMs: 5
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
    const orderbooks = new Map<string, OrderBookState>([
      ['yes-1', makeBook('yes-1', 0.45, 0.44, now)],
      ['no-1', makeBook('no-1', 0.5, 0.49, now)],
      ['yes-2', makeBook('yes-2', 0.7, 0.69, now)],
      ['no-2', makeBook('no-2', 0.35, 0.34, now)]
    ]);

    const result = await agent.projectUniverse({
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionTopK: 0
      },
      nowMs: now,
      orderbooks,
      marketUniverse: [
        { marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        { marketId: 'm2', yesTokenId: 'yes-2', noTokenId: 'no-2' }
      ]
    });

    expect(result.opportunities.length).toBeGreaterThan(0);
    const summary = metrics
      .recent('fw_projection', 20)
      .find(
        (event) =>
          event.data &&
          typeof event.data === 'object' &&
          (event.data as { event?: string }).event === 'candidate_filter_summary'
      );
    expect(summary).toBeDefined();
    expect((summary?.data as { rejected_by_weight?: number }).rejected_by_weight ?? 0).toBeGreaterThan(0);
    expect(
      (summary?.data as { rejected_by_lower_bound?: number }).rejected_by_lower_bound ?? 0
    ).toBeGreaterThan(0);
  });

  it('supports top-k FW selection when weight-floor filtering is too strict', async () => {
    const oracle = new IpOracleClient({
      timeoutMs: 100,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 1000,
      fallbackSolver: async (request) => ({
        requestId: request.requestId,
        status: 'optimal',
        assignment: { 'x_m-fw': 1 },
        runtimeMs: 5
      })
    });
    const agent = new FwProjectionAgent({
      resolverConfig: {
        mode: 'deterministic',
        hybridMerge: 'consensus',
        minConfidence: 0.1,
        maxEdgesPerMarket: 10
      },
      oracleClient: oracle
    });

    const now = Date.now();
    const strictWeightResult = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionWeightFloor: 1.1,
        fwSelectionTopK: 0
      },
      nowMs: now
    });
    expect(strictWeightResult.opportunity).toBeNull();
    expect(strictWeightResult.reason).toBe('no_positive_lower_bound');

    const topKResult = await agent.projectPair({
      pair: PAIR,
      yesBook: makeBook(PAIR.yesTokenId, 0.45, 0.44, now + 1),
      noBook: makeBook(PAIR.noTokenId, 0.5, 0.49, now + 1),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        fwSelectionWeightFloor: 1.1,
        fwSelectionTopK: 1
      },
      nowMs: now + 1
    });
    expect(topKResult.opportunity?.type).toBe('fw_projection');
  });
});
