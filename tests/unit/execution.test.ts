import { describe, it, expect, vi } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import { ExecutionAdvisor } from '../../src/agents/execution/ExecutionAdvisor.js';
import {
  buildFokBuyOrder,
  createInitialExecutionState,
  toClobOrderPayload,
  isDelayedOrderResponse,
  isOrderFailure
} from '../../src/domain/execution.js';
import { createIdempotencyKey, type IdempotencyRecord } from '../../src/domain/idempotency.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { IncidentTracker } from '../../src/services/IncidentTracker.js';
import type { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { EventStore, type StoredEvent } from '../../src/core/EventStore.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import type { PolymarketRealtime, UserOrderUpdate } from '../../src/services/PolymarketRealtime.js';
import { messageBus } from '../../src/core/MessageBus.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  const base = {
    id: 'opp-test-1',
    marketId: 'market-1',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesPrice: 0.48,
    noPrice: 0.49,
    costPerSet: 0.97,
    edge: 0.03,
    tickSize: 0.01,
    maxSizeByDepth: 1000,
    minOrderSize: 0.001,
    detectedAt: Date.now(),
    gateReasons: [],
    pair: { conditionId: 'cond-1', yesTokenId: 'yes-token', noTokenId: 'no-token' }
  };
  return { ...base, ...overrides } as ArbitrageOpportunity;
}

function makeEvOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return makeOpportunity({
    type: 'ev',
    side: 'yes',
    evRaw: 0.05,
    evNet: 0.05,
    modelConfidence: 0.9,
    ...overrides
  });
}

function makeMockClob(
  responses: { yes: unknown; no: unknown },
  options: { onCreateOrder?: (response: unknown, callIndex: number) => void } = {}
): PolymarketClob {
  let callCount = 0;
  const onCreate = options.onCreateOrder;
  return {
    createOrder: vi.fn().mockImplementation(() => {
      const response = callCount === 0 ? responses.yes : responses.no;
      onCreate?.(response, callCount);
      callCount++;
      return Promise.resolve(response);
    }),
    ...makeCancelMocks()
  } as unknown as PolymarketClob;
}

class MockUserRealtime extends EventEmitter {
  constructor(private connected = true) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(next: boolean): void {
    this.connected = next;
  }
}

function asPolymarketRealtime(realtime: MockUserRealtime): PolymarketRealtime {
  return realtime as unknown as PolymarketRealtime;
}

function emitOrderMatched(realtime: MockUserRealtime, orderId: string): void {
  const event: UserOrderUpdate = {
    eventType: 'order',
    orderId,
    status: 'MATCHED',
    orderEventType: 'UPDATE',
    timestampMs: Date.now(),
    raw: {}
  };
  realtime.emit('user:order', event);
}

function makeCancelMocks() {
  let nextNonce = 1000;
  return {
    reserveNonce: vi.fn().mockImplementation(() => String(nextNonce++)),
    cancelOrder: vi
      .fn()
      .mockImplementation((orderId: string) =>
        Promise.resolve({ canceled: [orderId], not_canceled: {} })
      ),
    cancelOrders: vi
      .fn()
      .mockImplementation((orderIds: string[]) =>
        Promise.resolve({ canceled: orderIds, not_canceled: {} })
      ),
    cancelAll: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
    cancelMarketOrders: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} })
  };
}

function makeMockIncidentTracker(): IncidentTracker {
  return {
    record: vi.fn()
  } as unknown as IncidentTracker;
}

describe('ExecutionAgent', () => {
  it('updates trading flags and configs', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off'
    });

    agent.updateTradingEnabled(true);
    agent.updateTradingMode('live');
    agent.updatePolicy({ ...DEFAULT_TRADE_POLICY, submitTimeoutMs: 1 });
    agent.updateRiskConfig({ ...DEFAULT_RISK_CONFIG, maxPerTradeLossDollars: 10 });

    expect(agent.isTradingEnabled()).toBe(true);
  });

  it('cleans up tracked fill waiters', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off'
    });

    const orderId = 'order-1';
    const timeout = setTimeout(() => {}, 1000);
    const waiters = (agent as unknown as {
      fillWaiters: Map<string, Array<{ desiredSize: number; resolve: () => void; timeout: ReturnType<typeof setTimeout> }>>;
      cleanupOrderTracking: (ids: string[]) => void;
    });

    waiters.fillWaiters.set(orderId, [{ desiredSize: 1, resolve: () => {}, timeout }]);
    waiters.cleanupOrderTracking([orderId]);

    expect(waiters.fillWaiters.has(orderId)).toBe(false);
  });

  it('applies unwind hints with minimum loss ticks', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const executionAdvisor = {
      getHint: vi.fn().mockReturnValue({
        timeoutMultiplier: 1,
        unwindHint: 'conservative',
        confidence: 0.8,
        expiresAtMs: Date.now() + 1000
      })
    } as unknown as ExecutionAdvisor;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      executionAdvisor,
      executionAdvisorMode: 'advisory'
    });

    const applyUnwindHint = (agent as unknown as {
      applyUnwindHint: (marketId: string, opportunityId: string, baseLossTicks: number, maxLossTicks: number, nowMs?: number) => number;
    }).applyUnwindHint;

    const zeroTicks = applyUnwindHint.call(agent, 'm1', 'opp-1', 0, 5, Date.now());
    const nonZeroTicks = applyUnwindHint.call(agent, 'm1', 'opp-1', 2, 5, Date.now());

    expect(zeroTicks).toBe(0);
    expect(nonZeroTicks).toBeGreaterThanOrEqual(1);
  });

  it('guards invalid timeout values', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const executionAdvisor = {
      getHint: vi.fn().mockReturnValue({
        timeoutMultiplier: 1,
        unwindHint: 'neutral',
        confidence: 0.5,
        expiresAtMs: Date.now() + 1000
      })
    } as unknown as ExecutionAdvisor;

    const zeroPolicy = {
      ...DEFAULT_TRADE_POLICY,
      submitTimeoutMs: 0,
      ackTimeoutMs: 0,
      fillTimeoutMs: 0,
      cancelTimeoutMs: 0
    };

    const agent = new ExecutionAgent(zeroPolicy, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      executionAdvisor,
      executionAdvisorMode: 'advisory'
    });

    const timeouts = (agent as unknown as {
      getEffectiveTimeouts: (marketId: string, opportunityId: string, nowMs: number) => {
        submitTimeoutMs: number;
      };
    }).getEffectiveTimeouts('m1', 'opp-1', Date.now());

    expect(timeouts.submitTimeoutMs).toBe(0);
  });

  it('uses max loss ticks when slippage tolerance is zero and hint is missing', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const executionAdvisor = {
      getHint: vi.fn().mockReturnValue(null)
    } as unknown as ExecutionAdvisor;

    const riskConfig = {
      ...DEFAULT_RISK_CONFIG,
      maxUnwindLossTicks: 5,
      unwindSlippageToleranceBps: 0
    };

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      executionAdvisor,
      executionAdvisorMode: 'advisory',
      riskConfig
    });

    const calculateUnwindPrice = (agent as unknown as {
      calculateUnwindPrice: (entryPrice: number, tickSize: number, advisory?: { marketId: string; opportunityId: string; nowMs?: number }) => number;
    }).calculateUnwindPrice;

    const price = calculateUnwindPrice.call(agent, 0.5, 0.01, { marketId: 'm1', opportunityId: 'opp-1' });
    expect(price).toBe(0.45);
  });

  it('uses base loss ticks when no advisory is provided', () => {
    const clob = makeMockClob({ yes: {}, no: {} });
    const riskConfig = {
      ...DEFAULT_RISK_CONFIG,
      maxUnwindLossTicks: 3,
      unwindSlippageToleranceBps: 100
    };

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      riskConfig
    });

    const calculateUnwindPrice = (agent as unknown as {
      calculateUnwindPrice: (entryPrice: number, tickSize: number, advisory?: { marketId: string; opportunityId: string; nowMs?: number }) => number;
    }).calculateUnwindPrice;

    const price = calculateUnwindPrice.call(agent, 0.5, 0.01);
    expect(price).toBeLessThan(0.5);
  });
  describe('kill-switch (tradingEnabled)', () => {
    it('blocks execution when tradingEnabled is false', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: false,
        tradingMode: 'live'
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('trading_disabled');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('allows execution when tradingEnabled is true', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(result.state).toBe('complete');
      expect(clob.createOrder).toHaveBeenCalledTimes(2);
    });

    it('defaults to tradingEnabled=false when config not provided', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob);

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('trading_disabled');
      expect(result.state).toBe('idle');
    });

    it('isTradingEnabled returns correct state', () => {
      const clob = makeMockClob({ yes: {}, no: {} });

      const enabledAgent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });
      const disabledAgent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: false,
        tradingMode: 'live'
      });

      expect(enabledAgent.isTradingEnabled()).toBe(true);
      expect(disabledAgent.isTradingEnabled()).toBe(false);
    });
  });

  it('tracks SELL side updates from user channel', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    userRealtime.emit('user:order', {
      eventType: 'order',
      orderId: 'sell-order-1',
      side: 'SELL',
      status: 'OPEN',
      timestampMs: Date.now(),
      raw: {}
    } as UserOrderUpdate);

    const state = (agent as unknown as { userOrders: Map<string, { side?: string }> }).userOrders.get('sell-order-1');
    expect(state?.side).toBe('SELL');
  });

  it('marks cancelled orders from user channel updates', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    userRealtime.emit('user:order', {
      eventType: 'order',
      orderId: 'cancel-order-1',
      side: 'HOLD',
      status: 'OPEN',
      orderEventType: 'CANCELLATION',
      timestampMs: Date.now(),
      raw: {}
    } as UserOrderUpdate);

    const state = (agent as unknown as { userOrders: Map<string, { side?: string; cancelled?: boolean }> })
      .userOrders.get('cancel-order-1');
    expect(state?.side).toBeUndefined();
    expect(state?.cancelled).toBe(true);

    userRealtime.emit('user:order', {
      eventType: 'order',
      orderId: 'cancel-order-2',
      side: 'BUY',
      status: 'CANCELED',
      timestampMs: Date.now(),
      raw: {}
    } as UserOrderUpdate);

    const state2 = (agent as unknown as { userOrders: Map<string, { cancelled?: boolean }> })
      .userOrders.get('cancel-order-2');
    expect(state2?.cancelled).toBe(true);
  });

  it('resolves fills from user status updates', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const outcomePromise = (agent as unknown as {
      waitForFillOutcome: (orderId: string, desiredSize: number, timeoutMs: number) => Promise<{
        fullyFilled: boolean;
        cancelled: boolean;
        timedOut: boolean;
      }>;
    }).waitForFillOutcome('order-fill-1', 10, 1000);

    await Promise.resolve();
    userRealtime.emit('user:order', {
      eventType: 'order',
      orderId: 'order-fill-1',
      status: 'FILLED',
      sizeMatched: 0,
      timestampMs: now + 10,
      raw: {}
    } as UserOrderUpdate);

    const outcome = await outcomePromise;
    expect(outcome.fullyFilled).toBe(true);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.timedOut).toBe(false);

    vi.useRealTimers();
  });

  it('resolves cancelled fill waits', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const outcomePromise = (agent as unknown as {
      waitForFillOutcome: (orderId: string, desiredSize: number, timeoutMs: number) => Promise<{
        fullyFilled: boolean;
        cancelled: boolean;
        timedOut: boolean;
      }>;
    }).waitForFillOutcome('order-cancel-1', 10, 1000);

    await Promise.resolve();
    userRealtime.emit('user:order', {
      eventType: 'order',
      orderId: 'order-cancel-1',
      status: 'OPEN',
      orderEventType: 'CANCELLATION',
      timestampMs: now + 5,
      raw: {}
    } as UserOrderUpdate);

    const outcome = await outcomePromise;
    expect(outcome.fullyFilled).toBe(false);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.timedOut).toBe(false);

    vi.useRealTimers();
  });

  it('returns immediate timeout when fill timeout is non-positive', async () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const outcome = await (agent as unknown as {
      waitForFillOutcome: (orderId: string, desiredSize: number, timeoutMs: number) => Promise<{
        timedOut: boolean;
      }>;
    }).waitForFillOutcome('missing-order', 10, 0);

    expect(outcome.timedOut).toBe(true);
  });

  it('records portfolio fills from user trades and ignores duplicates', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const portfolio = { applyFillWithReconciliation: vi.fn() } as unknown as PortfolioAgent;
    const _agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      portfolio,
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const handler = vi.fn();
    messageBus.on('execution:fill', handler);

    userRealtime.emit('user:trade', {
      eventType: 'trade',
      tradeId: 'trade-1',
      marketId: 'm1',
      assetId: 'asset-1',
      side: 'BUY',
      price: 0.45,
      size: 2,
      takerOrderId: 'order-taker-1',
      makerOrderIds: ['order-maker-1', 'order-maker-2'],
      makerMatches: [
        { orderId: 'order-maker-1', matchedAmount: 1 },
        { orderId: 'order-maker-2', matchedAmount: 0 }
      ],
      timestampMs: Date.now(),
      raw: {}
    });

    userRealtime.emit('user:trade', {
      eventType: 'trade',
      tradeId: 'trade-1',
      marketId: 'm1',
      assetId: 'asset-1',
      side: 'BUY',
      price: 0.45,
      size: 2,
      takerOrderId: 'order-taker-1',
      makerOrderIds: ['order-maker-1'],
      makerMatches: [{ orderId: 'order-maker-1', matchedAmount: 1 }],
      timestampMs: Date.now(),
      raw: {}
    });

    expect(portfolio.applyFillWithReconciliation).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);

    messageBus.off('execution:fill', handler);
  });

  it('skips portfolio fill when trade data is incomplete', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const portfolio = { applyFillWithReconciliation: vi.fn() } as unknown as PortfolioAgent;
    const _agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      portfolio,
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    userRealtime.emit('user:trade', {
      eventType: 'trade',
      tradeId: 'trade-3',
      marketId: 'm1',
      assetId: 'asset-1',
      side: 'HOLD',
      price: NaN,
      size: 2,
      takerOrderId: 'order-taker-3',
      makerOrderIds: [],
      makerMatches: [],
      timestampMs: Date.now(),
      raw: {}
    });

    expect(portfolio.applyFillWithReconciliation).not.toHaveBeenCalled();
  });
  it('ignores trade updates when portfolio is missing', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = makeMockClob({ yes: {}, no: {} });
    const _agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: false,
      tradingMode: 'off',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    userRealtime.emit('user:trade', {
      eventType: 'trade',
      tradeId: 'trade-2',
      marketId: 'm1',
      assetId: 'asset-1',
      side: 'BUY',
      price: 0.45,
      size: 2,
      takerOrderId: 'order-taker-2',
      makerOrderIds: [],
      makerMatches: [],
      timestampMs: Date.now(),
      raw: {}
    });
  });

  describe('trading mode enforcement', () => {
    it('blocks execution in shadow mode even when tradingEnabled is true', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'shadow'
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('shadow_mode');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('blocks execution in paper mode even when tradingEnabled is true', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'paper'
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('paper_mode');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('blocks execution in live mode when user channel is unconfigured (near-zero-risk)', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('user_channel_unconfigured');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('blocks execution in live mode when user channel is disconnected (near-zero-risk)', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const userRealtime = new MockUserRealtime(false);
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('user_channel_disconnected');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('blocks EV execution when user channel is unconfigured', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const policy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' as const };
      const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });

      const result = await agent.executeArbitrage(makeEvOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('user_channel_unconfigured');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('blocks EV execution when user channel is disconnected', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const policy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' as const };
      const userRealtime = new MockUserRealtime(false);
      const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeEvOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('user_channel_disconnected');
      expect(result.state).toBe('idle');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });
  });

  it('blocks execution when circuit breaker is open', async () => {
    const clob = makeMockClob({
      yes: { orderId: 'o1', status: 'LIVE' },
      no: { orderId: 'o2', status: 'LIVE' }
    });

    const incidentTracker = makeMockIncidentTracker();
    const circuitBreakers = { isOpen: vi.fn().mockReturnValue(true) } as unknown as { isOpen: (marketId: string) => boolean };
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      circuitBreakers
    });

    const result = await agent.executeArbitrage(makeOpportunity(), 100);

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('circuit_breaker');
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'circuit_breaker' }));
  });

  describe('pre-trade controls', () => {
    it('blocks when decision latency exceeds limit', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxDecisionLatencyMs: 10
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const now = Date.now();
      const opp = makeOpportunity({ detectedAt: now - 100 });
      const result = await agent.executeArbitrage(opp, 100, { nowMs: now });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('decision_latency_exceeded');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'latency_exceeded' })
      );
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('does not block solely on order velocity', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const incidentTracker = makeMockIncidentTracker();
      metrics.recordOrderAttempt('market-1', now);

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxOrdersPerMinute: 5,
        orderVelocityWindowMs: 60000,
        maxOrderToTradeRatio: 100,
        orderToTradeWindowMs: 60000,
        strategyMode: 'standard',
        fillTimeoutMs: 0
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(incidentTracker.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'velocity_throttle' })
      );

      vi.useRealTimers();
    });

    it('blocks when order velocity exceeds limit', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const incidentTracker = makeMockIncidentTracker();
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordOrderAttempt('market-1', now);

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxOrdersPerMinute: 2,
        orderVelocityWindowMs: 60000,
        maxOrderToTradeRatio: 100,
        orderToTradeWindowMs: 60000
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('velocity_throttle');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'velocity_throttle' })
      );

      vi.useRealTimers();
    });

    it('blocks when OTR exceeds limit', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const incidentTracker = makeMockIncidentTracker();
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordFill('market-1', now);

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxOrdersPerMinute: 100,
        orderVelocityWindowMs: 60000,
        maxOrderToTradeRatio: 2,
        orderToTradeWindowMs: 60000
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('otr_exceeded');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'otr_exceeded' })
      );

      vi.useRealTimers();
    });

    it('blocks when delayed ack rate exceeds limit', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const incidentTracker = makeMockIncidentTracker();
      metrics.recordOrderAttempt('market-1', now);
      metrics.recordDelayedAck('market-1', now);

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxDelayedAckRate: 0.1,
        orderToTradeWindowMs: 60000
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100, { nowMs: now });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('delayed_ack_rate_exceeded');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'latency_exceeded' })
      );
      expect(clob.createOrder).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('blocks when price moves beyond band', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        priceBandBps: 10
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const yesBook = { bestAsk: { price: 0.6, size: 1 } } as OrderBookState;
      const noBook = { bestAsk: { price: 0.7, size: 1 } } as OrderBookState;

      const result = await agent.executeArbitrage(makeOpportunity(), 100, { yesBook, noBook });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('price_moved');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'price_moved' })
      );
    });

    it('allows price checks when opportunity prices are zero', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const yesBook = { bestAsk: { price: 0.5, size: 1 } } as OrderBookState;
      const noBook = { bestAsk: { price: 0.5, size: 1 } } as OrderBookState;

      const result = await agent.executeArbitrage(
        makeOpportunity({ yesPrice: 0, noPrice: 0 }),
        1,
        { yesBook, noBook }
      );

      expect(result.status).toBe('submitted');
    });
  });

  describe('order execution', () => {
    it('throws when rejectDelayed is disabled', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(
        { ...DEFAULT_TRADE_POLICY, rejectDelayed: false },
        clob,
        undefined,
        undefined,
        {
          tradingEnabled: true,
          tradingMode: 'live',
          userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
        }
      );

      await expect(agent.executeArbitrage(makeOpportunity(), 100)).rejects.toThrow(
        /rejectDelayed=true/
      );
    });

    it('executes without user channel in standard mode', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });

      const policy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' as const };
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const agent = new ExecutionAgent(policy, clob, undefined, metrics, {
        tradingEnabled: true,
        tradingMode: 'live'
      });

      const result = await agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 100, { nowMs: now });

      expect(result.status).toBe('submitted');
      expect(result.state).toBe('complete');
      expect(clob.createOrder).toHaveBeenCalledTimes(2);

      const stats = metrics.getOrderStats('market-1', 60000, now);
      expect(stats.orders).toBe(2);
      expect(stats.fills).toBe(2);

      vi.useRealTimers();
    });

    it('fails and cancels when order responses are missing order IDs (user channel)', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { status: 'LIVE' },
        no: { status: 'LIVE' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_failed');
      expect(clob.cancelMarketOrders).toHaveBeenCalledTimes(2);
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_failed' })
      );
    });

    it('returns submitted status on successful FOK orders', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(result.yesOrder).toBeDefined();
      expect(result.noOrder).toBeDefined();
      expect(result.idempotencyKey).toBeDefined();
      expect(result.executionId).toBe(result.idempotencyKey);
      expect(result.state).toBe('complete');
    });

    it('records order attempts and fills when metrics are provided', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      const stats = metrics.getOrderStats('market-1', 60000, now);
      expect(stats.orders).toBe(2);
      expect(stats.fills).toBe(2);

      vi.useRealTimers();
    });

    it('records incident and returns failed on delayed orders', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'DELAYED' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_delayed');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_delayed' })
      );
    });

    it('records critical incident when cancel fails', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      clob.cancelOrder = vi
        .fn()
        .mockImplementation((orderId: string) =>
          Promise.resolve({ canceled: [], not_canceled: { [orderId]: 'not_found' } })
        );

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_cancel_failed' })
      );
    });

    it('records cancel failure when both legs are delayed', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'DELAYED' }
      });
      clob.cancelOrder = vi
        .fn()
        .mockImplementation((orderId: string) =>
          Promise.resolve({ canceled: [], not_canceled: { [orderId]: 'not_found' } })
        );

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_cancel_failed' })
      );
    });

    it('records critical incident when cancel throws', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      clob.cancelOrder = vi
        .fn()
        .mockRejectedValueOnce(42);

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_cancel_failed' })
      );
      const recordMock = incidentTracker.record as unknown as { mock: { calls: unknown[][] } };
      const cancelIncident = recordMock.mock.calls.find((call) => call[0]?.reason === 'order_cancel_failed');
      expect(cancelIncident?.[0]?.detail?.cancel?.error).toBe('42');
    });

    it('records fallback cancel error when cancel throws undefined', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      clob.cancelOrder = vi.fn().mockRejectedValueOnce(undefined);

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      const recordMock = incidentTracker.record as unknown as { mock: { calls: unknown[][] } };
      const cancelIncident = recordMock.mock.calls.find((call) => call[0]?.reason === 'order_cancel_failed');
      expect(cancelIncident?.[0]?.detail?.cancel?.error).toBe('cancel_failed');
    });

    it('records critical incident when cancel response is missing', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      clob.cancelOrder = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_cancel_failed' })
      );
    });

    it('does not flag cancel failure when not_canceled is non-object', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      clob.cancelOrder = vi
        .fn()
        .mockImplementation((orderId: string) =>
          Promise.resolve({ canceled: [orderId], not_canceled: 'oops' })
        );

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      const recordMock = incidentTracker.record as unknown as { mock: { calls: unknown[][] } };
      expect(recordMock.mock.calls.some((call) => call[0]?.reason === 'order_cancel_failed')).toBe(false);
    });

    it('records cancel error message when cancel throws Error', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'DELAYED' }
      });
      clob.cancelOrder = vi.fn().mockRejectedValue(new Error('cancel error'));

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      const recordMock = incidentTracker.record as unknown as { mock: { calls: unknown[][] } };
      const cancelIncident = recordMock.mock.calls.find((call) => call[0]?.reason === 'order_cancel_failed');
      expect(cancelIncident?.[0]?.detail?.yes?.error ?? cancelIncident?.[0]?.detail?.cancel?.error).toBe(
        'cancel error'
      );
    });

    it('flags cancel failure when canceled list is malformed', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'DELAYED' }
      });
      clob.cancelOrder = vi
        .fn()
        .mockImplementation((_orderId: string) =>
          Promise.resolve({ canceled: 'oops', not_canceled: {} })
        );

      const incidentTracker = makeMockIncidentTracker();
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_cancel_failed' })
      );
    });

    it('records incident and returns failed on submit rejection', async () => {
      const clob = {
        createOrder: vi
          .fn()
          .mockRejectedValueOnce(new Error('network down'))
          .mockRejectedValueOnce(new Error('network down')),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_failed');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_failed' })
      );
    });

    it('skips submit timeout when configured to 0', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        submitTimeoutMs: 0
      };

      const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(result.state).toBe('complete');
    });

    it('fails when submit timeout is exceeded', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = {
        createOrder: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ orderId: 'yes-order-1', status: 'LIVE' }), 50);
            })
        ),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        submitTimeoutMs: 10,
        ackTimeoutMs: 1000
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 100);
      await vi.advanceTimersByTimeAsync(20);
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_timeout');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_timeout' })
      );

      await vi.runAllTimersAsync();
      vi.useRealTimers();
    });

    it('fails when ack latency exceeds timeout', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = {
        createOrder: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ orderId: 'yes-order-1', status: 'LIVE' }), 30);
            })
        ),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        submitTimeoutMs: 1000,
        ackTimeoutMs: 10
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 100);
      await vi.advanceTimersByTimeAsync(40);
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_timeout');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_timeout' })
      );

      await vi.runAllTimersAsync();
      vi.useRealTimers();
    });

    it('fails when fill timeout is exceeded (user channel)', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const policy = {
        ...DEFAULT_TRADE_POLICY,
        submitTimeoutMs: 1000,
        ackTimeoutMs: 1000,
        fillTimeoutMs: 25
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 100);
      await vi.advanceTimersByTimeAsync(30);
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_timeout');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_timeout' })
      );

      await vi.runAllTimersAsync();
      vi.useRealTimers();
    });

    it('records delayed ack metrics when responses are delayed', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'DELAYED' }
      });
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.state).toBe('failed');
      expect(metrics.getDelayedAckRate('market-1', 60000, Date.now())).toBeGreaterThan(0);
    });

    it('records incident and returns failed on rejected orders', async () => {
      const clob = makeMockClob({
        yes: { errorMsg: 'Insufficient balance', success: false },
        no: { errorMsg: 'Insufficient balance', success: false }
      });
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_rejected');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_rejected' })
      );
    });

    it('unwinds with FAK order when one leg fails', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const incidentTracker = makeMockIncidentTracker();
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        portfolio,
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(opportunity, 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('partial_fill');
      expect(result.state).toBe('complete');

      const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
      expect(unwindPayload.order_type).toBe('FAK');
      expect(unwindPayload.side).toBe('SELL');
      expect(unwindPayload.token_id).toBe(opportunity.yesTokenId);
      expect(unwindPayload.price).toBe(0.46);

      expect(portfolio.applyUnwind).toHaveBeenCalledWith(
        expect.objectContaining({
          marketId: opportunity.marketId,
          tokenId: opportunity.yesTokenId,
          entryPrice: 0.48,
          unwindPrice: 0.46,
          size: 100
        })
      );

      const recordMock = incidentTracker.record as unknown as { mock: { calls: unknown[][] } };
      expect(recordMock.mock.calls.some((call) => call[0]?.reason === 'partial_fill')).toBe(true);
      expect(recordMock.mock.calls.some((call) => call[0]?.reason === 'unwind_triggered')).toBe(true);
    });

    it('applies unwind hint in advisory mode when aggressive', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const executionAdvisor = new ExecutionAdvisor({ enabled: true });
      const riskConfig = {
        ...DEFAULT_RISK_CONFIG,
        maxUnwindLossTicks: 6,
        unwindSlippageToleranceBps: 300
      };

      try {
        messageBus.emit('learning:insight', {
          insights: [
            { market_id: opportunity.marketId, value: 0.9, ttl_ms: 60000, confidence: 0.9 }
          ]
        });

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          portfolio,
          riskConfig,
          executionAdvisor,
          executionAdvisorMode: 'advisory',
          userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
        });

        await agent.executeArbitrage(opportunity, 100);

        const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
        expect(unwindPayload.price).toBe(0.45);
      } finally {
        executionAdvisor.stop();
      }
    });

    it('applies unwind hint in advisory mode when conservative', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const executionAdvisor = new ExecutionAdvisor({ enabled: true });
      const riskConfig = {
        ...DEFAULT_RISK_CONFIG,
        maxUnwindLossTicks: 6,
        unwindSlippageToleranceBps: 300
      };

      try {
        messageBus.emit('learning:insight', {
          insights: [
            { market_id: opportunity.marketId, value: 0.2, ttl_ms: 60000, confidence: 0.8 }
          ]
        });

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          portfolio,
          riskConfig,
          executionAdvisor,
          executionAdvisorMode: 'advisory',
          userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
        });

        await agent.executeArbitrage(opportunity, 100);

        const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
        expect(unwindPayload.price).toBeCloseTo(0.47, 8);
      } finally {
        executionAdvisor.stop();
      }
    });

    it('keeps base unwind price when hint is neutral', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const executionAdvisor = new ExecutionAdvisor({ enabled: true });
      const riskConfig = {
        ...DEFAULT_RISK_CONFIG,
        maxUnwindLossTicks: 6,
        unwindSlippageToleranceBps: 300
      };

      try {
        messageBus.emit('learning:insight', {
          insights: [
            { market_id: opportunity.marketId, value: 0.5, ttl_ms: 60000, confidence: 0.6 }
          ]
        });

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          portfolio,
          riskConfig,
          executionAdvisor,
          executionAdvisorMode: 'advisory',
          userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
        });

        await agent.executeArbitrage(opportunity, 100);

        const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
        expect(unwindPayload.price).toBe(0.46);
      } finally {
        executionAdvisor.stop();
      }
    });

    it('ignores unwind hint in shadow mode', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const executionAdvisor = new ExecutionAdvisor({ enabled: true });
      const riskConfig = {
        ...DEFAULT_RISK_CONFIG,
        maxUnwindLossTicks: 6,
        unwindSlippageToleranceBps: 300
      };

      try {
        messageBus.emit('learning:insight', {
          insights: [
            { market_id: opportunity.marketId, value: 0.9, ttl_ms: 60000, confidence: 0.9 }
          ]
        });

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          portfolio,
          riskConfig,
          executionAdvisor,
          executionAdvisorMode: 'shadow',
          userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
        });

        await agent.executeArbitrage(opportunity, 100);

        const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
        expect(unwindPayload.price).toBe(0.46);
      } finally {
        executionAdvisor.stop();
      }
    });

    it('uses book tick size for unwind pricing when available', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const yesBook = { tickSize: 0.02 } as unknown as OrderBookState;
      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        portfolio,
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      await agent.executeArbitrage(opportunity, 100, { yesBook });

      const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
      expect(unwindPayload.price).toBe(0.44);
    });

    it('caps unwind price by slippage tolerance bps when tighter than maxUnwindLossTicks', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const portfolio = {
        expectFill: vi.fn(),
        applyFillWithReconciliation: vi.fn(),
        applyUnwind: vi.fn()
      } as unknown as PortfolioAgent;
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const riskConfig = { ...DEFAULT_RISK_CONFIG, maxUnwindLossTicks: 10, unwindSlippageToleranceBps: 1 };

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        portfolio,
        riskConfig,
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      await agent.executeArbitrage(opportunity, 100);

      const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
      expect(unwindPayload.price).toBeCloseTo(0.47, 8);
    });

    it('uses entry price when unwind tick size is non-positive', async () => {
      const policy = { ...DEFAULT_TRADE_POLICY, fallbackTickSize: 0 };
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0 });
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      await agent.executeArbitrage(opportunity, 100);

      const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
      expect(unwindPayload.price).toBe(0.48);
    });

    it('blocks when unwind fails after partial fill', async () => {
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0.01 });
      const incidentTracker = makeMockIncidentTracker();
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockResolvedValueOnce({ errorMsg: 'no_liquidity', success: false }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(opportunity, 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('unwind_failed');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unwind_failed', recoveryAction: 'block' })
      );
    });

    it('uses fallback tick size and fails when unwind throws', async () => {
      const policy = { ...DEFAULT_TRADE_POLICY, fallbackTickSize: 0.02 };
      const opportunity = makeOpportunity({ yesPrice: 0.48, tickSize: 0 });
      const incidentTracker = makeMockIncidentTracker();
      const clob = {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
          .mockResolvedValueOnce({ errorMsg: 'Insufficient balance', success: false })
          .mockRejectedValueOnce(new Error('unwind down')),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const result = await agent.executeArbitrage(opportunity, 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('unwind_failed');
      const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
      expect(unwindPayload.price).toBe(0.44);
    });

    it('fails when leg ack skew exceeds limit', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const clob = {
        createOrder: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                setTimeout(() => resolve({ orderId: 'yes-order-1', status: 'LIVE' }), 10);
              })
          )
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                setTimeout(() => resolve({ orderId: 'no-order-1', status: 'LIVE' }), 60);
              })
          ),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const incidentTracker = makeMockIncidentTracker();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        maxLegSkewMs: 20
      };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(new MockUserRealtime(true))
      });

      const resultPromise = agent.executeArbitrage(makeOpportunity(), 100, { nowMs: now });
      await vi.advanceTimersByTimeAsync(70);
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('leg_skew_exceeded');
      expect(result.state).toBe('failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'latency_exceeded' })
      );

      vi.useRealTimers();
    });
  });

  describe('idempotency', () => {
    it('generates consistent idempotency key for same opportunity', async () => {
      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      }, {
        onCreateOrder: (response) => {
          const orderId = (response as { orderId?: string }).orderId;
          if (orderId) emitOrderMatched(userRealtime, orderId);
        }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const opp = makeOpportunity({ detectedAt: 1000 });
      const result1 = await agent.executeArbitrage(opp, 100);
      const result2 = await agent.executeArbitrage(opp, 100);

      expect(result1.idempotencyKey).toBe(result2.idempotencyKey);
      expect(result1.executionId).toBe(result2.executionId);
    });

    it('reuses stored order IDs on retry without re-submitting', async () => {
      const now = Date.now();
      const opp = makeOpportunity({ detectedAt: now });
      const baseKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const dbPath = `data/test-${randomUUID()}.db`;
      const store = new EventStore({ dbPath });

      store.upsertIdempotencyRecord({
        key: `${baseKey}:yes`,
        nonce: '1001',
        status: 'submitted',
        orderId: 'yes-order-1',
        createdAt: now,
        updatedAt: now
      });
      store.upsertIdempotencyRecord({
        key: `${baseKey}:no`,
        nonce: '1002',
        status: 'submitted',
        orderId: 'no-order-1',
        createdAt: now,
        updatedAt: now
      });

      try {
        const userRealtime = new MockUserRealtime(true);

        const clob = makeMockClob({
          yes: { orderId: 'fresh-yes', status: 'LIVE' },
          no: { orderId: 'fresh-no', status: 'LIVE' }
        });

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          eventStore: store,
          userRealtime: asPolymarketRealtime(userRealtime)
        });

        const resultPromise = agent.executeArbitrage(opp, 100, { nowMs: now });
        await Promise.resolve();
        emitOrderMatched(userRealtime, 'yes-order-1');
        emitOrderMatched(userRealtime, 'no-order-1');
        const result = await resultPromise;

        expect(clob.createOrder).not.toHaveBeenCalled();
        expect(result.yesOrder?.orderID).toBe('yes-order-1');
        expect(result.noOrder?.orderID).toBe('no-order-1');
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it('reuses stored nonce when submitting orders', async () => {
      const now = Date.now();
      const opp = makeOpportunity({ detectedAt: now });
      const baseKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const dbPath = `data/test-${randomUUID()}.db`;
      const store = new EventStore({ dbPath });

      store.upsertIdempotencyRecord({
        key: `${baseKey}:yes`,
        nonce: '1234',
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
      store.upsertIdempotencyRecord({
        key: `${baseKey}:no`,
        nonce: 'nonce-5678',
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });

      try {
        const userRealtime = new MockUserRealtime(true);

        const clob = {
          createOrder: vi.fn().mockImplementation(() => {
            const orderId = `order-${randomUUID()}`;
            emitOrderMatched(userRealtime, orderId);
            return Promise.resolve({ orderId, status: 'LIVE' });
          }),
          ...makeCancelMocks()
        } as unknown as PolymarketClob;

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
          tradingEnabled: true,
          tradingMode: 'live',
          eventStore: store,
          userRealtime: asPolymarketRealtime(userRealtime)
        });

        await agent.executeArbitrage(opp, 100, { nowMs: now });

        const yesPayload = clob.createOrder.mock.calls[0][0] as Record<string, unknown>;
        const noPayload = clob.createOrder.mock.calls[1][0] as Record<string, unknown>;

        expect(yesPayload.nonce).toBe(1234);
        expect(noPayload.nonce).toBe('nonce-5678');
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it('prunes stale idempotency cache between runs', async () => {
      const base = Date.now();
      const later = base + DEFAULT_TRADE_POLICY.orderToTradeWindowMs + 1000;
      const opp = makeOpportunity({ detectedAt: base });

      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob(
        {
          yes: { orderId: 'yes-order-1', status: 'LIVE' },
          no: { orderId: 'no-order-1', status: 'LIVE' }
        },
        {
          onCreateOrder: (response) => {
            const orderId = (response as { orderId?: string }).orderId;
            if (orderId) emitOrderMatched(userRealtime, orderId);
          }
        }
      );

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      await agent.executeArbitrage(opp, 100, { nowMs: base });
      await agent.executeArbitrage(opp, 100, { nowMs: later });

      expect(clob.reserveNonce).toHaveBeenCalledTimes(4);
    });
  });

  describe('EV execution', () => {
    it('blocks EV when side is missing', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now, side: undefined });
      const clob = makeMockClob({ yes: {}, no: {} });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('ev_missing_side');
    });

    it('blocks EV when price moves beyond band', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now, side: 'yes', yesPrice: 0.4 });
      const clob = makeMockClob({ yes: { orderId: 'o1', status: 'LIVE' }, no: { orderId: 'o2', status: 'LIVE' } });
      const incidentTracker = makeMockIncidentTracker();
      const userRealtime = new MockUserRealtime(true);
      const policy = { ...DEFAULT_TRADE_POLICY, priceBandBps: 10 };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const yesBook = { bestAsk: { price: 0.6, size: 1 } } as OrderBookState;
      const noBook = { bestAsk: { price: 0.7, size: 1 } } as OrderBookState;

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now, yesBook, noBook });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('price_moved');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'price_moved' })
      );
    });

    it('blocks EV when price is invalid', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now, yesPrice: 0 });
      const clob = makeMockClob({ yes: {}, no: {} });
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('invalid_price');
    });

    it('blocks EV helper when side is missing', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now, side: undefined });
      const clob = {
        createOrder: vi.fn(),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });

      const idempotencyKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const yesKey = `${idempotencyKey}:yes`;
      const noKey = `${idempotencyKey}:no`;
      const baseRecord: IdempotencyRecord = {
        key: yesKey,
        nonce: 'n1',
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      const timeouts = (agent as unknown as { timeouts: unknown }).timeouts;

      const result = await (agent as unknown as {
        executeEvOrder: (
          opportunity: ArbitrageOpportunity,
          size: number,
          context: unknown,
          params: {
            nowMs: number;
            idempotencyKey: string;
            executionId: string;
            idleState: string;
            timeouts: unknown;
            yesIdempotencyKey: string;
            noIdempotencyKey: string;
            yesRecord: IdempotencyRecord;
            noRecord: IdempotencyRecord;
            trackedOrderIds: string[];
            requiresUserChannel: boolean;
          }
        ) => Promise<{ status: string; reason?: string }>;
      }).executeEvOrder(opp, 10, undefined, {
        nowMs: now,
        idempotencyKey,
        executionId: idempotencyKey,
        idleState: 'idle',
        timeouts,
        yesIdempotencyKey: yesKey,
        noIdempotencyKey: noKey,
        yesRecord: baseRecord,
        noRecord: { ...baseRecord, key: noKey },
        trackedOrderIds: [],
        requiresUserChannel: false
      });

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('ev_missing_side');
    });

    it('records portfolio expectation in EV helper', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now, side: 'yes' });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ orderID: 'ev-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const portfolio = { expectFill: vi.fn() } as unknown as PortfolioAgent;

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        portfolio
      });

      const idempotencyKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const yesKey = `${idempotencyKey}:yes`;
      const noKey = `${idempotencyKey}:no`;
      const baseRecord: IdempotencyRecord = {
        key: yesKey,
        nonce: 'n1',
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      const timeouts = (agent as unknown as { timeouts: unknown }).timeouts;

      await (agent as unknown as {
        executeEvOrder: (
          opportunity: ArbitrageOpportunity,
          size: number,
          context: unknown,
          params: {
            nowMs: number;
            idempotencyKey: string;
            executionId: string;
            idleState: string;
            timeouts: unknown;
            yesIdempotencyKey: string;
            noIdempotencyKey: string;
            yesRecord: IdempotencyRecord;
            noRecord: IdempotencyRecord;
            trackedOrderIds: string[];
            requiresUserChannel: boolean;
          }
        ) => Promise<{ status: string; state: string }>;
      }).executeEvOrder(opp, 10, undefined, {
        nowMs: now,
        idempotencyKey,
        executionId: idempotencyKey,
        idleState: 'idle',
        timeouts,
        yesIdempotencyKey: yesKey,
        noIdempotencyKey: noKey,
        yesRecord: baseRecord,
        noRecord: { ...baseRecord, key: noKey },
        trackedOrderIds: [],
        requiresUserChannel: false
      });

      expect(portfolio.expectFill).toHaveBeenCalledWith(
        expect.objectContaining({
          opportunityId: opp.id,
          tokenId: opp.yesTokenId,
          expectedSize: 10,
          expectedPrice: opp.yesPrice
        })
      );
    });

    it('waits for EV fills and confirms idempotency', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const baseKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const dbPath = `data/test-${randomUUID()}.db`;
      const store = new EventStore({ dbPath });

      try {
        const userRealtime = new MockUserRealtime(true);
        const clob = {
          createOrder: vi.fn().mockImplementation(() => {
            const orderId = 'ev-order-1';
            emitOrderMatched(userRealtime, orderId);
            return Promise.resolve({ orderId, status: 'LIVE' });
          }),
          ...makeCancelMocks()
        } as unknown as PolymarketClob;

        const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
        const policy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' as const };
        const agent = new ExecutionAgent(policy, clob, undefined, metrics, {
          tradingEnabled: true,
          tradingMode: 'live',
          eventStore: store,
          userRealtime: asPolymarketRealtime(userRealtime)
        });

        const result = await agent.executeArbitrage(opp, 50, { nowMs: now });

        expect(result.status).toBe('submitted');
        expect(result.state).toBe('complete');
        expect(clob.createOrder).toHaveBeenCalledTimes(1);
        expect(metrics.recent('fill', 1).length).toBe(1);

        const record = store.getIdempotencyRecord(`${baseKey}:yes`);
        expect(record?.status).toBe('confirmed');
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it('fails EV when order response is missing orderId', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(opp, 25, { nowMs: now });

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'order_failed' }));
    });

    it('fails EV when order response is delayed', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ status: 'DELAYED' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_delayed');
      expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'order_delayed' }));
      expect(metrics.recent('delayed_ack', 1).length).toBe(1);
    });

    it('fails EV when order response is rejected', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ status: 'rejected' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_rejected');
      expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'order_rejected' }));
    });

    it('reuses stored orderId when ack response omits it', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const baseKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const dbPath = `data/test-${randomUUID()}.db`;
      const store = new EventStore({ dbPath });

      try {
        store.upsertIdempotencyRecord({
          key: `${baseKey}:yes`,
          nonce: 'n1',
          status: 'submitted',
          orderId: 'stored-order-1',
          createdAt: now,
          updatedAt: now
        });

        const clob = {
          createOrder: vi.fn().mockResolvedValue({ status: 'DELAYED' }),
          ...makeCancelMocks()
        } as unknown as PolymarketClob;
        const incidentTracker = makeMockIncidentTracker();
        const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
        const userRealtime = new MockUserRealtime(true);

        const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, metrics, {
          tradingEnabled: true,
          tradingMode: 'live',
          eventStore: store,
          userRealtime: asPolymarketRealtime(userRealtime)
        });

        const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

        expect(result.reason).toBe('order_delayed');
        const record = store.getIdempotencyRecord(`${baseKey}:yes`);
        expect(record?.orderId).toBe('stored-order-1');
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it('returns complete when user channel is not required in EV helper', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ orderID: 'ev-order-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const idempotencyKey = createIdempotencyKey(
        `${opp.marketId}:${opp.yesTokenId}:${opp.noTokenId}:${opp.detectedAt}`
      );
      const yesKey = `${idempotencyKey}:yes`;
      const noKey = `${idempotencyKey}:no`;
      const baseRecord: IdempotencyRecord = {
        key: yesKey,
        nonce: 'n1',
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      const timeouts = (agent as unknown as { timeouts: unknown }).timeouts;

      const result = await (agent as unknown as {
        executeEvOrder: (
          opportunity: ArbitrageOpportunity,
          size: number,
          context: unknown,
          params: {
            nowMs: number;
            idempotencyKey: string;
            executionId: string;
            idleState: string;
            timeouts: unknown;
            yesIdempotencyKey: string;
            noIdempotencyKey: string;
            yesRecord: IdempotencyRecord;
            noRecord: IdempotencyRecord;
            trackedOrderIds: string[];
            requiresUserChannel: boolean;
          }
        ) => Promise<{ status: string; state: string }>;
      }).executeEvOrder(opp, 10, undefined, {
        nowMs: now,
        idempotencyKey,
        executionId: idempotencyKey,
        idleState: 'idle',
        timeouts,
        yesIdempotencyKey: yesKey,
        noIdempotencyKey: noKey,
        yesRecord: baseRecord,
        noRecord: { ...baseRecord, key: noKey },
        trackedOrderIds: [],
        requiresUserChannel: false
      });

      expect(result.status).toBe('submitted');
      expect(result.state).toBe('complete');
    });

    it('fails EV when submit timeout is exceeded', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const opp = makeEvOpportunity({ detectedAt: now });
      const pending = new Promise(() => {});
      const clob = {
        createOrder: vi.fn().mockReturnValue(pending),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();
      const userRealtime = new MockUserRealtime(true);
      const policy = { ...DEFAULT_TRADE_POLICY, submitTimeoutMs: 5 };

      const agent = new ExecutionAgent(policy, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const resultPromise = agent.executeArbitrage(opp, 10, { nowMs: now });
      await vi.advanceTimersByTimeAsync(10);
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_timeout');
      expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'order_timeout' }));

      vi.useRealTimers();
    });

    it('fails EV when submit throws non-timeout error', async () => {
      const now = Date.now();
      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockRejectedValue(new Error('boom')),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;
      const incidentTracker = makeMockIncidentTracker();
      const userRealtime = new MockUserRealtime(true);

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(opp, 10, { nowMs: now });

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_failed');
      expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'order_failed' }));
    });

    it('fails EV when fill times out', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const opp = makeEvOpportunity({ detectedAt: now });
      const clob = {
        createOrder: vi.fn().mockResolvedValue({ orderId: 'ev-timeout-1', status: 'LIVE' }),
        ...makeCancelMocks()
      } as unknown as PolymarketClob;

      const policy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' as const, fillTimeoutMs: 5 };
      const userRealtime = new MockUserRealtime(true);
      const agent = new ExecutionAgent(policy, clob, makeMockIncidentTracker(), undefined, {
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const resultPromise = agent.executeArbitrage(opp, 50, { nowMs: now });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_timeout');

      vi.useRealTimers();
    });
  });

  describe('execution lifecycle tracking', () => {
    it('records lifecycle and latency events, and clears active executions', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const userRealtime = new MockUserRealtime(true);
      const clob = makeMockClob(
        {
          yes: { orderId: 'yes-order-1', status: 'LIVE' },
          no: { orderId: 'no-order-1', status: 'LIVE' }
        },
        {
          onCreateOrder: (response) => {
            const orderId = (response as { orderId?: string }).orderId;
            if (orderId) emitOrderMatched(userRealtime, orderId);
          }
        }
      );
      const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
      const store = { append: vi.fn() } as unknown as EventStore;

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, metrics, {
        tradingEnabled: true,
        tradingMode: 'live',
        eventStore: store,
        userRealtime: asPolymarketRealtime(userRealtime)
      });

      const result = await agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 100);

      expect(result.state).toBe('complete');
      expect(agent.getActiveExecutions()).toEqual([]);
      expect(store.append).toHaveBeenCalled();

      const storedEvents = store.append.mock.calls.map((call) => call[0]);
      const recoveryAgent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
        tradingEnabled: true,
        tradingMode: 'live'
      });
      recoveryAgent.restoreActiveExecutions([storedEvents[0]]);
      expect(recoveryAgent.getActiveExecutions().length).toBe(1);

      const lifecycle = metrics.recent('execution_lifecycle', 1)[0];
      const lifecycleData = lifecycle.data as { state: string };
      expect(lifecycleData.state).toBe('complete');

      const latencyStages = metrics
        .recent('latency', 10)
        .map((event) => (event.data as { stage: string }).stage);
      expect(latencyStages).toEqual(
        expect.arrayContaining(['detected', 'submitted', 'acked', 'filled'])
      );

      vi.useRealTimers();
    });

    it('ignores missing snapshots and drops terminal snapshots on restore', () => {
      const base = createInitialExecutionState({
        id: 'exec-restore-1',
        opportunityId: 'opp-restore-1',
        marketId: 'market-1',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
        size: 1,
        yesPrice: 0.45,
        noPrice: 0.55,
        createdAtMs: 1000
      });
      const pending = { ...base, state: 'submitting', lastUpdatedMs: 1001 };
      const terminal = { ...base, state: 'complete', lastUpdatedMs: 1002 };

      const events: StoredEvent[] = [
        {
          id: 'evt-1',
          timestamp: pending.lastUpdatedMs,
          type: 'execution:transition',
          payload: { snapshot: pending },
          metadata: {}
        },
        {
          id: 'evt-2',
          timestamp: terminal.lastUpdatedMs,
          type: 'execution:transition',
          payload: { snapshot: terminal },
          metadata: {}
        },
        {
          id: 'evt-3',
          timestamp: 1003,
          type: 'execution:transition',
          payload: {},
          metadata: {}
        }
      ];

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, makeMockClob({ yes: {}, no: {} }));
      agent.restoreActiveExecutions(events);
      expect(agent.getActiveExecutions()).toEqual([]);
    });
  });
});

describe('execution utilities', () => {
  it('builds FOK orders and serializes payloads', () => {
    const order = buildFokBuyOrder({
      tokenId: 'token-1',
      size: 10,
      price: 0.5,
      clientOrderId: 'client-1'
    });

    expect(order.orderType).toBe('FOK');
    expect(toClobOrderPayload(order).order_type).toBe('FOK');
  });

  it('detects delayed responses', () => {
    expect(isDelayedOrderResponse({ status: 'delayed' })).toBe(true);
    expect(isDelayedOrderResponse({ errorMsg: 'ORDER_DELAYED' })).toBe(true);
    expect(isDelayedOrderResponse({ error: 'ORDER_DELAYED' })).toBe(true);
    expect(isDelayedOrderResponse({ status: 'LIVE' })).toBe(false);
  });

  it('detects order failures', () => {
    expect(isOrderFailure({ success: false })).toBe(true);
    expect(isOrderFailure({ errorMsg: 'boom' })).toBe(true);
    expect(isOrderFailure({ status: 'rejected' })).toBe(true);
    expect(isOrderFailure({ success: true, status: 'LIVE' })).toBe(false);
  });
});

describe('ExecutionAgent basket execution', () => {
  function makeBasketOpportunity(
    overrides: Partial<ArbitrageOpportunity> = {}
  ): ArbitrageOpportunity {
    return makeOpportunity({
      id: 'opp-basket-1',
      type: 'fw_basket',
      fwBasket: {
        basketId: 'basket-1',
        executionMode: 'sequential_failfast',
        aggregateEdgeLowerBound: 0.04,
        aggregateProjectedEdge: 0.05,
        loop: {
          loopId: 'loop-1',
          iterationCount: 3,
          activeSetSize: 2,
          contractionSteps: 0,
          terminalGapAbs: 0.0001,
          terminalGapRel: 0.0001,
          terminalReason: 'gap_converged',
          converged: true,
          runtimeMs: 10
        },
        markets: [
          {
            marketId: 'market-1',
            yesTokenId: 'yes-token',
            noTokenId: 'no-token',
            yesPrice: 0.48,
            noPrice: 0.49,
            costPerSet: 0.97,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          },
          {
            marketId: 'market-2',
            yesTokenId: 'yes-token-2',
            noTokenId: 'no-token-2',
            yesPrice: 0.47,
            noPrice: 0.49,
            costPerSet: 0.96,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          }
        ]
      },
      ...overrides
    });
  }

  it('executes basket legs sequentially in failfast mode', async () => {
    const clob = makeMockClob({ yes: { status: 'LIVE' }, no: { status: 'LIVE' } });
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live'
    });
    const spy = vi
      .spyOn(agent, 'executeArbitrage')
      .mockResolvedValue({
        status: 'submitted',
        idempotencyKey: 'id',
        executionId: 'exec',
        state: 'complete'
      } as unknown as Awaited<ReturnType<ExecutionAgent['executeArbitrage']>>);

    const result = await agent.executeBasketArbitrage(makeBasketOpportunity(), 10, {
      nowMs: Date.now()
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('submitted');
    expect(result.basket?.mode).toBe('sequential_failfast');
    expect(result.basket?.legs).toHaveLength(2);
  });

  it('falls back from batch mode to sequential failfast', async () => {
    const clob = makeMockClob({ yes: { status: 'LIVE' }, no: { status: 'LIVE' } }) as unknown as {
      createBatchOrders: ReturnType<typeof vi.fn>;
      createOrder: ReturnType<typeof vi.fn>;
      reserveNonce: ReturnType<typeof vi.fn>;
      cancelOrder: ReturnType<typeof vi.fn>;
      cancelOrders: ReturnType<typeof vi.fn>;
      cancelAll: ReturnType<typeof vi.fn>;
      cancelMarketOrders: ReturnType<typeof vi.fn>;
    };
    clob.createBatchOrders = vi.fn().mockRejectedValue(new Error('unsupported'));
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live'
    });
    const spy = vi
      .spyOn(agent, 'executeArbitrage')
      .mockResolvedValue({
        status: 'submitted',
        idempotencyKey: 'id',
        executionId: 'exec',
        state: 'complete'
      } as unknown as Awaited<ReturnType<ExecutionAgent['executeArbitrage']>>);

    const result = await agent.executeBasketArbitrage(
      makeBasketOpportunity({
        fwBasket: {
          ...makeBasketOpportunity().fwBasket!,
          executionMode: 'batch_best_effort'
        }
      }),
      10,
      { nowMs: Date.now() }
    );

    expect(clob.createBatchOrders).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('submitted');
    expect(result.basket?.fallbackUsed).toBe(true);
  });

  it('fails batch mode on partial acceptance without sequential fallback', async () => {
    const clob = makeMockClob({ yes: { status: 'LIVE' }, no: { status: 'LIVE' } }) as unknown as {
      createBatchOrders: ReturnType<typeof vi.fn>;
      reserveNonce: ReturnType<typeof vi.fn>;
      createOrder: ReturnType<typeof vi.fn>;
      cancelOrder: ReturnType<typeof vi.fn>;
      cancelOrders: ReturnType<typeof vi.fn>;
      cancelAll: ReturnType<typeof vi.fn>;
      cancelMarketOrders: ReturnType<typeof vi.fn>;
    };
    clob.createBatchOrders = vi.fn().mockResolvedValue([
      { orderId: 'batch-yes-1', status: 'LIVE' },
      { status: 'rejected' },
      { status: 'rejected' },
      { status: 'rejected' }
    ]);
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live'
    });
    const sequentialSpy = vi.spyOn(agent, 'executeArbitrage');

    const result = await agent.executeBasketArbitrage(
      makeBasketOpportunity({
        fwBasket: {
          ...makeBasketOpportunity().fwBasket!,
          executionMode: 'batch_best_effort'
        }
      }),
      10,
      { nowMs: Date.now() }
    );

    expect(clob.createBatchOrders).toHaveBeenCalledTimes(1);
    expect(sequentialSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('batch_partial_accepted');
    expect(result.basket?.mode).toBe('batch_best_effort');
    expect(result.basket?.fallbackUsed).toBe(false);
  });

  it('waits for batch fill outcomes and confirms basket plus leg idempotency records', async () => {
    const nowMs = Date.now();
    const userRealtime = new MockUserRealtime(true);
    const opportunity = makeBasketOpportunity({
      id: 'opp-basket-confirm',
      fwBasket: {
        ...makeBasketOpportunity().fwBasket!,
        executionMode: 'batch_best_effort'
      }
    });
    const clob = makeMockClob({ yes: { status: 'LIVE' }, no: { status: 'LIVE' } }) as unknown as {
      createBatchOrders: ReturnType<typeof vi.fn>;
      reserveNonce: ReturnType<typeof vi.fn>;
      createOrder: ReturnType<typeof vi.fn>;
      cancelOrder: ReturnType<typeof vi.fn>;
      cancelOrders: ReturnType<typeof vi.fn>;
      cancelAll: ReturnType<typeof vi.fn>;
      cancelMarketOrders: ReturnType<typeof vi.fn>;
    };
    clob.createBatchOrders = vi.fn().mockResolvedValue([
      { orderId: 'batch-1-yes', status: 'LIVE' },
      { orderId: 'batch-1-no', status: 'LIVE' },
      { orderId: 'batch-2-yes', status: 'LIVE' },
      { orderId: 'batch-2-no', status: 'LIVE' }
    ]);
    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const waitSpy = vi.spyOn(
      agent as unknown as {
        waitForBatchFillOutcomes: (
          acceptedOrders: Array<{ orderId: string; marketId: string; idempotencyKey: string; side: 'yes' | 'no' }>,
          size: number,
          timeoutMs: number
        ) => Promise<{
          allFilled: boolean;
          outcomes: Array<{
            order: { orderId: string; marketId: string; idempotencyKey: string; side: 'yes' | 'no' };
            outcome: {
              orderId: string;
              sizeMatched: number;
              fullyFilled: boolean;
              cancelled: boolean;
              timedOut: boolean;
              observedAtMs: number;
            };
          }>;
          observedAtMs: number;
        }>;
      },
      'waitForBatchFillOutcomes'
    ).mockImplementation(async (acceptedOrders) => ({
      allFilled: true,
      observedAtMs: nowMs + 25,
      outcomes: acceptedOrders.map((order) => ({
        order,
        outcome: {
          orderId: order.orderId,
          sizeMatched: 10,
          fullyFilled: true,
          cancelled: false,
          timedOut: false,
          observedAtMs: nowMs + 25
        }
      }))
    }));

    const result = await agent.executeBasketArbitrage(opportunity, 10, { nowMs });
    const basketKey = createIdempotencyKey(`${opportunity.id}:basket:${(10).toFixed(8)}`);
    const reader = agent as unknown as {
      getIdempotencyRecord: (key: string) => IdempotencyRecord | undefined;
    };

    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('submitted');
    expect(result.basket?.mode).toBe('batch_best_effort');
    expect(reader.getIdempotencyRecord(basketKey)?.status).toBe('confirmed');
    for (const market of opportunity.fwBasket!.markets) {
      expect(reader.getIdempotencyRecord(`${basketKey}:${market.marketId}:yes`)?.status).toBe('confirmed');
      expect(reader.getIdempotencyRecord(`${basketKey}:${market.marketId}:no`)?.status).toBe('confirmed');
    }
  });

  it('cancels outstanding batch orders and fails basket idempotency on partial fill wait', async () => {
    const nowMs = Date.now();
    const userRealtime = new MockUserRealtime(true);
    const opportunity = makeBasketOpportunity({
      id: 'opp-basket-partial-fill',
      fwBasket: {
        ...makeBasketOpportunity().fwBasket!,
        executionMode: 'batch_best_effort'
      }
    });
    const clob = makeMockClob({ yes: { status: 'LIVE' }, no: { status: 'LIVE' } }) as unknown as {
      createBatchOrders: ReturnType<typeof vi.fn>;
      reserveNonce: ReturnType<typeof vi.fn>;
      createOrder: ReturnType<typeof vi.fn>;
      cancelOrder: ReturnType<typeof vi.fn>;
      cancelOrders: ReturnType<typeof vi.fn>;
      cancelAll: ReturnType<typeof vi.fn>;
      cancelMarketOrders: ReturnType<typeof vi.fn>;
    };
    clob.createBatchOrders = vi.fn().mockResolvedValue([
      { orderId: 'batch-1-yes', status: 'LIVE' },
      { orderId: 'batch-1-no', status: 'LIVE' },
      { orderId: 'batch-2-yes', status: 'LIVE' },
      { orderId: 'batch-2-no', status: 'LIVE' }
    ]);

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });
    const waitSpy = vi.spyOn(
      agent as unknown as {
        waitForBatchFillOutcomes: (
          acceptedOrders: Array<{ orderId: string; marketId: string; idempotencyKey: string; side: 'yes' | 'no' }>,
          size: number,
          timeoutMs: number
        ) => Promise<{
          allFilled: boolean;
          outcomes: Array<{
            order: { orderId: string; marketId: string; idempotencyKey: string; side: 'yes' | 'no' };
            outcome: {
              orderId: string;
              sizeMatched: number;
              fullyFilled: boolean;
              cancelled: boolean;
              timedOut: boolean;
              observedAtMs: number;
            };
          }>;
          observedAtMs: number;
        }>;
      },
      'waitForBatchFillOutcomes'
    ).mockImplementation(async (acceptedOrders) => ({
      allFilled: false,
      observedAtMs: nowMs + 40,
      outcomes: acceptedOrders.map((order) => ({
        order,
        outcome: {
          orderId: order.orderId,
          sizeMatched: order.marketId === 'market-1' ? 10 : 0,
          fullyFilled: order.marketId === 'market-1',
          cancelled: false,
          timedOut: order.marketId !== 'market-1',
          observedAtMs: nowMs + 40
        }
      }))
    }));
    const unwindSpy = vi.spyOn(
      agent as unknown as {
        unwindBasketLegs: (
          basketOpportunity: ArbitrageOpportunity,
          legs: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'],
          size: number,
          nowMs: number
        ) => Promise<void>;
      },
      'unwindBasketLegs'
    ).mockResolvedValue();

    const result = await agent.executeBasketArbitrage(opportunity, 10, { nowMs });
    const basketKey = createIdempotencyKey(`${opportunity.id}:basket:${(10).toFixed(8)}`);
    const reader = agent as unknown as {
      getIdempotencyRecord: (key: string) => IdempotencyRecord | undefined;
    };

    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(clob.cancelOrder).toHaveBeenCalledTimes(2);
    expect(unwindSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('partial_fill');
    expect(reader.getIdempotencyRecord(basketKey)?.status).toBe('failed');
    expect(reader.getIdempotencyRecord(`${basketKey}:market-2:yes`)?.status).toBe('failed');
    expect(reader.getIdempotencyRecord(`${basketKey}:market-2:no`)?.status).toBe('failed');
  });
});
