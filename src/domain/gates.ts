import type { TradePolicy } from '../config/policy.js';
import type { OrderBookState } from './orderbook.js';
import { sweepCost } from './orderbook.js';
import type { VenueId } from '../config/venues.js';
import type { FeeModel } from './feeModel.js';
import type { FwBasketMarketLeg, FwProjectionMetadata } from './opportunity.js';
import {
  evaluateBaseGates,
  resolveTickSize
} from './gateSupport.js';

interface GateDecision {
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

interface GateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  desiredSize?: number;
  tickSize?: number;
}

interface EvGateInputs {
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

interface FwProjectionGateInputs {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  projection: FwProjectionMetadata;
  desiredSize?: number;
  tickSize?: number;
}

interface FwBasketGateInputs {
  policy: TradePolicy;
  nowMs: number;
  markets: FwBasketMarketLeg[];
  orderbooks: Map<string, OrderBookState>;
  aggregateEdgeLowerBound: number;
  projectionAgeMs: number;
  desiredSize?: number;
}

interface DepthGateInputs {
  reasons: string[];
  maxSizeByDepth: number;
  minOrderSize: number;
  desiredSize: number | undefined;
  depthBufferMultiplier: number;
}

interface DepthDiagnosticsInput {
  maxSizeByDepth: number;
  minOrderSize: number;
  desiredSize: number | undefined;
  depthBufferMultiplier: number;
  depthHeadroomFraction: number;
  depthLevels: number;
  depthAtLevels: { yes: number; no: number };
}

interface EvThresholdInput {
  reasons: string[];
  policy: TradePolicy;
  evEdge: number;
  confidence: number;
}

interface SlippageGateInput {
  reasons: string[];
  book: OrderBookState;
  askPrice: number;
  desiredSize: number | undefined;
  maxSlippage: number;
  exhaustedReason: string;
  slippageReason: string;
}

function applyDepthGateChecks(input: DepthGateInputs): void {
  if (input.maxSizeByDepth <= 0) {
    input.reasons.push('insufficient_depth');
  }
  if (input.maxSizeByDepth < input.minOrderSize) {
    input.reasons.push('below_min_order_size');
  }
  if (input.desiredSize !== undefined && input.desiredSize > input.maxSizeByDepth) {
    input.reasons.push('desired_size_exceeds_depth');
  }
  if (input.desiredSize !== undefined && input.desiredSize > 0 && input.depthBufferMultiplier > 0) {
    const requiredDepth = input.desiredSize * input.depthBufferMultiplier;
    if (input.maxSizeByDepth < requiredDepth) {
      input.reasons.push('insufficient_depth_buffer');
    }
  }
}

function buildDepthDiagnostics(input: DepthDiagnosticsInput): GateDecision['depthDiagnostics'] {
  const needsDepthDiagnostics =
    input.maxSizeByDepth <= 0 ||
    input.maxSizeByDepth < input.minOrderSize ||
    (input.desiredSize !== undefined && input.desiredSize > input.maxSizeByDepth) ||
    (input.desiredSize !== undefined &&
      input.desiredSize > 0 &&
      input.depthBufferMultiplier > 0 &&
      input.maxSizeByDepth < input.desiredSize * input.depthBufferMultiplier);

  return needsDepthDiagnostics
    ? {
        minOrderSize: input.minOrderSize,
        maxSizeByDepth: input.maxSizeByDepth,
        depthHeadroomFraction: input.depthHeadroomFraction,
        depthLevels: input.depthLevels,
        depthAtLevels: input.depthAtLevels
      }
    : undefined;
}

function resolveEffectiveConfidenceMin(policy: TradePolicy, evEdge: number): number {
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
  return policy.evConfidenceMin - confidenceRatio * (policy.evConfidenceMin - confidenceFloor);
}

function applyEvThresholdChecks(input: EvThresholdInput): number {
  if (!Number.isFinite(input.evEdge)) {
    input.reasons.push('ev_edge_invalid');
  }
  if (!Number.isFinite(input.confidence)) {
    input.reasons.push('ev_confidence_invalid');
  }

  const evMaxEdge = Number.isFinite(input.policy.evMaxEdge) ? input.policy.evMaxEdge : input.policy.maxEdge;
  const effectiveConfidenceMin = resolveEffectiveConfidenceMin(input.policy, input.evEdge);
  if (Number.isFinite(input.evEdge)) {
    if (input.evEdge < input.policy.evEdgeRequired) {
      input.reasons.push('ev_edge_below_threshold');
    }
    if (input.evEdge > evMaxEdge) {
      input.reasons.push('ev_edge_above_max');
    }
  }
  if (Number.isFinite(input.confidence) && input.confidence < effectiveConfidenceMin) {
    input.reasons.push('ev_confidence_below_min');
  }
  return evMaxEdge;
}

function applyEdgeThresholdChecks(reasons: string[], policy: TradePolicy, edge: number): void {
  if (edge < policy.edgeRequired) {
    reasons.push('edge_below_threshold');
  }

  if (edge > policy.maxEdge) {
    reasons.push('edge_above_max');
  }
}

function applyMinEdgeTicksCheck(
  reasons: string[],
  minEdgeTicks: number,
  edge: number,
  tickSize: number | undefined
): number | undefined {
  const edgeInTicks = tickSize && tickSize > 0 ? edge / tickSize : undefined;
  if (minEdgeTicks > 0 && edgeInTicks !== undefined && edgeInTicks < minEdgeTicks) {
    reasons.push('edge_below_min_ticks');
  }
  return edgeInTicks;
}

function applySlippageChecks(input: SlippageGateInput): void {
  if (input.desiredSize === undefined || input.desiredSize <= 0) {
    return;
  }

  const sweep = sweepCost(input.book.asks, input.desiredSize);
  if (sweep.exhausted) {
    input.reasons.push(input.exhaustedReason);
  }

  const slippage = input.askPrice > 0 ? (sweep.averagePrice - input.askPrice) / input.askPrice : 0;
  if (slippage > input.maxSlippage) {
    input.reasons.push(input.slippageReason);
  }
}

function buildGateDecision(input: {
  base: ReturnType<typeof evaluateBaseGates>;
  reasons: string[];
  costPerSet: number;
  edge: number;
  edgeInTicks?: number;
  maxSizeByDepth: number;
  depthDiagnostics?: GateDecision['depthDiagnostics'];
}): GateDecision {
  return {
    passed: input.reasons.length === 0,
    reasons: input.reasons,
    costPerSet: input.costPerSet,
    edge: input.edge,
    edgeInTicks: input.edgeInTicks,
    maxSizeByDepth: input.maxSizeByDepth,
    yesStalenessMs: input.base.yesStalenessMs,
    noStalenessMs: input.base.noStalenessMs,
    legSkewMs: input.base.legSkewMs,
    depthAtLevels: input.base.depthAtLevels,
    tickDiagnostics: input.base.tickDiagnostics,
    depthDiagnostics: input.depthDiagnostics
  };
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
  applyEdgeThresholdChecks(reasons, policy, edge);

  const maxSizeByDepth = Math.min(base.depthAtLevels.yes, base.depthAtLevels.no) * policy.depthHeadroomFraction;
  const minOrderSize = base.minOrderSize;
  applyDepthGateChecks({
    reasons,
    maxSizeByDepth,
    minOrderSize,
    desiredSize,
    depthBufferMultiplier: policy.depthBufferMultiplier
  });

  const tickSize = resolveTickSize(
    inputs.tickSize,
    Math.max(yesBook.tickSize, noBook.tickSize),
    policy.fallbackTickSize
  );
  const edgeInTicks = applyMinEdgeTicksCheck(reasons, policy.minEdgeTicks, edge, tickSize);
  const maxSlippage = policy.entrySlippageToleranceBps / 10000;
  applySlippageChecks({
    reasons,
    book: yesBook,
    askPrice: yesAskPrice,
    desiredSize,
    maxSlippage,
    exhaustedReason: 'yes_depth_exhausted',
    slippageReason: 'yes_slippage_exceeded'
  });
  applySlippageChecks({
    reasons,
    book: noBook,
    askPrice: noAskPrice,
    desiredSize,
    maxSlippage,
    exhaustedReason: 'no_depth_exhausted',
    slippageReason: 'no_slippage_exceeded'
  });

  const depthDiagnostics = buildDepthDiagnostics({
    maxSizeByDepth,
    minOrderSize,
    desiredSize,
    depthBufferMultiplier: policy.depthBufferMultiplier,
    depthHeadroomFraction: policy.depthHeadroomFraction,
    depthLevels: base.depthLevels,
    depthAtLevels: base.depthAtLevels
  });

  return buildGateDecision({
    base,
    reasons,
    costPerSet,
    edge,
    edgeInTicks,
    maxSizeByDepth,
    depthDiagnostics
  });
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
  applyDepthGateChecks({
    reasons,
    maxSizeByDepth,
    minOrderSize,
    desiredSize,
    depthBufferMultiplier: policy.depthBufferMultiplier
  });
  applyEvThresholdChecks({ reasons, policy, evEdge, confidence });

  const tickSize = resolveTickSize(
    inputs.tickSize,
    Math.max(yesBook.tickSize, noBook.tickSize),
    policy.fallbackTickSize
  );
  const edgeInTicks =
    Number.isFinite(evEdge) ? applyMinEdgeTicksCheck(reasons, policy.minEdgeTicks, evEdge, tickSize) : undefined;
  const maxSlippage = policy.entrySlippageToleranceBps / 10000;
  applySlippageChecks({
    reasons,
    book: sideBook,
    askPrice: sideAskPrice,
    desiredSize,
    maxSlippage,
    exhaustedReason: side === 'yes' ? 'yes_depth_exhausted' : 'no_depth_exhausted',
    slippageReason: side === 'yes' ? 'yes_slippage_exceeded' : 'no_slippage_exceeded'
  });

  const depthDiagnostics = buildDepthDiagnostics({
    maxSizeByDepth,
    minOrderSize,
    desiredSize,
    depthBufferMultiplier: policy.depthBufferMultiplier,
    depthHeadroomFraction: policy.depthHeadroomFraction,
    depthLevels: base.depthLevels,
    depthAtLevels: base.depthAtLevels
  });

  return buildGateDecision({
    base,
    reasons,
    costPerSet: sideAskPrice,
    edge: evEdge,
    edgeInTicks,
    maxSizeByDepth,
    depthDiagnostics
  });
}

export function evaluateFwProjectionGates(inputs: FwProjectionGateInputs): GateDecision {
  const base = evaluateGates({
    yesBook: inputs.yesBook,
    noBook: inputs.noBook,
    policy: inputs.policy,
    nowMs: inputs.nowMs,
    desiredSize: inputs.desiredSize,
    tickSize: inputs.tickSize
  });

  const reasons = base.reasons.filter(
    (reason) =>
      reason !== 'edge_below_threshold' &&
      reason !== 'edge_above_max' &&
      reason !== 'edge_below_min_ticks'
  );
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

  const tickSize = resolveTickSize(
    inputs.tickSize,
    Math.max(inputs.yesBook.tickSize, inputs.noBook.tickSize),
    inputs.policy.fallbackTickSize
  );
  const fwEdge = projection.edgeLowerBound;
  const fwEdgeInTicks = tickSize > 0 ? fwEdge / tickSize : undefined;

  return {
    ...base,
    edge: fwEdge,
    edgeInTicks: fwEdgeInTicks,
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

export { computeExecutableLowerBound } from './gateSupport.js';

function fail(reasons: string[]): GateDecision {
  return {
    passed: false,
    reasons,
    costPerSet: 0,
    edge: 0,
    maxSizeByDepth: 0
  };
}
