import type { OrderPlacement, OrderResponse } from './types.js';

/**
 * ExecutionState describes the lifecycle of a paired YES/NO arbitrage execution.
 */
export type ExecutionState =
  /** Awaiting submission of both legs. */
  | 'idle'
  /** Submission in progress. */
  | 'submitting'
  /** Only YES leg submitted, awaiting ACK. */
  | 'yes_pending'
  /** Only NO leg submitted, awaiting ACK. */
  | 'no_pending'
  /** Both legs submitted, awaiting ACKs. */
  | 'both_pending'
  /** YES leg ACKed, awaiting NO ACK. */
  | 'yes_acked'
  /** NO leg ACKed, awaiting YES ACK. */
  | 'no_acked'
  /** Both legs ACKed, awaiting fills. */
  | 'both_acked'
  /** YES leg filled, awaiting NO fill. */
  | 'yes_filled'
  /** NO leg filled, awaiting YES fill. */
  | 'no_filled'
  /** Both legs filled. */
  | 'both_filled'
  /** One leg filled while the other failed/cancelled. */
  | 'partial_fill'
  /** Unwind execution underway. */
  | 'unwinding'
  /** Unwind completed. */
  | 'unwind_complete'
  /** Unwind failed. */
  | 'unwind_failed'
  /** Cancellation in progress. */
  | 'cancelling'
  /** Cancellation complete. */
  | 'cancelled'
  /** Execution failed (non-timeout). */
  | 'failed'
  /** Execution timed out. */
  | 'timeout'
  /** Execution fully complete. */
  | 'complete';

export type ExecutionAction =
  | 'submit'
  | 'await_ack'
  | 'await_fill'
  | 'cancel'
  | 'unwind'
  | 'finalize'
  | 'none';

export interface PairedExecutionState {
  id: string;
  opportunityId: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  size: number;
  yesPrice: number;
  noPrice: number;
  state: ExecutionState;
  createdAtMs: number;
  lastUpdatedMs: number;
  yesSubmitted: boolean;
  noSubmitted: boolean;
  yesAcked: boolean;
  noAcked: boolean;
  yesFilled: boolean;
  noFilled: boolean;
  yesOrder?: OrderResponse;
  noOrder?: OrderResponse;
  error?: string;
}

export interface UnwindResult {
  ok: boolean;
  leg: 'yes' | 'no';
  price: number;
  size: number;
  order?: OrderResponse;
  error?: string;
}

export interface InitialExecutionInput {
  id: string;
  opportunityId: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  size: number;
  yesPrice: number;
  noPrice: number;
  createdAtMs: number;
}

export type ExecutionEvent =
  | { type: 'SUBMIT_STARTED'; atMs: number }
  | { type: 'SUBMIT_YES'; atMs: number }
  | { type: 'SUBMIT_NO'; atMs: number }
  | { type: 'ACK_YES'; atMs: number; order: OrderResponse }
  | { type: 'ACK_NO'; atMs: number; order: OrderResponse }
  | { type: 'FILL_YES'; atMs: number }
  | { type: 'FILL_NO'; atMs: number }
  | { type: 'PARTIAL_FILL'; atMs: number }
  | { type: 'START_UNWIND'; atMs: number }
  | { type: 'UNWIND_COMPLETE'; atMs: number }
  | { type: 'UNWIND_FAILED'; atMs: number; error?: string }
  | { type: 'CANCEL_STARTED'; atMs: number }
  | { type: 'CANCELLED'; atMs: number }
  | { type: 'FAILED'; atMs: number; reason: string }
  | { type: 'TIMEOUT'; atMs: number; phase?: string }
  | { type: 'COMPLETE'; atMs: number };

const TERMINAL_STATES = new Set<ExecutionState>(['failed', 'timeout', 'complete']);

export function createInitialExecutionState(input: InitialExecutionInput): PairedExecutionState {
  return {
    id: input.id,
    opportunityId: input.opportunityId,
    marketId: input.marketId,
    yesTokenId: input.yesTokenId,
    noTokenId: input.noTokenId,
    size: input.size,
    yesPrice: input.yesPrice,
    noPrice: input.noPrice,
    state: 'idle',
    createdAtMs: input.createdAtMs,
    lastUpdatedMs: input.createdAtMs,
    yesSubmitted: false,
    noSubmitted: false,
    yesAcked: false,
    noAcked: false,
    yesFilled: false,
    noFilled: false
  };
}

export function transitionExecutionState(
  current: PairedExecutionState,
  event: ExecutionEvent
): PairedExecutionState {
  if (TERMINAL_STATES.has(current.state)) {
    throw new Error(`Invalid transition from terminal state: ${current.state}`);
  }

  const next: PairedExecutionState = {
    ...current,
    lastUpdatedMs: event.atMs
  };

  switch (event.type) {
    case 'SUBMIT_STARTED':
      assertTransition(current.state, event.type, ['idle']);
      next.state = 'submitting';
      return next;
    case 'SUBMIT_YES':
      assertTransition(current.state, event.type, [
        'idle',
        'submitting',
        'yes_pending',
        'no_pending',
        'both_pending'
      ]);
      next.yesSubmitted = true;
      next.state = next.noSubmitted ? 'both_pending' : 'yes_pending';
      return next;
    case 'SUBMIT_NO':
      assertTransition(current.state, event.type, [
        'idle',
        'submitting',
        'yes_pending',
        'no_pending',
        'both_pending'
      ]);
      next.noSubmitted = true;
      next.state = next.yesSubmitted ? 'both_pending' : 'no_pending';
      return next;
    case 'ACK_YES':
      assertTransition(current.state, event.type, [
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked'
      ]);
      next.yesAcked = true;
      next.yesOrder = event.order;
      next.state = next.noAcked ? 'both_acked' : 'yes_acked';
      return next;
    case 'ACK_NO':
      assertTransition(current.state, event.type, [
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked'
      ]);
      next.noAcked = true;
      next.noOrder = event.order;
      next.state = next.yesAcked ? 'both_acked' : 'no_acked';
      return next;
    case 'FILL_YES':
      assertTransition(current.state, event.type, [
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked',
        'yes_filled',
        'no_filled'
      ]);
      next.yesFilled = true;
      next.state = next.noFilled ? 'both_filled' : 'yes_filled';
      return next;
    case 'FILL_NO':
      assertTransition(current.state, event.type, [
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked',
        'yes_filled',
        'no_filled'
      ]);
      next.noFilled = true;
      next.state = next.yesFilled ? 'both_filled' : 'no_filled';
      return next;
    case 'PARTIAL_FILL':
      assertTransition(current.state, event.type, ['yes_filled', 'no_filled', 'both_acked']);
      next.state = 'partial_fill';
      return next;
    case 'START_UNWIND':
      assertTransition(current.state, event.type, ['partial_fill']);
      next.state = 'unwinding';
      return next;
    case 'UNWIND_COMPLETE':
      assertTransition(current.state, event.type, ['unwinding']);
      next.state = 'unwind_complete';
      return next;
    case 'UNWIND_FAILED':
      assertTransition(current.state, event.type, ['unwinding']);
      next.state = 'unwind_failed';
      next.error = event.error ?? 'unwind_failed';
      return next;
    case 'CANCEL_STARTED':
      assertTransition(current.state, event.type, [
        'submitting',
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked',
        'yes_filled',
        'no_filled',
        'partial_fill'
      ]);
      next.state = 'cancelling';
      return next;
    case 'CANCELLED':
      assertTransition(current.state, event.type, ['cancelling']);
      next.state = 'cancelled';
      return next;
    case 'FAILED':
      assertTransition(current.state, event.type, [
        'submitting',
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked',
        'yes_filled',
        'no_filled',
        'partial_fill',
        'unwinding',
        'cancelling'
      ]);
      next.state = 'failed';
      next.error = event.reason;
      return next;
    case 'TIMEOUT':
      assertTransition(current.state, event.type, [
        'submitting',
        'yes_pending',
        'no_pending',
        'both_pending',
        'yes_acked',
        'no_acked',
        'both_acked',
        'yes_filled',
        'no_filled',
        'partial_fill',
        'unwinding',
        'cancelling'
      ]);
      next.state = 'timeout';
      next.error = event.phase ?? 'timeout';
      return next;
    case 'COMPLETE':
      assertTransition(current.state, event.type, ['both_filled', 'unwind_complete', 'cancelled']);
      next.state = 'complete';
      return next;
    default:
      throw new Error(`Unknown execution event: ${(event as { type?: unknown }).type ?? 'unknown'}`);
  }
}

export function getRequiredAction(state: ExecutionState): ExecutionAction {
  switch (state) {
    case 'idle':
      return 'submit';
    case 'submitting':
    case 'yes_pending':
    case 'no_pending':
    case 'both_pending':
      return 'await_ack';
    case 'yes_acked':
    case 'no_acked':
    case 'both_acked':
    case 'yes_filled':
    case 'no_filled':
      return 'await_fill';
    case 'both_filled':
      return 'finalize';
    case 'partial_fill':
    case 'unwinding':
      return 'unwind';
    case 'cancelling':
      return 'cancel';
    case 'unwind_complete':
    case 'unwind_failed':
    case 'cancelled':
      return 'finalize';
    case 'failed':
    case 'timeout':
    case 'complete':
      return 'none';
    default:
      return 'none';
  }
}

function assertTransition(
  state: ExecutionState,
  eventType: ExecutionEvent['type'],
  allowed: ExecutionState[]
): void {
  if (!allowed.includes(state)) {
    throw new Error(`Invalid transition: ${state} -> ${eventType}`);
  }
}

export function buildFokBuyOrder(input: {
  tokenId: string;
  size: number;
  price: number;
  clientOrderId: string;
}): OrderPlacement {
  return {
    tokenId: input.tokenId,
    side: 'BUY',
    size: input.size,
    price: input.price,
    orderType: 'FOK',
    clientOrderId: input.clientOrderId
  };
}

export function buildFakSellOrder(input: {
  tokenId: string;
  size: number;
  price: number;
  clientOrderId: string;
}): OrderPlacement {
  return {
    tokenId: input.tokenId,
    side: 'SELL',
    size: input.size,
    price: input.price,
    orderType: 'FAK',
    clientOrderId: input.clientOrderId
  };
}

export function toClobOrderPayload(order: OrderPlacement): Record<string, unknown> {
  return {
    token_id: order.tokenId,
    side: order.side,
    size: order.size,
    price: order.price,
    order_type: order.orderType,
    client_order_id: order.clientOrderId
  };
}

export function isDelayedOrderResponse(response: unknown): boolean {
  const payload = response as { status?: string; errorMsg?: string; error?: string };
  const status = payload?.status?.toUpperCase();
  return (
    status === 'DELAYED' ||
    payload?.errorMsg === 'ORDER_DELAYED' ||
    payload?.error === 'ORDER_DELAYED'
  );
}

export function isOrderFailure(response: unknown): boolean {
  const payload = response as { success?: boolean; errorMsg?: string; status?: string };
  if (payload?.success === false) return true;
  if (payload?.errorMsg && payload.errorMsg.length > 0) return true;
  return payload?.status === 'rejected';
}

export function coerceOrderResponse(response: unknown): OrderResponse {
  return response as OrderResponse;
}
