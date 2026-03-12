import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { createInitialExecutionState, type PairedExecutionState } from '../../src/domain/execution.js';
import type { IdempotencyRecord } from '../../src/domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import {
  ExecutionIdempotencyStore,
  ExecutionLifecycle,
  ExecutionUnwindSupport,
  cancelOutstandingBatchOrders,
  waitForBatchFillOutcomes
} from '../../src/agents/execution/ExecutionAgentSupport.js';
import { ExecutionOrderTracker } from '../../src/agents/execution/ExecutionOrderTracker.js';
import { runExecutionPreflight } from '../../src/agents/execution/ExecutionPreflight.js';
import {
  alignPriceUp,
  applyMultiplier,
  coerceNonceValue,
  extractOrderId,
  formatCancelError,
  isCancelFailure,
  isOrderSuccessful,
  isTimeoutError,
  withTimeout
} from '../../src/agents/execution/ExecutionShared.js';

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'opp-1',
    marketId: 'market-1',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesPrice: 0.48,
    noPrice: 0.49,
    costPerSet: 0.97,
    edge: 0.03,
    tickSize: 0.01,
    maxSizeByDepth: 10,
    minOrderSize: 1,
    detectedAt: 1_000,
    gateReasons: [],
    pair: {
      marketId: 'market-1',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token'
    },
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ExecutionShared', () => {
  it('handles timeout, scaling, and response helpers deterministically', async () => {
    vi.useFakeTimers();

    const pending = withTimeout(new Promise<never>(() => undefined), 50, 'submit');
    const rejection = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await rejection;

    expect(isTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({ phase: 'submit', timeoutMs: 50 });
    expect(applyMultiplier(100, 0.25)).toBe(25);
    expect(applyMultiplier(100, 2)).toBe(100);
    expect(coerceNonceValue('42')).toBe(42);
    expect(coerceNonceValue('nonce-42')).toBe('nonce-42');
    expect(alignPriceUp(0.431, 0.01)).toBeCloseTo(0.44);
    expect(isOrderSuccessful({ success: true, status: 'LIVE', orderID: 'o-1' })).toBe(true);
    expect(isOrderSuccessful({ status: 'DELAYED' })).toBe(false);
    expect(isOrderSuccessful({ success: false, errorMsg: 'bad request' })).toBe(false);
    expect(extractOrderId({ order_id: 'o-2' } as { order_id: string })).toBe('o-2');
    expect(isCancelFailure({ canceled: ['o-1'], not_canceled: {} }, 'o-1')).toBe(false);
    expect(isCancelFailure({ canceled: [], not_canceled: { 'o-1': 'missing' } }, 'o-1')).toBe(true);
    expect(formatCancelError(new Error('cancel failed'))).toBe('cancel failed');
  });
});

describe('ExecutionAgentSupport', () => {
  it('refreshes idempotency records and emits lifecycle outcome/transition events', () => {
    const persisted = new Map<string, IdempotencyRecord>([
      [
        'existing',
        {
          key: 'existing',
          nonce: '7',
          status: 'submitted',
          orderId: 'order-7',
          createdAt: 10,
          updatedAt: 10
        }
      ],
      [
        'failed',
        {
          key: 'failed',
          nonce: '8',
          status: 'failed',
          orderId: 'order-8',
          createdAt: 11,
          updatedAt: 11
        }
      ]
    ]);
    const store = {
      getIdempotencyRecord: vi.fn((key: string) => persisted.get(key)),
      upsertIdempotencyRecord: vi.fn((record: IdempotencyRecord) => {
        persisted.set(record.key, record);
      }),
      pruneIdempotencyRecords: vi.fn()
    };
    const idempotency = new ExecutionIdempotencyStore({
      clob: { reserveNonce: vi.fn().mockReturnValue('99') },
      store: store as unknown as never
    });

    expect(idempotency.ensureRecord('existing', 25)).toMatchObject({
      key: 'existing',
      nonce: '7',
      updatedAt: 25
    });
    expect(idempotency.ensureRecord('failed', 30)).toMatchObject({
      key: 'failed',
      nonce: '99',
      status: 'pending',
      updatedAt: 30
    });

    const messageBus = { emit: vi.fn() };
    const eventStore = { append: vi.fn() };
    const metrics = { record: vi.fn() };
    const completedState: PairedExecutionState = {
      ...createInitialExecutionState({
        id: 'exec-1',
        opportunityId: 'opp-1',
        marketId: 'market-1',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
        size: 2,
        yesPrice: 0.48,
        noPrice: 0.49,
        createdAtMs: 1
      }),
      state: 'both_filled',
      yesSubmitted: true,
      noSubmitted: true,
      yesAcked: true,
      noAcked: true,
      yesFilled: true,
      noFilled: true
    };
    const activeExecutions = new Map<string, PairedExecutionState>([['exec-1', completedState]]);
    const lifecycle = new ExecutionLifecycle({
      messageBus: messageBus as never,
      store: eventStore as never,
      metrics: metrics as never,
      activeExecutions
    });

    lifecycle.emitExecutionOutcome(makeOpportunity(), {
      status: 'failed',
      reason: 'submit_timeout',
      idempotencyKey: 'key-1',
      executionId: 'exec-1'
    }, 40);
    const next = lifecycle.transition(completedState, { type: 'COMPLETE', atMs: 41 });

    expect(messageBus.emit).toHaveBeenCalledWith('execution:outcome', expect.objectContaining({
      status: 'timeout',
      idempotencyKey: 'key-1'
    }));
    expect(next.state).toBe('complete');
    expect(activeExecutions.has('exec-1')).toBe(false);
    expect(metrics.record).toHaveBeenCalledTimes(1);
    expect(eventStore.append).toHaveBeenCalledTimes(1);
    idempotency.prune(26);
    expect(store.pruneIdempotencyRecords).toHaveBeenCalledWith(26);
  });

  it('applies unwind hints, tracks batch fills, and cancels only incomplete batch orders', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);

    const incidentTracker = { record: vi.fn() };
    const portfolio = { applyUnwind: vi.fn() };
    const metrics = { record: vi.fn() };
    const createOrder = vi.fn().mockRejectedValue(new Error('venue down'));
    const support = new ExecutionUnwindSupport({
      getPolicy: () => ({ ...DEFAULT_TRADE_POLICY, fallbackTickSize: 0.02 }),
      getRiskConfig: () => ({ ...DEFAULT_RISK_CONFIG, maxUnwindLossTicks: 4, unwindSlippageToleranceBps: 100 }),
      getExecutionAdvisor: () => ({
        getHint: () => ({
          timeoutMultiplier: 1,
          unwindHint: 'aggressive',
          confidence: 0.8,
          expiresAtMs: 9_999
        })
      }) as unknown as never,
      getExecutionAdvisorMode: () => 'advisory',
      clob: { createOrder } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      portfolio: portfolio as never
    });

    expect(
      support.resolveUnwindTickSize('yes', makeOpportunity({ tickSize: 0.01 }), {
        yesBook: { tickSize: 0.05 } as { tickSize: number }
      })
    ).toBe(0.05);
    expect(support.calculateUnwindPrice(0.63, 0.05, { marketId: 'market-1', opportunityId: 'opp-1', nowMs: 20 }))
      .toBeCloseTo(0.55);

    support.recordUnwindPortfolio('market-1', 'yes-token', 0.63, 0.55, 3);
    expect(portfolio.applyUnwind).toHaveBeenCalledWith({
      marketId: 'market-1',
      tokenId: 'yes-token',
      entryPrice: 0.63,
      unwindPrice: 0.55,
      size: 3
    });

    await support.unwindBasketLegs(
      makeOpportunity({ type: 'fw_basket' }),
      [{
        marketId: 'market-1',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
        yesPrice: 0.48,
        noPrice: 0.49,
        costPerSet: 0.97,
        projectedEdge: 0.04,
        edgeLowerBound: 0.03,
        maxSizeByDepth: 10,
        minOrderSize: 1,
        tickSize: 0.01
      }],
      2,
      21,
      5
    );

    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'unwind_failed',
      marketId: 'market-1'
    }));

    const filled = await waitForBatchFillOutcomes(
      [
        { marketId: 'market-1', side: 'yes', idempotencyKey: 'k-1', orderId: 'o-1' },
        { marketId: 'market-2', side: 'no', idempotencyKey: 'k-2', orderId: 'o-2' }
      ],
      2,
      100,
      async (orderId) => ({
        orderId,
        sizeMatched: orderId === 'o-1' ? 2 : 1,
        fullyFilled: orderId === 'o-1',
        cancelled: false,
        timedOut: false,
        observedAtMs: orderId === 'o-1' ? 30 : 35
      })
    );

    expect(filled).toMatchObject({
      allFilled: false,
      observedAtMs: 35
    });

    const cancelOrder = vi.fn().mockResolvedValue({ canceled: ['o-2'], not_canceled: {} });
    const markIdempotencyFailed = vi.fn();
    await cancelOutstandingBatchOrders(filled.outcomes, 'opp-1', 36, {
      clob: { cancelOrder } as never,
      incidentTracker: incidentTracker as never,
      cancelTimeoutMs: 5,
      markIdempotencyFailed
    });

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('o-2');
    expect(markIdempotencyFailed).toHaveBeenCalledWith('k-2', 36);
  });
});

describe('ExecutionPreflight', () => {
  it('blocks execution when trading is disabled', () => {
    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity({ type: 'ev', side: 'yes' }),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: false,
      tradingMode: 'live',
      idempotencyKey: 'key-disabled',
      executionId: 'exec-disabled',
      idleState: 'idle',
      isEv: true
    });

    expect(result).toMatchObject({
      requiresUserChannel: false,
      plannedOrders: 1,
      blocked: { reason: 'trading_disabled' }
    });
  });

  it('blocks live execution when the user channel is required but unconfigured', () => {
    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'live',
      idempotencyKey: 'key-unconfigured',
      executionId: 'exec-unconfigured',
      idleState: 'idle',
      isEv: false
    });

    expect(result).toMatchObject({
      requiresUserChannel: true,
      blocked: { reason: 'user_channel_unconfigured' }
    });
  });

  it('blocks live execution when the user channel is disconnected', () => {
    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => false } as never,
      idempotencyKey: 'key-disconnected',
      executionId: 'exec-disconnected',
      idleState: 'idle',
      isEv: false
    });

    expect(result).toMatchObject({
      requiresUserChannel: true,
      blocked: { reason: 'user_channel_disconnected' }
    });
  });

  it('blocks shadow mode and records the shadow decision', () => {
    const metrics = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'shadow',
      metrics: metrics as never,
      idempotencyKey: 'key-1',
      executionId: 'exec-1',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked).toMatchObject({ reason: 'shadow_mode' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'metric',
      event: expect.objectContaining({ type: 'shadow_decision' })
    }));
  });

  it('blocks paper mode without requiring the user channel', () => {
    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'paper',
      idempotencyKey: 'key-paper',
      executionId: 'exec-paper',
      idleState: 'idle',
      isEv: false
    });

    expect(result).toMatchObject({
      requiresUserChannel: false,
      plannedOrders: 2,
      blocked: { reason: 'paper_mode' }
    });
  });

  it('blocks trading_mode_off when live execution is disabled by mode', () => {
    const result = runExecutionPreflight({
      nowMs: 2_000,
      opportunity: makeOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'off',
      idempotencyKey: 'key-off',
      executionId: 'exec-off',
      idleState: 'idle',
      isEv: false
    });

    expect(result).toMatchObject({
      requiresUserChannel: false,
      plannedOrders: 2,
      blocked: { reason: 'trading_mode_off' }
    });
  });

  it('blocks live execution when EV pricing moves outside the allowed band', () => {
    const incidentTracker = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ type: 'ev', side: 'yes', detectedAt: 2_050 }),
      policy: { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard', priceBandBps: 100 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      idempotencyKey: 'key-2',
      executionId: 'exec-2',
      idleState: 'idle',
      isEv: true,
      yesBook: { bestAsk: { price: 0.7, size: 10 } } as { bestAsk: { price: number; size: number } },
      noBook: { bestAsk: { price: 0.49, size: 10 } } as { bestAsk: { price: number; size: number } }
    });

    expect(result.blocked).toMatchObject({ reason: 'price_moved' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'price_moved' })
    }));
  });

  it('blocks paired execution when either best ask moves outside the allowed band', () => {
    const incidentTracker = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ detectedAt: 2_050 }),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      idempotencyKey: 'key-pair-band',
      executionId: 'exec-pair-band',
      idleState: 'idle',
      isEv: false,
      yesBook: { bestAsk: { price: 0.6, size: 10 } } as { bestAsk: { price: number; size: number } },
      noBook: { bestAsk: { price: 0.49, size: 10 } } as { bestAsk: { price: number; size: number } }
    });

    expect(result.blocked).toMatchObject({ reason: 'price_moved' });
    expect(result.requiresUserChannel).toBe(false);
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({
        reason: 'price_moved',
        detail: expect.objectContaining({
          yesDeviation: expect.any(Number),
          noDeviation: expect.any(Number)
        })
      })
    }));
  });

  it('blocks execution when decision latency exceeds policy limits', () => {
    const incidentTracker = { record: vi.fn() };
    const metrics = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_500,
      opportunity: makeOpportunity({ detectedAt: 2_000 }),
      policy: { ...DEFAULT_TRADE_POLICY, maxDecisionLatencyMs: 100 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      idempotencyKey: 'key-latency',
      executionId: 'exec-latency',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked).toMatchObject({ reason: 'decision_latency_exceeded' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'metric',
      event: expect.objectContaining({
        type: 'slo_violation',
        data: expect.objectContaining({ sloName: 'decision_latency' })
      })
    }));
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'latency_exceeded' })
    }));
  });

  it('blocks EV execution when decision latency exceeds policy limits', () => {
    const incidentTracker = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_500,
      opportunity: makeOpportunity({ type: 'ev', side: 'no', detectedAt: 2_000 }),
      policy: { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard', maxDecisionLatencyMs: 100 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      metrics: { record: vi.fn() } as never,
      idempotencyKey: 'key-latency-ev',
      executionId: 'exec-latency-ev',
      idleState: 'idle',
      isEv: true
    });

    expect(result).toMatchObject({
      requiresUserChannel: true,
      plannedOrders: 1,
      blocked: { reason: 'decision_latency_exceeded' }
    });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'latency_exceeded' })
    }));
  });

  it('blocks execution when projected order velocity exceeds policy limits', () => {
    const incidentTracker = { record: vi.fn() };
    const metrics = {
      getOrderStats: vi.fn().mockReturnValue({ orders: 0, fills: 1 }),
      getOrderVelocity: vi.fn().mockReturnValue(5),
      getDelayedAckRate: vi.fn().mockReturnValue(0),
      record: vi.fn()
    };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ detectedAt: 2_050 }),
      policy: { ...DEFAULT_TRADE_POLICY, maxOrdersPerMinute: 4, orderVelocityWindowMs: 60_000 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      idempotencyKey: 'key-velocity',
      executionId: 'exec-velocity',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked).toMatchObject({ reason: 'velocity_throttle' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'metric',
      event: expect.objectContaining({
        type: 'slo_violation',
        data: expect.objectContaining({ sloName: 'order_velocity' })
      })
    }));
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'velocity_throttle' })
    }));
  });

  it('blocks execution when projected order-to-trade ratio exceeds policy limits', () => {
    const incidentTracker = { record: vi.fn() };
    const metrics = {
      getOrderStats: vi.fn().mockReturnValue({ orders: 8, fills: 1 }),
      getOrderVelocity: vi.fn(),
      getDelayedAckRate: vi.fn(),
      record: vi.fn()
    };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ detectedAt: 2_050 }),
      policy: { ...DEFAULT_TRADE_POLICY, maxOrderToTradeRatio: 5 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      idempotencyKey: 'key-otr',
      executionId: 'exec-otr',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked).toMatchObject({ reason: 'otr_exceeded' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'otr_exceeded' })
    }));
    expect(metrics.getOrderVelocity).not.toHaveBeenCalled();
  });

  it('blocks execution when delayed acknowledgements exceed policy limits', () => {
    const incidentTracker = { record: vi.fn() };
    const metrics = {
      getOrderStats: vi.fn().mockReturnValue({ orders: 0, fills: 2 }),
      getOrderVelocity: vi.fn().mockReturnValue(0),
      getDelayedAckRate: vi.fn().mockReturnValue(0.8),
      record: vi.fn()
    };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ detectedAt: 2_050 }),
      policy: { ...DEFAULT_TRADE_POLICY, maxDelayedAckRate: 0.5 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      idempotencyKey: 'key-delayed',
      executionId: 'exec-delayed',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked).toMatchObject({ reason: 'delayed_ack_rate_exceeded' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'metric',
      event: expect.objectContaining({
        type: 'slo_violation',
        data: expect.objectContaining({ sloName: 'delayed_ack_rate' })
      })
    }));
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({ reason: 'latency_exceeded' })
    }));
  });

  it('allows live EV execution when latency, velocity, delayed ack, and price bands stay within policy', () => {
    const metrics = {
      getOrderStats: vi.fn().mockReturnValue({ orders: 1, fills: 2 }),
      getOrderVelocity: vi.fn().mockReturnValue(1),
      getDelayedAckRate: vi.fn().mockReturnValue(0.1),
      record: vi.fn()
    };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ type: 'ev', side: 'yes', detectedAt: 2_050 }),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        strategyMode: 'standard',
        priceBandBps: 100,
        maxOrdersPerMinute: 5,
        maxDelayedAckRate: 0.5
      },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      metrics: metrics as never,
      idempotencyKey: 'key-pass',
      executionId: 'exec-pass',
      idleState: 'idle',
      isEv: true,
      yesBook: { bestAsk: { price: 0.481, size: 10 } } as { bestAsk: { price: number; size: number } },
      noBook: { bestAsk: { price: 0.49, size: 10 } } as { bestAsk: { price: number; size: number } }
    });

    expect(result).toMatchObject({
      requiresUserChannel: true,
      plannedOrders: 1
    });
    expect(result.blocked).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('allows live EV execution when velocity and delayed-ack throttles are disabled', () => {
    const metrics = {
      getOrderStats: vi.fn().mockReturnValue({ orders: 1, fills: 2 }),
      getOrderVelocity: vi.fn(),
      getDelayedAckRate: vi.fn(),
      record: vi.fn()
    };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ type: 'ev', side: 'no', detectedAt: 2_050 }),
      policy: {
        ...DEFAULT_TRADE_POLICY,
        strategyMode: 'standard',
        priceBandBps: 100,
        maxOrdersPerMinute: 0,
        maxDelayedAckRate: 0
      },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      metrics: metrics as never,
      idempotencyKey: 'key-no-throttle',
      executionId: 'exec-no-throttle',
      idleState: 'idle',
      isEv: true,
      yesBook: { bestAsk: { price: 0.48, size: 10 } } as { bestAsk: { price: number; size: number } },
      noBook: { bestAsk: { price: 0.491, size: 10 } } as { bestAsk: { price: number; size: number } }
    });

    expect(result).toMatchObject({
      requiresUserChannel: true,
      plannedOrders: 1
    });
    expect(result.blocked).toBeUndefined();
    expect(metrics.getOrderVelocity).not.toHaveBeenCalled();
    expect(metrics.getDelayedAckRate).not.toHaveBeenCalled();
  });

  it('blocks live EV execution on the no side when pricing moves outside the allowed band', () => {
    const incidentTracker = { record: vi.fn() };

    const result = runExecutionPreflight({
      nowMs: 2_100,
      opportunity: makeOpportunity({ type: 'ev', side: 'no', detectedAt: 2_050 }),
      policy: { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard', priceBandBps: 100 },
      tradingEnabled: true,
      tradingMode: 'live',
      userRealtime: { isConnected: () => true } as never,
      incidentTracker: incidentTracker as never,
      idempotencyKey: 'key-no-band',
      executionId: 'exec-no-band',
      idleState: 'idle',
      isEv: true,
      yesBook: { bestAsk: { price: 0.48, size: 10 } } as { bestAsk: { price: number; size: number } },
      noBook: { bestAsk: { price: 0.7, size: 10 } } as { bestAsk: { price: number; size: number } }
    });

    expect(result.blocked).toMatchObject({ reason: 'price_moved' });
    expect(result.effects).toContainEqual(expect.objectContaining({
      type: 'incident',
      incident: expect.objectContaining({
        reason: 'price_moved',
        detail: expect.objectContaining({ side: 'no' })
      })
    }));
  });

  it('throws when near-zero mode disables rejectDelayed', () => {
    expect(() =>
      runExecutionPreflight({
        nowMs: 2_100,
        opportunity: makeOpportunity({ detectedAt: 2_050 }),
        policy: { ...DEFAULT_TRADE_POLICY, rejectDelayed: false },
        tradingEnabled: true,
        tradingMode: 'live',
        userRealtime: { isConnected: () => true } as never,
        idempotencyKey: 'key-reject-delayed',
        executionId: 'exec-reject-delayed',
        idleState: 'idle',
        isEv: false
      })
    ).toThrow('ExecutionAgent requires rejectDelayed=true for near-risk-free mode');
  });
});

describe('ExecutionOrderTracker', () => {
  it('deduplicates trade updates and resolves fill waiters with reconciliation details', async () => {
    const messageBus = { emit: vi.fn() };
    const portfolio = { applyFillWithReconciliation: vi.fn() };
    const tracker = new ExecutionOrderTracker({
      messageBus: messageBus as never,
      portfolio: portfolio as never,
      entrySlippageToleranceBps: 50
    });

    const waiter = tracker.waitForFillOutcome('order-1', 1, 1_000);
    tracker.handleUserOrderUpdate({
      orderId: 'order-1',
      marketId: 'market-1',
      assetId: 'yes-token',
      side: 'BUY',
      price: 0.5,
      sizeMatched: 0,
      originalSize: 1,
      status: 'LIVE',
      orderEventType: 'UPDATE',
      timestampMs: 10,
      raw: {}
    } as never);

    const tradeUpdate = {
      tradeId: 'trade-1',
      takerOrderId: 'order-1',
      makerMatches: [],
      size: 1,
      marketId: 'market-1',
      assetId: 'yes-token',
      side: 'BUY',
      price: 0.51,
      timestampMs: 15
    };
    tracker.handleUserTradeUpdate(tradeUpdate as never);
    tracker.handleUserTradeUpdate(tradeUpdate as never);

    await expect(waiter).resolves.toEqual({
      orderId: 'order-1',
      sizeMatched: 1,
      fullyFilled: true,
      cancelled: false,
      timedOut: false,
      observedAtMs: 15
    });
    expect(portfolio.applyFillWithReconciliation).toHaveBeenCalledTimes(1);
    expect(messageBus.emit).toHaveBeenCalledTimes(1);
    const [, payload] = messageBus.emit.mock.calls[0] as [string, {
      orderId: string;
      marketId: string;
      slippage: number;
    }];
    expect(payload.orderId).toBe('order-1');
    expect(payload.marketId).toBe('market-1');
    expect(payload.slippage).toBeCloseTo(0.02);
  });
});
