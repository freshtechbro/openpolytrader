import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import { computeDependencyGraphQualityStats, type DependencyMarketInput } from '../../domain/dependency.js';
import type { MarketPair } from '../../domain/market.js';
import type { OrderBookState } from '../../domain/orderbook.js';
import type { ArbitrageOpportunity, FwProjectionMetadata } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { DependencyResolver, type DependencyResolverConfig } from '../dependency/DependencyResolver.js';
import { IpOracleClient, type IpOracleRequest, type IpOracleResponse } from '../../services/ip-oracle/IpOracleClient.js';
import {
  buildBasketOpportunity,
  buildCandidatesFromIterate,
  buildConstraintRows,
  buildOracleRequest,
  buildProjectionUniverse,
  canProceedWithApproximateLoopIterate,
  emitLoopDiagnostics,
  filterExecutableBasketCandidates,
  mapNonConvergedReason,
  toLoopPolicy,
  toSingleFwOpportunity
} from './FwProjectionAgentSupport.js';
import { FwLoopEngine } from './fw/FwLoopEngine.js';
import type { FwLoopDiagnostics } from './fw/types.js';

interface FwProjectionAgentConfig {
  resolverConfig: DependencyResolverConfig;
  oracleClient: IpOracleClient;
  metrics?: MetricsStore;
}

interface FwProjectionInput {
  pair: MarketPair;
  yesBook: OrderBookState;
  noBook: OrderBookState;
  orderbooks?: Map<string, OrderBookState>;
  policy: TradePolicy;
  nowMs: number;
  marketUniverse?: DependencyMarketInput[];
}

interface FwProjectionResult {
  opportunity: ArbitrageOpportunity | null;
  reason?: string;
  metadata?: FwProjectionMetadata;
}

interface FwUniverseProjectionInput {
  policy: TradePolicy;
  nowMs: number;
  orderbooks: Map<string, OrderBookState>;
  marketUniverse: DependencyMarketInput[];
  allowBasket?: boolean;
}

interface FwUniverseProjectionResult {
  opportunities: ArbitrageOpportunity[];
  reason?: string;
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
        confidenceMin: dependencyEdges.length > 0 ? Math.min(...dependencyEdges.map((edge) => edge.confidence)) : 1,
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
    const loop = await this.loopEngine.run({
      loopId,
      variableOrder: variables,
      edgeCoefficients: projectionUniverse.map((entry) => entry.rankingEdge),
      policy: toLoopPolicy(policy),
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
        const response = await this.solveOracleWithConcurrency(oracleRequest, nowMs, policy.fwOracleMaxConcurrency);
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
    if (!loop.iterate) return { opportunities: [], reason: loop.reason ?? 'oracle_unavailable' };

    if (!loop.diagnostics.converged) {
      if (policy.fwRequireConverged) {
        const reason = 'projection_requires_converged';
        this.metrics?.record({
          type: 'fw_projection',
          timestamp: nowMs,
          data: {
            event: 'projection_rejected',
            marketId: projectionUniverse[0]?.marketId ?? 'unknown',
            reason,
            loopId: loop.diagnostics.loopId,
            terminalReason: loop.diagnostics.terminalReason,
            runtimeMs: loop.diagnostics.runtimeMs,
            iterationCount: loop.diagnostics.iterationCount
          }
        });
        return { opportunities: [], reason };
      }

      if (!canProceedWithApproximateLoopIterate(loop)) {
        const reason = mapNonConvergedReason(loop.diagnostics);
        this.metrics?.record({
          type: 'fw_projection',
          timestamp: nowMs,
          data: {
            event: 'projection_rejected',
            marketId: projectionUniverse[0]?.marketId ?? 'unknown',
            reason,
            loopId: loop.diagnostics.loopId,
            terminalReason: loop.diagnostics.terminalReason,
            runtimeMs: loop.diagnostics.runtimeMs,
            iterationCount: loop.diagnostics.iterationCount
          }
        });
        return { opportunities: [], reason };
      }

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

    const candidateSelection = buildCandidatesFromIterate({ iterate: loop, projectionUniverse, policy });
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
        relation_backed_selected: candidateSelection.candidates.filter((candidate) => candidate.relationIds.length > 0).length,
        relation_signaled_selected: candidateSelection.candidates.filter((candidate) => candidate.relationSignal > 0).length,
        rejection_split: candidateSelection.summary.lowerBoundTelemetry.rejectionSplit,
        lower_bound_telemetry: candidateSelection.summary.lowerBoundTelemetry
      }
    });
    if (candidateSelection.candidates.length === 0) {
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

    const basketCandidates = allowBasket
      ? this.filterBasketCandidates(candidateSelection.candidates, orderbooks, policy, nowMs, loop.diagnostics)
      : candidateSelection.candidates;
    const basket = allowBasket ? buildBasketOpportunity(basketCandidates, policy, nowMs, loop.diagnostics) : null;
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

    const single = basketCandidates[0] ?? null;
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

  private filterBasketCandidates(
    candidates: Awaited<ReturnType<typeof buildCandidatesFromIterate>>['candidates'],
    orderbooks: Map<string, OrderBookState>,
    policy: TradePolicy,
    nowMs: number,
    loop: FwLoopDiagnostics
  ) {
    const basketLegFilter = filterExecutableBasketCandidates(candidates, orderbooks, policy, nowMs, loop);
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
    return basketLegFilter.executableCandidates;
  }

  private emitConvergedZeroIntentAlert(nowMs: number, diagnostics: FwLoopDiagnostics, marketCount: number): void {
    if (!this.metrics || !diagnostics.converged) return;
    if (nowMs - this.lastConvergedZeroIntentAlertAtMs < FwProjectionAgent.CONVERGED_ZERO_INTENT_ALERT_COOLDOWN_MS) {
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
