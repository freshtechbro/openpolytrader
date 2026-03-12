import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMessageBus } from '../../src/core/MessageBus.js';
import {
  cancelOutstandingBatchOrders,
  ExecutionIdempotencyStore,
  ExecutionLifecycle,
  ExecutionUnwindSupport,
  waitForBatchFillOutcomes
} from '../../src/agents/execution/ExecutionAgentSupport.js';
import { ExecutionBasketRunner } from '../../src/agents/execution/ExecutionBasketRunner.js';
import { ExecutionEvRunner } from '../../src/agents/execution/ExecutionEvRunner.js';
import { ExecutionFailureRecovery } from '../../src/agents/execution/ExecutionFailureRecovery.js';
import { ExecutionModeSupport } from '../../src/agents/execution/ExecutionModeSupport.js';
import { ExecutionOrderTracker } from '../../src/agents/execution/ExecutionOrderTracker.js';
import { ExecutionPairedRunner } from '../../src/agents/execution/ExecutionPairedRunner.js';
import { runExecutionPreflight } from '../../src/agents/execution/ExecutionPreflight.js';
import {
  alignPriceUp,
  applyMultiplier,
  extractOrderId,
  formatCancelError,
  isCancelFailure,
  isOrderSuccessful,
  isTimeoutError,
  withTimeout
} from '../../src/agents/execution/ExecutionShared.js';
import type {
  ExecutionFillServices,
  ExecutionIdempotencyServices,
  ExecutionUnwindServices,
  PairedExecutionService
} from '../../src/agents/execution/ExecutionContracts.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import {
  createInitialExecutionState,
  transitionExecutionState,
  type ExecutionEvent
} from '../../src/domain/execution.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';

function makeHelperOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'opp-helper-1',
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
    pair: { conditionId: 'cond-1', yesTokenId: 'yes-token', noTokenId: 'no-token' },
    ...overrides
  } as ArbitrageOpportunity;
}

type BasketRunnerDeps = ConstructorParameters<typeof ExecutionBasketRunner>[0];
type LegacyBasketRunnerDeps = Omit<BasketRunnerDeps, 'idempotency' | 'fills' | 'unwind' | 'paired'> & {
  ensureIdempotencyRecord: ExecutionIdempotencyServices['ensureRecord'];
  getIdempotencyRecord: ExecutionIdempotencyServices['getRecord'];
  saveIdempotencyRecord: ExecutionIdempotencyServices['saveRecord'];
  markIdempotencyFailed: ExecutionIdempotencyServices['markFailed'];
  executeArbitrage: PairedExecutionService['execute'];
  waitForBatchFillOutcomes: ExecutionFillServices['waitForBatchFillOutcomes'];
  cancelOutstandingBatchOrders: ExecutionFillServices['cancelOutstandingBatchOrders'];
  unwindBasketLegs: ExecutionUnwindServices['unwindBasketLegs'];
  calculateUnwindPrice: ExecutionUnwindServices['calculateUnwindPrice'];
};

type EvRunnerDeps = ConstructorParameters<typeof ExecutionEvRunner>[0];
type LegacyEvRunnerDeps = Omit<EvRunnerDeps, 'idempotency' | 'fills'> & {
  markIdempotencyFailed: ExecutionIdempotencyServices['markFailed'];
  saveIdempotencyRecord: ExecutionIdempotencyServices['saveRecord'];
  waitForFillOutcome: ExecutionFillServices['waitForFillOutcome'];
};

function makeBasketRunner({
  ensureIdempotencyRecord,
  getIdempotencyRecord,
  saveIdempotencyRecord,
  markIdempotencyFailed,
  executeArbitrage,
  waitForBatchFillOutcomes,
  cancelOutstandingBatchOrders,
  unwindBasketLegs,
  calculateUnwindPrice,
  ...deps
}: LegacyBasketRunnerDeps): ExecutionBasketRunner {
  return new ExecutionBasketRunner({
    ...deps,
    idempotency: {
      ensureRecord: ensureIdempotencyRecord,
      getRecord: getIdempotencyRecord,
      saveRecord: saveIdempotencyRecord,
      markFailed: markIdempotencyFailed
    },
    fills: {
      waitForFillOutcome: async () => {
        throw new Error('ExecutionBasketRunner waitForFillOutcome not used in module tests');
      },
      waitForBatchFillOutcomes,
      cancelOutstandingBatchOrders
    },
    unwind: {
      unwindBasketLegs,
      calculateUnwindPrice
    },
    paired: {
      execute: executeArbitrage
    }
  });
}

function makeEvRunner({
  markIdempotencyFailed,
  saveIdempotencyRecord,
  waitForFillOutcome,
  ...deps
}: LegacyEvRunnerDeps): ExecutionEvRunner {
  return new ExecutionEvRunner({
    ...deps,
    idempotency: {
      markFailed: markIdempotencyFailed,
      saveRecord: saveIdempotencyRecord
    },
    fills: {
      waitForFillOutcome
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('execution helper modules', () => {
  it('covers shared execution helpers directly', async () => {
    expect(applyMultiplier(100, 0.5)).toBe(50);
    expect(alignPriceUp(0.451, 0.01)).toBe(0.46);
    expect(extractOrderId({ order_id: 'abc' } as never)).toBe('abc');
    expect(isOrderSuccessful({ status: 'LIVE' } as never)).toBe(true);
    expect(isCancelFailure({ canceled: ['abc'], not_canceled: {} }, 'abc')).toBe(false);
    expect(formatCancelError(new Error('boom'))).toBe('boom');

    await expect(withTimeout(Promise.resolve('ok'), 10, 'phase')).resolves.toBe('ok');
    await expect(withTimeout(new Promise(() => {}), 1, 'phase')).rejects.toMatchObject({ phase: 'phase' });
    await withTimeout(new Promise((resolve) => setTimeout(resolve, 0)), 10, 'phase').catch(() => undefined);
    await expect(withTimeout(Promise.reject(new Error('x')), 10, 'phase')).rejects.toThrow('x');
    expect(isTimeoutError(new Error('x'))).toBe(false);
  });

  it('covers execution order tracking directly', async () => {
    const tracker = new ExecutionOrderTracker({
      messageBus: createMessageBus(),
      entrySlippageToleranceBps: DEFAULT_TRADE_POLICY.entrySlippageToleranceBps
    });

    tracker.handleUserOrderUpdate({
      eventType: 'order',
      orderId: 'order-1',
      status: 'FILLED',
      sizeMatched: 1,
      timestampMs: Date.now(),
      raw: {}
    });

    const outcome = await tracker.waitForFillOutcome('order-1', 1, 10);
    expect(outcome.fullyFilled).toBe(true);
    tracker.cleanupOrderTracking(['order-1']);
    expect(tracker.userOrders.has('order-1')).toBe(false);
  });

  it('covers execution preflight directly', () => {
    const result = runExecutionPreflight({
      nowMs: Date.now(),
      opportunity: makeHelperOpportunity(),
      policy: DEFAULT_TRADE_POLICY,
      tradingEnabled: false,
      tradingMode: 'off',
      idempotencyKey: 'idempotency',
      executionId: 'execution',
      idleState: 'idle',
      isEv: false
    });

    expect(result.blocked?.reason).toBe('trading_disabled');
    expect(result.plannedOrders).toBe(2);
  });

  it('covers idempotency store and lifecycle helpers directly', () => {
    const store = {
      getIdempotencyRecord: vi.fn(),
      upsertIdempotencyRecord: vi.fn(),
      pruneIdempotencyRecords: vi.fn(),
      append: vi.fn()
    };
    const idempotency = new ExecutionIdempotencyStore({
      clob: { reserveNonce: vi.fn().mockReturnValue('100') } as never,
      store: store as never
    });

    const record = idempotency.ensureRecord('key-1', 1000);
    expect(record.nonce).toBe('100');
    idempotency.markFailed('key-1', 1001);
    idempotency.prune(2000);
    expect(store.upsertIdempotencyRecord).toHaveBeenCalled();
    expect(store.pruneIdempotencyRecords).toHaveBeenCalledWith(2000);

    const messageBus = createMessageBus();
    const emitSpy = vi.spyOn(messageBus, 'emit');
    const activeExecutions = new Map();
    const lifecycle = new ExecutionLifecycle({
      messageBus,
      store: store as never,
      activeExecutions
    });
    const initial = createInitialExecutionState({
      id: 'execution-1',
      opportunityId: 'opp-1',
      marketId: 'market-1',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
      size: 1,
      yesPrice: 0.48,
      noPrice: 0.49,
      createdAtMs: 1000
    });

    lifecycle.emitExecutionOutcome(makeHelperOpportunity(), {
      status: 'submitted',
      idempotencyKey: 'key-1',
      executionId: 'execution-1'
    });
    const next = lifecycle.transition(initial, { type: 'SUBMIT_STARTED', atMs: 1001 } as ExecutionEvent);

    expect(emitSpy).toHaveBeenCalledWith(
      'execution:outcome',
      expect.objectContaining({ executionId: 'execution-1', idempotencyKey: 'key-1' })
    );
    expect(next.state).toBe('submitting');
    expect(activeExecutions.get('execution-1')).toEqual(next);
  });

  it('covers unwind and batch support helpers directly', async () => {
    const incidentTracker = { record: vi.fn() };
    const support = new ExecutionUnwindSupport({
      getPolicy: () => DEFAULT_TRADE_POLICY,
      getRiskConfig: () => DEFAULT_RISK_CONFIG,
      getExecutionAdvisor: () =>
        ({
          getHint: () => ({ unwindHint: 'aggressive', timeoutMultiplier: 0.5, confidence: 0.9 })
        }) as never,
      getExecutionAdvisorMode: () => 'advisory',
      clob: { createOrder: vi.fn().mockResolvedValue({ orderId: 'u-1', status: 'LIVE' }) } as never,
      incidentTracker: incidentTracker as never,
      portfolio: { applyUnwind: vi.fn() } as never
    });

    expect(
      support.resolveUnwindTickSize('yes', makeHelperOpportunity(), { yesBook: { tickSize: 0.02 } as never })
    ).toBe(0.02);
    expect(support.calculateUnwindPrice(0.5, 0.01, { marketId: 'market-1', opportunityId: 'opp-1' })).toBeLessThan(0.5);

    const wait = await waitForBatchFillOutcomes(
      [{ marketId: 'market-1', side: 'yes', idempotencyKey: 'idempotency', orderId: 'order-1' }],
      1,
      10,
      async (orderId) => ({
        orderId,
        sizeMatched: 1,
        fullyFilled: true,
        cancelled: false,
        timedOut: false,
        observedAtMs: 1000
      })
    );
    expect(wait.allFilled).toBe(true);

    await cancelOutstandingBatchOrders(
      [{ order: { marketId: 'market-1', side: 'yes', idempotencyKey: 'idempotency', orderId: 'order-1' }, outcome: { ...wait.outcomes[0].outcome, fullyFilled: false } }],
      'opp-1',
      1000,
      {
        clob: { cancelOrder: vi.fn().mockResolvedValue({ canceled: ['order-1'], not_canceled: {} }) } as never,
        incidentTracker: incidentTracker as never,
        cancelTimeoutMs: 10,
        markIdempotencyFailed: vi.fn()
      }
    );

    await support.unwindBasketLegs(
      makeHelperOpportunity({
        type: 'fw_basket',
        fwBasket: {
          basketId: 'basket-1',
          executionMode: 'batch_best_effort',
          markets: [{ marketId: 'market-1', yesTokenId: 'yes-token', noTokenId: 'no-token', yesPrice: 0.48, noPrice: 0.49, tickSize: 0.01 }]
        }
      }),
      [{ marketId: 'market-1', yesTokenId: 'yes-token', noTokenId: 'no-token', yesPrice: 0.48, noPrice: 0.49, tickSize: 0.01 }],
      1,
      1000,
      10
    );
    expect(incidentTracker.record).not.toHaveBeenCalled();
  });

  it('covers execution mode support directly', async () => {
    const record = { key: 'key', nonce: '1', status: 'pending', createdAt: 1, updatedAt: 1 };
    const modeSupport = new ExecutionModeSupport({
      runtime: {
        getPolicy: () => DEFAULT_TRADE_POLICY,
        getTimeouts: () => ({ submitTimeoutMs: 100, ackTimeoutMs: 100, fillTimeoutMs: 100, cancelTimeoutMs: 100 }),
        getExecutionAdvisor: () =>
          ({
            getHint: () => ({ timeoutMultiplier: 0.5, unwindHint: 'neutral', confidence: 0.8 })
          }) as never,
        getExecutionAdvisorMode: () => 'advisory',
        getTradingEnabled: () => true,
        getTradingMode: () => 'live'
      },
      idempotency: {
        ensureRecord: vi.fn(() => ({ ...record })),
        getRecord: vi.fn(),
        saveRecord: vi.fn(),
        markFailed: vi.fn()
      },
      fills: {
        waitForFillOutcome: vi.fn().mockResolvedValue({
          orderId: 'order-1',
          sizeMatched: 1,
          fullyFilled: true,
          cancelled: false,
          timedOut: false,
          observedAtMs: Date.now()
        }),
        waitForBatchFillOutcomes: vi.fn(),
        cancelOutstandingBatchOrders: vi.fn()
      },
      unwind: {
        unwindBasketLegs: vi.fn(),
        calculateUnwindPrice: vi.fn().mockReturnValue(0.47)
      },
      pairedExecution: {
        execute: vi
          .fn()
          .mockResolvedValue({ kind: 'paired', status: 'submitted', idempotencyKey: 'key', executionId: 'exec', state: 'complete' })
      },
      clob: { createOrder: vi.fn().mockResolvedValue({ orderId: 'order-1', status: 'LIVE' }) } as never,
    });

    expect(modeSupport.getEffectiveTimeouts('market-1', 'opp-1', Date.now()).submitTimeoutMs).toBe(50);
    const basketResult = await modeSupport.executeBasketArbitrage(makeHelperOpportunity(), 1);
    expect(basketResult.status).toBe('blocked');
    const evResult = await modeSupport.executeEvOrder(
      makeHelperOpportunity({ type: 'ev', side: undefined }),
      1,
      {
        nowMs: Date.now(),
        idempotencyKey: 'key',
        executionId: 'exec',
        idleState: 'idle',
        timeouts: { submitTimeoutMs: 100, fillTimeoutMs: 100 },
        record: { ...record },
        trackedOrderIds: [],
        requiresUserChannel: true
      }
    );
    expect(evResult.reason).toBe('ev_missing_side');
  });

  it('covers execution runner modules directly', async () => {
    const basketRunner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {} as never,
      ensureIdempotencyRecord: vi.fn(),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (value) => value,
      extractOrderId
    });
    await expect(basketRunner.executeBasketArbitrage(makeHelperOpportunity(), 1)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'fw_basket_missing'
    });

    const evRunner = makeEvRunner({
      clob: {} as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError,
      coerceNonceValue: (value) => value,
      extractOrderId
    });
    await expect(
      evRunner.execute(makeHelperOpportunity({ type: 'ev', side: undefined }), 1, {
        nowMs: Date.now(),
        idempotencyKey: 'key',
        executionId: 'exec',
        idleState: 'idle',
        timeouts: { submitTimeoutMs: 100, fillTimeoutMs: 100 },
        record: { key: 'yes', nonce: '1', status: 'pending', createdAt: 1, updatedAt: 1 },
        trackedOrderIds: [],
        requiresUserChannel: true
      })
    ).resolves.toMatchObject({ reason: 'ev_missing_side' });

    const current = transitionExecutionState(
      createInitialExecutionState({
        id: 'execution-1',
        opportunityId: 'opp-1',
        marketId: 'market-1',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
        size: 1,
        yesPrice: 0.48,
        noPrice: 0.49,
        createdAtMs: 1000
      }),
      { type: 'SUBMIT_STARTED', atMs: 1000 }
    );
    const failureRecovery = new ExecutionFailureRecovery({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ orderId: 'unwind-1', status: 'LIVE' }),
        cancelOrder: vi.fn().mockResolvedValue({ canceled: ['no-order'], not_canceled: {} }),
        cancelMarketOrders: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} })
      } as never,
      opportunity: makeHelperOpportunity(),
      timeouts: { submitTimeoutMs: 10, cancelTimeoutMs: 10 },
      idempotencyKey: 'key',
      executionId: 'exec',
      yesIdempotencyKey: 'yes',
      noIdempotencyKey: 'no',
      markIdempotencyFailed: vi.fn(),
      resolveUnwindTickSize: vi.fn().mockReturnValue(0.01),
      calculateUnwindPrice: vi.fn().mockReturnValue(0.46),
      recordUnwindPortfolio: vi.fn(),
      transition: (state, event) => transitionExecutionState(state, event as ExecutionEvent),
      withTimeout,
      extractOrderId,
      isOrderSuccessful,
      isCancelFailure,
      formatCancelError
    });
    await expect(
      failureRecovery.handleFailure(current, 1001, 1, 'order_failed', 'order_failed', {}, undefined, undefined)
    ).resolves.toMatchObject({ status: 'failed', reason: 'order_failed' });

    const pairedRunner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ orderId: 'yes-order', status: 'LIVE' })
          .mockResolvedValueOnce({ orderId: 'no-order', status: 'LIVE' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (state, event) => transitionExecutionState(state, event as ExecutionEvent),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({ orderId: 'yes-order', sizeMatched: 1, fullyFilled: true, cancelled: false, timedOut: false, observedAtMs: 1002 })
        .mockResolvedValueOnce({ orderId: 'no-order', sizeMatched: 1, fullyFilled: true, cancelled: false, timedOut: false, observedAtMs: 1003 }),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError,
      coerceNonceValue: (value) => value,
      extractOrderId,
      handleFailure: vi.fn(),
      handleObservedPartialFill: vi.fn()
    });
    await expect(
      pairedRunner.execute({
        opportunity: makeHelperOpportunity(),
        size: 1,
        nowMs: 1000,
        timeouts: { submitTimeoutMs: 1000, ackTimeoutMs: 1000, fillTimeoutMs: 1000 },
        idempotencyKey: 'key',
        executionId: 'exec',
        yesIdempotencyKey: 'yes',
        noIdempotencyKey: 'no',
        yesRecord: { key: 'yes', nonce: '1', status: 'pending', createdAt: 1, updatedAt: 1 },
        noRecord: { key: 'no', nonce: '2', status: 'pending', createdAt: 1, updatedAt: 1 },
        trackedOrderIds: [],
        requiresUserChannel: true
      })
    ).resolves.toMatchObject({ status: 'submitted', state: 'complete' });
  });
});
