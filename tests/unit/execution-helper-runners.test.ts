import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { createInitialExecutionState, transitionExecutionState } from '../../src/domain/execution.js';
import type { IdempotencyRecord } from '../../src/domain/idempotency.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import { ExecutionBasketRunner } from '../../src/agents/execution/ExecutionBasketRunner.js';
import { ExecutionEvRunner } from '../../src/agents/execution/ExecutionEvRunner.js';
import { ExecutionFailureRecovery } from '../../src/agents/execution/ExecutionFailureRecovery.js';
import { ExecutionModeSupport } from '../../src/agents/execution/ExecutionModeSupport.js';
import { ExecutionPairedRunner } from '../../src/agents/execution/ExecutionPairedRunner.js';
import { isCancelFailure, isOrderSuccessful, withTimeout } from '../../src/agents/execution/ExecutionShared.js';
import type {
  ExecutionEvParams,
  ExecutionFillServices,
  ExecutionIdempotencyServices,
  ExecutionUnwindServices,
  PairedExecutionService
} from '../../src/agents/execution/ExecutionContracts.js';

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

function makeRecord(key: string, nonce: string, orderId?: string): IdempotencyRecord {
  return {
    key,
    nonce,
    status: orderId ? 'submitted' : 'pending',
    orderId,
    createdAt: 1,
    updatedAt: 1
  };
}

function makeEvParams(overrides: Partial<ExecutionEvParams> = {}): ExecutionEvParams {
  const base: ExecutionEvParams = {
    nowMs: 1_100,
    idempotencyKey: 'ev-key',
    executionId: 'ev-exec',
    idleState: 'idle',
    timeouts: { submitTimeoutMs: 20, fillTimeoutMs: 50 },
    record: makeRecord('ev-yes', '11'),
    trackedOrderIds: []
  };
  return {
    ...base,
    ...overrides,
    timeouts: { ...base.timeouts, ...overrides.timeouts }
  };
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
        throw new Error('ExecutionBasketRunner waitForFillOutcome not used in basket tests');
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

function makeBasketOpportunity(
  overrides: Partial<ArbitrageOpportunity> & {
    fwBasket?: NonNullable<ArbitrageOpportunity['fwBasket']>;
  } = {}
): ArbitrageOpportunity {
  const baseMarkets: NonNullable<ArbitrageOpportunity['fwBasket']>['markets'] = [
    {
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
    },
    {
      marketId: 'market-2',
      yesTokenId: 'yes-token-2',
      noTokenId: 'no-token-2',
      yesPrice: 0.46,
      noPrice: 0.47,
      costPerSet: 0.93,
      projectedEdge: 0.05,
      edgeLowerBound: 0.04,
      maxSizeByDepth: 10,
      minOrderSize: 1,
      tickSize: 0.01
    }
  ];

  return makeOpportunity({
    type: 'fw_basket',
    fwBasket: {
      basketId: 'basket-1',
      executionMode: 'batch_best_effort',
      aggregateEdgeLowerBound: 0.03,
      aggregateProjectedEdge: 0.04,
      loop: {
        loopId: 'loop-1',
        iterationCount: 1,
        activeSetSize: 1,
        contractionSteps: 0,
        terminalGapAbs: 0.001,
        terminalGapRel: 0.01,
        terminalReason: 'gap_converged',
        converged: true,
        runtimeMs: 5
      },
      markets: baseMarkets
    },
    ...overrides
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExecutionModeSupport', () => {
  it('applies advisory timeout hints without mutating the base timeouts', () => {
    const metrics = { record: vi.fn() };
    const support = new ExecutionModeSupport({
      runtime: {
        getPolicy: () => DEFAULT_TRADE_POLICY,
        getTimeouts: () => ({
          submitTimeoutMs: 200,
          ackTimeoutMs: 400,
          fillTimeoutMs: 600,
          cancelTimeoutMs: 800
        }),
        getExecutionAdvisor: () => ({
          getHint: () => ({
            timeoutMultiplier: 0.25,
            unwindHint: 'neutral',
            confidence: 0.8,
            expiresAtMs: 9_999
          })
        }) as unknown as never,
        getExecutionAdvisorMode: () => 'advisory'
      },
      idempotency: {
        ensureRecord: () => makeRecord('unused', '1'),
        getRecord: () => undefined,
        saveRecord: vi.fn(),
        markFailed: vi.fn()
      },
      fills: {
        waitForFillOutcome: vi.fn(),
        waitForBatchFillOutcomes: vi.fn(),
        cancelOutstandingBatchOrders: vi.fn()
      },
      unwind: {
        unwindBasketLegs: vi.fn(),
        calculateUnwindPrice: vi.fn()
      },
      pairedExecution: {
        execute: vi.fn()
      },
      clob: {} as never,
      metrics: metrics as never
    });

    const effective = support.getEffectiveTimeouts('market-1', 'opp-1', 2_000);

    expect(effective).toEqual({
      submitTimeoutMs: 50,
      ackTimeoutMs: 100,
      fillTimeoutMs: 150,
      cancelTimeoutMs: 200
    });
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'shadow_decision'
    }));
  });

  it('returns base timeouts when the execution advisor has no hint', () => {
    const metrics = { record: vi.fn() };
    const support = new ExecutionModeSupport({
      runtime: {
        getPolicy: () => DEFAULT_TRADE_POLICY,
        getTimeouts: () => ({
          submitTimeoutMs: 200,
          ackTimeoutMs: 400,
          fillTimeoutMs: 600,
          cancelTimeoutMs: 800
        }),
        getExecutionAdvisor: () =>
          ({
            getHint: () => undefined
          }) as unknown as never,
        getExecutionAdvisorMode: () => 'advisory'
      },
      idempotency: {
        ensureRecord: () => makeRecord('unused', '1'),
        getRecord: () => undefined,
        saveRecord: vi.fn(),
        markFailed: vi.fn()
      },
      fills: {
        waitForFillOutcome: vi.fn(),
        waitForBatchFillOutcomes: vi.fn(),
        cancelOutstandingBatchOrders: vi.fn()
      },
      unwind: {
        unwindBasketLegs: vi.fn(),
        calculateUnwindPrice: vi.fn()
      },
      pairedExecution: {
        execute: vi.fn()
      },
      clob: {} as never,
      metrics: metrics as never
    });

    expect(support.getEffectiveTimeouts('market-1', 'opp-1', 2_000)).toEqual({
      submitTimeoutMs: 200,
      ackTimeoutMs: 400,
      fillTimeoutMs: 600,
      cancelTimeoutMs: 800
    });
    expect(metrics.record).not.toHaveBeenCalled();
  });
});

describe('ExecutionEvRunner', () => {
  it('blocks EV execution when the opportunity side is missing', async () => {
    const runner = makeEvRunner({
      clob: { createOrder: vi.fn() } as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: undefined,
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'ev_missing_side',
      state: 'idle'
    });
  });

  it('blocks EV execution when the selected side has an invalid price', async () => {
    const runner = makeEvRunner({
      clob: { createOrder: vi.fn() } as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'no',
        noPrice: 0,
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams({ record: makeRecord('ev-no', '12') })
    );

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'invalid_price',
      state: 'idle'
    });
  });

  it('fails EV execution on delayed acknowledgements', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_120);

    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    const metrics = {
      recordLatency: vi.fn(),
      recordOrderAttempt: vi.fn(),
      recordFill: vi.fn(),
      recordDelayedAck: vi.fn()
    };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'DELAYED', orderID: 'ev-order-1' })
      } as never,
      incidentTracker: incidentTracker as never,
      metrics: metrics as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_delayed',
      state: 'failed',
      side: 'yes',
      order: { orderID: 'ev-order-1' }
    });
    expect(metrics.recordDelayedAck).toHaveBeenCalledWith('market-1', 1_120);
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-yes', 1_120);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_delayed'
    }));
  });

  it('waits for the EV fill outcome before completing', async () => {
    const waitForFillOutcome = vi.fn().mockResolvedValue({
      orderId: 'ev-order-1',
      sizeMatched: 2,
      fullyFilled: true,
      cancelled: false,
      timedOut: false,
      observedAtMs: 1_130
    });
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE', orderID: 'ev-order-1' })
      } as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome,
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      side: 'yes',
      order: { orderID: 'ev-order-1' }
    });
    expect(waitForFillOutcome).toHaveBeenCalledWith('ev-order-1', 2, expect.any(Number));
  });

  it('fails EV execution when the acknowledgement has no order id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_120);

    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE' })
      } as never,
      incidentTracker: incidentTracker as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: () => undefined
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_failed',
      state: 'failed'
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-yes', 1_120);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_failed'
    }));
  });

  it('fails EV execution when the fill outcome times out', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_140);

    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE', orderID: 'ev-order-1' })
      } as never,
      incidentTracker: incidentTracker as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn().mockResolvedValue({
        orderId: 'ev-order-1',
        sizeMatched: 1,
        fullyFilled: false,
        cancelled: false,
        timedOut: true,
        observedAtMs: 1_130
      }),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_timeout',
      state: 'timeout'
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-yes', 1_140);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_timeout'
    }));
  });

  it('confirms a filled EV order through the user channel path', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_100);

    const saveIdempotencyRecord = vi.fn();
    const metrics = {
      recordLatency: vi.fn(),
      recordOrderAttempt: vi.fn(),
      recordFill: vi.fn(),
      recordDelayedAck: vi.fn()
    };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE', orderID: 'ev-order-1' })
      } as never,
      portfolio: { expectFill: vi.fn() } as never,
      incidentTracker: { record: vi.fn() } as never,
      metrics: metrics as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord,
      waitForFillOutcome: vi.fn().mockResolvedValue({
        orderId: 'ev-order-1',
        sizeMatched: 2,
        fullyFilled: true,
        cancelled: false,
        timedOut: false,
        observedAtMs: 1_120
      }),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      side: 'yes',
      order: { orderID: 'ev-order-1' }
    });
    expect(saveIdempotencyRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'ev-yes',
      status: 'confirmed',
      orderId: 'ev-order-1'
    }));
    expect(metrics.recordFill).toHaveBeenCalledWith('market-1', 1_120);
  });

  it('reuses a stored no-side order id when the venue omits it', async () => {
    const saveIdempotencyRecord = vi.fn();
    const trackedOrderIds: string[] = [];
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE' })
      } as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord,
      waitForFillOutcome: vi.fn().mockResolvedValue({
        orderId: 'ev-order-no',
        sizeMatched: 0,
        fullyFilled: false,
        cancelled: false,
        timedOut: true,
        observedAtMs: 1_130
      }),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'no',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams({
        record: makeRecord('ev-no', '12', 'ev-order-no'),
        trackedOrderIds
      })
    );

    expect(result).toMatchObject({
      status: 'failed',
      state: 'timeout',
      side: 'no',
      order: { orderID: 'ev-order-no' }
    });
    expect(trackedOrderIds).toEqual(['ev-order-no']);
    expect(saveIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({
      key: 'ev-no',
      orderId: 'ev-order-no',
      status: 'submitted'
    }));
  });

  it('classifies rejected no-side EV acknowledgements as order_rejected', async () => {
    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: false, status: 'rejected' })
      } as never,
      incidentTracker: incidentTracker as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'no',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams({ record: makeRecord('ev-no', '12') })
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_rejected',
      state: 'failed',
      side: 'no',
      order: { status: 'rejected' }
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-no', expect.any(Number));
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_rejected'
    }));
  });

  it('classifies timeout failures during EV submission distinctly', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_115);

    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockRejectedValue({ phase: 'ev_submit_yes', timeoutMs: 20 })
      } as never,
      incidentTracker: incidentTracker as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: (error): error is { phase: string; timeoutMs: number } =>
        Boolean(error && typeof error === 'object' && 'phase' in error && 'timeoutMs' in error),
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_timeout',
      state: 'failed'
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-yes', 1_115);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_timeout',
      detail: expect.objectContaining({ phase: 'ev_submit_yes', timeoutMs: 20 })
    }));
  });

  it('classifies non-error EV submission failures with a string detail', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_116);

    const incidentTracker = { record: vi.fn() };
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockRejectedValue('venue down')
      } as never,
      incidentTracker: incidentTracker as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'yes',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams()
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_failed',
      state: 'failed'
    });
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_failed',
      detail: { error: 'venue down' }
    }));
  });

  it('keeps EV confirmation logic on the no side when fill timeout is zero', async () => {
    const waitForFillOutcome = vi.fn().mockResolvedValue({
      orderId: 'ev-order-no',
      sizeMatched: 2,
      fullyFilled: true,
      cancelled: false,
      timedOut: false,
      observedAtMs: 1_120
    });
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE', orderID: 'ev-order-no' })
      } as never,
      markIdempotencyFailed: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome,
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'no',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams({
        record: makeRecord('ev-no', '12'),
        timeouts: { submitTimeoutMs: 20, fillTimeoutMs: 0 }
      })
    );

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      side: 'no',
      order: { orderID: 'ev-order-no' }
    });
    expect(waitForFillOutcome).toHaveBeenCalledWith('ev-order-no', 2, 0);
  });

  it('fails non-timeout EV fill outcomes on the no side', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_140);

    const markIdempotencyFailed = vi.fn();
    const runner = makeEvRunner({
      clob: {
        createOrder: vi.fn().mockResolvedValue({ success: true, status: 'LIVE', orderID: 'ev-order-no' })
      } as never,
      incidentTracker: { record: vi.fn() } as never,
      markIdempotencyFailed,
      saveIdempotencyRecord: vi.fn(),
      waitForFillOutcome: vi.fn().mockResolvedValue({
        orderId: 'ev-order-no',
        sizeMatched: 1,
        fullyFilled: false,
        cancelled: true,
        timedOut: false,
        observedAtMs: 1_130
      }),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.execute(
      makeOpportunity({
        type: 'ev',
        side: 'no',
        evRaw: 0.04,
        evNet: 0.04,
        modelConfidence: 0.9
      }),
      2,
      makeEvParams({ record: makeRecord('ev-no', '12') })
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_failed',
      state: 'failed',
      side: 'no',
      order: { orderID: 'ev-order-no' }
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('ev-no', 1_140);
  });
});

describe('ExecutionBasketRunner', () => {
  it('blocks basket execution when fw basket data is missing', async () => {
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {} as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
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
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeOpportunity(), 2, { nowMs: 1_200 });

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'fw_basket_missing',
      state: 'idle'
    });
  });

  it('completes a fully accepted batch immediately when no fill wait is required', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const saveIdempotencyRecord = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 0, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord,
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_210 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(saveIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({
      status: 'confirmed'
    }));
  });

  it('ignores extra batch candidates and keeps success when one accepted order lacks an order id', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const saveIdempotencyRecord = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' },
          { status: 'LIVE', orderID: 'extra-order' }
        ])
      } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 0, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord,
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_215 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(saveIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'yes-order-1',
      status: 'submitted'
    }));
    expect(saveIdempotencyRecord).not.toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'extra-order'
    }));
  });

  it('confirms fully filled basket batches through the user channel path', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const saveIdempotencyRecord = vi.fn();
    const acceptedOrders = [
      { marketId: 'market-1', side: 'yes', idempotencyKey: 'basket-key:market-1:yes', orderId: 'yes-order-1' },
      { marketId: 'market-1', side: 'no', idempotencyKey: 'basket-key:market-1:no', orderId: 'no-order-1' },
      { marketId: 'market-2', side: 'yes', idempotencyKey: 'basket-key:market-2:yes', orderId: 'yes-order-2' },
      { marketId: 'market-2', side: 'no', idempotencyKey: 'basket-key:market-2:no', orderId: 'no-order-2' }
    ] as const;
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      userRealtime: { isConnected: () => true } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 20, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord,
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn().mockResolvedValue({
        allFilled: true,
        outcomes: acceptedOrders.map((order) => ({
          order,
          outcome: {
            orderId: order.orderId,
            sizeMatched: 2,
            fullyFilled: true,
            cancelled: false,
            timedOut: false,
            observedAtMs: 1_280
          }
        })),
        observedAtMs: 1_280
      }),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(saveIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringContaining('market-1:yes'),
      orderId: 'yes-order-1',
      status: 'confirmed',
      updatedAt: 1_280
    }));
    expect(saveIdempotencyRecord).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringContaining('market-2:no'),
      orderId: 'no-order-2',
      status: 'confirmed',
      updatedAt: 1_280
    }));
  });

  it('completes filled basket batches even when accepted order records are already gone', async () => {
    const ensureIdempotencyRecord = vi.fn((key: string) => makeRecord(key, '1'));
    const saveIdempotencyRecord = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      userRealtime: { isConnected: () => true } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 20, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: () => undefined,
      saveIdempotencyRecord,
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn().mockResolvedValue({
        allFilled: true,
        outcomes: [],
        observedAtMs: 1_280
      }),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete'
    });
    expect(saveIdempotencyRecord).not.toHaveBeenCalled();
  });

  it('completes accepted-count basket batches using stored order ids', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`, `${key}-order`);
      batchRecords.set(key, record);
      return record;
    });
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue({ accepted: 4 })
      } as never,
      userRealtime: { isConnected: () => true } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 0, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
  });

  it('fails batch mode when only part of the basket batch is accepted', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const markIdempotencyFailed = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'rejected' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed,
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_200 });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'batch_partial_accepted',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith(expect.stringContaining('market-2:yes'), 1_200);
  });

  it('falls back to sequential execution when batch submission throws', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const markIdempotencyFailed = vi.fn();
    const executeArbitrage = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'complete'
      })
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-2-key',
        executionId: 'leg-2-exec',
        state: 'complete'
      });
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockRejectedValue(new Error('batch exploded'))
      } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed,
      executeArbitrage,
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_250 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'sequential_failfast', fallbackUsed: true }
    });
    expect(markIdempotencyFailed).toHaveBeenCalledTimes(4);
    expect(executeArbitrage).toHaveBeenCalledTimes(2);
  });

  it('records batch fallback responses before succeeding sequentially', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const metrics = { record: vi.fn() };
    const executeArbitrage = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'complete'
      })
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-2-key',
        executionId: 'leg-2-exec',
        state: 'complete'
      });
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'DELAYED' },
          { status: 'rejected' },
          { status: 'DELAYED' },
          { status: 'rejected' }
        ])
      } as never,
      metrics: metrics as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage,
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'sequential_failfast', fallbackUsed: true }
    });
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'batch_fallback' })
    }));
  });

  it('cancels and unwinds partial fills after an accepted basket batch', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const acceptedOrders = [
      { marketId: 'market-1', side: 'yes', idempotencyKey: 'basket-key:market-1:yes', orderId: 'yes-order-1' },
      { marketId: 'market-1', side: 'no', idempotencyKey: 'basket-key:market-1:no', orderId: 'no-order-1' },
      { marketId: 'market-2', side: 'yes', idempotencyKey: 'basket-key:market-2:yes', orderId: 'yes-order-2' },
      { marketId: 'market-2', side: 'no', idempotencyKey: 'basket-key:market-2:no', orderId: 'no-order-2' }
    ] as const;
    const cancelOutstandingBatchOrders = vi.fn();
    const unwindBasketLegs = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      userRealtime: { isConnected: () => true } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 20, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn().mockResolvedValue({
        allFilled: false,
        outcomes: acceptedOrders.map((order, index) => ({
          order,
          outcome: {
            orderId: order.orderId,
            sizeMatched: index < 2 ? 2 : 0,
            fullyFilled: index < 2,
            cancelled: false,
            timedOut: index >= 2,
            observedAtMs: 1_275
          }
        })),
        observedAtMs: 1_275
      }),
      cancelOutstandingBatchOrders,
      unwindBasketLegs,
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(
      makeBasketOpportunity({ id: 'opp-batch-partial' }),
      2,
      { nowMs: 1_260 }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'partial_fill',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(cancelOutstandingBatchOrders).toHaveBeenCalledTimes(1);
    expect(unwindBasketLegs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'opp-batch-partial' }),
      [expect.objectContaining({ marketId: 'market-1' })],
      2,
      1_275
    );
  });

  it('cancels partial basket batches without unwinding when nothing filled', async () => {
    const batchRecords = new Map<string, IdempotencyRecord>();
    const ensureIdempotencyRecord = vi.fn((key: string) => {
      const record = makeRecord(key, `${batchRecords.size + 1}`);
      batchRecords.set(key, record);
      return record;
    });
    const cancelOutstandingBatchOrders = vi.fn();
    const unwindBasketLegs = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockResolvedValue([
          { status: 'LIVE', orderID: 'yes-order-1' },
          { status: 'LIVE', orderID: 'no-order-1' },
          { status: 'LIVE', orderID: 'yes-order-2' },
          { status: 'LIVE', orderID: 'no-order-2' }
        ])
      } as never,
      userRealtime: { isConnected: () => true } as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 20, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord,
      getIdempotencyRecord: (key: string) => batchRecords.get(key),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn(),
      waitForBatchFillOutcomes: vi.fn().mockResolvedValue({
        allFilled: false,
        outcomes: [
          {
            order: { marketId: 'market-1', side: 'yes', idempotencyKey: 'basket-key:market-1:yes', orderId: 'yes-order-1' },
            outcome: { orderId: 'yes-order-1', sizeMatched: 0, fullyFilled: false, cancelled: true, timedOut: false, observedAtMs: 1_285 }
          },
          {
            order: { marketId: 'market-1', side: 'no', idempotencyKey: 'basket-key:market-1:no', orderId: 'no-order-1' },
            outcome: { orderId: 'no-order-1', sizeMatched: 0, fullyFilled: false, cancelled: true, timedOut: false, observedAtMs: 1_285 }
          },
          {
            order: { marketId: 'market-2', side: 'yes', idempotencyKey: 'basket-key:market-2:yes', orderId: 'yes-order-2' },
            outcome: { orderId: 'yes-order-2', sizeMatched: 0, fullyFilled: false, cancelled: false, timedOut: true, observedAtMs: 1_285 }
          },
          {
            order: { marketId: 'market-2', side: 'no', idempotencyKey: 'basket-key:market-2:no', orderId: 'no-order-2' },
            outcome: { orderId: 'no-order-2', sizeMatched: 0, fullyFilled: false, cancelled: false, timedOut: true, observedAtMs: 1_285 }
          }
        ],
        observedAtMs: 1_285
      }),
      cancelOutstandingBatchOrders,
      unwindBasketLegs,
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'partial_fill',
      basket: { mode: 'batch_best_effort', fallbackUsed: false }
    });
    expect(cancelOutstandingBatchOrders).toHaveBeenCalledTimes(1);
    expect(unwindBasketLegs).not.toHaveBeenCalled();
  });

  it('uses order_failed when a sequential basket leg fails without an explicit reason', async () => {
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {} as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord: vi.fn().mockReturnValue(makeRecord('basket-key', '21')),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn().mockResolvedValue({
        status: 'failed',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'failed'
      }),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(
      makeBasketOpportunity({
        fwBasket: {
          ...makeBasketOpportunity().fwBasket!,
          executionMode: 'sequential_failfast'
        }
      }),
      2,
      { nowMs: 1_200 }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_failed',
      basket: { mode: 'sequential_failfast', fallbackUsed: false }
    });
  });

  it('records string batch fallback errors before succeeding sequentially', async () => {
    const metrics = { record: vi.fn() };
    const executeArbitrage = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'complete'
      })
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-2-key',
        executionId: 'leg-2-exec',
        state: 'complete'
      });
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockRejectedValue('batch exploded')
      } as never,
      metrics: metrics as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord: vi.fn().mockReturnValue(makeRecord('basket-key', '1')),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage,
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'sequential_failfast', fallbackUsed: true }
    });
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'batch_fallback', error: 'batch exploded' })
    }));
  });

  it('records Error batch fallback messages before succeeding sequentially', async () => {
    const metrics = { record: vi.fn() };
    const executeArbitrage = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'complete'
      })
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-2-key',
        executionId: 'leg-2-exec',
        state: 'complete'
      });
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {
        createBatchOrders: vi.fn().mockRejectedValue(new Error('batch exploded'))
      } as never,
      metrics: metrics as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord: vi.fn().mockReturnValue(makeRecord('basket-key', '1')),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage,
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(makeBasketOpportunity(), 2, { nowMs: 1_260 });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      basket: { mode: 'sequential_failfast', fallbackUsed: true }
    });
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'batch_fallback', error: 'batch exploded' })
    }));
  });

  it('unwinds earlier basket legs when sequential fail-fast execution later fails', async () => {
    const executeArbitrage = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'submitted',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'complete'
      })
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'order_rejected',
        idempotencyKey: 'leg-2-key',
        executionId: 'leg-2-exec',
        state: 'failed'
      });
    const unwindBasketLegs = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {} as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord: vi.fn().mockReturnValue(makeRecord('basket-key', '21')),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage,
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs,
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(
      makeOpportunity({
        type: 'fw_basket',
        fwBasket: {
          basketId: 'basket-1',
          executionMode: 'sequential_failfast',
          aggregateEdgeLowerBound: 0.03,
          aggregateProjectedEdge: 0.04,
          loop: {
            loopId: 'loop-1',
            iterationCount: 1,
            activeSetSize: 1,
            contractionSteps: 0,
            terminalGapAbs: 0.001,
            terminalGapRel: 0.01,
            terminalReason: 'gap_converged',
            converged: true,
            runtimeMs: 5
          },
          markets: [
            {
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
            },
            {
              marketId: 'market-2',
              yesTokenId: 'yes-token-2',
              noTokenId: 'no-token-2',
              yesPrice: 0.46,
              noPrice: 0.47,
              costPerSet: 0.93,
              projectedEdge: 0.05,
              edgeLowerBound: 0.04,
              maxSizeByDepth: 10,
              minOrderSize: 1,
              tickSize: 0.01
            }
          ]
        }
      }),
      2,
      { nowMs: 1_200 }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'partial_fill',
      basket: { mode: 'sequential_failfast', fallbackUsed: false }
    });
    expect(unwindBasketLegs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'opp-1' }),
      [expect.objectContaining({ marketId: 'market-1' })],
      2,
      1_200
    );
  });

  it('fails immediately when the first sequential basket leg is blocked', async () => {
    const unwindBasketLegs = vi.fn();
    const runner = makeBasketRunner({
      defaultExecutionMode: 'batch_best_effort',
      clob: {} as never,
      timeouts: { submitTimeoutMs: 10, fillTimeoutMs: 10, cancelTimeoutMs: 10 },
      ensureIdempotencyRecord: vi.fn().mockReturnValue(makeRecord('basket-key', '21')),
      getIdempotencyRecord: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      markIdempotencyFailed: vi.fn(),
      executeArbitrage: vi.fn().mockResolvedValue({
        status: 'blocked',
        reason: 'price_moved',
        idempotencyKey: 'leg-1-key',
        executionId: 'leg-1-exec',
        state: 'idle'
      }),
      waitForBatchFillOutcomes: vi.fn(),
      cancelOutstandingBatchOrders: vi.fn(),
      unwindBasketLegs,
      calculateUnwindPrice: vi.fn(),
      withTimeout,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID
    });

    const result = await runner.executeBasketArbitrage(
      makeBasketOpportunity({
        fwBasket: {
          ...makeBasketOpportunity().fwBasket!,
          executionMode: 'sequential_failfast'
        }
      }),
      2,
      { nowMs: 1_200 }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'price_moved',
      basket: { mode: 'sequential_failfast', fallbackUsed: false }
    });
    expect(unwindBasketLegs).not.toHaveBeenCalled();
  });
});

describe('ExecutionPairedRunner', () => {
  it('routes delayed paired acknowledgements through failure handling', async () => {
    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_delayed',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const metrics = {
      recordLatency: vi.fn(),
      recordOrderAttempt: vi.fn(),
      recordFill: vi.fn(),
      recordDelayedAck: vi.fn()
    };
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'DELAYED', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      metrics: metrics as never,
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 500, fillTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_delayed');
    expect(metrics.recordDelayedAck).toHaveBeenCalledWith('market-1', expect.any(Number));
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      2,
      'order_delayed',
      'order_delayed',
      expect.objectContaining({
        yesOrder: expect.objectContaining({ status: 'DELAYED', orderID: 'yes-order-1' })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('fails paired execution when acknowledgement skew exceeds policy', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_050)
      .mockReturnValueOnce(1_220);

    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'leg_skew_exceeded',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 500, fillTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('leg_skew_exceeded');
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      1_220,
      2,
      'leg_skew_exceeded',
      'latency_exceeded',
      expect.objectContaining({ legSkewMs: 170, maxLegSkewMs: 100 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('fails paired execution when user-channel confirmation lacks an order id', async () => {
    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_failed',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_failed');
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      2,
      'order_failed',
      'order_failed',
      expect.objectContaining({ yesOrderId: undefined, noOrderId: 'no-order-1' }),
      expect.anything(),
      expect.anything()
    );
  });

  it('routes single-leg fills through partial-fill recovery', async () => {
    const handleObservedPartialFill = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_failed',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: 'yes-order-1',
          sizeMatched: 1.5,
          fullyFilled: false,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_320
        })
        .mockResolvedValueOnce({
          orderId: 'no-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_321
        }),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure: vi.fn(),
      handleObservedPartialFill
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 1_000, fillTimeoutMs: 50 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_failed');
    expect(handleObservedPartialFill).toHaveBeenCalledWith(
      expect.anything(),
      1_321,
      'yes',
      1.5,
      'order_failed',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('completes both paired legs when user-channel confirmation is not required', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_300);

    const saveIdempotencyRecord = vi.fn();
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      metrics: {
        recordLatency: vi.fn(),
        recordOrderAttempt: vi.fn(),
        recordFill: vi.fn()
      } as never,
      portfolio: { expectFill: vi.fn() } as never,
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord,
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure: vi.fn(),
      handleObservedPartialFill: vi.fn()
    });
    const trackedOrderIds: string[] = [];

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds,
      requiresUserChannel: false
    });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      yesOrder: { orderID: 'yes-order-1' },
      noOrder: { orderID: 'no-order-1' }
    });
    expect(trackedOrderIds).toEqual(['yes-order-1', 'no-order-1']);
    expect(saveIdempotencyRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'pair-no',
      status: 'confirmed',
      orderId: 'no-order-1'
    }));
  });

  it('fails paired execution when acknowledgement latency exceeds the ack timeout', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_040)
      .mockReturnValueOnce(1_080);

    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_timeout',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 30, fillTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_timeout');
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      1_080,
      2,
      'order_timeout',
      'order_timeout',
      expect.objectContaining({ phase: 'ack', ackLatencyMs: 80, ackTimeoutMs: 30 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('confirms both paired legs through the user channel path', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_301)
      .mockReturnValueOnce(1_305)
      .mockReturnValueOnce(1_306)
      .mockReturnValueOnce(1_306);

    const metrics = {
      recordLatency: vi.fn(),
      recordOrderAttempt: vi.fn(),
      recordFill: vi.fn()
    };
    const saveIdempotencyRecord = vi.fn();
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      metrics: metrics as never,
      portfolio: { expectFill: vi.fn() } as never,
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: 'yes-order-1',
          sizeMatched: 2,
          fullyFilled: true,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_320
        })
        .mockResolvedValueOnce({
          orderId: 'no-order-1',
          sizeMatched: 2,
          fullyFilled: true,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_322
        }),
      saveIdempotencyRecord,
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure: vi.fn(),
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 50 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete',
      yesOrder: { orderID: 'yes-order-1' },
      noOrder: { orderID: 'no-order-1' }
    });
    expect(metrics.recordFill).toHaveBeenCalledTimes(2);
    expect(saveIdempotencyRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'pair-no',
      status: 'confirmed',
      orderId: 'no-order-1',
      updatedAt: 1_322
    }));
  }, 15000);

  it('routes no-fill paired timeouts through failure handling', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_301)
      .mockReturnValueOnce(1_305)
      .mockReturnValueOnce(1_306)
      .mockReturnValueOnce(1_306);

    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_timeout',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: 'yes-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: false,
          timedOut: true,
          observedAtMs: 1_320
        })
        .mockResolvedValueOnce({
          orderId: 'no-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_321
        }),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 50 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_timeout');
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      1_321,
      2,
      'order_timeout',
      'order_timeout',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  }, 15000);

  it('routes non-timeout paired no-fill outcomes through failure handling', async () => {
    const handleFailure = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_failed',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: 'yes-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: true,
          timedOut: false,
          observedAtMs: 1_320
        })
        .mockResolvedValueOnce({
          orderId: 'no-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: true,
          timedOut: false,
          observedAtMs: 1_321
        }),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure,
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 50 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_failed');
    expect(handleFailure).toHaveBeenCalledWith(
      expect.anything(),
      1_321,
      2,
      'order_failed',
      'order_failed',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('routes no-leg partial fills through partial-fill recovery', async () => {
    const handleObservedPartialFill = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'order_timeout',
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      state: 'failed'
    });
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          orderId: 'yes-order-1',
          sizeMatched: 0,
          fullyFilled: false,
          cancelled: false,
          timedOut: false,
          observedAtMs: 1_320
        })
        .mockResolvedValueOnce({
          orderId: 'no-order-1',
          sizeMatched: 1.5,
          fullyFilled: false,
          cancelled: false,
          timedOut: true,
          observedAtMs: 1_321
        }),
      saveIdempotencyRecord: vi.fn(),
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure: vi.fn(),
      handleObservedPartialFill
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 20, fillTimeoutMs: 50 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result.reason).toBe('order_timeout');
    expect(handleObservedPartialFill).toHaveBeenCalledWith(
      expect.anything(),
      1_321,
      'no',
      1.5,
      'order_timeout',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('falls through to immediate paired completion when user confirmation time is exhausted', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_010)
      .mockReturnValueOnce(1_050);

    const metrics = {
      recordLatency: vi.fn(),
      recordOrderAttempt: vi.fn(),
      recordFill: vi.fn()
    };
    const saveIdempotencyRecord = vi.fn();
    const runner = new ExecutionPairedRunner({
      clob: {
        createOrder: vi
          .fn()
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'yes-order-1' })
          .mockResolvedValueOnce({ success: true, status: 'LIVE', orderID: 'no-order-1' })
      } as never,
      policy: { maxLegSkewMs: 100 },
      metrics: metrics as never,
      transition: (current, event) => transitionExecutionState(current, event as never),
      waitForFillOutcome: vi.fn(),
      saveIdempotencyRecord,
      withTimeout,
      isTimeoutError: () => false,
      coerceNonceValue: (nonce) => Number(nonce),
      extractOrderId: (order) => order?.orderID,
      handleFailure: vi.fn(),
      handleObservedPartialFill: vi.fn()
    });

    const result = await runner.execute({
      opportunity: makeOpportunity(),
      size: 2,
      nowMs: 1_300,
      timeouts: { submitTimeoutMs: 20, ackTimeoutMs: 100, fillTimeoutMs: 10 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      yesRecord: makeRecord('pair-yes', '31'),
      noRecord: makeRecord('pair-no', '32'),
      trackedOrderIds: [],
      requiresUserChannel: true
    });

    expect(result).toMatchObject({
      status: 'submitted',
      state: 'complete'
    });
    expect(metrics.recordFill).toHaveBeenCalledTimes(2);
    expect(saveIdempotencyRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'pair-no',
      status: 'confirmed'
    }));
  });
});

describe('ExecutionFailureRecovery', () => {
  it('cancels both legs and marks the execution failed when neither leg filled', async () => {
    const markIdempotencyFailed = vi.fn();
    const incidentTracker = { record: vi.fn() };
    let state = createInitialExecutionState({
      id: 'pair-exec',
      opportunityId: 'opp-1',
      marketId: 'market-1',
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
      size: 2,
      yesPrice: 0.48,
      noPrice: 0.49,
      createdAtMs: 1
    });
    state = transitionExecutionState(state, { type: 'SUBMIT_STARTED', atMs: 2 });
    state = transitionExecutionState(state, { type: 'SUBMIT_YES', atMs: 2 });
    state = transitionExecutionState(state, { type: 'SUBMIT_NO', atMs: 2 });
    state = transitionExecutionState(state, { type: 'ACK_YES', atMs: 3, order: { orderID: 'yes-order-1' } });
    state = transitionExecutionState(state, { type: 'ACK_NO', atMs: 3, order: { orderID: 'no-order-1' } });

    const recovery = new ExecutionFailureRecovery({
      clob: {
        cancelOrder: vi.fn().mockResolvedValue({ canceled: ['yes-order-1'], not_canceled: {} }),
        cancelMarketOrders: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
        createOrder: vi.fn()
      } as never,
      incidentTracker: incidentTracker as never,
      opportunity: makeOpportunity(),
      timeouts: { submitTimeoutMs: 20, cancelTimeoutMs: 20 },
      idempotencyKey: 'pair-key',
      executionId: 'pair-exec',
      yesIdempotencyKey: 'pair-yes',
      noIdempotencyKey: 'pair-no',
      markIdempotencyFailed,
      resolveUnwindTickSize: vi.fn(),
      calculateUnwindPrice: vi.fn(),
      recordUnwindPortfolio: vi.fn(),
      transition: (current, event) => transitionExecutionState(current, event),
      withTimeout,
      extractOrderId: (order) => order?.orderID,
      isOrderSuccessful,
      isCancelFailure,
      formatCancelError: (error) => String(error)
    });

    const result = await recovery.handleFailure(
      state,
      4,
      2,
      'order_rejected',
      'order_rejected',
      { phase: 'submit' },
      { success: false, status: 'rejected', orderID: 'yes-order-1' },
      { success: false, status: 'rejected', orderID: 'no-order-1' }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'order_rejected',
      state: 'failed'
    });
    expect(markIdempotencyFailed).toHaveBeenCalledWith('pair-yes', 4);
    expect(markIdempotencyFailed).toHaveBeenCalledWith('pair-no', 4);
    expect(incidentTracker.record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'order_rejected',
      detail: expect.objectContaining({ cancelTimeoutMs: 20 })
    }));
  });
});
