import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import type { DependencyEdge, DependencyMarketInput } from '../../domain/dependency.js';
import type { MarketPair } from '../../domain/market.js';
import { depthAtTopLevels, type OrderBookState } from '../../domain/orderbook.js';
import {
  fwOpportunityId,
  type ArbitrageOpportunity,
  type FwBasketMarketLeg,
  type FwBasketMetadata,
  type FwProjectionMetadata
} from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { DependencyResolver, type DependencyResolverConfig } from '../dependency/DependencyResolver.js';
import {
  IpOracleClient,
  type IpOracleRequest,
  type IpOracleResponse
} from '../../services/ip-oracle/IpOracleClient.js';
import { FwLoopEngine } from './fw/FwLoopEngine.js';
import type {
  FwLoopDiagnostics,
  FwLoopPolicy,
  FwLoopResult
} from './fw/types.js';

export interface FwProjectionAgentConfig {
  resolverConfig: DependencyResolverConfig;
  oracleClient: IpOracleClient;
  metrics?: MetricsStore;
}

export interface FwProjectionInput {
  pair: MarketPair;
  yesBook: OrderBookState;
  noBook: OrderBookState;
  orderbooks?: Map<string, OrderBookState>;
  policy: TradePolicy;
  nowMs: number;
  marketUniverse?: DependencyMarketInput[];
}

export interface FwProjectionResult {
  opportunity: ArbitrageOpportunity | null;
  reason?: string;
  metadata?: FwProjectionMetadata;
}

export interface FwUniverseProjectionInput {
  policy: TradePolicy;
  nowMs: number;
  orderbooks: Map<string, OrderBookState>;
  marketUniverse: DependencyMarketInput[];
  allowBasket?: boolean;
}

export interface FwUniverseProjectionResult {
  opportunities: ArbitrageOpportunity[];
  reason?: string;
}

interface ProjectionUniverseEntry {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  variable: string;
  yesPrice: number;
  noPrice: number;
  costPerSet: number;
  projectedEdge: number;
  dependencyConfidence: number;
  maxSizeByDepth: number;
  minOrderSize: number;
  tickSize: number;
  projectionAgeMs: number;
  pair: MarketPair;
}

type ProjectionCandidate = ProjectionUniverseEntry & {
  selectionWeight: number;
  edgeLowerBound: number;
  weightedEdgeLowerBound: number;
};

interface CandidateSelectionSummary {
  total: number;
  selected: number;
  rejectedByWeight: number;
  rejectedByLowerBound: number;
  rejectedByBoth: number;
  strategy: 'weight_floor' | 'top_k_weighted';
  selectionWeightFloor: number;
  selectionTopK: number;
  minEdgeThreshold: number;
}

interface CandidateSelectionResult {
  candidates: ProjectionCandidate[];
  summary: CandidateSelectionSummary;
}

export class FwProjectionAgent {
  private static readonly CONVERGED_ZERO_INTENT_ALERT_COOLDOWN_MS = 30_000;
  private readonly resolver: DependencyResolver;
  private readonly oracleClient: IpOracleClient;
  private readonly metrics?: MetricsStore;
  private readonly loopEngine: FwLoopEngine;
  private inFlightOracleRequests = 0;
  private lastConvergedZeroIntentAlertAtMs = 0;

  constructor(config: FwProjectionAgentConfig) {
    this.resolver = new DependencyResolver(config.resolverConfig);
    this.oracleClient = config.oracleClient;
    this.metrics = config.metrics;
    this.loopEngine = new FwLoopEngine();
  }

  updateResolverConfig(config: DependencyResolverConfig): void {
    this.resolver.updateConfig(config);
  }

  async projectPair(input: FwProjectionInput): Promise<FwProjectionResult> {
    const marketUniverse =
      input.marketUniverse && input.marketUniverse.length > 0
        ? input.marketUniverse
        : [{ marketId: input.pair.marketId, yesTokenId: input.pair.yesTokenId, noTokenId: input.pair.noTokenId }];
    const orderbooks = new Map<string, OrderBookState>(input.orderbooks ?? []);
    orderbooks.set(input.pair.yesTokenId, input.yesBook);
    orderbooks.set(input.pair.noTokenId, input.noBook);

    const result = await this.projectUniverse({
      policy: input.policy,
      nowMs: input.nowMs,
      orderbooks,
      marketUniverse,
      allowBasket: false
    });

    if (result.opportunities.length === 0) {
      return { opportunity: null, reason: result.reason ?? 'projection_rejected' };
    }
    const selected =
      result.opportunities.find((opportunity) => opportunity.marketId === input.pair.marketId) ??
      result.opportunities[0];
    return { opportunity: selected, metadata: selected.fw };
  }

  async projectUniverse(input: FwUniverseProjectionInput): Promise<FwUniverseProjectionResult> {
    const { policy, nowMs, orderbooks, marketUniverse, allowBasket = true } = input;
    if (marketUniverse.length === 0) return { opportunities: [], reason: 'empty_market_universe' };

    const resolution = await this.resolver.resolve(marketUniverse, nowMs);
    const dependencyEdges = resolution.edges;
    this.metrics?.record({
      type: 'fw_dependency',
      timestamp: nowMs,
      data: {
        event: 'dependency_graph_built',
        mode: resolution.summary.mode,
        hybridMerge: policy.fwDependencyHybridMerge,
        edgeCount: dependencyEdges.length,
        markets: marketUniverse.length,
        deterministicEdges: resolution.summary.deterministicEdges,
        llmEdges: resolution.summary.llmEdges,
        mergedEdges: resolution.summary.mergedEdges,
        fallbackSource:
          resolution.summary.mode === 'hybrid' &&
          resolution.summary.mergedEdges > 0 &&
          (resolution.summary.deterministicEdges === 0 || resolution.summary.llmEdges === 0)
            ? resolution.summary.deterministicEdges > 0
              ? 'deterministic'
              : 'llm'
            : null,
        confidenceMin:
          dependencyEdges.length > 0
            ? Math.min(...dependencyEdges.map((edge) => edge.confidence))
            : 1
      }
    });

    const projectionUniverse = buildProjectionUniverse({
      orderbooks,
      marketUniverse,
      dependencyEdges,
      policy,
      nowMs
    });
    if (projectionUniverse.length === 0) {
      return { opportunities: [], reason: 'no_markets_with_books' };
    }

    const loopId = randomUUID();
    const variables = projectionUniverse.map((entry) => entry.variable);
    const baseRows = buildConstraintRows(projectionUniverse, dependencyEdges);
    const loopPolicy = toLoopPolicy(policy);
    const loop = await this.loopEngine.run({
      loopId,
      variableOrder: variables,
      edgeCoefficients: projectionUniverse.map((entry) => entry.projectedEdge),
      policy: loopPolicy,
      oracleSolve: async (oracleInput) => {
        const oracleRequest = buildOracleRequest({
          loopId: oracleInput.loopId,
          iteration: oracleInput.iteration,
          variables,
          objectiveCoefficients: oracleInput.objectiveCoefficients,
          rows: baseRows,
          timeLimitMs: policy.fwOracleTimeLimitMs,
          warmStart: oracleInput.warmStart
        });
        const response = await this.solveOracleWithConcurrency(
          oracleRequest,
          nowMs,
          policy.fwOracleMaxConcurrency
        );
        this.metrics?.record({
          type: 'fw_oracle',
          timestamp: Date.now(),
          data: {
            event: 'oracle_solve',
            status: response.status,
            runtimeMs: response.runtimeMs,
            timeLimitMs: oracleRequest.timeLimitMs,
            gap: response.relativeGap ?? response.gap,
            error: response.error
          }
        });
        return {
          status: response.status,
          runtimeMs: response.runtimeMs,
          assignment: response.assignment,
          objectiveValue: response.objectiveValue,
          gap: response.gap,
          relativeGap: response.relativeGap,
          bestBound: response.bestBound,
          error: response.error
        };
      }
    });

    emitLoopDiagnostics(this.metrics, loop.diagnostics, nowMs, projectionUniverse.length);

    if (!loop.iterate) {
      return { opportunities: [], reason: loop.reason ?? 'oracle_unavailable' };
    }

    if (!loop.diagnostics.converged) {
      const reason = mapNonConvergedReason(loop.diagnostics);
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'projection_rejected',
          marketId: projectionUniverse[0]?.marketId ?? 'unknown',
          reason
        }
      });
      return { opportunities: [], reason };
    }

    const candidateSelection = buildCandidatesFromIterate({
      iterate: loop,
      projectionUniverse,
      policy
    });
    this.metrics?.record({
      type: 'fw_projection',
      timestamp: nowMs,
      data: {
        event: 'candidate_filter_summary',
        loopId: loop.diagnostics.loopId,
        markets: projectionUniverse.length,
        total: candidateSelection.summary.total,
        selected: candidateSelection.summary.selected,
        rejected_by_weight: candidateSelection.summary.rejectedByWeight,
        rejected_by_lower_bound: candidateSelection.summary.rejectedByLowerBound,
        rejected_by_both: candidateSelection.summary.rejectedByBoth,
        selection_strategy: candidateSelection.summary.strategy,
        selection_weight_floor: candidateSelection.summary.selectionWeightFloor,
        selection_top_k: candidateSelection.summary.selectionTopK,
        min_edge_threshold: candidateSelection.summary.minEdgeThreshold
      }
    });
    const candidates = candidateSelection.candidates;
    if (candidates.length === 0) {
      this.emitConvergedZeroIntentAlert(nowMs, loop.diagnostics, projectionUniverse.length);
      return { opportunities: [], reason: 'no_positive_lower_bound' };
    }

    const basket = allowBasket ? buildBasketOpportunity(candidates, policy, nowMs, loop.diagnostics) : null;
    if (basket) {
      this.metrics?.record({
        type: 'fw_basket',
        timestamp: nowMs,
        data: {
          event: 'basket_selected',
          basketId: basket.fwBasket?.basketId,
          markets: basket.fwBasket?.markets.length ?? 0,
          edgeLowerBound: basket.edge
        }
      });
      return { opportunities: [basket] };
    }

    const single = candidates[0];
    const opportunity = toSingleFwOpportunity(single, nowMs, loop.diagnostics, policy);
    this.metrics?.record({
      type: 'fw_projection',
      timestamp: nowMs,
      data: {
        event: 'projection_selected',
        marketId: opportunity.marketId,
        projectedEdge: single.projectedEdge,
        edgeLowerBound: single.edgeLowerBound,
        dependencyMode: policy.fwDependencyMode
      }
    });
    return { opportunities: [opportunity] };
  }

  private emitConvergedZeroIntentAlert(
    nowMs: number,
    diagnostics: FwLoopDiagnostics,
    marketCount: number
  ): void {
    if (!this.metrics || !diagnostics.converged) return;
    if (
      nowMs - this.lastConvergedZeroIntentAlertAtMs <
      FwProjectionAgent.CONVERGED_ZERO_INTENT_ALERT_COOLDOWN_MS
    ) {
      return;
    }
    this.lastConvergedZeroIntentAlertAtMs = nowMs;
    this.metrics.record({
      type: 'incident',
      timestamp: nowMs,
      data: {
        reason: 'fw_converged_zero_intent',
        loopId: diagnostics.loopId,
        markets: marketCount,
        iterationCount: diagnostics.iterationCount,
        terminalGapAbs: diagnostics.terminalGapAbs,
        terminalGapRel: diagnostics.terminalGapRel
      }
    });
    this.metrics.record({
      type: 'fw_projection',
      timestamp: nowMs,
      data: {
        event: 'converged_zero_intent',
        marketId: 'multi',
        reason: 'fw_converged_zero_intent',
        loopId: diagnostics.loopId,
        markets: marketCount
      }
    });
  }

  private async solveOracleWithConcurrency(
    request: IpOracleRequest,
    nowMs: number,
    maxConcurrency: number
  ): Promise<IpOracleResponse> {
    const maxConcurrent = Math.max(1, Math.floor(maxConcurrency));
    if (this.inFlightOracleRequests >= maxConcurrent) {
      return {
        requestId: request.requestId,
        loopId: request.loopId,
        iteration: request.iteration,
        status: 'error',
        runtimeMs: 0,
        error: 'oracle_concurrency_limited'
      };
    }

    this.inFlightOracleRequests += 1;
    try {
      return await this.oracleClient.solve(request, nowMs);
    } finally {
      this.inFlightOracleRequests = Math.max(0, this.inFlightOracleRequests - 1);
    }
  }
}

function buildProjectionUniverse(input: {
  orderbooks: Map<string, OrderBookState>;
  marketUniverse: DependencyMarketInput[];
  dependencyEdges: DependencyEdge[];
  policy: TradePolicy;
  nowMs: number;
}): ProjectionUniverseEntry[] {
  const confidenceByMarket = buildDependencyConfidenceByMarket(input.dependencyEdges);
  const dependencyBoostByMarket = buildDependencyBoostByMarket(input.dependencyEdges);
  const entries: ProjectionUniverseEntry[] = [];

  for (const market of input.marketUniverse) {
    if (!market.yesTokenId || !market.noTokenId) continue;
    const yesBook = input.orderbooks.get(market.yesTokenId);
    const noBook = input.orderbooks.get(market.noTokenId);
    if (!yesBook?.bestAsk || !noBook?.bestAsk) continue;
    const yesPrice = yesBook.bestAsk.price;
    const noPrice = noBook.bestAsk.price;
    if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;

    const depthLevels = Math.max(1, Math.floor(input.policy.minDepthLevels));
    const maxSizeByDepth =
      Math.min(depthAtTopLevels(yesBook.asks, depthLevels), depthAtTopLevels(noBook.asks, depthLevels)) *
      input.policy.depthHeadroomFraction;
    const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize, 0);
    const tickSize = Math.max(yesBook.tickSize, noBook.tickSize, input.policy.fallbackTickSize);
    const projectionAgeMs = Math.max(0, input.nowMs - Math.min(yesBook.lastUpdateMs, noBook.lastUpdateMs));
    const baseEdge = 1 - yesPrice - noPrice;
    const dependencyBoost = dependencyBoostByMarket.get(market.marketId) ?? 0;

    entries.push({
      marketId: market.marketId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      variable: variableNameForMarket(market.marketId),
      yesPrice,
      noPrice,
      costPerSet: yesPrice + noPrice,
      projectedEdge: baseEdge + dependencyBoost,
      dependencyConfidence: confidenceByMarket.get(market.marketId) ?? 1,
      maxSizeByDepth,
      minOrderSize,
      tickSize,
      projectionAgeMs,
      pair: {
        marketId: market.marketId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        question: market.question,
        category: market.category,
        tags: market.tags
      }
    });
  }

  return entries;
}

function buildDependencyConfidenceByMarket(dependencyEdges: DependencyEdge[]): Map<string, number> {
  const confidenceByMarket = new Map<string, { sum: number; count: number }>();
  for (const edge of dependencyEdges) {
    const confidence = clamp01(edge.confidence);
    const left = confidenceByMarket.get(edge.marketA) ?? { sum: 0, count: 0 };
    left.sum += confidence;
    left.count += 1;
    confidenceByMarket.set(edge.marketA, left);

    const right = confidenceByMarket.get(edge.marketB) ?? { sum: 0, count: 0 };
    right.sum += confidence;
    right.count += 1;
    confidenceByMarket.set(edge.marketB, right);
  }
  return new Map(
    Array.from(confidenceByMarket.entries()).map(([marketId, stats]) => [
      marketId,
      stats.count > 0 ? stats.sum / stats.count : 1
    ])
  );
}

function buildDependencyBoostByMarket(dependencyEdges: DependencyEdge[]): Map<string, number> {
  const confidenceByMarket = buildDependencyConfidenceByMarket(dependencyEdges);
  return new Map(
    Array.from(confidenceByMarket.entries()).map(([marketId, confidence]) => [
      marketId,
      Math.min(0.01, confidence * 0.01)
    ])
  );
}

function buildConstraintRows(
  entries: ProjectionUniverseEntry[],
  dependencyEdges: DependencyEdge[]
): IpOracleRequest['constraints']['rows'] {
  const marketIndexById = new Map(entries.map((entry, index) => [entry.marketId, index]));
  const rows: IpOracleRequest['constraints']['rows'] = [];

  for (const edge of dependencyEdges) {
    const leftIndex = marketIndexById.get(edge.marketA);
    const rightIndex = marketIndexById.get(edge.marketB);
    if (leftIndex === undefined || rightIndex === undefined || leftIndex === rightIndex) continue;

    const coefficients = zeroRow(entries.length);
    let op: '<=' | '>=' | '=' | null = null;
    let rhs = 0;
    switch (edge.relationType) {
      case 'mutual_exclusive':
      case 'partition':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = 1;
        op = '<=';
        rhs = 1;
        break;
      case 'implies':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = -1;
        op = '<=';
        rhs = 0;
        break;
      case 'complementary':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = -1;
        op = '=';
        rhs = 0;
        break;
      default:
        break;
    }
    if (!op) continue;
    rows.push({ coefficients, op, rhs });
  }
  return rows;
}

function toLoopPolicy(policy: TradePolicy): FwLoopPolicy {
  return {
    maxIterations: policy.fwMaxIterations,
    maxLoopRuntimeMs: policy.fwMaxLoopRuntimeMs,
    gapAbsTolerance: policy.fwGapAbsTolerance,
    gapRelTolerance: policy.fwGapRelTolerance,
    contractionInitialEpsilon: policy.fwContractionInitialEpsilon,
    contractionDecay: policy.fwContractionDecay,
    contractionMinEpsilon: policy.fwContractionMinEpsilon,
    stallIterationLimit: policy.fwStallIterationLimit,
    activeSetMaxVertices: policy.fwActiveSetMaxVertices,
    hullSolveMaxIterations: policy.fwHullSolveMaxIterations,
    hullSolveTolerance: policy.fwHullSolveTolerance
  };
}

function buildOracleRequest(input: {
  loopId: string;
  iteration: number;
  variables: string[];
  objectiveCoefficients: number[];
  rows: IpOracleRequest['constraints']['rows'];
  timeLimitMs: number;
  warmStart?: number[];
}): IpOracleRequest {
  const warmStart = input.warmStart && input.warmStart.length === input.variables.length
    ? {
        variables: input.variables,
        values: input.warmStart.map((value) =>
          Number.isFinite(value) && value >= 0.5 ? 1 : 0
        )
      }
    : undefined;
  return {
    requestId: randomUUID(),
    loopId: input.loopId,
    iteration: input.iteration,
    timeLimitMs: input.timeLimitMs,
    objective: {
      variables: input.variables,
      coefficients: input.objectiveCoefficients,
      sense: 'max'
    },
    constraints: {
      type: 'linear_binary',
      rows: input.rows
    },
    warmStartHint: warmStart
  };
}

function buildCandidatesFromIterate(input: {
  iterate: FwLoopResult;
  projectionUniverse: ProjectionUniverseEntry[];
  policy: TradePolicy;
}): CandidateSelectionResult {
  const policy = input.policy;
  const selectionWeightFloor = Number.isFinite(policy.fwSelectionWeightFloor)
    ? policy.fwSelectionWeightFloor
    : 0.5;
  const selectionTopK = Number.isFinite(policy.fwSelectionTopK)
    ? Math.max(0, Math.floor(policy.fwSelectionTopK))
    : 0;
  const summaryBase: Omit<CandidateSelectionSummary, 'total' | 'selected' | 'rejectedByWeight' | 'rejectedByLowerBound' | 'rejectedByBoth'> = {
    strategy: selectionTopK > 0 ? 'top_k_weighted' : 'weight_floor',
    selectionWeightFloor,
    selectionTopK,
    minEdgeThreshold: policy.fwMinEdgeThreshold
  };
  if (!input.iterate.iterate) {
    return {
      candidates: [],
      summary: {
        ...summaryBase,
        total: 0,
        selected: 0,
        rejectedByWeight: 0,
        rejectedByLowerBound: 0,
        rejectedByBoth: 0
      }
    };
  }
  const point = input.iterate.iterate.point;
  const feeCost = Math.max(policy.nearZeroFeeBps, 0) / 10000;
  const slippageCost = Math.max(policy.fwSlippageToleranceBps, 0) / 10000;
  const executionRiskBuffer = Math.max(policy.fwExecutionRiskBufferBps, 0) / 10000;

  const scored = input.projectionUniverse
    .map((entry, index) => {
      const selectionWeight = clamp01(point[index] ?? 0);
      const stalenessPenalty =
        policy.fwMaxProjectionAgeMs > 0
          ? Math.min(1, entry.projectionAgeMs / policy.fwMaxProjectionAgeMs) * 0.001
          : 0;
      const edgeLowerBound =
        entry.projectedEdge - feeCost - slippageCost - executionRiskBuffer - stalenessPenalty;
      return {
        ...entry,
        selectionWeight,
        edgeLowerBound,
        weightedEdgeLowerBound: edgeLowerBound * selectionWeight,
        lowWeight: selectionWeight < selectionWeightFloor,
        lowEdge: edgeLowerBound < policy.fwMinEdgeThreshold
      };
    })
    .sort((left, right) => {
      if (right.weightedEdgeLowerBound !== left.weightedEdgeLowerBound) {
        return right.weightedEdgeLowerBound - left.weightedEdgeLowerBound;
      }
      return left.marketId.localeCompare(right.marketId);
    });

  const rejectedByWeight = scored.filter((entry) => entry.lowWeight).length;
  const rejectedByLowerBound = scored.filter((entry) => entry.lowEdge).length;
  const rejectedByBoth = scored.filter((entry) => entry.lowWeight && entry.lowEdge).length;
  const edgeEligible = scored.filter((entry) => !entry.lowEdge);
  const selected = (
    selectionTopK > 0
      ? edgeEligible.slice(0, selectionTopK)
      : edgeEligible.filter((entry) => !entry.lowWeight)
  ).map(({ lowWeight: _lowWeight, lowEdge: _lowEdge, ...candidate }) => candidate);

  return {
    candidates: selected,
    summary: {
      ...summaryBase,
      total: scored.length,
      selected: selected.length,
      rejectedByWeight,
      rejectedByLowerBound,
      rejectedByBoth
    }
  };
}

function buildBasketOpportunity(
  candidates: ProjectionCandidate[],
  policy: TradePolicy,
  nowMs: number,
  loop: FwLoopDiagnostics
): ArbitrageOpportunity | null {
  const maxMarkets = Math.max(policy.fwBasketMinMarkets, policy.fwBasketMaxMarkets);
  const selected = candidates.slice(0, maxMarkets);
  if (selected.length < policy.fwBasketMinMarkets) return null;
  if (selected.length > policy.fwBasketMaxMarkets) return null;

  const markets: FwBasketMarketLeg[] = selected.map((entry) => ({
    marketId: entry.marketId,
    yesTokenId: entry.yesTokenId,
    noTokenId: entry.noTokenId,
    yesPrice: entry.yesPrice,
    noPrice: entry.noPrice,
    costPerSet: entry.costPerSet,
    projectedEdge: entry.projectedEdge,
    edgeLowerBound: entry.edgeLowerBound,
    maxSizeByDepth: entry.maxSizeByDepth,
    minOrderSize: entry.minOrderSize,
    tickSize: entry.tickSize
  }));

  const primary = selected[0];
  const aggregateEdgeLowerBound = selected.reduce(
    (sum, entry) => sum + entry.weightedEdgeLowerBound,
    0
  );
  const aggregateProjectedEdge = selected.reduce(
    (sum, entry) => sum + entry.projectedEdge * entry.selectionWeight,
    0
  );
  const maxSizeByDepth = Math.min(...selected.map((entry) => entry.maxSizeByDepth));
  const minOrderSize = Math.max(...selected.map((entry) => entry.minOrderSize));
  const tickSize = Math.max(...selected.map((entry) => entry.tickSize));
  const basketId = randomUUID();
  const metadata: FwBasketMetadata = {
    basketId,
    executionMode: policy.fwBasketExecutionMode,
    aggregateEdgeLowerBound,
    aggregateProjectedEdge,
    markets,
    loop
  };

  return {
    id: `${primary.marketId}:fwb:${aggregateEdgeLowerBound.toFixed(6)}:${nowMs}`,
    marketId: primary.marketId,
    yesTokenId: primary.yesTokenId,
    noTokenId: primary.noTokenId,
    yesPrice: primary.yesPrice,
    noPrice: primary.noPrice,
    costPerSet: primary.costPerSet,
    edge: aggregateEdgeLowerBound,
    tickSize,
    maxSizeByDepth,
    minOrderSize,
    detectedAt: nowMs,
    gateReasons: [],
    pair: primary.pair,
    type: 'fw_basket',
    fw: toProjectionMetadata(primary, loop, policy),
    fwBasket: metadata
  };
}

function toSingleFwOpportunity(
  candidate: ProjectionUniverseEntry & {
    selectionWeight: number;
    edgeLowerBound: number;
    weightedEdgeLowerBound: number;
  },
  nowMs: number,
  loop: FwLoopDiagnostics,
  policy: TradePolicy
): ArbitrageOpportunity {
  return {
    id: fwOpportunityId(candidate.marketId, candidate.projectedEdge, candidate.edgeLowerBound, nowMs),
    marketId: candidate.marketId,
    yesTokenId: candidate.yesTokenId,
    noTokenId: candidate.noTokenId,
    yesPrice: candidate.yesPrice,
    noPrice: candidate.noPrice,
    costPerSet: candidate.costPerSet,
    edge: candidate.edgeLowerBound,
    tickSize: candidate.tickSize,
    maxSizeByDepth: candidate.maxSizeByDepth,
    minOrderSize: candidate.minOrderSize,
    detectedAt: nowMs,
    gateReasons: [],
    pair: candidate.pair,
    type: 'fw_projection',
    fw: toProjectionMetadata(candidate, loop, policy)
  };
}

function toProjectionMetadata(
  candidate: ProjectionUniverseEntry & { edgeLowerBound: number },
  loop: FwLoopDiagnostics,
  policy: TradePolicy
): FwProjectionMetadata {
  return {
    projectionId: randomUUID(),
    dependencyMode: policy.fwDependencyMode,
    dependencyConfidence: candidate.dependencyConfidence,
    projectedEdge: candidate.projectedEdge,
    edgeLowerBound: candidate.edgeLowerBound,
    solverRuntimeMs: loop.runtimeMs,
    solverStatus: loop.converged ? 'optimal' : 'feasible',
    projectionAgeMs: candidate.projectionAgeMs,
    loop: {
      loopId: loop.loopId,
      iterationCount: loop.iterationCount,
      activeSetSize: loop.activeSetSize,
      contractionSteps: loop.contractionSteps,
      terminalGapAbs: loop.terminalGapAbs,
      terminalGapRel: loop.terminalGapRel,
      terminalReason: loop.terminalReason,
      converged: loop.converged,
      runtimeMs: loop.runtimeMs
    }
  };
}

function mapNonConvergedReason(diagnostics: FwLoopDiagnostics): string {
  switch (diagnostics.terminalReason) {
    case 'runtime_budget':
      return 'fw_loop_runtime_exceeded';
    case 'contraction_floor':
      return 'fw_contraction_floor';
    case 'oracle_unavailable':
      return 'oracle_unavailable';
    default:
      return 'fw_gap_not_converged';
  }
}

function emitLoopDiagnostics(
  metrics: MetricsStore | undefined,
  diagnostics: FwLoopDiagnostics,
  nowMs: number,
  marketCount: number
): void {
  if (!metrics) return;
  for (const iteration of diagnostics.iterations) {
    metrics.record({
      type: 'fw_iteration',
      timestamp: nowMs,
      data: {
        loopId: diagnostics.loopId,
        iteration: iteration.iteration,
        objective: iteration.objective,
        runtimeMs: iteration.runtimeMs
      }
    });
    metrics.record({
      type: 'fw_gap',
      timestamp: nowMs,
      data: {
        loopId: diagnostics.loopId,
        iteration: iteration.iteration,
        abs: iteration.gapAbs,
        rel: iteration.gapRel
      }
    });
    metrics.record({
      type: 'fw_active_set',
      timestamp: nowMs,
      data: {
        loopId: diagnostics.loopId,
        iteration: iteration.iteration,
        size: iteration.activeSetSize
      }
    });
  }
  if (diagnostics.contractionSteps > 0) {
    metrics.record({
      type: 'fw_contraction',
      timestamp: nowMs,
      data: {
        loopId: diagnostics.loopId,
        steps: diagnostics.contractionSteps,
        terminalReason: diagnostics.terminalReason
      }
    });
  }
  metrics.record({
    type: 'fw_projection',
    timestamp: nowMs,
    data: {
      event: 'loop_finished',
      loopId: diagnostics.loopId,
      converged: diagnostics.converged,
      terminalReason: diagnostics.terminalReason,
      markets: marketCount,
      runtimeMs: diagnostics.runtimeMs
    }
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function zeroRow(size: number): number[] {
  return Array.from({ length: size }, () => 0);
}

function variableNameForMarket(marketId: string): string {
  return `x_${marketId}`;
}
