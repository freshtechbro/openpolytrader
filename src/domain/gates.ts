import type { TradePolicy } from '../config/policy.js';
import type { OrderBookState } from './orderbook.js';
import { depthAtTopLevels, isAlignedToTick, spread } from './orderbook.js';
import type { VenueId } from '../config/venues.js';
import type { FeeModel } from './feeModel.js';

export interface GateDecision {
  passed: boolean;
  reasons: string[];
  costPerSet: number;
  edge: number;
  maxSizeByDepth: number;
}

export interface GateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  desiredSize?: number;
}

export function evaluateGates(inputs: GateInputs): GateDecision {
  const { yesBook, noBook, policy, nowMs, desiredSize } = inputs;
  const reasons: string[] = [];

  if (!yesBook.bestAsk || !noBook.bestAsk) {
    reasons.push('missing_best_ask');
    return fail(reasons);
  }

  const yesSpread = spread(yesBook);
  const noSpread = spread(noBook);

  if (yesSpread === null || noSpread === null) {
    reasons.push('missing_spread');
  } else {
    if (yesSpread > policy.maxSpread) reasons.push('yes_spread_too_wide');
    if (noSpread > policy.maxSpread) reasons.push('no_spread_too_wide');
  }

  const costPerSet = yesBook.bestAsk.price + noBook.bestAsk.price;
  const edge = 1 - costPerSet;

  if (edge < policy.edgeRequired) {
    reasons.push('edge_below_threshold');
  }

  if (edge > policy.maxEdge) {
    reasons.push('edge_above_max');
  }

  const yesFresh = nowMs - yesBook.lastUpdateMs <= policy.orderbookFreshnessMs;
  const noFresh = nowMs - noBook.lastUpdateMs <= policy.orderbookFreshnessMs;
  if (!yesFresh || !noFresh) {
    reasons.push('stale_orderbook');
  }

  const yesStable = nowMs - yesBook.stableSinceMs >= policy.topOfBookStabilityMs;
  const noStable = nowMs - noBook.stableSinceMs >= policy.topOfBookStabilityMs;
  if (!yesStable || !noStable) {
    reasons.push('unstable_top_of_book');
  }

  if (!isAlignedToTick(yesBook.bestAsk.price, yesBook.tickSize)) {
    reasons.push('yes_tick_misaligned');
  }
  if (!isAlignedToTick(noBook.bestAsk.price, noBook.tickSize)) {
    reasons.push('no_tick_misaligned');
  }

  const yesDepth = depthAtTopLevels(yesBook.asks, 3);
  const noDepth = depthAtTopLevels(noBook.asks, 3);
  const maxSizeByDepth = Math.min(yesDepth, noDepth) * policy.depthHeadroomFraction;

  if (maxSizeByDepth <= 0) {
    reasons.push('insufficient_depth');
  }

  const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);
  if (maxSizeByDepth < minOrderSize) {
    reasons.push('below_min_order_size');
  }

  if (desiredSize !== undefined && desiredSize > maxSizeByDepth) {
    reasons.push('desired_size_exceeds_depth');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    costPerSet,
    edge,
    maxSizeByDepth
  };
}

export function evaluateGatesWithFees(input: GateInputs & { venue: VenueId; feeModel: FeeModel }): GateDecision {
  const base = evaluateGates(input);
  if (base.reasons.length > 0) return base;

  const netEdge = input.feeModel.netEdge(input.venue, base.edge);
  const reasons = [...base.reasons];

  if (netEdge < input.policy.edgeRequired) {
    reasons.push('edge_below_threshold_after_fees');
  }

  if (netEdge > input.policy.maxEdge) {
    reasons.push('edge_above_max_after_fees');
  }

  return {
    ...base,
    edge: netEdge,
    reasons,
    passed: reasons.length === 0
  };
}

function fail(reasons: string[]): GateDecision {
  return {
    passed: false,
    reasons,
    costPerSet: 0,
    edge: 0,
    maxSizeByDepth: 0
  };
}
