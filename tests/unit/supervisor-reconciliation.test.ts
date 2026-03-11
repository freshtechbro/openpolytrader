import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMessageBus } from '../../src/core/MessageBus.js';
import { Supervisor, type SupervisorDeps } from '../../src/core/Supervisor.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { IncidentTracker } from '../../src/services/IncidentTracker.js';
import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketDataApi } from '../../src/services/PolymarketDataApi.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withMessageBus(deps: Omit<SupervisorDeps, 'messageBus'>): SupervisorDeps {
  return {
    messageBus: createMessageBus(),
    ...deps
  };
}

describe('Supervisor reconciliation', () => {
  it('fails startup when market-data realtime cannot connect', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error('marketdata offline'))
        .mockResolvedValueOnce(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;
    const clob = {
      getActiveOrders: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketClob;
    const dataApi = {
      getPositions: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketDataApi;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off',
        reconciliation: {
          intervalMs: 0,
          afterIncidentDelayMs: 0,
          positionSizeTolerance: 0,
          positionsUser: '0xabc',
          positionsSizeThreshold: 0,
          positionsLimit: 100,
          positionsOffset: 0
        }
      },
      withMessageBus({
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    await expect(supervisor.start()).rejects.toThrow('marketdata offline');
    expect(metrics.recent('error', 2).map((event) => event.data?.message)).toEqual([
      'realtime_connect_failed',
      'startup_dependency_failed'
    ]);

    await expect(supervisor.start()).resolves.toBeUndefined();
    expect(realtime.connect).toHaveBeenCalledTimes(2);
  });

  it('runs reconciliation on startup', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const reconcileSpy = vi.spyOn(portfolio, 'reconcileWithVenue');

    const clob = {
      getActiveOrders: vi.fn().mockResolvedValue([
        { orderId: 'orphan-1', marketId: 'market-1', tokenId: 'yes-1', status: 'LIVE' }
      ]),
      cancelOrder: vi.fn().mockResolvedValue({})
    } as unknown as PolymarketClob;
    const dataApi = {
      getPositions: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketDataApi;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off',
        reconciliation: {
          intervalMs: 0,
          afterIncidentDelayMs: 0,
          positionSizeTolerance: 0,
          positionsUser: '0xabc',
          positionsSizeThreshold: 0,
          positionsLimit: 100,
          positionsOffset: 0
        }
      },
      withMessageBus({
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    await supervisor.start();

    expect(clob.getActiveOrders).toHaveBeenCalledTimes(1);
    expect(clob.cancelOrder).toHaveBeenCalledTimes(1);
    expect(dataApi.getPositions).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it('runs reconciliation after incidents', async () => {
    vi.useFakeTimers();

    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000, incidentTracker);
    const reconcileSpy = vi.spyOn(portfolio, 'reconcileWithVenue');

    const clob = {
      getActiveOrders: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketClob;
    const dataApi = {
      getPositions: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketDataApi;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off',
        reconciliation: {
          intervalMs: 0,
          afterIncidentDelayMs: 0,
          positionSizeTolerance: 0,
          positionsUser: '0xabc',
          positionsSizeThreshold: 0,
          positionsLimit: 100,
          positionsOffset: 0
        }
      },
      withMessageBus({
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    await supervisor.start();
    reconcileSpy.mockClear();

    metrics.record({ type: 'incident', timestamp: Date.now(), data: { marketId: 'market-1', reason: 'order_failed' } });

    await vi.runAllTimersAsync();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Supervisor fee-aware near-zero gate recheck', () => {
  function createBook(tokenId: string, bestBid: number, bestAsk: number, nowMs: number) {
    return {
      tokenId,
      bids: [{ price: bestBid, size: 100 }],
      asks: [{ price: bestAsk, size: 100 }],
      tickSize: 0.01,
      minOrderSize: 1,
      lastUpdateMs: nowMs,
      stableSinceMs: nowMs - 1000,
      bestBid: { price: bestBid, size: 100 },
      bestAsk: { price: bestAsk, size: 100 }
    };
  }

  function createSupervisor(policyOverrides: Partial<typeof DEFAULT_TRADE_POLICY>) {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);

    const clob = {} as unknown as PolymarketClob;
    const dataApi = {} as unknown as PolymarketDataApi;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY, ...policyOverrides },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper'
      },
      withMessageBus({
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    return { supervisor, metrics };
  }

  it('rejects risk-approved near-zero execution when fees erase edge', async () => {
    const nowMs = Date.now();
    const { supervisor, metrics } = createSupervisor({
      nearZeroFeeBps: 100,
      minDepthLevels: 1,
      depthHeadroomFraction: 1,
      depthBufferMultiplier: 0,
      minEdgeTicks: 0,
      entrySlippageToleranceBps: 1000
    });

    const executeArbitrage = vi.fn().mockResolvedValue({ status: 'submitted' });
    const internals = supervisor as unknown as {
      marketData: { getOrderBook: (tokenId: string) => unknown };
      execution: { executeArbitrage: typeof executeArbitrage };
      handleRiskApproved: (payload: { opportunity: unknown; size: number }) => Promise<void>;
    };
    internals.marketData = {
      getOrderBook: (tokenId: string) => {
        if (tokenId === 'yes-1') return createBook('yes-1', 0.47, 0.48, nowMs);
        if (tokenId === 'no-1') return createBook('no-1', 0.48, 0.49, nowMs);
        return undefined;
      }
    };
    internals.execution = { executeArbitrage };

    await internals.handleRiskApproved({
      opportunity: {
        id: 'opp-1',
        marketId: 'market-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        yesPrice: 0.48,
        noPrice: 0.49,
        costPerSet: 0.97,
        edge: 0.03,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: nowMs,
        gateReasons: [],
        pair: { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        type: 'near_zero'
      },
      size: 1
    });

    expect(executeArbitrage).not.toHaveBeenCalled();
    const rejection = metrics.recent('gate_rejection', 1)[0];
    expect(rejection?.data?.reasons).toContain('edge_below_threshold_after_fees');
  });

  it('keeps backward-compatible behavior under zero fee config', async () => {
    const nowMs = Date.now();
    const { supervisor } = createSupervisor({
      nearZeroFeeBps: 0,
      minDepthLevels: 1,
      depthHeadroomFraction: 1,
      depthBufferMultiplier: 0,
      minEdgeTicks: 0,
      entrySlippageToleranceBps: 1000
    });

    const executeArbitrage = vi.fn().mockResolvedValue({ status: 'submitted' });
    const internals = supervisor as unknown as {
      marketData: { getOrderBook: (tokenId: string) => unknown };
      execution: { executeArbitrage: typeof executeArbitrage };
      handleRiskApproved: (payload: { opportunity: unknown; size: number }) => Promise<void>;
    };
    internals.marketData = {
      getOrderBook: (tokenId: string) => {
        if (tokenId === 'yes-1') return createBook('yes-1', 0.47, 0.48, nowMs);
        if (tokenId === 'no-1') return createBook('no-1', 0.48, 0.49, nowMs);
        return undefined;
      }
    };
    internals.execution = { executeArbitrage };

    await internals.handleRiskApproved({
      opportunity: {
        id: 'opp-1',
        marketId: 'market-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        yesPrice: 0.48,
        noPrice: 0.49,
        costPerSet: 0.97,
        edge: 0.03,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: nowMs,
        gateReasons: [],
        pair: { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        type: 'near_zero'
      },
      size: 1
    });

    expect(executeArbitrage).toHaveBeenCalledTimes(1);
  });
});

describe('Supervisor gate rejection dedupe', () => {
  function createSupervisorForDedupe(configOverrides?: { maxConcurrentMarkets?: number }) {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper',
        ...configOverrides
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    return { supervisor, metrics };
  }

  function makeOpportunity(nowMs: number) {
    return {
      id: 'opp-1',
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1',
      yesPrice: 0.48,
      noPrice: 0.49,
      costPerSet: 0.97,
      edge: 0.03,
      tickSize: 0.01,
      maxSizeByDepth: 100,
      minOrderSize: 1,
      detectedAt: nowMs,
      gateReasons: [],
      pair: { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
      type: 'near_zero' as const
    };
  }

  it('suppresses identical market_in_flight rejections within cooldown', async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    vi.setSystemTime(nowMs);

    const { supervisor, metrics } = createSupervisorForDedupe();
    const internals = supervisor as unknown as {
      inFlightMarkets: Set<string>;
      handleRiskApproved: (payload: { opportunity: ReturnType<typeof makeOpportunity>; size: number }) => Promise<void>;
    };
    internals.inFlightMarkets.add('market-1');

    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs), size: 1 });
    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs), size: 1 });

    const events = metrics.recent('gate_rejection', 10);
    expect(events).toHaveLength(1);
    expect((events[0].data as { reasons: string[] }).reasons).toContain('market_in_flight');
  });

  it('re-emits identical rejection after dedupe cooldown elapses', async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    vi.setSystemTime(nowMs);

    const { supervisor, metrics } = createSupervisorForDedupe();
    const internals = supervisor as unknown as {
      inFlightMarkets: Set<string>;
      handleRiskApproved: (payload: { opportunity: ReturnType<typeof makeOpportunity>; size: number }) => Promise<void>;
    };
    internals.inFlightMarkets.add('market-1');

    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs), size: 1 });
    vi.setSystemTime(nowMs + 3001);
    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs + 3001), size: 1 });

    const events = metrics.recent('gate_rejection', 10);
    expect(events).toHaveLength(2);
    expect((events[0].data as { reasons: string[] }).reasons).toContain('market_in_flight');
    expect((events[1].data as { reasons: string[] }).reasons).toContain('market_in_flight');
  });

  it('emits immediately when rejection reason changes within cooldown', async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    vi.setSystemTime(nowMs);

    const { supervisor, metrics } = createSupervisorForDedupe({ maxConcurrentMarkets: 2 });
    const internals = supervisor as unknown as {
      inFlightMarkets: Set<string>;
      handleRiskApproved: (payload: { opportunity: ReturnType<typeof makeOpportunity>; size: number }) => Promise<void>;
    };

    internals.inFlightMarkets.add('market-1');
    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs), size: 1 });

    internals.inFlightMarkets.clear();
    internals.inFlightMarkets.add('other-1');
    internals.inFlightMarkets.add('other-2');
    vi.setSystemTime(nowMs + 1000);
    await internals.handleRiskApproved({ opportunity: makeOpportunity(nowMs + 1000), size: 1 });

    const events = metrics.recent('gate_rejection', 10);
    expect(events).toHaveLength(2);
    expect((events[0].data as { reasons: string[] }).reasons).toContain('market_in_flight');
    expect((events[1].data as { reasons: string[] }).reasons).toContain('max_concurrent_markets');
  });
});

describe('Supervisor circuit breaker accounting', () => {
  function createBook(tokenId: string, bestBid: number, bestAsk: number, nowMs: number) {
    return {
      tokenId,
      bids: [{ price: bestBid, size: 100 }],
      asks: [{ price: bestAsk, size: 100 }],
      tickSize: 0.01,
      minOrderSize: 1,
      lastUpdateMs: nowMs,
      stableSinceMs: nowMs - 1000,
      bestBid: { price: bestBid, size: 100 },
      bestAsk: { price: bestAsk, size: 100 }
    };
  }

  function createBasketOpportunity(nowMs: number, converged = true): ArbitrageOpportunity {
    return {
      id: 'opp-basket',
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1',
      yesPrice: 0.48,
      noPrice: 0.49,
      costPerSet: 0.97,
      edge: 0.03,
      tickSize: 0.01,
      maxSizeByDepth: 10,
      minOrderSize: 1,
      detectedAt: nowMs,
      gateReasons: [],
      pair: { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
      type: 'fw_basket',
      fwBasket: {
        basketId: 'basket-1',
        executionMode: 'sequential_failfast',
        aggregateEdgeLowerBound: 0.03,
        aggregateProjectedEdge: 0.04,
        loop: {
          loopId: 'loop-1',
          iterationCount: 1,
          activeSetSize: 2,
          contractionSteps: 0,
          terminalGapAbs: 0.001,
          terminalGapRel: 0.01,
          terminalReason: converged ? 'gap_converged' : 'runtime_budget',
          converged,
          runtimeMs: 5
        },
        markets: [
          {
            marketId: 'market-1',
            yesTokenId: 'yes-1',
            noTokenId: 'no-1',
            yesPrice: 0.48,
            noPrice: 0.49,
            costPerSet: 0.97,
            projectedEdge: 0.03,
            edgeLowerBound: 0.03,
            maxSizeByDepth: 10,
            minOrderSize: 1,
            tickSize: 0.01
          },
          {
            marketId: 'market-2',
            yesTokenId: 'yes-2',
            noTokenId: 'no-2',
            yesPrice: 0.46,
            noPrice: 0.47,
            costPerSet: 0.93,
            projectedEdge: 0.04,
            edgeLowerBound: 0.03,
            maxSizeByDepth: 10,
            minOrderSize: 1,
            tickSize: 0.01
          }
        ]
      }
    };
  }

  function createSupervisorForCircuitAccounting(
    executeBasketArbitrage: (opportunity: ArbitrageOpportunity, size: number) => Promise<{
      kind: 'basket';
      status: 'submitted' | 'failed' | 'blocked';
      reason?: string;
      idempotencyKey: string;
      executionId: string;
      state: 'idle' | 'pending' | 'submitted' | 'partially_filled' | 'filled' | 'failed' | 'complete';
    }>
  ) {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [
          { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
          { marketId: 'market-2', yesTokenId: 'yes-2', noTokenId: 'no-2' }
        ],
        policy: {
          ...DEFAULT_TRADE_POLICY,
          minDepthLevels: 1,
          depthHeadroomFraction: 1,
          depthBufferMultiplier: 0,
          minEdgeTicks: 0,
          entrySlippageToleranceBps: 1000
        },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper'
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    const nowMs = Date.now();
    const internals = supervisor as unknown as {
      marketData: { getOrderBook: (tokenId: string) => unknown };
      execution: { executeBasketArbitrage: typeof executeBasketArbitrage };
      marketCircuitBreakers: {
        get: (marketId: string) => { getFailureCount: () => number; currentState: () => string };
      };
      handleRiskApproved: (payload: { opportunity: ArbitrageOpportunity; size: number }) => Promise<void>;
    };
    internals.marketData = {
      getOrderBook: (tokenId: string) => {
        if (tokenId === 'yes-1') return createBook('yes-1', 0.47, 0.48, nowMs);
        if (tokenId === 'no-1') return createBook('no-1', 0.48, 0.49, nowMs);
        if (tokenId === 'yes-2') return createBook('yes-2', 0.45, 0.46, nowMs);
        if (tokenId === 'no-2') return createBook('no-2', 0.46, 0.47, nowMs);
        return undefined;
      }
    };
    internals.execution = { executeBasketArbitrage };

    return { supervisor: internals, metrics };
  }

  it('ignores non-live paper-mode failures for circuit breaker counts', async () => {
    const executeBasketArbitrage = vi.fn().mockResolvedValue({
      kind: 'basket',
      status: 'failed',
      reason: 'paper_mode',
      idempotencyKey: 'basket-key',
      executionId: 'basket-exec',
      state: 'failed'
    });
    const { supervisor, metrics } = createSupervisorForCircuitAccounting(executeBasketArbitrage);

    await supervisor.handleRiskApproved({
      opportunity: createBasketOpportunity(Date.now()),
      size: 1
    });

    expect(executeBasketArbitrage).toHaveBeenCalledTimes(1);
    expect(supervisor.marketCircuitBreakers.get('market-1').getFailureCount()).toBe(0);
    expect(supervisor.marketCircuitBreakers.get('market-2').getFailureCount()).toBe(0);
    expect(supervisor.marketCircuitBreakers.get('market-1').currentState()).toBe('closed');
    expect(supervisor.marketCircuitBreakers.get('market-2').currentState()).toBe('closed');
    expect(metrics.recent('incident', 10)).toHaveLength(0);
  });

  it('rejects non-converged baskets before execution in strict mode', async () => {
    const executeBasketArbitrage = vi.fn().mockResolvedValue({
      kind: 'basket',
      status: 'submitted',
      idempotencyKey: 'basket-key',
      executionId: 'basket-exec',
      state: 'submitted'
    });
    const { supervisor, metrics } = createSupervisorForCircuitAccounting(executeBasketArbitrage);

    await supervisor.handleRiskApproved({
      opportunity: createBasketOpportunity(Date.now(), false),
      size: 1
    });

    expect(executeBasketArbitrage).not.toHaveBeenCalled();
    const rejection = metrics.recent('gate_rejection', 1)[0];
    expect((rejection?.data as { reasons?: string[] } | undefined)?.reasons).toContain(
      'fw_basket_requires_converged'
    );
  });

  it('still counts real basket failures for circuit breaker state', async () => {
    const executeBasketArbitrage = vi.fn().mockResolvedValue({
      kind: 'basket',
      status: 'failed',
      reason: 'order_rejected',
      idempotencyKey: 'basket-key',
      executionId: 'basket-exec',
      state: 'failed'
    });
    const { supervisor } = createSupervisorForCircuitAccounting(executeBasketArbitrage);

    await supervisor.handleRiskApproved({
      opportunity: createBasketOpportunity(Date.now()),
      size: 1
    });

    expect(executeBasketArbitrage).toHaveBeenCalledTimes(1);
    expect(supervisor.marketCircuitBreakers.get('market-1').getFailureCount()).toBe(1);
    expect(supervisor.marketCircuitBreakers.get('market-2').getFailureCount()).toBe(1);
  });
});

describe('Supervisor FW market metadata wiring', () => {
  it('passes rich market metadata into FW scan universe', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [
          {
            marketId: 'market-1',
            yesTokenId: 'yes-1',
            noTokenId: 'no-1',
            question: 'Will Candidate A win election 2026?',
            category: 'politics',
            tags: ['election', 'candidate-a', 'usa']
          }
        ],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off'
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    const scanFwUniverse = vi.fn().mockResolvedValue([]);
    const internals = supervisor as unknown as {
      scanner: {
        scanPair: (...args: unknown[]) => unknown;
        scanFwUniverse: (...args: unknown[]) => Promise<unknown[]>;
      };
      marketData: { getOrderBook: (tokenId: string) => unknown };
      handleMarketUpdated: (event: { tokenId: string }) => Promise<void>;
    };

    internals.scanner = {
      scanPair: () => null,
      scanFwUniverse
    };
    internals.marketData = {
      getOrderBook: () => undefined
    };

    await internals.handleMarketUpdated({ tokenId: 'yes-1' });

    expect(scanFwUniverse).toHaveBeenCalledTimes(1);
    expect(scanFwUniverse.mock.calls[0]?.[1]).toEqual([
      {
        marketId: 'market-1',
        yesTokenId: 'yes-1',
        noTokenId: 'no-1',
        question: 'Will Candidate A win election 2026?',
        category: 'politics',
        tags: ['election', 'candidate-a', 'usa']
      }
    ]);
  });
});

describe('Supervisor FW scan coalescing', () => {
  it('coalesces concurrent market updates into serialized FW universe scans', async () => {
    vi.useFakeTimers();

    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper'
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    let resolveFirst: ((value: unknown) => void) | null = null;
    const firstScan = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve;
    });

    const scanFwUniverse = vi
      .fn()
      .mockReturnValueOnce(firstScan)
      .mockResolvedValueOnce([]);

    const internals = supervisor as unknown as {
      started: boolean;
      scanner: {
        scanPair: (...args: unknown[]) => unknown;
        scanFwUniverse: (...args: unknown[]) => Promise<unknown[]>;
      };
      marketData: { getOrderBook: (tokenId: string) => unknown };
      handleMarketUpdated: (event: { tokenId: string }) => Promise<void>;
    };
    internals.started = true;
    internals.scanner = {
      scanPair: () => null,
      scanFwUniverse
    };
    internals.marketData = {
      getOrderBook: () => undefined
    };

    const firstUpdate = internals.handleMarketUpdated({ tokenId: 'yes-1' });
    const secondUpdate = internals.handleMarketUpdated({ tokenId: 'yes-1' });

    expect(scanFwUniverse).toHaveBeenCalledTimes(1);
    resolveFirst?.([]);
    await firstUpdate;
    await secondUpdate;
    await vi.advanceTimersByTimeAsync(300);

    expect(scanFwUniverse).toHaveBeenCalledTimes(2);
  });
});

describe('Supervisor FW universe mode selection', () => {
  it('selects dependency-cohort universes deterministically when relation graph is dense enough', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [
          {
            marketId: 'm-a',
            yesTokenId: 'yes-a',
            noTokenId: 'no-a',
            question: 'Will rain tomorrow?',
            category: 'weather',
            tags: ['rain', 'weather']
          },
          {
            marketId: 'm-b',
            yesTokenId: 'yes-b',
            noTokenId: 'no-b',
            question: 'Will not rain tomorrow?',
            category: 'weather',
            tags: ['rain', 'weather']
          },
          {
            marketId: 'm-c',
            yesTokenId: 'yes-c',
            noTokenId: 'no-c',
            question: 'Will Team X win?',
            category: 'sports',
            tags: ['sports', 'team-x']
          },
          {
            marketId: 'm-d',
            yesTokenId: 'yes-d',
            noTokenId: 'no-d',
            question: 'Will GDP beat forecast?',
            category: 'economy',
            tags: ['macro', 'gdp']
          }
        ],
        policy: { ...DEFAULT_TRADE_POLICY, fwUniverseMode: 'dependency_cohort' },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper'
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    const scanFwUniverse = vi.fn(async () => []);
    const internals = supervisor as unknown as {
      started: boolean;
      scanner: {
        scanPair: (...args: unknown[]) => unknown;
        scanFwUniverse: (...args: unknown[]) => Promise<unknown[]>;
      };
      marketData: { getOrderBook: (tokenId: string) => unknown };
      handleMarketUpdated: (event: { tokenId: string }) => Promise<void>;
    };
    internals.started = true;
    internals.scanner = {
      scanPair: () => null,
      scanFwUniverse
    };
    internals.marketData = {
      getOrderBook: () => undefined
    };

    await internals.handleMarketUpdated({ tokenId: 'yes-a' });

    expect(scanFwUniverse).toHaveBeenCalledTimes(1);
    const selectedUniverse = scanFwUniverse.mock.calls[0]?.[1] as Array<{ marketId: string }>;
    expect(selectedUniverse.map((entry) => entry.marketId).sort((left, right) => left.localeCompare(right))).toEqual([
      'm-a',
      'm-b'
    ]);
  });

  it('falls back to broad rotation when dependency cohort graph is sparse', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [
          {
            marketId: 'm-x',
            yesTokenId: 'yes-x',
            noTokenId: 'no-x',
            question: 'Will Team X win?',
            category: 'sports',
            tags: ['sports', 'team-x']
          },
          {
            marketId: 'm-y',
            yesTokenId: 'yes-y',
            noTokenId: 'no-y',
            question: 'Will GDP beat forecast?',
            category: 'economy',
            tags: ['macro', 'gdp']
          }
        ],
        policy: { ...DEFAULT_TRADE_POLICY, fwUniverseMode: 'dependency_cohort' },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: true,
        tradingMode: 'paper'
      },
      withMessageBus({
        clob: {} as unknown as PolymarketClob,
        dataApi: {} as unknown as PolymarketDataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      })
    );

    const scanFwUniverse = vi.fn(async () => []);
    const internals = supervisor as unknown as {
      started: boolean;
      scanner: {
        scanPair: (...args: unknown[]) => unknown;
        scanFwUniverse: (...args: unknown[]) => Promise<unknown[]>;
      };
      marketData: { getOrderBook: (tokenId: string) => unknown };
      handleMarketUpdated: (event: { tokenId: string }) => Promise<void>;
    };
    internals.started = true;
    internals.scanner = {
      scanPair: () => null,
      scanFwUniverse
    };
    internals.marketData = {
      getOrderBook: () => undefined
    };

    await internals.handleMarketUpdated({ tokenId: 'yes-x' });

    expect(scanFwUniverse).toHaveBeenCalledTimes(1);
    const selectedUniverse = scanFwUniverse.mock.calls[0]?.[1] as Array<{ marketId: string }>;
    expect(selectedUniverse.map((entry) => entry.marketId).sort((left, right) => left.localeCompare(right))).toEqual([
      'm-x',
      'm-y'
    ]);
  });
});
