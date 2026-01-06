import { describe, it, expect, vi } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import {
  buildFokBuyOrder,
  createInitialExecutionState,
  toClobOrderPayload,
  isDelayedOrderResponse,
  isOrderFailure
} from '../../src/domain/execution.js';
import { createIdempotencyKey } from '../../src/domain/idempotency.js';
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
