import { describe, it, expect } from 'vitest';

import {
  createInitialBasketExecutionState,
  createInitialExecutionState,
  transitionExecutionState,
  transitionBasketExecutionState,
  getRequiredAction,
  type ExecutionState,
  type ExecutionAction,
  type ExecutionEvent,
  type PairedExecutionState
} from '../../src/domain/execution.js';
import type { OrderResponse } from '../../src/domain/types.js';

const BASE_INPUT = {
  id: 'exec-1',
  opportunityId: 'opp-1',
  marketId: 'market-1',
  yesTokenId: 'yes-token',
  noTokenId: 'no-token',
  size: 10,
  yesPrice: 0.48,
  noPrice: 0.49,
  createdAtMs: 1000
};

const ORDER: OrderResponse = { orderID: 'order-1', status: 'LIVE' };

function applyEvents(
  state: PairedExecutionState,
  events: ExecutionEvent[]
): PairedExecutionState {
  return events.reduce((current, event) => transitionExecutionState(current, event), state);
}

describe('execution state machine', () => {
  it('creates an initial state', () => {
    const state = createInitialExecutionState(BASE_INPUT);

    expect(state.state).toBe('idle');
    expect(state.createdAtMs).toBe(BASE_INPUT.createdAtMs);
    expect(state.lastUpdatedMs).toBe(BASE_INPUT.createdAtMs);
    expect(state.yesSubmitted).toBe(false);
    expect(state.noSubmitted).toBe(false);
    expect(state.yesAcked).toBe(false);
    expect(state.noAcked).toBe(false);
    expect(state.yesFilled).toBe(false);
    expect(state.noFilled).toBe(false);
  });

  it('transitions through submit -> ack -> fill happy path', () => {
    const initial = createInitialExecutionState(BASE_INPUT);

    const submitting = transitionExecutionState(initial, { type: 'SUBMIT_STARTED', atMs: 1100 });
    expect(submitting.state).toBe('submitting');

    const yesPending = transitionExecutionState(submitting, { type: 'SUBMIT_YES', atMs: 1101 });
    expect(yesPending.state).toBe('yes_pending');

    const bothPending = transitionExecutionState(yesPending, { type: 'SUBMIT_NO', atMs: 1102 });
    expect(bothPending.state).toBe('both_pending');

    const yesAcked = transitionExecutionState(bothPending, {
      type: 'ACK_YES',
      atMs: 1103,
      order: ORDER
    });
    expect(yesAcked.state).toBe('yes_acked');
    expect(yesAcked.yesOrder).toEqual(ORDER);

    const bothAcked = transitionExecutionState(yesAcked, {
      type: 'ACK_NO',
      atMs: 1104,
      order: ORDER
    });
    expect(bothAcked.state).toBe('both_acked');

    const yesFilled = transitionExecutionState(bothAcked, { type: 'FILL_YES', atMs: 1105 });
    expect(yesFilled.state).toBe('yes_filled');

    const bothFilled = transitionExecutionState(yesFilled, { type: 'FILL_NO', atMs: 1106 });
    expect(bothFilled.state).toBe('both_filled');
  });

  it('supports NO-first submission and ACK ordering', () => {
    const initial = createInitialExecutionState(BASE_INPUT);

    const noPending = transitionExecutionState(initial, { type: 'SUBMIT_NO', atMs: 1200 });
    expect(noPending.state).toBe('no_pending');

    const bothPending = transitionExecutionState(noPending, { type: 'SUBMIT_YES', atMs: 1201 });
    expect(bothPending.state).toBe('both_pending');

    const noAcked = transitionExecutionState(bothPending, {
      type: 'ACK_NO',
      atMs: 1202,
      order: ORDER
    });
    expect(noAcked.state).toBe('no_acked');

    const bothAcked = transitionExecutionState(noAcked, {
      type: 'ACK_YES',
      atMs: 1203,
      order: ORDER
    });
    expect(bothAcked.state).toBe('both_acked');
  });

  it('supports NO-first fill ordering', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const state = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1250 },
      { type: 'SUBMIT_YES', atMs: 1251 },
      { type: 'SUBMIT_NO', atMs: 1252 },
      { type: 'ACK_YES', atMs: 1253, order: ORDER },
      { type: 'ACK_NO', atMs: 1254, order: ORDER },
      { type: 'FILL_NO', atMs: 1255 }
    ]);

    expect(state.state).toBe('no_filled');
  });

  it('transitions to both_filled when YES fill arrives after NO fill', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const noFilled = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1260 },
      { type: 'SUBMIT_YES', atMs: 1261 },
      { type: 'SUBMIT_NO', atMs: 1262 },
      { type: 'ACK_YES', atMs: 1263, order: ORDER },
      { type: 'ACK_NO', atMs: 1264, order: ORDER },
      { type: 'FILL_NO', atMs: 1265 }
    ]);

    const bothFilled = transitionExecutionState(noFilled, { type: 'FILL_YES', atMs: 1266 });
    expect(bothFilled.state).toBe('both_filled');
  });

  it('handles partial fill and unwind completion', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const state = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1300 },
      { type: 'SUBMIT_YES', atMs: 1301 },
      { type: 'SUBMIT_NO', atMs: 1302 },
      { type: 'ACK_YES', atMs: 1303, order: ORDER },
      { type: 'ACK_NO', atMs: 1304, order: ORDER },
      { type: 'PARTIAL_FILL', atMs: 1305 },
      { type: 'START_UNWIND', atMs: 1306 },
      { type: 'UNWIND_COMPLETE', atMs: 1307 }
    ]);

    expect(state.state).toBe('unwind_complete');

    const completed = transitionExecutionState(state, { type: 'COMPLETE', atMs: 1308 });
    expect(completed.state).toBe('complete');
  });

  it('records unwind failure error', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const state = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1400 },
      { type: 'SUBMIT_YES', atMs: 1401 },
      { type: 'SUBMIT_NO', atMs: 1402 },
      { type: 'ACK_YES', atMs: 1403, order: ORDER },
      { type: 'ACK_NO', atMs: 1404, order: ORDER },
      { type: 'PARTIAL_FILL', atMs: 1405 },
      { type: 'START_UNWIND', atMs: 1406 },
      { type: 'UNWIND_FAILED', atMs: 1407, error: 'no-liquidity' }
    ]);

    expect(state.state).toBe('unwind_failed');
    expect(state.error).toBe('no-liquidity');
  });

  it('defaults unwind failure error when reason is missing', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const state = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1450 },
      { type: 'SUBMIT_YES', atMs: 1451 },
      { type: 'SUBMIT_NO', atMs: 1452 },
      { type: 'ACK_YES', atMs: 1453, order: ORDER },
      { type: 'ACK_NO', atMs: 1454, order: ORDER },
      { type: 'PARTIAL_FILL', atMs: 1455 },
      { type: 'START_UNWIND', atMs: 1456 },
      { type: 'UNWIND_FAILED', atMs: 1457 }
    ]);

    expect(state.state).toBe('unwind_failed');
    expect(state.error).toBe('unwind_failed');
  });

  it('handles cancellation flow', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const state = applyEvents(initial, [
      { type: 'SUBMIT_STARTED', atMs: 1500 },
      { type: 'SUBMIT_YES', atMs: 1501 },
      { type: 'ACK_YES', atMs: 1502, order: ORDER },
      { type: 'CANCEL_STARTED', atMs: 1503 },
      { type: 'CANCELLED', atMs: 1504 }
    ]);

    expect(state.state).toBe('cancelled');

    const completed = transitionExecutionState(state, { type: 'COMPLETE', atMs: 1505 });
    expect(completed.state).toBe('complete');
  });

  it('handles failure and timeout events', () => {
    const initial = createInitialExecutionState(BASE_INPUT);

    const submitting = transitionExecutionState(initial, { type: 'SUBMIT_STARTED', atMs: 1600 });
    const failed = transitionExecutionState(submitting, {
      type: 'FAILED',
      atMs: 1601,
      reason: 'submission_failed'
    });
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('submission_failed');

    const timeoutSource = createInitialExecutionState(BASE_INPUT);
    const yesPending = transitionExecutionState(timeoutSource, { type: 'SUBMIT_YES', atMs: 1602 });
    const timedOut = transitionExecutionState(yesPending, {
      type: 'TIMEOUT',
      atMs: 1603,
      phase: 'ack'
    });
    expect(timedOut.state).toBe('timeout');
    expect(timedOut.error).toBe('ack');
  });

  it('defaults timeout phase when missing', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    const yesPending = transitionExecutionState(initial, { type: 'SUBMIT_YES', atMs: 1604 });
    const timedOut = transitionExecutionState(yesPending, {
      type: 'TIMEOUT',
      atMs: 1605
    });

    expect(timedOut.state).toBe('timeout');
    expect(timedOut.error).toBe('timeout');
  });

  it('rejects invalid transitions and terminal states', () => {
    const initial = createInitialExecutionState(BASE_INPUT);

    expect(() =>
      transitionExecutionState(initial, {
        type: 'ACK_YES',
        atMs: 1700,
        order: ORDER
      })
    ).toThrow('Invalid transition: idle -> ACK_YES');

    const terminal: PairedExecutionState = {
      ...initial,
      state: 'complete'
    };

    expect(() =>
      transitionExecutionState(terminal, { type: 'SUBMIT_STARTED', atMs: 1701 })
    ).toThrow('Invalid transition from terminal state: complete');
  });

  it('throws on unknown execution event types', () => {
    const initial = createInitialExecutionState(BASE_INPUT);
    expect(() =>
      transitionExecutionState(initial, { type: 'UNKNOWN', atMs: 1702 } as unknown as ExecutionEvent)
    ).toThrow('Unknown execution event');
  });

  it('uses unknown fallback when event type is absent', () => {
    const initial = createInitialExecutionState(BASE_INPUT);

    expect(() =>
      transitionExecutionState(initial, { atMs: 1703 } as unknown as ExecutionEvent)
    ).toThrow('Unknown execution event: unknown');
  });

  it('returns required actions for each state', () => {
    const cases: Array<[ExecutionState, ExecutionAction]> = [
      ['idle', 'submit'],
      ['submitting', 'await_ack'],
      ['yes_pending', 'await_ack'],
      ['no_pending', 'await_ack'],
      ['both_pending', 'await_ack'],
      ['yes_acked', 'await_fill'],
      ['no_acked', 'await_fill'],
      ['both_acked', 'await_fill'],
      ['yes_filled', 'await_fill'],
      ['no_filled', 'await_fill'],
      ['both_filled', 'finalize'],
      ['partial_fill', 'unwind'],
      ['unwinding', 'unwind'],
      ['unwind_complete', 'finalize'],
      ['unwind_failed', 'finalize'],
      ['cancelling', 'cancel'],
      ['cancelled', 'finalize'],
      ['failed', 'none'],
      ['timeout', 'none'],
      ['complete', 'none']
    ];

    for (const [state, action] of cases) {
      expect(getRequiredAction(state)).toBe(action);
    }
  });

  it('falls back to none for unknown states', () => {
    expect(getRequiredAction('bogus' as unknown as ExecutionState)).toBe('none');
  });
});

describe('basket execution state machine', () => {
  it('initializes basket state with pending legs', () => {
    const state = createInitialBasketExecutionState({
      id: 'basket-exec-1',
      opportunityId: 'opp-basket-1',
      createdAtMs: 2000,
      markets: [
        { marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1', idempotencyKey: 'k1' },
        { marketId: 'm2', yesTokenId: 'yes-2', noTokenId: 'no-2', idempotencyKey: 'k2' }
      ]
    });

    expect(state.state).toBe('submitted');
    expect(state.legs).toHaveLength(2);
    expect(state.legs.every((leg) => leg.state === 'pending')).toBe(true);
  });

  it('transitions leg lifecycle and completes', () => {
    const initial = createInitialBasketExecutionState({
      id: 'basket-exec-2',
      opportunityId: 'opp-basket-2',
      createdAtMs: 2100,
      markets: [{ marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1' }]
    });

    const submitted = transitionBasketExecutionState(initial, {
      type: 'LEG_SUBMITTED',
      atMs: 2101,
      marketId: 'm1'
    });
    expect(submitted.legs[0]?.state).toBe('submitted');

    const acked = transitionBasketExecutionState(submitted, {
      type: 'LEG_ACKED',
      atMs: 2102,
      marketId: 'm1'
    });
    expect(acked.legs[0]?.state).toBe('acked');

    const filled = transitionBasketExecutionState(acked, {
      type: 'LEG_FILLED',
      atMs: 2103,
      marketId: 'm1'
    });
    expect(filled.legs[0]?.state).toBe('filled');

    const complete = transitionBasketExecutionState(filled, { type: 'COMPLETE', atMs: 2104 });
    expect(complete.state).toBe('complete');
  });

  it('handles partial-fill unwind failure path', () => {
    const initial = createInitialBasketExecutionState({
      id: 'basket-exec-3',
      opportunityId: 'opp-basket-3',
      createdAtMs: 2200,
      markets: [{ marketId: 'm1', yesTokenId: 'yes-1', noTokenId: 'no-1' }]
    });

    const partial = transitionBasketExecutionState(initial, {
      type: 'PARTIAL_FILL',
      atMs: 2201,
      reason: 'partial_fill'
    });
    expect(partial.state).toBe('partial_fill');

    const unwinding = transitionBasketExecutionState(partial, { type: 'START_UNWIND', atMs: 2202 });
    expect(unwinding.state).toBe('unwinding');

    const failed = transitionBasketExecutionState(unwinding, {
      type: 'UNWIND_FAILED',
      atMs: 2203,
      reason: 'unwind_failed'
    });
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('unwind_failed');
  });
});
