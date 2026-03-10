import type { OrderPlacement, OrderResponse } from './types.js';
export {
  createInitialBasketExecutionState,
  transitionBasketExecutionState
} from './basketExecution.js';
export type { BasketExecutionLegState } from './basketExecution.js';

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

interface InitialExecutionInput {
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
const SUBMIT_PENDING_STATES: ExecutionState[] = [
  'idle',
  'submitting',
  'yes_pending',
  'no_pending',
  'both_pending'
];
const ACK_STATES: ExecutionState[] = [
  'yes_pending',
  'no_pending',
  'both_pending',
  'yes_acked',
  'no_acked',
  'both_acked'
];
const FILL_STATES: ExecutionState[] = [
  'yes_pending',
  'no_pending',
  'both_pending',
  'yes_acked',
  'no_acked',
  'both_acked',
  'yes_filled',
  'no_filled'
];
const CANCELLABLE_STATES: ExecutionState[] = [
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
];
const FAILABLE_STATES: ExecutionState[] = [
  ...CANCELLABLE_STATES,
  'unwinding',
  'cancelling'
];
const FINALIZE_STATES: ExecutionState[] = ['both_filled', 'unwind_complete', 'cancelled'];
const AWAIT_ACK_STATES = new Set<ExecutionState>([
  'submitting',
  'yes_pending',
  'no_pending',
  'both_pending'
]);
const AWAIT_FILL_STATES = new Set<ExecutionState>([
  'yes_acked',
  'no_acked',
  'both_acked',
  'yes_filled',
  'no_filled'
]);
const UNWIND_STATES = new Set<ExecutionState>(['partial_fill', 'unwinding']);
const FINALIZE_ACTION_STATES = new Set<ExecutionState>([
  'both_filled',
  'unwind_complete',
  'unwind_failed',
  'cancelled'
]);
const NO_ACTION_STATES = new Set<ExecutionState>(['failed', 'timeout', 'complete']);

type TransitionEvent = ExecutionEvent['type'];
type TypedExecutionEvent<K extends TransitionEvent> = Extract<ExecutionEvent, { type: K }>;
type ExecutionTransitionHandler<K extends TransitionEvent> = {
  allowedStates: ExecutionState[];
  apply: (next: PairedExecutionState, event: TypedExecutionEvent<K>) => void;
};
type ExecutionTransitionHandlers = {
  [K in TransitionEvent]: ExecutionTransitionHandler<K>;
};

const EXECUTION_TRANSITIONS: ExecutionTransitionHandlers = {
  SUBMIT_STARTED: {
    allowedStates: ['idle'],
    apply: (next) => {
      next.state = 'submitting';
    }
  },
  SUBMIT_YES: {
    allowedStates: SUBMIT_PENDING_STATES,
    apply: (next) => {
      next.yesSubmitted = true;
      next.state = next.noSubmitted ? 'both_pending' : 'yes_pending';
    }
  },
  SUBMIT_NO: {
    allowedStates: SUBMIT_PENDING_STATES,
    apply: (next) => {
      next.noSubmitted = true;
      next.state = next.yesSubmitted ? 'both_pending' : 'no_pending';
    }
  },
  ACK_YES: {
    allowedStates: ACK_STATES,
    apply: (next, event) => {
      next.yesAcked = true;
      next.yesOrder = event.order;
      next.state = next.noAcked ? 'both_acked' : 'yes_acked';
    }
  },
  ACK_NO: {
    allowedStates: ACK_STATES,
    apply: (next, event) => {
      next.noAcked = true;
      next.noOrder = event.order;
      next.state = next.yesAcked ? 'both_acked' : 'no_acked';
    }
  },
  FILL_YES: {
    allowedStates: FILL_STATES,
    apply: (next) => {
      next.yesFilled = true;
      next.state = next.noFilled ? 'both_filled' : 'yes_filled';
    }
  },
  FILL_NO: {
    allowedStates: FILL_STATES,
    apply: (next) => {
      next.noFilled = true;
      next.state = next.yesFilled ? 'both_filled' : 'no_filled';
    }
  },
  PARTIAL_FILL: {
    allowedStates: ['yes_filled', 'no_filled', 'both_acked'],
    apply: (next) => {
      next.state = 'partial_fill';
    }
  },
  START_UNWIND: {
    allowedStates: ['partial_fill'],
    apply: (next) => {
      next.state = 'unwinding';
    }
  },
  UNWIND_COMPLETE: {
    allowedStates: ['unwinding'],
    apply: (next) => {
      next.state = 'unwind_complete';
    }
  },
  UNWIND_FAILED: {
    allowedStates: ['unwinding'],
    apply: (next, event) => {
      next.state = 'unwind_failed';
      next.error = event.error ?? 'unwind_failed';
    }
  },
  CANCEL_STARTED: {
    allowedStates: CANCELLABLE_STATES,
    apply: (next) => {
      next.state = 'cancelling';
    }
  },
  CANCELLED: {
    allowedStates: ['cancelling'],
    apply: (next) => {
      next.state = 'cancelled';
    }
  },
  FAILED: {
    allowedStates: FAILABLE_STATES,
    apply: (next, event) => {
      next.state = 'failed';
      next.error = event.reason;
    }
  },
  TIMEOUT: {
    allowedStates: FAILABLE_STATES,
    apply: (next, event) => {
      next.state = 'timeout';
      next.error = event.phase ?? 'timeout';
    }
  },
  COMPLETE: {
    allowedStates: FINALIZE_STATES,
    apply: (next) => {
      next.state = 'complete';
    }
  }
};

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
  const handler = EXECUTION_TRANSITIONS[event.type];
  if (!handler) {
    throw new Error(`Unknown execution event: ${(event as { type?: unknown }).type ?? 'unknown'}`);
  }
  assertTransition(current.state, event.type, handler.allowedStates);
  handler.apply(next, event as never);
  return next;
}

export function getRequiredAction(state: ExecutionState): ExecutionAction {
  if (state === 'idle') return 'submit';
  if (AWAIT_ACK_STATES.has(state)) return 'await_ack';
  if (AWAIT_FILL_STATES.has(state)) return 'await_fill';
  if (UNWIND_STATES.has(state)) return 'unwind';
  if (state === 'cancelling') return 'cancel';
  if (FINALIZE_ACTION_STATES.has(state)) return 'finalize';
  if (NO_ACTION_STATES.has(state)) return 'none';
  return 'none';
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
