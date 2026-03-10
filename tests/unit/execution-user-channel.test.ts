import { describe, it, expect, vi } from 'vitest';

import { EventEmitter } from 'node:events';

import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import type {
  PolymarketRealtime,
  UserOrderUpdate,
  UserTradeUpdate
} from '../../src/services/PolymarketRealtime.js';

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  const base = {
    id: 'opp-test-user-1',
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

class MockUserRealtime extends EventEmitter {
  constructor(private connected = true) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function asPolymarketRealtime(realtime: MockUserRealtime): PolymarketRealtime {
  return realtime as unknown as PolymarketRealtime;
}

function emitUserOrder(
  realtime: MockUserRealtime,
  orderId: string,
  overrides: Partial<UserOrderUpdate> = {}
): void {
  const event: UserOrderUpdate = {
    eventType: 'order',
    orderId,
    timestampMs: Date.now(),
    raw: {},
    ...overrides
  };
  realtime.emit('user:order', event);
}

function emitUserTrade(realtime: MockUserRealtime, update: UserTradeUpdate): void {
  realtime.emit('user:trade', update);
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

describe('ExecutionAgent (user channel)', () => {
  it('unwinds using trade updates and dedupes trade ids', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const portfolio = {
      expectFill: vi.fn(),
      applyFillWithReconciliation: vi.fn(),
      applyUnwind: vi.fn()
    } as unknown as PortfolioAgent;

    const clob = {
      createOrder: vi
        .fn()
        .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
        .mockResolvedValueOnce({ orderId: 'no-order-1', status: 'LIVE' })
        .mockResolvedValueOnce({ orderId: 'unwind-order-1', status: 'LIVE' }),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      fillTimeoutMs: 20
    };

    const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      portfolio,
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 1, { nowMs: now });
    await Promise.resolve();

    const trade: UserTradeUpdate = {
      eventType: 'trade',
      tradeId: 'trade-1',
      takerOrderId: 'yes-order-1',
      size: 0.2,
      makerOrderIds: ['yes-order-1'],
      makerMatches: [
        { orderId: 'yes-order-1', matchedAmount: 0.2 },
        { orderId: 'yes-order-1', matchedAmount: 0 }
      ],
      timestampMs: now + 1,
      raw: {}
    };

    emitUserTrade(userRealtime, trade);
    emitUserTrade(userRealtime, trade);

    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('partial_fill');
    expect(clob.createOrder).toHaveBeenCalledTimes(3);

    const unwindPayload = clob.createOrder.mock.calls[2][0] as Record<string, unknown>;
    expect(unwindPayload.order_type).toBe('FAK');
    expect(unwindPayload.side).toBe('SELL');
    expect(unwindPayload.size).toBe(0.2);
    expect(unwindPayload.token_id).toBe('yes-token');

    expect(portfolio.applyUnwind).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: 'market-1',
        tokenId: 'yes-token',
        entryPrice: 0.48,
        unwindPrice: 0.46,
        size: 0.2
      })
    );

    vi.useRealTimers();
  });

  it('applies portfolio fills from trade updates when metadata is available', async () => {
    const userRealtime = new MockUserRealtime(true);
    const portfolio = {
      expectFill: vi.fn(),
      applyFillWithReconciliation: vi.fn(),
      applyUnwind: vi.fn()
    } as unknown as PortfolioAgent;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, {} as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      portfolio,
      userRealtime: asPolymarketRealtime(userRealtime)
    });
    void agent;
    const now = Date.now();

    emitUserOrder(userRealtime, {
      orderId: 'yes-order-1',
      marketId: 'market-1',
      assetId: 'yes-token',
      side: 'BUY',
      price: 0.48,
      originalSize: 1,
      sizeMatched: 0,
      status: 'LIVE',
      timestampMs: now
    });

    const trade: UserTradeUpdate = {
      eventType: 'trade',
      tradeId: 'trade-1',
      marketId: 'market-1',
      assetId: 'yes-token',
      side: 'BUY',
      price: 0.48,
      makerOrderIds: ['yes-order-1'],
      makerMatches: [{ orderId: 'yes-order-1', matchedAmount: 1 }],
      timestampMs: now + 1,
      raw: {}
    };

    emitUserTrade(userRealtime, trade);
    emitUserTrade(userRealtime, trade);

    expect((portfolio as unknown as { applyFillWithReconciliation: ReturnType<typeof vi.fn> }).applyFillWithReconciliation).toHaveBeenCalledTimes(1);
  });

  it('skips portfolio fill application when required trade metadata is missing', async () => {
    const userRealtime = new MockUserRealtime(true);
    const portfolio = {
      expectFill: vi.fn(),
      applyFillWithReconciliation: vi.fn(),
      applyUnwind: vi.fn()
    } as unknown as PortfolioAgent;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, {} as unknown as PolymarketClob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      portfolio,
      userRealtime: asPolymarketRealtime(userRealtime)
    });
    void agent;
    const now = Date.now();

    emitUserTrade(userRealtime, {
      eventType: 'trade',
      tradeId: 'trade-1',
      makerOrderIds: ['yes-order-1'],
      makerMatches: [{ orderId: 'yes-order-1', matchedAmount: 1 }],
      timestampMs: now + 1,
      raw: {}
    });

    expect((portfolio as unknown as { applyFillWithReconciliation: ReturnType<typeof vi.fn> }).applyFillWithReconciliation).not.toHaveBeenCalled();
  });

  it('fails and cancels when both legs partially fill (no single filled leg)', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = {
      createOrder: vi
        .fn()
        .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
        .mockResolvedValueOnce({ orderId: 'no-order-1', status: 'LIVE' }),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const policy = { ...DEFAULT_TRADE_POLICY, fillTimeoutMs: 20 };
    const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 1, { nowMs: now });
    await Promise.resolve();

    emitUserTrade(userRealtime, {
      eventType: 'trade',
      tradeId: 'trade-yes',
      takerOrderId: 'yes-order-1',
      size: 0.2,
      makerOrderIds: [],
      makerMatches: [],
      timestampMs: now + 1,
      raw: {}
    });
    emitUserTrade(userRealtime, {
      eventType: 'trade',
      tradeId: 'trade-no',
      takerOrderId: 'no-order-1',
      size: 0.3,
      makerOrderIds: [],
      makerMatches: [],
      timestampMs: now + 1,
      raw: {}
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('order_timeout');
    expect(clob.cancelOrder).toHaveBeenCalledWith('yes-order-1');
    expect(clob.cancelOrder).toHaveBeenCalledWith('no-order-1');

    vi.useRealTimers();
  });

  it('returns submitted status when both legs are fully filled via user order updates', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = {
      createOrder: vi
        .fn()
        .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
        .mockResolvedValueOnce({ orderId: 'no-order-1', status: 'LIVE' }),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const policy = { ...DEFAULT_TRADE_POLICY, fillTimeoutMs: 50 };
    const agent = new ExecutionAgent(policy, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 1, { nowMs: now });
    await Promise.resolve();

    emitUserOrder(userRealtime, 'yes-order-1', {
      orderEventType: 'UPDATE',
      status: 'MATCHED',
      sizeMatched: 1,
      originalSize: 1,
      timestampMs: now + 1
    });
    emitUserOrder(userRealtime, 'no-order-1', {
      orderEventType: 'UPDATE',
      status: 'MATCHED',
      sizeMatched: 1,
      originalSize: 1,
      timestampMs: now + 1
    });

    const result = await resultPromise;

    expect(result.status).toBe('submitted');
    expect(result.state).toBe('complete');
    expect(clob.createOrder).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('treats cancellation updates as non-timeout failures', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = {
      createOrder: vi
        .fn()
        .mockResolvedValueOnce({ orderId: 'yes-order-1', status: 'LIVE' })
        .mockResolvedValueOnce({ orderId: 'no-order-1', status: 'LIVE' }),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    const resultPromise = agent.executeArbitrage(makeOpportunity({ detectedAt: now }), 1, { nowMs: now });
    await Promise.resolve();

    emitUserOrder(userRealtime, 'yes-order-1', {
      orderEventType: 'CANCELLATION',
      status: 'CANCELLED',
      timestampMs: now + 1
    });
    emitUserOrder(userRealtime, 'no-order-1', {
      orderEventType: 'CANCELLATION',
      status: 'CANCELLED',
      timestampMs: now + 1
    });

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('order_failed');
    expect(clob.cancelOrder).toHaveBeenCalledWith('yes-order-1');
    expect(clob.cancelOrder).toHaveBeenCalledWith('no-order-1');

    vi.useRealTimers();
  });

  it('keeps remaining waiters when one times out', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userRealtime = new MockUserRealtime(true);
    const clob = {
      createOrder: vi.fn(),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    type Outcome = {
      orderId: string;
      sizeMatched: number;
      fullyFilled: boolean;
      cancelled: boolean;
      timedOut: boolean;
      observedAtMs: number;
    };

    const waitForFillOutcome = (
      agent as unknown as {
        orderTracker: {
          waitForFillOutcome: (
            orderId: string,
            desiredSize: number,
            timeoutMs: number
          ) => Promise<Outcome>;
        };
      }
    ).orderTracker.waitForFillOutcome.bind((agent as unknown as { orderTracker: unknown }).orderTracker);

    const immediateOutcome = await waitForFillOutcome('order-0', 1, 0);
    expect(immediateOutcome.timedOut).toBe(true);

    const partialPromise = waitForFillOutcome('order-2', 1, 50);
    emitUserTrade(userRealtime, {
      eventType: 'trade',
      tradeId: 'trade-partial',
      takerOrderId: 'order-2',
      size: 0.2,
      makerOrderIds: [],
      makerMatches: [],
      timestampMs: now + 1,
      raw: {}
    });
    emitUserOrder(userRealtime, 'order-2', { orderEventType: 'UPDATE' });

    const shortPromise = waitForFillOutcome('order-1', 1, 5);
    const longPromise = waitForFillOutcome('order-1', 1, 50);

    await vi.advanceTimersByTimeAsync(10);
    const shortOutcome = await shortPromise;
    expect(shortOutcome.timedOut).toBe(true);

    emitUserOrder(userRealtime, 'order-1', {
      orderEventType: 'CANCELLATION',
      status: 'CANCELLED',
      timestampMs: now + 1
    });

    const longOutcome = await longPromise;
    expect(longOutcome.timedOut).toBe(false);
    expect(longOutcome.cancelled).toBe(true);

    emitUserOrder(userRealtime, 'order-2', {
      orderEventType: 'CANCELLATION',
      status: 'CANCELLED',
      timestampMs: now + 2
    });
    const partialOutcome = await partialPromise;
    expect(partialOutcome.timedOut).toBe(false);
    expect(partialOutcome.fullyFilled).toBe(false);

    vi.useRealTimers();
  });

  it('ignores missing idempotency records when marking failed', () => {
    const userRealtime = new MockUserRealtime(true);
    const clob = {
      createOrder: vi.fn(),
      ...makeCancelMocks()
    } as unknown as PolymarketClob;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, undefined, {
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: asPolymarketRealtime(userRealtime)
    });

    (
      agent as unknown as {
        idempotency: { markFailed: (key: string, nowMs: number) => void };
      }
    ).idempotency.markFailed('missing', Date.now());

    expect(true).toBe(true);
  });
});
