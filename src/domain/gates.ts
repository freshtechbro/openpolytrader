import type { TradePolicy } from '../config/policy.js';
import type { OrderBookState } from './orderbook.js';
import { depthAtTopLevels, isAlignedToTick, spread, sweepCost } from './orderbook.js';
import type { VenueId } from '../config/venues.js';
import type { FeeModel } from './feeModel.js';

export interface GateDecision {
  passed: boolean;
  reasons: string[];
  costPerSet: number;
  edge: number;
  edgeInTicks?: number;
  maxSizeByDepth: number;
  yesStalenessMs?: number;
  noStalenessMs?: number;
  legSkewMs?: number;
  depthAtLevels?: { yes: number; no: number };
}

export interface GateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  desiredSize?: number;
  tickSize?: number;
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

  const yesStalenessMs = Math.max(0, nowMs - yesBook.lastUpdateMs);
  const noStalenessMs = Math.max(0, nowMs - noBook.lastUpdateMs);
  const maxStaleness = policy.maxBookStalenessMs ?? policy.orderbookFreshnessMs;
  if (policy.requireFreshBook !== false) {
    if (yesStalenessMs > maxStaleness) reasons.push('yes_book_stale');
    if (noStalenessMs > maxStaleness) reasons.push('no_book_stale');
  }

  const legSkewMs = Math.abs(yesBook.lastUpdateMs - noBook.lastUpdateMs);
  if (policy.maxLegSkewMs > 0 && legSkewMs > policy.maxLegSkewMs) {
    reasons.push('leg_sync_skew');
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

  const depthLevels = Math.max(1, Math.floor(policy.minDepthLevels));
  const yesDepth = depthAtTopLevels(yesBook.asks, depthLevels);
  const noDepth = depthAtTopLevels(noBook.asks, depthLevels);
  const depthAtLevels = { yes: yesDepth, no: noDepth };
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

  if (desiredSize !== undefined && desiredSize > 0 && policy.depthBufferMultiplier > 0) {
    const requiredDepth = desiredSize * policy.depthBufferMultiplier;
    if (maxSizeByDepth < requiredDepth) {
      reasons.push('insufficient_depth_buffer');
    }
  }

  const tickSize = resolveTickSize(
    inputs.tickSize,
    Math.max(yesBook.tickSize, noBook.tickSize),
    policy.fallbackTickSize
  );
  const edgeInTicks = tickSize > 0 ? edge / tickSize : undefined;
  if (policy.minEdgeTicks > 0 && edgeInTicks !== undefined && edgeInTicks < policy.minEdgeTicks) {
    reasons.push('edge_below_min_ticks');
  }

  if (desiredSize !== undefined && desiredSize > 0) {
    const maxSlippage = policy.entrySlippageToleranceBps / 10000;
    const yesSweep = sweepCost(yesBook.asks, desiredSize);
    const noSweep = sweepCost(noBook.asks, desiredSize);
    if (yesSweep.exhausted) reasons.push('yes_depth_exhausted');
    if (noSweep.exhausted) reasons.push('no_depth_exhausted');

    const yesSlippage =
      yesBook.bestAsk.price > 0
        ? (yesSweep.averagePrice - yesBook.bestAsk.price) / yesBook.bestAsk.price
        : 0;
    const noSlippage =
      noBook.bestAsk.price > 0
        ? (noSweep.averagePrice - noBook.bestAsk.price) / noBook.bestAsk.price
        : 0;

    if (yesSlippage > maxSlippage) reasons.push('yes_slippage_exceeded');
    if (noSlippage > maxSlippage) reasons.push('no_slippage_exceeded');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    costPerSet,
    edge,
    edgeInTicks,
    maxSizeByDepth,
    yesStalenessMs,
    noStalenessMs,
    legSkewMs,
    depthAtLevels
  };
}

export function evaluateGatesWithFees(input: GateInputs & { venue: VenueId; feeModel: FeeModel }): GateDecision {
  const base = evaluateGates(input);
  if (base.reasons.length > 0) return base;

  const netEdge = input.feeModel.netEdge(input.venue, base.edge);
  const reasons = [...base.reasons];
  const tickSize = resolveTickSize(
    input.tickSize,
    Math.max(input.yesBook.tickSize, input.noBook.tickSize),
    input.policy.fallbackTickSize
  );
  const edgeInTicks = tickSize > 0 ? netEdge / tickSize : base.edgeInTicks;

  if (netEdge < input.policy.edgeRequired) {
    reasons.push('edge_below_threshold_after_fees');
  }

  if (netEdge > input.policy.maxEdge) {
    reasons.push('edge_above_max_after_fees');
  }

  return {
    ...base,
    edge: netEdge,
    edgeInTicks,
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

function resolveTickSize(...candidates: Array<number | undefined>): number {
  const valid = candidates.filter(
    (candidate): candidate is number =>
      typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
  );
  if (valid.length === 0) return 0;
  return Math.max(...valid);
}
