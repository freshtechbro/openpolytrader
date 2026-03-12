export interface BasketExecutionLegState {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  state: 'pending' | 'submitted' | 'acked' | 'filled' | 'failed' | 'cancelled' | 'blocked';
  executionId?: string;
  idempotencyKey?: string;
  reason?: string;
}

type BasketExecutionState =
  | 'submitted'
  | 'failed'
  | 'partial_fill'
  | 'unwinding'
  | 'complete';

interface BasketExecutionTrackingState {
  id: string;
  opportunityId: string;
  state: BasketExecutionState;
  legs: BasketExecutionLegState[];
  createdAtMs: number;
  lastUpdatedMs: number;
  error?: string;
}

type BasketExecutionEvent =
  | { type: 'LEG_SUBMITTED'; atMs: number; marketId: string }
  | { type: 'LEG_ACKED'; atMs: number; marketId: string }
  | { type: 'LEG_FILLED'; atMs: number; marketId: string }
  | { type: 'LEG_FAILED'; atMs: number; marketId: string; reason?: string }
  | { type: 'LEG_CANCELLED'; atMs: number; marketId: string; reason?: string }
  | { type: 'PARTIAL_FILL'; atMs: number; reason?: string }
  | { type: 'START_UNWIND'; atMs: number }
  | { type: 'UNWIND_COMPLETE'; atMs: number }
  | { type: 'UNWIND_FAILED'; atMs: number; reason?: string }
  | { type: 'FAILED'; atMs: number; reason?: string }
  | { type: 'COMPLETE'; atMs: number };

export function createInitialBasketExecutionState(input: {
  id: string;
  opportunityId: string;
  markets: Array<{ marketId: string; yesTokenId: string; noTokenId: string; idempotencyKey?: string }>;
  createdAtMs: number;
}): BasketExecutionTrackingState {
  return {
    id: input.id,
    opportunityId: input.opportunityId,
    state: 'submitted',
    createdAtMs: input.createdAtMs,
    lastUpdatedMs: input.createdAtMs,
    legs: input.markets.map((market) => ({
      marketId: market.marketId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      idempotencyKey: market.idempotencyKey,
      state: 'pending'
    }))
  };
}

export function transitionBasketExecutionState(
  current: BasketExecutionTrackingState,
  event: BasketExecutionEvent
): BasketExecutionTrackingState {
  const next: BasketExecutionTrackingState = {
    ...current,
    legs: current.legs.slice(),
    lastUpdatedMs: event.atMs
  };

  switch (event.type) {
    case 'LEG_SUBMITTED':
      next.legs = setLegState(next.legs, event.marketId, 'submitted');
      return next;
    case 'LEG_ACKED':
      next.legs = setLegState(next.legs, event.marketId, 'acked');
      return next;
    case 'LEG_FILLED':
      next.legs = setLegState(next.legs, event.marketId, 'filled');
      return next;
    case 'LEG_FAILED':
      next.legs = setLegState(next.legs, event.marketId, 'failed', event.reason);
      next.state = 'failed';
      next.error = event.reason ?? 'leg_failed';
      return next;
    case 'LEG_CANCELLED':
      next.legs = setLegState(next.legs, event.marketId, 'cancelled', event.reason);
      return next;
    case 'PARTIAL_FILL':
      next.state = 'partial_fill';
      next.error = event.reason;
      return next;
    case 'START_UNWIND':
      next.state = 'unwinding';
      return next;
    case 'UNWIND_COMPLETE':
      next.state = 'complete';
      next.error = undefined;
      return next;
    case 'UNWIND_FAILED':
      next.state = 'failed';
      next.error = event.reason ?? 'unwind_failed';
      return next;
    case 'FAILED':
      next.state = 'failed';
      next.error = event.reason ?? 'basket_failed';
      return next;
    case 'COMPLETE':
      next.state = 'complete';
      next.error = undefined;
      return next;
  }
}

function setLegState(
  legs: BasketExecutionLegState[],
  marketId: string,
  state: BasketExecutionLegState['state'],
  reason?: string
): BasketExecutionLegState[] {
  return legs.map((leg) => {
    if (leg.marketId !== marketId) return leg;
    return {
      ...leg,
      state,
      reason: reason ?? leg.reason
    };
  });
}
