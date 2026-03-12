import type { TradePolicy } from '../config/policy.js';
import type { OrderBookState } from './orderbook.js';
import { depthAtTopLevels, isAlignedToTick, spread } from './orderbook.js';

interface ExecutableLowerBoundInputs {
  theoreticalEdge: number;
  feeCost: number;
  sweepSlippageCost: number;
  stalenessPenalty: number;
  stabilityPenalty: number;
  executionRiskBuffer: number;
}

interface ExecutableLowerBoundResult {
  edgeLowerBound: number;
  components: {
    theoreticalEdge: number;
    feeCost: number;
    sweepSlippageCost: number;
    stalenessPenalty: number;
    stabilityPenalty: number;
    executionRiskBuffer: number;
  };
}

interface BaseGateEvaluation {
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
  tickDiagnostics?: {
    yes: { price: number; tickSize: number; aligned: boolean };
    no: { price: number; tickSize: number; aligned: boolean };
  };
}

function computeExecutableLowerBound(
  input: ExecutableLowerBoundInputs
): ExecutableLowerBoundResult {
  const components = {
    theoreticalEdge: ensureFinite(input.theoreticalEdge),
    feeCost: clampNonNegative(input.feeCost),
    sweepSlippageCost: clampNonNegative(input.sweepSlippageCost),
    stalenessPenalty: clampNonNegative(input.stalenessPenalty),
    stabilityPenalty: clampNonNegative(input.stabilityPenalty),
    executionRiskBuffer: clampNonNegative(input.executionRiskBuffer)
  };
  return {
    edgeLowerBound:
      components.theoreticalEdge -
      components.feeCost -
      components.sweepSlippageCost -
      components.stalenessPenalty -
      components.stabilityPenalty -
      components.executionRiskBuffer,
    components
  };
}

function evaluateBaseGates(input: {
  yesBook: OrderBookState;
  noBook: OrderBookState;
  policy: TradePolicy;
  nowMs: number;
}): BaseGateEvaluation {
  const { yesBook, noBook, policy, nowMs } = input;
  const reasons: string[] = [];
  const emptyResult = {
    yesAskPrice: 0,
    noAskPrice: 0,
    yesStalenessMs: 0,
    noStalenessMs: 0,
    legSkewMs: 0,
    depthLevels: Math.max(1, Math.floor(policy.minDepthLevels)),
    depthAtLevels: { yes: 0, no: 0 },
    minOrderSize: 0
  };

  if (!yesBook.bestAsk || !noBook.bestAsk) {
    return { fatal: true, reasons: ['missing_best_ask'], ...emptyResult };
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
    return { fatal: true, reasons, ...emptyResult, yesAskPrice, noAskPrice };
  }

  const yesBidPrice = yesBook.bestBid?.price;
  const noBidPrice = noBook.bestBid?.price;
  if (typeof yesBidPrice === 'number' && Number.isFinite(yesBidPrice) && yesBidPrice > yesAskPrice) {
    reasons.push('yes_book_crossed');
  }
  if (typeof noBidPrice === 'number' && Number.isFinite(noBidPrice) && noBidPrice > noAskPrice) {
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

  if (
    nowMs - yesBook.stableSinceMs < policy.topOfBookStabilityMs ||
    nowMs - noBook.stableSinceMs < policy.topOfBookStabilityMs
  ) {
    reasons.push('unstable_top_of_book');
  }

  const yesTickAligned = isAlignedToTick(yesAskPrice, yesBook.tickSize);
  const noTickAligned = isAlignedToTick(noAskPrice, noBook.tickSize);
  if (!yesTickAligned) reasons.push('yes_tick_misaligned');
  if (!noTickAligned) reasons.push('no_tick_misaligned');

  const depthLevels = Math.max(1, Math.floor(policy.minDepthLevels));
  const depthAtLevels = {
    yes: depthAtTopLevels(yesBook.asks, depthLevels),
    no: depthAtTopLevels(noBook.asks, depthLevels)
  };

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
    minOrderSize: Math.max(yesBook.minOrderSize, noBook.minOrderSize),
    tickDiagnostics:
      !yesTickAligned || !noTickAligned
        ? {
            yes: { price: yesAskPrice, tickSize: yesBook.tickSize, aligned: yesTickAligned },
            no: { price: noAskPrice, tickSize: noBook.tickSize, aligned: noTickAligned }
          }
        : undefined
  };
}

function resolveTickSize(...candidates: Array<number | undefined>): number {
  const valid = candidates.filter(
    (candidate): candidate is number =>
      typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
  );
  return valid.length === 0 ? 0 : Math.max(...valid);
}

function ensureFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export { computeExecutableLowerBound, evaluateBaseGates, resolveTickSize };
