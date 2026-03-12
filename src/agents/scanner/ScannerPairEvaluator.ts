import type { TradePolicy } from '../../config/policy.js';
import { evaluateEvGates, evaluateGatesWithFees } from '../../domain/gates.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity, evOpportunityId, opportunityId } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { clamp01 } from '../../utils/math.js';
import { normalizeReasonKey, shouldEmitScopedReason } from '../../utils/eventDedupe.js';
import type { ScannerInsight } from './ScannerOpportunityScorer.js';

export const REJECTION_EMISSION_COOLDOWN_MS = 3000;

type EmissionState = Map<string, { reasonKey: string; timestampMs: number }>;

interface ScannerPairEvaluatorArgs {
  pair: MarketPair;
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  nearZeroFeeModel: ReturnType<typeof import('../../domain/feeModel.js').createUniformTakerFeeModel>;
  metrics?: MetricsStore;
  gateRejectionEmissionState: EmissionState;
  evSignalEmissionState: EmissionState;
  lastEvOpportunityAt: Map<string, number>;
  getInsight: (marketId: string, nowMs: number) => ScannerInsight | null;
}

export function evaluateScannerPair({
  pair,
  yesBook,
  noBook,
  policy,
  nowMs,
  nearZeroFeeModel,
  metrics,
  gateRejectionEmissionState,
  evSignalEmissionState,
  lastEvOpportunityAt,
  getInsight
}: ScannerPairEvaluatorArgs): ArbitrageOpportunity | null {
  const allowNearZero = policy.signalMode !== 'ev';
  const allowEv = policy.signalMode !== 'near_zero';

  let nearZeroOpportunity: ArbitrageOpportunity | null = null;
  if (allowNearZero) {
    const gateDecision = evaluateGatesWithFees({
      yesBook,
      noBook,
      policy,
      nowMs,
      venue: 'polymarket',
      feeModel: nearZeroFeeModel
    });

    if (!gateDecision.passed) {
      const reasonKey = normalizeReasonKey(gateDecision.reasons);
      if (
        shouldEmitScopedReason(
          gateRejectionEmissionState,
          pair.marketId,
          reasonKey,
          nowMs,
          REJECTION_EMISSION_COOLDOWN_MS
        )
      ) {
        metrics?.record({
          type: 'gate_rejection',
          timestamp: nowMs,
          data: {
            opportunityId: buildGateOpportunityId(pair, yesBook, noBook, nowMs),
            marketId: pair.marketId,
            reasons: gateDecision.reasons,
            gateDecision
          }
        });
      }
    } else {
      const bestYes = yesBook.bestAsk!;
      const bestNo = noBook.bestAsk!;
      const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);
      const tickSize = Math.max(yesBook.tickSize, noBook.tickSize);

      nearZeroOpportunity = {
        id: opportunityId(pair.marketId, bestYes.price, bestNo.price, nowMs),
        marketId: pair.marketId,
        yesTokenId: pair.yesTokenId,
        noTokenId: pair.noTokenId,
        yesPrice: bestYes.price,
        noPrice: bestNo.price,
        costPerSet: gateDecision.costPerSet,
        edge: gateDecision.edge,
        tickSize,
        maxSizeByDepth: gateDecision.maxSizeByDepth,
        minOrderSize,
        detectedAt: nowMs,
        gateReasons: gateDecision.reasons,
        pair,
        type: 'near_zero'
      };
    }
  }

  const evOpportunity = allowEv
    ? buildEvOpportunity({
        pair,
        yesBook,
        noBook,
        policy,
        nowMs,
        metrics,
        evSignalEmissionState,
        lastEvOpportunityAt,
        getInsight
      })
    : null;

  if (nearZeroOpportunity && evOpportunity) {
    if (evOpportunity.edge > nearZeroOpportunity.edge) {
      lastEvOpportunityAt.set(pair.marketId, nowMs);
      return evOpportunity;
    }
    return nearZeroOpportunity;
  }

  if (evOpportunity) {
    lastEvOpportunityAt.set(pair.marketId, nowMs);
    return evOpportunity;
  }

  return nearZeroOpportunity;
}

interface EvOpportunityArgs {
  pair: MarketPair;
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
  metrics?: MetricsStore;
  evSignalEmissionState: EmissionState;
  lastEvOpportunityAt: Map<string, number>;
  getInsight: (marketId: string, nowMs: number) => ScannerInsight | null;
}

function buildEvOpportunity({
  pair,
  yesBook,
  noBook,
  policy,
  nowMs,
  metrics,
  evSignalEmissionState,
  lastEvOpportunityAt,
  getInsight
}: EvOpportunityArgs): ArbitrageOpportunity | null {
  const insight = getInsight(pair.marketId, nowMs);
  const signalConfidence = insight?.confidence ?? 0;
  const hasSignal = typeof insight?.value === 'number' && Number.isFinite(insight.value);
  const signalAllowed = hasSignal && signalConfidence >= policy.evModelConfidenceFloor;
  const pSignal = signalAllowed ? clamp01(insight!.value) : undefined;

  if (policy.evModelMode === 'llm_only' && pSignal === undefined) {
    emitEvSignal(metrics, evSignalEmissionState, {
      scope: `${pair.marketId}:na`,
      marketId: pair.marketId,
      nowMs,
      reason: 'ev_missing_signal'
    });
    return null;
  }

  const pMarket = computeMarketPrior(yesBook, noBook);
  const pFinal = computeFinalProbability(pMarket, pSignal, signalConfidence, policy);

  const yesAsk = yesBook.bestAsk?.price;
  const noAsk = noBook.bestAsk?.price;
  if (!Number.isFinite(yesAsk) || !Number.isFinite(noAsk)) return null;

  const evYes = pFinal - yesAsk!;
  const evNo = (1 - pFinal) - noAsk!;
  const side: 'yes' | 'no' = evYes >= evNo ? 'yes' : 'no';
  const evRaw = side === 'yes' ? evYes : evNo;
  const slippageEstimate = policy.entrySlippageToleranceBps / 10000;
  const feeEstimate = Math.max(policy.evFeeBps, 0) / 10000;
  const evNet = evRaw - feeEstimate - slippageEstimate;
  const modelConfidence = clamp01(signalAllowed ? signalConfidence : 0);

  const lastEvAt = lastEvOpportunityAt.get(pair.marketId) ?? 0;
  if (policy.evCooldownSeconds > 0 && nowMs - lastEvAt < policy.evCooldownSeconds * 1000) {
    emitEvSignal(metrics, evSignalEmissionState, {
      scope: `${pair.marketId}:${side}`,
      marketId: pair.marketId,
      nowMs,
      side,
      evNet,
      confidence: modelConfidence,
      reason: 'ev_cooldown'
    });
    return null;
  }

  const gateDecision = evaluateEvGates({
    yesBook,
    noBook,
    policy,
    nowMs,
    side,
    evEdge: evNet,
    confidence: modelConfidence
  });

  if (!gateDecision.passed) {
    emitEvSignal(metrics, evSignalEmissionState, {
      scope: `${pair.marketId}:${side}`,
      marketId: pair.marketId,
      nowMs,
      side,
      evNet,
      confidence: modelConfidence,
      reason: gateDecision.reasons
    });
    return null;
  }

  const price = side === 'yes' ? yesAsk! : noAsk!;
  const minOrderSize = Math.max(side === 'yes' ? yesBook.minOrderSize : noBook.minOrderSize, 0);
  const tickSize = Math.max(yesBook.tickSize, noBook.tickSize);

  metrics?.record({
    type: 'ev_signal',
    timestamp: nowMs,
    data: { marketId: pair.marketId, side, evNet, confidence: modelConfidence, reason: 'ev_selected' }
  });

  return {
    id: evOpportunityId(pair.marketId, side, price, pFinal, nowMs),
    marketId: pair.marketId,
    yesTokenId: pair.yesTokenId,
    noTokenId: pair.noTokenId,
    yesPrice: yesAsk!,
    noPrice: noAsk!,
    costPerSet: price,
    edge: evNet,
    tickSize,
    maxSizeByDepth: gateDecision.maxSizeByDepth,
    minOrderSize,
    detectedAt: nowMs,
    gateReasons: gateDecision.reasons,
    pair,
    type: 'ev',
    side,
    pFinal,
    evRaw,
    evNet,
    modelConfidence
  };
}

interface EvSignalEmissionArgs {
  scope: string;
  marketId: string;
  nowMs: number;
  reason: string | string[];
  side?: 'yes' | 'no';
  evNet?: number;
  confidence?: number;
}

function emitEvSignal(
  metrics: MetricsStore | undefined,
  emissionState: EmissionState,
  { scope, marketId, nowMs, reason, side, evNet, confidence }: EvSignalEmissionArgs
): void {
  const reasonKey = normalizeReasonKey(reason);
  if (!shouldEmitScopedReason(emissionState, scope, reasonKey, nowMs, REJECTION_EMISSION_COOLDOWN_MS)) return;

  metrics?.record({
    type: 'ev_signal',
    timestamp: nowMs,
    data: { marketId, side, evNet, confidence, reason }
  });
}

function computeMarketPrior(yesBook: OrderBookState, noBook: OrderBookState): number {
  const yesAsk = yesBook.bestAsk?.price ?? 0;
  const yesBid = yesBook.bestBid?.price ?? yesAsk;
  const noAsk = noBook.bestAsk?.price ?? 0;
  const noBid = noBook.bestBid?.price ?? noAsk;
  const yesMid = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : yesAsk || yesBid || 0.5;
  const noMid = noAsk > 0 && noBid > 0 ? (noAsk + noBid) / 2 : noAsk || noBid || 0.5;
  return clamp01((yesMid + (1 - noMid)) / 2);
}

function computeFinalProbability(
  pMarket: number,
  pSignal: number | undefined,
  confidence: number,
  policy: TradePolicy
): number {
  const w = clamp01(confidence);
  let combined = pMarket;

  if (policy.evModelMode === 'llm_only') {
    combined = pSignal ?? pMarket;
  } else if (policy.evModelMode === 'hybrid') {
    combined = pSignal === undefined ? pMarket : (1 - w) * pMarket + w * pSignal;
  }

  const clamped = clamp01(combined);
  const logit = toLogit(clamped);

  if (policy.evCalibrationMethod === 'temperature') {
    return clamp01(sigmoid(logit / 1.5));
  }

  if (policy.evCalibrationMethod === 'sigmoid') {
    return clamp01(sigmoid(logit * 0.9));
  }

  return clamped;
}

function toLogit(p: number): number {
  const bounded = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(bounded / (1 - bounded));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function buildGateOpportunityId(
  pair: MarketPair,
  yesBook: OrderBookState,
  noBook: OrderBookState,
  nowMs: number
): string {
  if (yesBook.bestAsk && noBook.bestAsk) {
    return opportunityId(pair.marketId, yesBook.bestAsk.price, noBook.bestAsk.price, nowMs);
  }
  return `${pair.marketId}:gate-rejection:${nowMs}`;
}
