import type { TradePolicy } from '../../config/policy.js';
import {
  dependencyEdgeKey,
  type DependencyEdge,
  type DependencyMarketInput,
  type DependencyRelation
} from '../../domain/dependency.js';
import { computeExecutableLowerBound, evaluateFwProjectionGates } from '../../domain/gates.js';
import type { MarketPair } from '../../domain/market.js';
import { depthAtTopLevels, sweepCost, type OrderBookState } from '../../domain/orderbook.js';
import {
  fwOpportunityId,
  type ArbitrageOpportunity,
  type FwProjectionMetadata
} from '../../domain/opportunity.js';
import type { FwLoopDiagnostics, FwLoopResult } from './fw/types.js';

interface LowerBoundComponentBreakdown {
  theoreticalEdge: number;
  feeCost: number;
  sweepSlippageCost: number;
  stalenessPenalty: number;
  stabilityPenalty: number;
  executionRiskBuffer: number;
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

interface RelationViolationCandidate {
  relationId: string;
  relationType: DependencyRelation;
  signal: number;
  marketA: string;
  marketB: string;
}

export function buildProjectionUniverse(input: {
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
    const lowerBound = computeExecutableLowerBound(
      estimateLowerBoundComponents({
        yesBook,
        noBook,
        policy: input.policy,
        projectedEdge: baseEdge,
        projectionAgeMs,
        desiredSize: minOrderSize
      })
    );

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
  applyRelationSignals(
    entries,
    buildRelationViolationCandidates(entries, input.dependencyEdges, input.policy),
    input.policy
  );
  return entries;
}

export function buildCandidatesFromIterate(input: {
  iterate: FwLoopResult;
  projectionUniverse: ProjectionUniverseEntry[];
  policy: TradePolicy;
}): CandidateSelectionResult {
  const { policy } = input;
  const selectionWeightFloor = Number.isFinite(policy.fwSelectionWeightFloor) ? policy.fwSelectionWeightFloor : 0.5;
  const selectionTopK = Number.isFinite(policy.fwSelectionTopK)
    ? Math.max(0, Math.floor(policy.fwSelectionTopK))
    : 0;
  const summaryBase: Omit<
    CandidateSelectionSummary,
    'total' | 'selected' | 'rejectedByWeight' | 'rejectedByLowerBound' | 'rejectedByBoth'
  > = {
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

  const scored = input.projectionUniverse
    .map((entry, index) => {
      const selectionWeight = clamp01(input.iterate.iterate?.point[index] ?? 0);
      const theoreticalEdge = resolveExecutableTheoreticalEdge(entry);
      const lowerBound = computeExecutableLowerBound({ ...entry.lowerBoundComponents, theoreticalEdge });
      const edgeLowerBound = lowerBound.edgeLowerBound;
      return {
        ...entry,
        lowerBoundComponents: lowerBound.components,
        selectionWeight,
        edgeLowerBound,
        weightedEdgeLowerBound: edgeLowerBound * selectionWeight,
        lowWeight: selectionWeight < selectionWeightFloor,
        lowEdge: edgeLowerBound < policy.fwMinEdgeThreshold,
        theoreticalEdgeNonPositive: theoreticalEdge <= 0,
        theoreticalEdgeBelowThreshold:
          theoreticalEdge > 0 && theoreticalEdge < policy.fwMinEdgeThreshold,
        penaltyDrivenLowEdge:
          theoreticalEdge >= policy.fwMinEdgeThreshold && edgeLowerBound < policy.fwMinEdgeThreshold
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
  const selected = (
    selectionTopK > 0
      ? scored.filter((entry) => !entry.lowEdge).slice(0, selectionTopK)
      : scored.filter((entry) => !entry.lowWeight && !entry.lowEdge)
  ).map((entry) => {
    const relationBackedEdge = computeRelationBackedExecutableEdge(entry);
    return {
      marketId: entry.marketId,
      yesTokenId: entry.yesTokenId,
      noTokenId: entry.noTokenId,
      variable: entry.variable,
      yesPrice: entry.yesPrice,
      noPrice: entry.noPrice,
      costPerSet: entry.costPerSet,
      rankingEdge: entry.rankingEdge,
      projectedEdge: entry.projectedEdge,
      dependencyConfidence: entry.dependencyConfidence,
      relationSignal: entry.relationSignal,
      relationIds: entry.relationIds,
      relationTypes: entry.relationTypes,
      lowerBoundComponents: entry.lowerBoundComponents,
      maxSizeByDepth: entry.maxSizeByDepth,
      minOrderSize: entry.minOrderSize,
      tickSize: entry.tickSize,
      projectionAgeMs: entry.projectionAgeMs,
      pair: entry.pair,
      selectionWeight: entry.selectionWeight,
      edgeLowerBound: relationBackedEdge,
      weightedEdgeLowerBound: relationBackedEdge * entry.selectionWeight
    };
  });

  return {
    candidates: selected,
    summary: {
      ...summaryBase,
      total: scored.length,
      selected: selected.length,
      rejectedByWeight,
      rejectedByLowerBound,
      rejectedByBoth,
      lowerBoundTelemetry: summarizeLowerBoundTelemetry(scored)
    }
  };
}

export function filterExecutableBasketCandidates(
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
    const gateDecision =
      yesBook && noBook
        ? evaluateFwProjectionGates({
            yesBook,
            noBook,
            policy,
            nowMs,
            projection: {
              projectionId: `${candidate.marketId}:basket`,
              dependencyMode: policy.fwDependencyMode,
              dependencyConfidence: candidate.dependencyConfidence,
              projectedEdge: candidate.projectedEdge,
              edgeLowerBound: candidate.edgeLowerBound,
              relationSignal: candidate.relationSignal,
              relationIds: candidate.relationIds,
              relationTypes: candidate.relationTypes,
              lowerBoundComponents: candidate.lowerBoundComponents,
              solverRuntimeMs: 0,
              solverStatus: 'feasible',
              projectionAgeMs: candidate.projectionAgeMs
            }
          })
        : { passed: false, reasons: ['missing_books'] };

    if (gateDecision.passed) {
      executableCandidates.push(candidate);
      continue;
    }

    rejectedCandidates.push({ marketId: candidate.marketId, reasons: gateDecision.reasons });
    for (const reason of gateDecision.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }

  return { executableCandidates, rejectedCandidates, reasonCounts };
}

export function buildBasketOpportunity(
  candidates: ProjectionCandidate[],
  policy: TradePolicy,
  nowMs: number,
  loop: FwLoopDiagnostics
): ArbitrageOpportunity | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((left, right) => right.edgeLowerBound - left.edgeLowerBound);
  const selected = sorted.slice(0, Math.max(policy.fwBasketMinMarkets, policy.fwBasketMaxMarkets));
  if (selected.length < Math.max(1, policy.fwBasketMinMarkets)) return null;

  const aggregateEdgeLowerBound = selected.reduce(
    (sum, candidate) => sum + candidate.edgeLowerBound,
    0
  );
  const aggregateProjectedEdge = selected.reduce(
    (sum, candidate) => sum + candidate.projectedEdge,
    0
  );
  const basketId = `fw-basket:${loop.loopId}:${nowMs}`;
  const first = selected[0];

  return {
    id: basketId,
    marketId: first.marketId,
    yesTokenId: first.yesTokenId,
    noTokenId: first.noTokenId,
    yesPrice: first.yesPrice,
    noPrice: first.noPrice,
    costPerSet: first.costPerSet,
    edge: aggregateEdgeLowerBound,
    tickSize: first.tickSize,
    maxSizeByDepth: Math.min(...selected.map((candidate) => candidate.maxSizeByDepth)),
    minOrderSize: Math.max(...selected.map((candidate) => candidate.minOrderSize)),
    detectedAt: nowMs,
    gateReasons: [],
    pair: first.pair,
    type: 'fw_basket',
    fw: toProjectionMetadata(first, nowMs, loop, policy),
    fwBasket: {
      basketId,
      executionMode: policy.fwBasketExecutionMode,
      aggregateEdgeLowerBound,
      aggregateProjectedEdge,
      markets: selected.map((candidate) => ({
        marketId: candidate.marketId,
        yesTokenId: candidate.yesTokenId,
        noTokenId: candidate.noTokenId,
        yesPrice: candidate.yesPrice,
        noPrice: candidate.noPrice,
        costPerSet: candidate.costPerSet,
        projectedEdge: candidate.projectedEdge,
        edgeLowerBound: candidate.edgeLowerBound,
        maxSizeByDepth: candidate.maxSizeByDepth,
        minOrderSize: candidate.minOrderSize,
        tickSize: candidate.tickSize,
        relationSignal: candidate.relationSignal,
        relationIds: candidate.relationIds,
        relationTypes: candidate.relationTypes
      })),
      loop
    }
  };
}

export function toSingleFwOpportunity(
  candidate: ProjectionCandidate,
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
    fw: toProjectionMetadata(candidate, nowMs, loop, policy)
  };
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
}): LowerBoundComponentBreakdown {
  const desiredSize = Math.max(input.desiredSize, 0);
  const yesSweep = desiredSize > 0 ? sweepCost(input.yesBook.asks, desiredSize) : null;
  const noSweep = desiredSize > 0 ? sweepCost(input.noBook.asks, desiredSize) : null;
  const yesBestAsk = input.yesBook.bestAsk?.price ?? 0;
  const noBestAsk = input.noBook.bestAsk?.price ?? 0;
  const yesSlippage =
    yesSweep && yesBestAsk > 0 ? Math.max(0, (yesSweep.averagePrice - yesBestAsk) / yesBestAsk) : 0;
  const noSlippage =
    noSweep && noBestAsk > 0 ? Math.max(0, (noSweep.averagePrice - noBestAsk) / noBestAsk) : 0;
  const adaptivePenaltyScale = Math.max(
    input.policy.fwMinEdgeThreshold * 0.5,
    Math.max(0, input.projectedEdge) * 0.25,
    0.00001
  );
  const maxProjectionAgeMs = Math.max(1, input.policy.fwMaxProjectionAgeMs);
  const projectionAnchorMs = Math.min(input.yesBook.lastUpdateMs, input.noBook.lastUpdateMs);
  const stableSinceMs = Math.min(input.yesBook.stableSinceMs, input.noBook.stableSinceMs);
  const requiredStabilityMs = Math.max(0, input.policy.topOfBookStabilityMs);
  const stabilityAgeMs = Math.max(0, projectionAnchorMs - stableSinceMs);
  const rawExecutionRiskBuffer = Math.max(0, input.policy.fwExecutionRiskBufferBps) / 10000;
  return {
    theoreticalEdge: input.projectedEdge,
    feeCost: Math.max(0, input.policy.nearZeroFeeBps) / 10000,
    sweepSlippageCost: Math.min(
      (yesSlippage + noSlippage) / 2,
      Math.max(0, input.policy.fwSlippageToleranceBps) / 10000
    ),
    stalenessPenalty:
      Math.min(
        1,
        Math.max(0, (input.projectionAgeMs - maxProjectionAgeMs) / maxProjectionAgeMs)
      ) *
      adaptivePenaltyScale *
      0.5,
    stabilityPenalty:
      (requiredStabilityMs > 0
        ? Math.max(0, (requiredStabilityMs - stabilityAgeMs) / requiredStabilityMs)
        : 0) *
      adaptivePenaltyScale *
      0.5,
    executionRiskBuffer:
      input.projectedEdge > 0
        ? Math.min(
            rawExecutionRiskBuffer,
            Math.max(input.policy.fwMinEdgeThreshold * 0.25, adaptivePenaltyScale * 0.75)
          )
        : 0
  };
}

function buildRelationViolationCandidates(
  entries: ProjectionUniverseEntry[],
  dependencyEdges: DependencyEdge[],
  policy: TradePolicy
): RelationViolationCandidate[] {
  const byMarketId = new Map(entries.map((entry) => [entry.marketId, entry]));
  const explicitPairKeys = new Set<string>();
  const candidates: RelationViolationCandidate[] = [];

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

  return maybeAugmentSparseRelationCandidates(entries, candidates, explicitPairKeys, policy).sort(
    (left, right) => {
      if (right.signal !== left.signal) return right.signal - left.signal;
      return left.relationId.localeCompare(right.relationId);
    }
  );
}

function maybeAugmentSparseRelationCandidates(
  entries: ProjectionUniverseEntry[],
  candidates: RelationViolationCandidate[],
  explicitPairKeys: Set<string>,
  policy: TradePolicy
): RelationViolationCandidate[] {
  if (entries.length < 3) return candidates;
  const coveredMarkets = new Set<string>();
  for (const candidate of candidates) {
    coveredMarkets.add(candidate.marketA);
    coveredMarkets.add(candidate.marketB);
  }
  if ((entries.length > 0 ? coveredMarkets.size / entries.length : 0) >= 0.35) return candidates;
  const inferred = buildInferredSemanticRelationCandidates(entries, explicitPairKeys, policy);
  return inferred.length === 0 ? candidates : [...candidates, ...inferred];
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
  const maxInferred = Math.max(1, Math.min(configuredTotalMax, entries.length * 3));
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
  left: { yesPrice: number; category: string; tags: Set<string>; questionTokens: Set<string> },
  right: { yesPrice: number; category: string; tags: Set<string>; questionTokens: Set<string> }
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

function normalizeSemanticValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeSemanticTags(tags: string[] | null | undefined): Set<string> {
  if (!Array.isArray(tags)) return new Set();
  return new Set(
    tags.map((tag) => normalizeSemanticValue(tag)).filter((tag) => tag.length > 0)
  );
}

function tokenizeSemanticText(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
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
    if (!left.relationTypes.includes(candidate.relationType)) left.relationTypes.push(candidate.relationType);
    if (!right.relationTypes.includes(candidate.relationType)) right.relationTypes.push(candidate.relationType);
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
  scored: Array<
    ProjectionCandidate & {
      lowWeight: boolean;
      lowEdge: boolean;
      theoreticalEdgeNonPositive: boolean;
      theoreticalEdgeBelowThreshold: boolean;
      penaltyDrivenLowEdge: boolean;
    }
  >
): CandidateSelectionSummary['lowerBoundTelemetry'] {
  if (scored.length === 0) return emptyLowerBoundTelemetry();

  const average = scored.reduce(
    (sum, entry) => {
      const totalPenalty =
        entry.lowerBoundComponents.feeCost +
        entry.lowerBoundComponents.sweepSlippageCost +
        entry.lowerBoundComponents.stalenessPenalty +
        entry.lowerBoundComponents.stabilityPenalty +
        entry.lowerBoundComponents.executionRiskBuffer;
      return {
        theoreticalEdge: sum.theoreticalEdge + entry.lowerBoundComponents.theoreticalEdge,
        feeCost: sum.feeCost + entry.lowerBoundComponents.feeCost,
        sweepSlippageCost: sum.sweepSlippageCost + entry.lowerBoundComponents.sweepSlippageCost,
        stalenessPenalty: sum.stalenessPenalty + entry.lowerBoundComponents.stalenessPenalty,
        stabilityPenalty: sum.stabilityPenalty + entry.lowerBoundComponents.stabilityPenalty,
        executionRiskBuffer: sum.executionRiskBuffer + entry.lowerBoundComponents.executionRiskBuffer,
        totalPenalty: sum.totalPenalty + totalPenalty,
        edgeLowerBound: sum.edgeLowerBound + entry.edgeLowerBound,
        weightedEdgeLowerBound:
          sum.weightedEdgeLowerBound + entry.weightedEdgeLowerBound,
        selectionWeight: sum.selectionWeight + entry.selectionWeight
      };
    },
    emptyLowerBoundTelemetry().average
  );
  const positiveLowerBoundCount = scored.filter((entry) => entry.edgeLowerBound > 0).length;
  const nonPositiveLowerBoundCount = scored.length - positiveLowerBoundCount;
  const dominantPenaltyCounts: Record<string, number> = {};
  const rejectedDominantPenaltyCounts: Record<string, number> = {};
  const penaltyRejectedDominantPenaltyCounts: Record<string, number> = {};

  for (const entry of scored) {
    const dominantPenalty = dominantPenaltyComponent(entry.lowerBoundComponents);
    dominantPenaltyCounts[dominantPenalty] = (dominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
    if (entry.lowEdge) {
      rejectedDominantPenaltyCounts[dominantPenalty] =
        (rejectedDominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
    }
    if (entry.penaltyDrivenLowEdge) {
      penaltyRejectedDominantPenaltyCounts[dominantPenalty] =
        (penaltyRejectedDominantPenaltyCounts[dominantPenalty] ?? 0) + 1;
    }
  }

  return {
    average: Object.fromEntries(
      Object.entries(average).map(([key, value]) => [key, value / scored.length])
    ) as CandidateSelectionSummary['lowerBoundTelemetry']['average'],
    positiveLowerBoundCount,
    nonPositiveLowerBoundCount,
    rejectionSplit: {
      theoreticalEdgeNonPositive: scored.filter((entry) => entry.theoreticalEdgeNonPositive).length,
      theoreticalEdgeBelowThreshold: scored.filter(
        (entry) => entry.theoreticalEdgeBelowThreshold
      ).length,
      penaltyDrivenLowerBound: scored.filter((entry) => entry.penaltyDrivenLowEdge).length
    },
    dominantPenaltyCounts,
    rejectedDominantPenaltyCounts,
    penaltyRejectedDominantPenaltyCounts
  };
}

function dominantPenaltyComponent(components: LowerBoundComponentBreakdown): string {
  const candidates = [
    ['feeCost', components.feeCost],
    ['sweepSlippageCost', components.sweepSlippageCost],
    ['stalenessPenalty', components.stalenessPenalty],
    ['stabilityPenalty', components.stabilityPenalty],
    ['executionRiskBuffer', components.executionRiskBuffer]
  ] as const;
  const dominant = candidates.reduce(
    (best, candidate) => (candidate[1] > best[1] ? candidate : best),
    candidates[0]
  );
  return dominant[1] > 0 ? dominant[0] : 'none';
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

function toProjectionMetadata(
  candidate: ProjectionCandidate,
  nowMs: number,
  loop: FwLoopDiagnostics,
  policy: TradePolicy
): FwProjectionMetadata {
  return {
    projectionId: `${candidate.marketId}:${loop.loopId}`,
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
    projectionAgeMs: Math.max(0, nowMs - (nowMs - candidate.projectionAgeMs)),
    loop
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function variableNameForMarket(marketId: string): string {
  return `x_${marketId}`;
}

function marketPairKey(marketA: string, marketB: string): string {
  return marketA < marketB ? `${marketA}|${marketB}` : `${marketB}|${marketA}`;
}
