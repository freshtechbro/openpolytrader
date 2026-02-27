import type { TradePolicy } from '../config/policy.js';
import type { OrderBookState } from './orderbook.js';
import { depthAtTopLevels, isAlignedToTick, spread, sweepCost } from './orderbook.js';
import type { VenueId } from '../config/venues.js';
import type { FeeModel } from './feeModel.js';
import type { FwBasketMarketLeg, FwProjectionMetadata } from './opportunity.js';

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
  tickDiagnostics?: {
    yes: { price: number; tickSize: number; aligned: boolean };
    no: { price: number; tickSize: number; aligned: boolean };
  };
  depthDiagnostics?: {
    minOrderSize: number;
    maxSizeByDepth: number;
    depthHeadroomFraction: number;
    depthLevels: number;
    depthAtLevels: { yes: number; no: number };
  };
}

export interface GateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  desiredSize?: number;
  tickSize?: number;
}

export interface EvGateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  side: 'yes' | 'no';
  evEdge: number;
  confidence: number;
  desiredSize?: number;
  tickSize?: number;
}

export interface FwProjectionGateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  projection: FwProjectionMetadata;
  desiredSize?: number;
  tickSize?: number;
}

export interface FwBasketGateInputs {
  policy: TradePolicy;
  nowMs: number;
  markets: FwBasketMarketLeg[];
  orderbooks: Map<string, OrderBookState>;
  aggregateEdgeLowerBound: number;
  projectionAgeMs: number;
  desiredSize?: number;
}

export function evaluateGates(inputs: GateInputs): GateDecision {
  const { yesBook, noBook, policy, desiredSize } = inputs;
  const base = evaluateBaseGates(inputs);
  if (base.fatal) return fail(base.reasons);

  const reasons = [...base.reasons];
  const yesAskPrice = base.yesAskPrice;
  const noAskPrice = base.noAskPrice;
  const costPerSet = yesAskPrice + noAskPrice;
  const edge = 1 - costPerSet;

  if (edge < policy.edgeRequired) {
    reasons.push('edge_below_threshold');
  }

  if (edge > policy.maxEdge) {
    reasons.push('edge_above_max');
  }

  const maxSizeByDepth = Math.min(base.depthAtLevels.yes, base.depthAtLevels.no) * policy.depthHeadroomFraction;

  if (maxSizeByDepth <= 0) {
    reasons.push('insufficient_depth');
  }

  const minOrderSize = base.minOrderSize;
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
      yesAskPrice > 0 ? (yesSweep.averagePrice - yesAskPrice) / yesAskPrice : 0;
    const noSlippage =
      noAskPrice > 0 ? (noSweep.averagePrice - noAskPrice) / noAskPrice : 0;

    if (yesSlippage > maxSlippage) reasons.push('yes_slippage_exceeded');
    if (noSlippage > maxSlippage) reasons.push('no_slippage_exceeded');
  }

  const needsDepthDiagnostics =
    maxSizeByDepth <= 0 ||
    maxSizeByDepth < minOrderSize ||
    (desiredSize !== undefined && desiredSize > maxSizeByDepth) ||
    (desiredSize !== undefined &&
      desiredSize > 0 &&
      policy.depthBufferMultiplier > 0 &&
      maxSizeByDepth < desiredSize * policy.depthBufferMultiplier);

  const depthDiagnostics = needsDepthDiagnostics
    ? {
        minOrderSize,
        maxSizeByDepth,
        depthHeadroomFraction: policy.depthHeadroomFraction,
        depthLevels: base.depthLevels,
        depthAtLevels: base.depthAtLevels
      }
    : undefined;

  return {
    passed: reasons.length === 0,
    reasons,
    costPerSet,
    edge,
    edgeInTicks,
    maxSizeByDepth,
    yesStalenessMs: base.yesStalenessMs,
    noStalenessMs: base.noStalenessMs,
    legSkewMs: base.legSkewMs,
    depthAtLevels: base.depthAtLevels,
    tickDiagnostics: base.tickDiagnostics,
    depthDiagnostics
  };
}

export function evaluateEvGates(inputs: EvGateInputs): GateDecision {
  const { yesBook, noBook, policy, desiredSize, side, evEdge, confidence } = inputs;
  const base = evaluateBaseGates(inputs);
  if (base.fatal) return fail(base.reasons);

  const reasons = [...base.reasons];
  const sideBook = side === 'yes' ? yesBook : noBook;
  const sideAskPrice = side === 'yes' ? base.yesAskPrice : base.noAskPrice;
  const sideDepth = side === 'yes' ? base.depthAtLevels.yes : base.depthAtLevels.no;
  const maxSizeByDepth = sideDepth * policy.depthHeadroomFraction;
  const minOrderSize = Math.max(sideBook.minOrderSize, 0);

  if (!Number.isFinite(evEdge)) {
    reasons.push('ev_edge_invalid');
  }

  if (!Number.isFinite(confidence)) {
    reasons.push('ev_confidence_invalid');
  }

  if (maxSizeByDepth <= 0) {
    reasons.push('insufficient_depth');
  }

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

  const evMaxEdge = Number.isFinite(policy.evMaxEdge) ? policy.evMaxEdge : policy.maxEdge;
  const confidenceFloor = Number.isFinite(policy.evConfidenceMinFloor)
    ? Math.max(0, Math.min(policy.evConfidenceMinFloor, policy.evConfidenceMin))
    : policy.evConfidenceMin;
  const confidenceSpan =
    Number.isFinite(evMaxEdge) && evMaxEdge > policy.evEdgeRequired
      ? evMaxEdge - policy.evEdgeRequired
      : 0;
  const confidenceRatio =
    Number.isFinite(evEdge) && confidenceSpan > 0
      ? Math.max(0, Math.min(1, (evEdge - policy.evEdgeRequired) / confidenceSpan))
      : 0;
  const effectiveConfidenceMin =
    policy.evConfidenceMin - confidenceRatio * (policy.evConfidenceMin - confidenceFloor);
  if (Number.isFinite(evEdge)) {
    if (evEdge < policy.evEdgeRequired) {
      reasons.push('ev_edge_below_threshold');
    }
    if (evEdge > evMaxEdge) {
      reasons.push('ev_edge_above_max');
    }
  }

  if (Number.isFinite(confidence) && confidence < effectiveConfidenceMin) {
    reasons.push('ev_confidence_below_min');
  }

  const tickSize = resolveTickSize(
    inputs.tickSize,
    Math.max(yesBook.tickSize, noBook.tickSize),
    policy.fallbackTickSize
  );
  const edgeInTicks = tickSize > 0 && Number.isFinite(evEdge) ? evEdge / tickSize : undefined;
  if (policy.minEdgeTicks > 0 && edgeInTicks !== undefined && edgeInTicks < policy.minEdgeTicks) {
    reasons.push('edge_below_min_ticks');
  }

  if (desiredSize !== undefined && desiredSize > 0) {
    const maxSlippage = policy.entrySlippageToleranceBps / 10000;
    const sweep = sweepCost(sideBook.asks, desiredSize);
    if (sweep.exhausted) reasons.push(side === 'yes' ? 'yes_depth_exhausted' : 'no_depth_exhausted');

    const slippage =
      sideAskPrice > 0 ? (sweep.averagePrice - sideAskPrice) / sideAskPrice : 0;

    if (slippage > maxSlippage) {
      reasons.push(side === 'yes' ? 'yes_slippage_exceeded' : 'no_slippage_exceeded');
    }
  }

  const needsDepthDiagnostics =
    maxSizeByDepth <= 0 ||
    maxSizeByDepth < minOrderSize ||
    (desiredSize !== undefined && desiredSize > maxSizeByDepth) ||
    (desiredSize !== undefined &&
      desiredSize > 0 &&
      policy.depthBufferMultiplier > 0 &&
      maxSizeByDepth < desiredSize * policy.depthBufferMultiplier);

  const depthDiagnostics = needsDepthDiagnostics
    ? {
        minOrderSize,
        maxSizeByDepth,
        depthHeadroomFraction: policy.depthHeadroomFraction,
        depthLevels: base.depthLevels,
        depthAtLevels: base.depthAtLevels
      }
    : undefined;

  return {
    passed: reasons.length === 0,
    reasons,
    costPerSet: sideAskPrice,
    edge: evEdge,
    edgeInTicks,
    maxSizeByDepth,
    yesStalenessMs: base.yesStalenessMs,
    noStalenessMs: base.noStalenessMs,
    legSkewMs: base.legSkewMs,
    depthAtLevels: base.depthAtLevels,
    tickDiagnostics: base.tickDiagnostics,
    depthDiagnostics
  };
}

export function evaluateFwProjectionGates(inputs: FwProjectionGateInputs): GateDecision {
  const relaxedPolicy: TradePolicy = {
    ...inputs.policy,
    edgeRequired: 0,
    maxEdge: 1,
    minEdgeTicks: 0
  };
  const base = evaluateGates({
    yesBook: inputs.yesBook,
    noBook: inputs.noBook,
    policy: relaxedPolicy,
    nowMs: inputs.nowMs,
    desiredSize: inputs.desiredSize,
    tickSize: inputs.tickSize
  });

  const reasons = [...base.reasons];
  const projection = inputs.projection;
  if (projection.dependencyConfidence < inputs.policy.fwDependencyMinConfidence) {
    reasons.push('fw_dependency_low_confidence');
  }
  if (projection.projectionAgeMs > inputs.policy.fwMaxProjectionAgeMs) {
    reasons.push('fw_projection_stale');
  }
  if (projection.edgeLowerBound < inputs.policy.fwMinEdgeThreshold) {
    reasons.push('fw_edge_lower_bound_fail');
  }
  if (projection.solverStatus !== 'optimal' && projection.solverStatus !== 'feasible') {
    reasons.push('fw_solver_status');
  }

  return {
    ...base,
    edge: projection.edgeLowerBound,
    reasons,
    passed: reasons.length === 0
  };
}

export function evaluateFwBasketGates(inputs: FwBasketGateInputs): GateDecision {
  const reasons: string[] = [];
  const { policy } = inputs;
  if (inputs.markets.length < policy.fwBasketMinMarkets) {
    reasons.push('fw_basket_min_markets');
  }
  if (inputs.markets.length > policy.fwBasketMaxMarkets) {
    reasons.push('fw_basket_max_markets');
  }

  if (inputs.projectionAgeMs > policy.fwMaxProjectionAgeMs) {
    reasons.push('fw_basket_projection_stale');
  }

  if (inputs.aggregateEdgeLowerBound < policy.fwMinEdgeThreshold) {
    reasons.push('fw_basket_edge_lower_bound_fail');
  }

  const perMarketDepth: number[] = [];
  const perMarketCosts: number[] = [];
  for (const market of inputs.markets) {
    const yesBook = inputs.orderbooks.get(market.yesTokenId);
    const noBook = inputs.orderbooks.get(market.noTokenId);
    if (!yesBook || !noBook) {
      reasons.push(`fw_basket:${market.marketId}:missing_orderbook`);
      continue;
    }
    const projection: FwProjectionMetadata = {
      projectionId: market.marketId,
      dependencyMode: 'deterministic',
      dependencyConfidence: 1,
      projectedEdge: market.projectedEdge,
      edgeLowerBound: market.edgeLowerBound,
      solverRuntimeMs: 0,
      solverStatus: 'optimal',
      projectionAgeMs: inputs.projectionAgeMs
    };
    const decision = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy,
      nowMs: inputs.nowMs,
      projection,
      desiredSize: inputs.desiredSize,
      tickSize: market.tickSize
    });
    perMarketDepth.push(decision.maxSizeByDepth);
    perMarketCosts.push(market.costPerSet);
    for (const reason of decision.reasons) {
      reasons.push(`fw_basket:${market.marketId}:${reason}`);
    }
  }

  const maxSizeByDepth =
    perMarketDepth.length > 0 ? Math.min(...perMarketDepth) : 0;
  if (inputs.desiredSize !== undefined && inputs.desiredSize > maxSizeByDepth) {
    reasons.push('fw_basket_desired_size_exceeds_depth');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    costPerSet: perMarketCosts.reduce((sum, value) => sum + value, 0),
    edge: inputs.aggregateEdgeLowerBound,
    maxSizeByDepth
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

function evaluateBaseGates(
  inputs: GateInputs | EvGateInputs
): {
  fatal: boolean;
  reasons: string[];
  yesAskPrice: number;
  noAskPrice: number;
  yesStalenessMs: number;
  noStalenessMs: number;
  legSkewMs: number;
  depthLevels: number;
  depthAtLevels: { yes: number; no: number };
  minOrderSize: number;
  tickDiagnostics?: GateDecision['tickDiagnostics'];
} {
  const { yesBook, noBook, policy, nowMs } = inputs;
  const reasons: string[] = [];

  if (!yesBook.bestAsk || !noBook.bestAsk) {
    reasons.push('missing_best_ask');
    return {
      fatal: true,
      reasons,
      yesAskPrice: 0,
      noAskPrice: 0,
      yesStalenessMs: 0,
      noStalenessMs: 0,
      legSkewMs: 0,
      depthLevels: Math.max(1, Math.floor(policy.minDepthLevels)),
      depthAtLevels: { yes: 0, no: 0 },
      minOrderSize: 0
    };
  }

  const yesAskPrice = yesBook.bestAsk.price;
  const noAskPrice = noBook.bestAsk.price;
  if (!Number.isFinite(yesAskPrice) || yesAskPrice <= 0 || yesAskPrice > 1) {
    reasons.push('yes_best_ask_invalid');
  }
  if (!Number.isFinite(noAskPrice) || noAskPrice <= 0 || noAskPrice > 1) {
    reasons.push('no_best_ask_invalid');
  }
  if (reasons.length > 0) {
    return {
      fatal: true,
      reasons,
      yesAskPrice,
      noAskPrice,
      yesStalenessMs: 0,
      noStalenessMs: 0,
      legSkewMs: 0,
      depthLevels: Math.max(1, Math.floor(policy.minDepthLevels)),
      depthAtLevels: { yes: 0, no: 0 },
      minOrderSize: 0
    };
  }

  const yesBidPrice = yesBook.bestBid?.price;
  const noBidPrice = noBook.bestBid?.price;
  if (
    typeof yesBidPrice === 'number' &&
    Number.isFinite(yesBidPrice) &&
    yesBidPrice > yesAskPrice
  ) {
    reasons.push('yes_book_crossed');
  }
  if (
    typeof noBidPrice === 'number' &&
    Number.isFinite(noBidPrice) &&
    noBidPrice > noAskPrice
  ) {
    reasons.push('no_book_crossed');
  }

  const yesSpread = spread(yesBook);
  const noSpread = spread(noBook);

  if (yesSpread === null || noSpread === null) {
    reasons.push('missing_spread');
  } else {
    if (yesSpread > policy.maxSpread) reasons.push('yes_spread_too_wide');
    if (noSpread > policy.maxSpread) reasons.push('no_spread_too_wide');
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

  const yesTickAligned = isAlignedToTick(yesAskPrice, yesBook.tickSize);
  const noTickAligned = isAlignedToTick(noAskPrice, noBook.tickSize);
  if (!yesTickAligned) {
    reasons.push('yes_tick_misaligned');
  }
  if (!noTickAligned) {
    reasons.push('no_tick_misaligned');
  }

  const depthLevels = Math.max(1, Math.floor(policy.minDepthLevels));
  const yesDepth = depthAtTopLevels(yesBook.asks, depthLevels);
  const noDepth = depthAtTopLevels(noBook.asks, depthLevels);
  const depthAtLevels = { yes: yesDepth, no: noDepth };
  const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);

  const tickDiagnostics =
    !yesTickAligned || !noTickAligned
      ? {
          yes: { price: yesAskPrice, tickSize: yesBook.tickSize, aligned: yesTickAligned },
          no: { price: noAskPrice, tickSize: noBook.tickSize, aligned: noTickAligned }
        }
      : undefined;

  return {
    fatal: false,
    reasons,
    yesAskPrice,
    noAskPrice,
    yesStalenessMs,
    noStalenessMs,
    legSkewMs,
    depthLevels,
    depthAtLevels,
    minOrderSize,
    tickDiagnostics
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
