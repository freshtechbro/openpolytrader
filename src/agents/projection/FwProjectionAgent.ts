import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import {
  computeDependencyGraphQualityStats,
  dependencyEdgeKey,
  type DependencyEdge,
  type DependencyMarketInput,
  type DependencyRelation
} from '../../domain/dependency.js';
import {
  computeExecutableLowerBound,
  evaluateFwProjectionGates
} from '../../domain/gates.js';
import type { MarketPair } from '../../domain/market.js';
import { depthAtTopLevels, sweepCost, type OrderBookState } from '../../domain/orderbook.js';
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
  rankingEdge: number;
  projectedEdge: number;
  dependencyConfidence: number;
  relationSignal: number;
  relationIds: string[];
  relationTypes: DependencyRelation[];
  lowerBoundComponents: LowerBoundComponentBreakdown;
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

interface RelationViolationCandidate {
  relationId: string;
  relationType: DependencyRelation;
  signal: number;
  marketA: string;
  marketB: string;
}

interface LowerBoundComponentBreakdown {
  theoreticalEdge: number;
  feeCost: number;
  sweepSlippageCost: number;
  stalenessPenalty: number;
  stabilityPenalty: number;
  executionRiskBuffer: number;
}

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
  lowerBoundTelemetry: {
    average: {
      theoreticalEdge: number;
      feeCost: number;
      sweepSlippageCost: number;
      stalenessPenalty: number;
      stabilityPenalty: number;
      executionRiskBuffer: number;
      totalPenalty: number;
      edgeLowerBound: number;
      weightedEdgeLowerBound: number;
      selectionWeight: number;
    };
    positiveLowerBoundCount: number;
    nonPositiveLowerBoundCount: number;
    rejectionSplit: {
      theoreticalEdgeNonPositive: number;
      theoreticalEdgeBelowThreshold: number;
      penaltyDrivenLowerBound: number;
    };
    dominantPenaltyCounts: Record<string, number>;
    rejectedDominantPenaltyCounts: Record<string, number>;
    penaltyRejectedDominantPenaltyCounts: Record<string, number>;
  };
}

interface CandidateSelectionResult {
  candidates: ProjectionCandidate[];
  summary: CandidateSelectionSummary;
}

interface BasketLegFilterRejection {
  marketId: string;
  reasons: string[];
}

interface BasketLegFilterResult {
  executableCandidates: ProjectionCandidate[];
  rejectedCandidates: BasketLegFilterRejection[];
  reasonCounts: Record<string, number>;
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
    const graphStats = computeDependencyGraphQualityStats(marketUniverse, dependencyEdges);
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
        catalogEdges: resolution.summary.catalogEdges ?? 0,
        llmEdges: resolution.summary.llmEdges,
        mergedEdges: resolution.summary.mergedEdges,
        fallbackSource: resolution.summary.fallbackSource ?? null,
        cacheStatus: resolution.summary.cacheStatus ?? 'bypass',
        llmReason: resolution.summary.llmReason ?? null,
        backoffActive: resolution.summary.backoffActive ?? false,
        confidenceMin:
          dependencyEdges.length > 0
            ? Math.min(...dependencyEdges.map((edge) => edge.confidence))
            : 1,
        componentCount: graphStats.componentCount,
        coverage: graphStats.coverage,
        relationTypeCounts: graphStats.relationTypeCounts
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
      edgeCoefficients: projectionUniverse.map((entry) => entry.rankingEdge),
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

    if (!loop.diagnostics.converged && !canProceedWithApproximateLoopIterate(loop)) {
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
    if (!loop.diagnostics.converged) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'non_converged_iterate_accepted',
          loopId: loop.diagnostics.loopId,
          terminalReason: loop.diagnostics.terminalReason,
          runtimeMs: loop.diagnostics.runtimeMs,
          iterationCount: loop.diagnostics.iterationCount
        }
      });
    }

    const candidateSelection = buildCandidatesFromIterate({
      iterate: loop,
      projectionUniverse,
      policy
    });
    const relationBackedSelected = candidateSelection.candidates.filter(
      (candidate) => candidate.relationIds.length > 0
    ).length;
    const relationSignaledSelected = candidateSelection.candidates.filter(
      (candidate) => candidate.relationSignal > 0
    ).length;
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
        min_edge_threshold: candidateSelection.summary.minEdgeThreshold,
        relation_backed_selected: relationBackedSelected,
        relation_signaled_selected: relationSignaledSelected,
        rejection_split: candidateSelection.summary.lowerBoundTelemetry.rejectionSplit,
        lower_bound_telemetry: candidateSelection.summary.lowerBoundTelemetry
      }
    });
    const candidates = candidateSelection.candidates;
    if (candidates.length === 0) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'projection_rejected',
          marketId: projectionUniverse[0]?.marketId ?? 'unknown',
          reason: 'no_positive_lower_bound',
          lower_bound_telemetry: candidateSelection.summary.lowerBoundTelemetry
        }
      });
      this.emitConvergedZeroIntentAlert(nowMs, loop.diagnostics, projectionUniverse.length);
      return { opportunities: [], reason: 'no_positive_lower_bound' };
    }

    const basketLegFilter = allowBasket
      ? filterExecutableBasketCandidates(candidates, orderbooks, policy, nowMs)
      : null;
    if (basketLegFilter) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'basket_leg_filter_summary',
          total_candidates: candidates.length,
          executable_candidates: basketLegFilter.executableCandidates.length,
          rejected_non_executable: basketLegFilter.rejectedCandidates.length,
          rejection_reasons: basketLegFilter.reasonCounts,
          rejected_markets: basketLegFilter.rejectedCandidates
        }
      });
    }

    const basketCandidates = basketLegFilter
      ? basketLegFilter.executableCandidates
      : candidates;
    const basket = allowBasket
      ? buildBasketOpportunity(basketCandidates, policy, nowMs, loop.diagnostics)
      : null;
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

    const single = (allowBasket ? basketCandidates[0] : candidates[0]) ?? null;
    if (!single) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'projection_rejected',
          marketId: projectionUniverse[0]?.marketId ?? 'unknown',
          reason: 'no_executable_candidates'
        }
      });
      return { opportunities: [], reason: 'no_executable_candidates' };
    }
    const opportunity = toSingleFwOpportunity(single, nowMs, loop.diagnostics, policy);
    this.metrics?.record({
      type: 'fw_projection',
      timestamp: nowMs,
      data: {
        event: 'projection_selected',
        marketId: opportunity.marketId,
        projectedEdge: single.projectedEdge,
        edgeLowerBound: single.edgeLowerBound,
        dependencyMode: policy.fwDependencyMode,
        relationIds: single.relationIds,
        relationTypes: single.relationTypes,
        relationSignal: single.relationSignal,
        lowerBoundComponents: single.lowerBoundComponents
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
    const lowerBoundComponents = estimateLowerBoundComponents({
      yesBook,
      noBook,
      policy: input.policy,
      projectedEdge: baseEdge,
      projectionAgeMs,
      desiredSize: minOrderSize
    });
    const lowerBound = computeExecutableLowerBound(lowerBoundComponents);

    entries.push({
      marketId: market.marketId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      variable: variableNameForMarket(market.marketId),
      yesPrice,
      noPrice,
      costPerSet: yesPrice + noPrice,
      rankingEdge: baseEdge,
      projectedEdge: baseEdge,
      dependencyConfidence: confidenceByMarket.get(market.marketId) ?? 1,
      relationSignal: 0,
      relationIds: [],
      relationTypes: [],
      lowerBoundComponents: lowerBound.components,
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

  if (entries.length === 0) return entries;
  const relationCandidates = buildRelationViolationCandidates(
    entries,
    input.dependencyEdges,
    input.policy
  );
  applyRelationSignals(entries, relationCandidates, input.policy);

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

function estimateLowerBoundComponents(input: {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  projectedEdge: number;
  projectionAgeMs: number;
  desiredSize: number;
}) {
  const desiredSize = Math.max(input.desiredSize, 0);
  const yesSweep = desiredSize > 0 ? sweepCost(input.yesBook.asks, desiredSize) : null;
  const noSweep = desiredSize > 0 ? sweepCost(input.noBook.asks, desiredSize) : null;
  const yesBestAsk = input.yesBook.bestAsk?.price ?? 0;
  const noBestAsk = input.noBook.bestAsk?.price ?? 0;
  const yesSlippage =
    yesSweep && yesBestAsk > 0
      ? Math.max(0, (yesSweep.averagePrice - yesBestAsk) / yesBestAsk)
      : 0;
  const noSlippage =
    noSweep && noBestAsk > 0
      ? Math.max(0, (noSweep.averagePrice - noBestAsk) / noBestAsk)
      : 0;
  const avgSlippage = (yesSlippage + noSlippage) / 2;
  const slippageCap = Math.max(0, input.policy.fwSlippageToleranceBps) / 10000;
  const projectedEdge = Math.max(0, input.projectedEdge);
  const adaptivePenaltyScale = Math.max(
    input.policy.fwMinEdgeThreshold * 0.5,
    projectedEdge * 0.25,
    0.00001
  );
  const maxProjectionAgeMs = Math.max(1, input.policy.fwMaxProjectionAgeMs);
  const stalenessOverrunRatio = Math.max(
    0,
    (input.projectionAgeMs - maxProjectionAgeMs) / maxProjectionAgeMs
  );
  const stalenessPenalty = Math.min(1, stalenessOverrunRatio) * adaptivePenaltyScale * 0.5;
  const projectionAnchorMs = Math.min(input.yesBook.lastUpdateMs, input.noBook.lastUpdateMs);
  const stableSinceMs = Math.min(input.yesBook.stableSinceMs, input.noBook.stableSinceMs);
  const stabilityAgeMs = Math.max(0, projectionAnchorMs - stableSinceMs);
  const requiredStabilityMs = Math.max(0, input.policy.topOfBookStabilityMs);
  const stabilityDeficitRatio =
    requiredStabilityMs > 0
      ? Math.max(0, (requiredStabilityMs - stabilityAgeMs) / requiredStabilityMs)
      : 0;
  const stabilityPenalty = stabilityDeficitRatio * adaptivePenaltyScale * 0.5;
  const rawExecutionRiskBuffer = Math.max(0, input.policy.fwExecutionRiskBufferBps) / 10000;
  const executionRiskBuffer =
    input.projectedEdge > 0
      ? Math.min(
          rawExecutionRiskBuffer,
          Math.max(input.policy.fwMinEdgeThreshold * 0.25, adaptivePenaltyScale * 0.75)
        )
      : 0;
  return {
    theoreticalEdge: input.projectedEdge,
    feeCost: Math.max(0, input.policy.nearZeroFeeBps) / 10000,
    sweepSlippageCost: Math.min(avgSlippage, slippageCap),
    stalenessPenalty,
    stabilityPenalty,
    executionRiskBuffer
  };
}

function buildRelationViolationCandidates(
  entries: ProjectionUniverseEntry[],
  dependencyEdges: DependencyEdge[],
  policy: TradePolicy
): RelationViolationCandidate[] {
  const byMarketId = new Map(entries.map((entry) => [entry.marketId, entry]));
  const candidates: RelationViolationCandidate[] = [];
  const explicitPairKeys = new Set<string>();

  for (const edge of dependencyEdges) {
    const left = byMarketId.get(edge.marketA);
    const right = byMarketId.get(edge.marketB);
    if (!left || !right) continue;
    const signal = computeRelationViolationSignal(edge.relationType, left.yesPrice, right.yesPrice);
    if (signal <= 0) continue;
    candidates.push({
      relationId: dependencyEdgeKey(edge),
      relationType: edge.relationType,
      signal: signal * clamp01(edge.confidence),
      marketA: edge.marketA,
      marketB: edge.marketB
    });
    explicitPairKeys.add(marketPairKey(edge.marketA, edge.marketB));
  }

  const augmented = maybeAugmentSparseRelationCandidates({
    entries,
    candidates,
    explicitPairKeys,
    policy
  });

  return augmented.sort((left, right) => {
    if (right.signal !== left.signal) return right.signal - left.signal;
    return left.relationId.localeCompare(right.relationId);
  });
}

function maybeAugmentSparseRelationCandidates(input: {
  entries: ProjectionUniverseEntry[];
  candidates: RelationViolationCandidate[];
  explicitPairKeys: Set<string>;
  policy: TradePolicy;
}): RelationViolationCandidate[] {
  const { entries, candidates, explicitPairKeys, policy } = input;
  if (entries.length < 3) return candidates;
  const coveredMarkets = new Set<string>();
  for (const candidate of candidates) {
    coveredMarkets.add(candidate.marketA);
    coveredMarkets.add(candidate.marketB);
  }
  const coverage = entries.length > 0 ? coveredMarkets.size / entries.length : 0;
  const sparseExplicitCoverage = coverage < 0.35;
  if (!sparseExplicitCoverage) return candidates;

  const inferred = buildInferredSemanticRelationCandidates(entries, explicitPairKeys, policy);
  if (inferred.length === 0) return candidates;
  return [...candidates, ...inferred];
}

function buildInferredSemanticRelationCandidates(
  entries: ProjectionUniverseEntry[],
  explicitPairKeys: Set<string>,
  policy: TradePolicy
): RelationViolationCandidate[] {
  const descriptors = entries.map((entry) => ({
    marketId: entry.marketId,
    yesPrice: entry.yesPrice,
    category: normalizeSemanticValue(entry.pair.category),
    tags: normalizeSemanticTags(entry.pair.tags),
    questionTokens: tokenizeSemanticText(entry.pair.question)
  }));
  const signalScale = Math.min(0.03, Math.max(0.01, policy.fwMinEdgeThreshold * 12));
  const configuredTotalMax = Number.isFinite(policy.fwRelationCandidatesTotalMax)
    ? Math.max(1, Math.floor(policy.fwRelationCandidatesTotalMax))
    : entries.length * 3;
  const maxInferred = Math.max(
    1,
    Math.min(configuredTotalMax, entries.length * 3)
  );
  const inferred: RelationViolationCandidate[] = [];

  for (let i = 0; i < descriptors.length; i += 1) {
    for (let j = i + 1; j < descriptors.length; j += 1) {
      if (inferred.length >= maxInferred) break;
      const left = descriptors[i];
      const right = descriptors[j];
      const pairKey = marketPairKey(left.marketId, right.marketId);
      if (explicitPairKeys.has(pairKey)) continue;

      const affinity = computeSemanticAffinity(left, right);
      if (affinity < 0.35) continue;
      const confidence = Math.min(0.8, 0.35 + affinity * 0.45);
      const signal = affinity * signalScale * confidence;
      if (signal <= 0) continue;

      inferred.push({
        relationId: `inferred:${pairKey}:complementary`,
        relationType: 'complementary',
        signal,
        marketA: left.marketId,
        marketB: right.marketId
      });
    }
  }

  return inferred;
}

function computeSemanticAffinity(
  left: {
    yesPrice: number;
    category: string;
    tags: Set<string>;
    questionTokens: Set<string>;
  },
  right: {
    yesPrice: number;
    category: string;
    tags: Set<string>;
    questionTokens: Set<string>;
  }
): number {
  const sameCategory =
    left.category.length > 0 && right.category.length > 0 && left.category === right.category;
  const sharedTags = intersectionSize(left.tags, right.tags);
  const tagScore = sharedTags > 0 ? Math.min(1, sharedTags / 3) : 0;
  const questionOverlap = jaccardScore(left.questionTokens, right.questionTokens);
  const priceAffinity = Math.max(0, 1 - Math.min(1, Math.abs(left.yesPrice - right.yesPrice) / 0.2));
  if (!sameCategory && sharedTags === 0 && questionOverlap < 0.2) return 0;
  return Math.min(
    1,
    (sameCategory ? 0.25 : 0) +
      tagScore * 0.25 +
      questionOverlap * 0.35 +
      priceAffinity * 0.15 +
      (sharedTags > 0 ? 0.05 : 0)
  );
}

function marketPairKey(marketA: string, marketB: string): string {
  return marketA < marketB ? `${marketA}|${marketB}` : `${marketB}|${marketA}`;
}

function normalizeSemanticValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeSemanticTags(tags: string[] | null | undefined): Set<string> {
  if (!Array.isArray(tags)) return new Set();
  return new Set(
    tags
      .map((tag) => normalizeSemanticValue(tag))
      .filter((tag) => tag.length > 0)
  );
}

function tokenizeSemanticText(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') return new Set();
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return new Set(normalized);
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let count = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const token of smaller) {
    if (larger.has(token)) count += 1;
  }
  return count;
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = intersectionSize(left, right);
  if (intersection === 0) return 0;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function applyRelationSignals(
  entries: ProjectionUniverseEntry[],
  relationCandidates: RelationViolationCandidate[],
  policy: TradePolicy
): void {
  if (relationCandidates.length === 0) return;
  const perMarketMax = Math.max(1, Math.floor(policy.fwRelationCandidatesPerMarketMax));
  const totalMax = Math.max(1, Math.floor(policy.fwRelationCandidatesTotalMax));
  const byMarketId = new Map(entries.map((entry) => [entry.marketId, entry]));
  const perMarketCounts = new Map<string, number>();
  let accepted = 0;

  for (const candidate of relationCandidates) {
    if (accepted >= totalMax) break;
    const left = byMarketId.get(candidate.marketA);
    const right = byMarketId.get(candidate.marketB);
    if (!left || !right) continue;

    const leftCount = perMarketCounts.get(candidate.marketA) ?? 0;
    const rightCount = perMarketCounts.get(candidate.marketB) ?? 0;
    if (leftCount >= perMarketMax || rightCount >= perMarketMax) continue;

    left.relationSignal += candidate.signal;
    right.relationSignal += candidate.signal;
    left.relationIds.push(candidate.relationId);
    right.relationIds.push(candidate.relationId);
    if (!left.relationTypes.includes(candidate.relationType)) {
      left.relationTypes.push(candidate.relationType);
    }
    if (!right.relationTypes.includes(candidate.relationType)) {
      right.relationTypes.push(candidate.relationType);
    }
    left.rankingEdge = left.projectedEdge + left.relationSignal;
    right.rankingEdge = right.projectedEdge + right.relationSignal;
    perMarketCounts.set(candidate.marketA, leftCount + 1);
    perMarketCounts.set(candidate.marketB, rightCount + 1);
    accepted += 1;
  }
}

function computeRelationViolationSignal(
  relationType: DependencyRelation,
  leftYesPrice: number,
  rightYesPrice: number
): number {
  if (!Number.isFinite(leftYesPrice) || !Number.isFinite(rightYesPrice)) return 0;
  switch (relationType) {
    case 'mutual_exclusive':
      return Math.max(0, leftYesPrice + rightYesPrice - 1);
    case 'implies':
      return Math.max(0, leftYesPrice - rightYesPrice);
    case 'partition':
      return Math.abs(1 - (leftYesPrice + rightYesPrice));
    case 'complementary':
      return Math.abs(leftYesPrice - rightYesPrice);
    default:
      return 0;
  }
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
    minEdgeThreshold: policy.fwMinEdgeThreshold,
    lowerBoundTelemetry: emptyLowerBoundTelemetry()
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

  const scored = input.projectionUniverse
    .map((entry, index) => {
      const selectionWeight = clamp01(point[index] ?? 0);
      const theoreticalEdge = resolveExecutableTheoreticalEdge(entry);
      const lowerBound = computeExecutableLowerBound({
        ...entry.lowerBoundComponents,
        theoreticalEdge
      });
      const edgeLowerBound = lowerBound.edgeLowerBound;
      const theoreticalEdgeNonPositive = theoreticalEdge <= 0;
      const theoreticalEdgeBelowThreshold =
        theoreticalEdge > 0 && theoreticalEdge < policy.fwMinEdgeThreshold;
      const penaltyDrivenLowEdge =
        theoreticalEdge >= policy.fwMinEdgeThreshold && edgeLowerBound < policy.fwMinEdgeThreshold;
      return {
        ...entry,
        lowerBoundComponents: lowerBound.components,
        selectionWeight,
        edgeLowerBound,
        weightedEdgeLowerBound: edgeLowerBound * selectionWeight,
        lowWeight: selectionWeight < selectionWeightFloor,
        lowEdge: edgeLowerBound < policy.fwMinEdgeThreshold,
        theoreticalEdgeNonPositive,
        theoreticalEdgeBelowThreshold,
        penaltyDrivenLowEdge
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
  const lowerBoundTelemetry = summarizeLowerBoundTelemetry(scored, policy.fwMinEdgeThreshold);
  const edgeEligible = scored.filter((entry) => !entry.lowEdge);
  const selected = (
    selectionTopK > 0
      ? edgeEligible.slice(0, selectionTopK)
      : edgeEligible.filter((entry) => !entry.lowWeight)
  ).map(
    ({
      lowWeight: _lowWeight,
      lowEdge: _lowEdge,
      theoreticalEdgeNonPositive: _theoreticalEdgeNonPositive,
      theoreticalEdgeBelowThreshold: _theoreticalEdgeBelowThreshold,
      penaltyDrivenLowEdge: _penaltyDrivenLowEdge,
      ...candidate
    }) => candidate
  );

  return {
    candidates: selected,
    summary: {
      ...summaryBase,
      total: scored.length,
      selected: selected.length,
      rejectedByWeight,
      rejectedByLowerBound,
      rejectedByBoth,
      lowerBoundTelemetry
    }
  };
}

function emptyLowerBoundTelemetry(): CandidateSelectionSummary['lowerBoundTelemetry'] {
  return {
    average: {
      theoreticalEdge: 0,
      feeCost: 0,
      sweepSlippageCost: 0,
      stalenessPenalty: 0,
      stabilityPenalty: 0,
      executionRiskBuffer: 0,
      totalPenalty: 0,
      edgeLowerBound: 0,
      weightedEdgeLowerBound: 0,
      selectionWeight: 0
    },
    positiveLowerBoundCount: 0,
    nonPositiveLowerBoundCount: 0,
    rejectionSplit: {
      theoreticalEdgeNonPositive: 0,
      theoreticalEdgeBelowThreshold: 0,
      penaltyDrivenLowerBound: 0
    },
    dominantPenaltyCounts: {},
    rejectedDominantPenaltyCounts: {},
    penaltyRejectedDominantPenaltyCounts: {}
  };
}

function summarizeLowerBoundTelemetry(
  candidates: Array<
    ProjectionUniverseEntry & {
      selectionWeight: number;
      edgeLowerBound: number;
      weightedEdgeLowerBound: number;
      lowWeight: boolean;
      lowEdge: boolean;
      theoreticalEdgeNonPositive: boolean;
      theoreticalEdgeBelowThreshold: boolean;
      penaltyDrivenLowEdge: boolean;
    }
  >,
  minEdgeThreshold: number
): CandidateSelectionSummary['lowerBoundTelemetry'] {
  if (candidates.length === 0) return emptyLowerBoundTelemetry();

  const total = candidates.length;
  const averages = {
    theoreticalEdge: 0,
    feeCost: 0,
    sweepSlippageCost: 0,
    stalenessPenalty: 0,
    stabilityPenalty: 0,
    executionRiskBuffer: 0,
    totalPenalty: 0,
    edgeLowerBound: 0,
    weightedEdgeLowerBound: 0,
    selectionWeight: 0
  };
  let positiveLowerBoundCount = 0;
  let nonPositiveLowerBoundCount = 0;
  const rejectionSplit = {
    theoreticalEdgeNonPositive: 0,
    theoreticalEdgeBelowThreshold: 0,
    penaltyDrivenLowerBound: 0
  };
  const dominantPenaltyCounts: Record<string, number> = {};
  const rejectedDominantPenaltyCounts: Record<string, number> = {};
  const penaltyRejectedDominantPenaltyCounts: Record<string, number> = {};

  for (const candidate of candidates) {
    const components = candidate.lowerBoundComponents;
    const totalPenalty =
      components.feeCost +
      components.sweepSlippageCost +
      components.stalenessPenalty +
      components.stabilityPenalty +
      components.executionRiskBuffer;
    averages.theoreticalEdge += components.theoreticalEdge;
    averages.feeCost += components.feeCost;
    averages.sweepSlippageCost += components.sweepSlippageCost;
    averages.stalenessPenalty += components.stalenessPenalty;
    averages.stabilityPenalty += components.stabilityPenalty;
    averages.executionRiskBuffer += components.executionRiskBuffer;
    averages.totalPenalty += totalPenalty;
    averages.edgeLowerBound += candidate.edgeLowerBound;
    averages.weightedEdgeLowerBound += candidate.weightedEdgeLowerBound;
    averages.selectionWeight += candidate.selectionWeight;

    if (candidate.edgeLowerBound > 0) {
      positiveLowerBoundCount += 1;
    } else {
      nonPositiveLowerBoundCount += 1;
    }

    const dominantPenalty = dominantPenaltyComponent(components);
    dominantPenaltyCounts[dominantPenalty] = (dominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
    if (candidate.lowEdge) {
      rejectedDominantPenaltyCounts[dominantPenalty] =
        (rejectedDominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
      if (candidate.theoreticalEdgeNonPositive) {
        rejectionSplit.theoreticalEdgeNonPositive += 1;
      } else if (candidate.penaltyDrivenLowEdge) {
        rejectionSplit.penaltyDrivenLowerBound += 1;
        penaltyRejectedDominantPenaltyCounts[dominantPenalty] =
          (penaltyRejectedDominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
      } else {
        rejectionSplit.theoreticalEdgeBelowThreshold += 1;
      }
    } else if (
      candidate.lowerBoundComponents.theoreticalEdge > 0 &&
      candidate.lowerBoundComponents.theoreticalEdge < minEdgeThreshold
    ) {
      rejectionSplit.theoreticalEdgeBelowThreshold += 1;
    }
  }

  return {
    average: {
      theoreticalEdge: averages.theoreticalEdge / total,
      feeCost: averages.feeCost / total,
      sweepSlippageCost: averages.sweepSlippageCost / total,
      stalenessPenalty: averages.stalenessPenalty / total,
      stabilityPenalty: averages.stabilityPenalty / total,
      executionRiskBuffer: averages.executionRiskBuffer / total,
      totalPenalty: averages.totalPenalty / total,
      edgeLowerBound: averages.edgeLowerBound / total,
      weightedEdgeLowerBound: averages.weightedEdgeLowerBound / total,
      selectionWeight: averages.selectionWeight / total
    },
    positiveLowerBoundCount,
    nonPositiveLowerBoundCount,
    rejectionSplit,
    dominantPenaltyCounts,
    rejectedDominantPenaltyCounts,
    penaltyRejectedDominantPenaltyCounts
  };
}

function dominantPenaltyComponent(components: LowerBoundComponentBreakdown): string {
  const candidates: Array<[string, number]> = [
    ['fee_cost', components.feeCost],
    ['sweep_slippage_cost', components.sweepSlippageCost],
    ['staleness_penalty', components.stalenessPenalty],
    ['stability_penalty', components.stabilityPenalty],
    ['execution_risk_buffer', components.executionRiskBuffer]
  ];
  let winner: [string, number] = ['none', 0];
  for (const candidate of candidates) {
    if (candidate[1] > winner[1]) {
      winner = candidate;
    }
  }
  return winner[1] > 0 ? winner[0] : 'none';
}

function resolveExecutableTheoreticalEdge(entry: ProjectionUniverseEntry): number {
  if (entry.relationIds.length === 0) return entry.projectedEdge;
  return Math.max(entry.projectedEdge, computeRelationBackedExecutableEdge(entry));
}

function computeRelationBackedExecutableEdge(entry: ProjectionUniverseEntry): number {
  if (entry.relationSignal <= 0) return entry.projectedEdge;
  const confidenceFloor = Math.max(0.5, clamp01(entry.dependencyConfidence));
  const relationTypeScale = Math.min(1, 0.5 + entry.relationTypes.length * 0.25);
  return entry.relationSignal * confidenceFloor * relationTypeScale;
}

function filterExecutableBasketCandidates(
  candidates: ProjectionCandidate[],
  orderbooks: Map<string, OrderBookState>,
  policy: TradePolicy,
  nowMs: number
): BasketLegFilterResult {
  const executableCandidates: ProjectionCandidate[] = [];
  const rejectedCandidates: BasketLegFilterRejection[] = [];
  const reasonCounts: Record<string, number> = {};

  for (const candidate of candidates) {
    const yesBook = orderbooks.get(candidate.yesTokenId);
    const noBook = orderbooks.get(candidate.noTokenId);

    if (!yesBook || !noBook) {
      const reasons = ['missing_orderbook'];
      rejectedCandidates.push({ marketId: candidate.marketId, reasons });
      reasonCounts.missing_orderbook = (reasonCounts.missing_orderbook ?? 0) + 1;
      continue;
    }

    const decision = evaluateFwProjectionGates({
      yesBook,
      noBook,
      policy,
      nowMs,
      projection: {
        projectionId: candidate.marketId,
        dependencyMode: policy.fwDependencyMode,
        dependencyConfidence: candidate.dependencyConfidence,
        projectedEdge: candidate.projectedEdge,
        edgeLowerBound: candidate.edgeLowerBound,
        solverRuntimeMs: 0,
        solverStatus: 'optimal',
        projectionAgeMs: candidate.projectionAgeMs
      },
      tickSize: candidate.tickSize
    });

    if (decision.passed) {
      executableCandidates.push(candidate);
      continue;
    }

    const reasons = decision.reasons.length > 0 ? decision.reasons : ['unknown_rejection'];
    rejectedCandidates.push({ marketId: candidate.marketId, reasons });
    for (const reason of reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }

  return {
    executableCandidates,
    rejectedCandidates,
    reasonCounts
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
    tickSize: entry.tickSize,
    relationSignal: entry.relationSignal,
    relationIds: entry.relationIds,
    relationTypes: entry.relationTypes
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
    relationSignal: candidate.relationSignal,
    relationIds: candidate.relationIds,
    relationTypes: candidate.relationTypes,
    lowerBoundComponents: candidate.lowerBoundComponents,
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

function canProceedWithApproximateLoopIterate(loop: FwLoopResult): boolean {
  if (!loop.iterate) return false;
  return loop.diagnostics.terminalReason === 'max_iterations';
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
