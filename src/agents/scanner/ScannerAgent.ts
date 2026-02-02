import type { TradePolicy } from '../../config/policy.js';
import type { TradingMode } from '../../config/env.js';
import { MarketAllowlist } from '../../domain/allowlist.js';
import { evaluateEvGates, evaluateGates } from '../../domain/gates.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity, evOpportunityId, opportunityId } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';
import { ScannerScoreSchema } from '../../domain/llm.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import { safeParseJSON } from '../../utils/serialization.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { clamp01 } from '../../utils/math.js';

export interface ScannerAgentConfig {
  tradingMode?: TradingMode;
  metrics?: MetricsStore;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: 'ScannerAgent', request: LLMRequest) => Promise<LLMCallResult> };
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
}

export class ScannerAgent {
  private tradingMode: TradingMode;
  private metrics?: MetricsStore;
  private store?: EventStore;
  private llm?: NonNullable<ScannerAgentConfig['llm']>;
  private insightHandler: ((payload: unknown) => void) | null = null;
  private insightsByMarketId = new Map<string, { market_id: string; signal: string; value: number; ttl_ms: number; confidence: number; expiresAtMs: number }>();
  private shadowScoringInFlight = false;
  private lastShadowScoringStartAtMs = 0;
  private lastEvOpportunityAt = new Map<string, number>();

  constructor(
    private policy: TradePolicy,
    private allowlist: MarketAllowlist,
    config?: ScannerAgentConfig
  ) {
    this.tradingMode = config?.tradingMode ?? 'off';
    this.metrics = config?.metrics;
    this.store = config?.eventStore;
    this.llm = config?.llm;

    this.insightHandler = (payload) => {
      const parsed = payload as { insights?: Array<{ market_id: string; signal: string; value: number; ttl_ms: number; confidence: number }> };
      if (!Array.isArray(parsed.insights)) return;
      const nowMs = Date.now();
      for (const insight of parsed.insights) {
        if (!insight || typeof insight.market_id !== 'string' || insight.market_id.length === 0) continue;
        if (typeof insight.ttl_ms !== 'number' || !Number.isFinite(insight.ttl_ms) || insight.ttl_ms <= 0) continue;
        if (typeof insight.value !== 'number' || !Number.isFinite(insight.value)) continue;
        if (typeof insight.confidence !== 'number' || !Number.isFinite(insight.confidence)) continue;
        this.insightsByMarketId.set(insight.market_id, { ...insight, expiresAtMs: nowMs + insight.ttl_ms });
      }
    };
    messageBus.on('learning:insight', this.insightHandler);
  }

  stop(): void {
    if (this.insightHandler) {
      messageBus.off('learning:insight', this.insightHandler);
      this.insightHandler = null;
    }
  }

  updateTradingMode(mode: TradingMode): void {
    this.tradingMode = mode;
  }

  async prioritizeOpportunities(
    opportunities: ArbitrageOpportunity[],
    nowMs = Date.now()
  ): Promise<ArbitrageOpportunity[]> {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return opportunities;

    const mode = llm.config.agents.ScannerAgent.mode;
    if (mode === 'disabled') return opportunities;

    const scoreTopN = Math.max(0, llm.config.agents.ScannerAgent.scoreTopN);
    const scoreConcurrency = Math.max(1, llm.config.agents.ScannerAgent.scoreConcurrency);

    const maxCandidates = Math.min(Math.max(opportunities.length, 0), scoreTopN);
    const maxConcurrency = scoreConcurrency;

    const sortedByEdge = opportunities
      .slice()
      .sort((a, b) => b.edge - a.edge || a.id.localeCompare(b.id));
    const candidates = sortedByEdge.slice(0, maxCandidates);
    const remainder = sortedByEdge.slice(maxCandidates);
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));

    if (mode === 'shadow') {
      this.maybeRunShadowScoring(candidates, nowMs, maxConcurrency);
      return opportunities;
    }

    const scored = await this.scoreCandidates(candidates, nowMs, maxConcurrency, mode);

    const orderedCandidates = scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((item) => item.opportunity);

    if (candidateIds.size === 0) {
      return sortedByEdge;
    }

    const remainderStable = remainder.filter((opportunity) => !candidateIds.has(opportunity.id));
    return [...orderedCandidates, ...remainderStable];
  }

  private maybeRunShadowScoring(
    candidates: ArbitrageOpportunity[],
    nowMs: number,
    maxConcurrency: number
  ): void {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return;
    if (llm.config.agents.ScannerAgent.mode !== 'shadow') return;

    const minIntervalMs = Math.max(0, llm.config.agents.ScannerAgent.shadowMinIntervalMs);
    if (this.shadowScoringInFlight) return;
    if (nowMs - this.lastShadowScoringStartAtMs < minIntervalMs) return;
    this.lastShadowScoringStartAtMs = nowMs;

    this.shadowScoringInFlight = true;
    void this.scoreCandidates(candidates, nowMs, maxConcurrency, 'shadow')
      .catch(() => {})
      .finally(() => {
        this.shadowScoringInFlight = false;
      });
  }

  private async scoreCandidates(
    candidates: ArbitrageOpportunity[],
    nowMs: number,
    maxConcurrency: number,
    mode: NonNullable<AppLLMConfig['agents']['ScannerAgent']>['mode']
  ): Promise<Array<{ opportunity: ArbitrageOpportunity; score: number }>> {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return candidates.map((opportunity) => ({ opportunity, score: opportunity.edge }));

    return mapWithConcurrency(candidates, maxConcurrency, async (opportunity) => {
        const insight = this.getInsight(opportunity.marketId, nowMs);
        const promptEnvelope = {
          task: 'score_market',
          inputs: {
            market_id: opportunity.marketId,
            current_edge: opportunity.edge,
            recent_outcomes: insight
              ? { signal: insight.signal, value: insight.value, confidence: insight.confidence }
              : null,
            book_quality: {
              depth: opportunity.maxSizeByDepth,
              spread: Math.max(opportunity.tickSize, 0)
            }
          },
          constraints: { no_trade_decisions: true },
          output: { priority_score: 0.5, rationale: '...', confidence: 0.5 }
        };

        const request: LLMRequest = {
          endpoint: 'chat.completions',
          model: llm.config.agents.ScannerAgent.model,
          temperature: 0,
          messages: [
            {
              role: 'developer',
              content:
                'Return JSON only, with shape: {"priority_score":number,"rationale":string,"confidence":number}. Do NOT make trade decisions; only rank opportunities. Use only the inputs. Score must be between 0 and 1 and reflect relative priority vs the deterministic edge. If inputs are incomplete or mixed, return priority_score=0.5, confidence=0, rationale="insufficient_data". Confidence must be between 0 and 1. No prose.'
            },
            { role: 'user', content: JSON.stringify(promptEnvelope) }
          ]
        };

        const call = await llm.client.call('ScannerAgent', request);
        const parsed = safeParseJSON(call.outputText);
        const validated = ScannerScoreSchema.safeParse(parsed);

        const output = validated.success
          ? validated.data
          : { priority_score: 0.5, rationale: 'invalid_output', confidence: 0 };

        logLLMDecision({
          agent: 'ScannerAgent',
          mode,
          task: 'score_market',
          subject: opportunity.id,
          baseline: { deterministic_priority: opportunity.edge },
          output,
          confidence: output.confidence,
          applied: mode === 'advisory',
          clamp: { raw: safeParseJSON(call.outputText), final: output, bounds: { priority_score: [0, 1] } },
          nowMs,
          call,
          request,
          promptEnvelopeForHash: promptEnvelope,
          contextForHash: { deterministic_priority: opportunity.edge },
          promptVersion: llm.promptVersion,
          policyHashes: llm.policyHashes,
          providerFallback: {
            providerId: llm.config.agents.ScannerAgent.provider,
            baseUrl: llm.config.providers[llm.config.agents.ScannerAgent.provider].baseUrl,
            endpoint: request.endpoint,
            model: request.model
          },
          store: this.store
        });

        if (mode === 'shadow') {
          this.metrics?.record({
            type: 'shadow_decision',
            timestamp: nowMs,
            data: {
              agent: 'ScannerAgent',
              opportunityId: opportunity.id,
              marketId: opportunity.marketId,
              deterministicPriority: opportunity.edge,
              llmPriority: output.priority_score,
              confidence: output.confidence
            }
          });
        }

        return { opportunity, score: output.priority_score };
      });
  }

  scanPair(
    pair: MarketPair,
    orderbooks: Map<string, OrderBookState>,
    nowMs = Date.now()
  ): ArbitrageOpportunity | null {
    if (this.tradingMode === 'off') {
      return null;
    }

    if (!this.allowlist.isAllowed(pair.marketId, nowMs)) {
      return null;
    }

    const yesBook = orderbooks.get(pair.yesTokenId);
    const noBook = orderbooks.get(pair.noTokenId);
    if (!yesBook || !noBook) {
      return null;
    }

    const allowNearZero = this.policy.signalMode !== 'ev';
    const allowEv = this.policy.signalMode !== 'near_zero';

    let nearZeroOpportunity: ArbitrageOpportunity | null = null;
    if (allowNearZero) {
      const gateDecision = evaluateGates({
        yesBook,
        noBook,
        policy: this.policy,
        nowMs
      });

      if (!gateDecision.passed) {
        const gateOpportunityId = buildGateOpportunityId(pair, yesBook, noBook, nowMs);
        this.metrics?.record({
          type: 'gate_rejection',
          timestamp: nowMs,
          data: {
            opportunityId: gateOpportunityId,
            marketId: pair.marketId,
            reasons: gateDecision.reasons,
            gateDecision
          }
        });
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

    let evOpportunity: ArbitrageOpportunity | null = null;
    if (allowEv) {
      evOpportunity = this.buildEvOpportunity(pair, yesBook, noBook, nowMs);
    }

    if (nearZeroOpportunity && evOpportunity) {
      if (evOpportunity.edge > nearZeroOpportunity.edge) {
        this.lastEvOpportunityAt.set(pair.marketId, nowMs);
        return evOpportunity;
      }
      return nearZeroOpportunity;
    }

    if (evOpportunity) {
      this.lastEvOpportunityAt.set(pair.marketId, nowMs);
      return evOpportunity;
    }

    return nearZeroOpportunity;
  }

  private getInsight(
    marketId: string,
    nowMs: number
  ): { market_id: string; signal: string; value: number; ttl_ms: number; confidence: number } | null {
    const cached = this.insightsByMarketId.get(marketId);
    if (!cached) return null;
    if (nowMs >= cached.expiresAtMs) {
      this.insightsByMarketId.delete(marketId);
      return null;
    }
    const { expiresAtMs: _expiresAtMs, ...rest } = cached;
    return rest;
  }

  private buildEvOpportunity(
    pair: MarketPair,
    yesBook: OrderBookState,
    noBook: OrderBookState,
    nowMs: number
  ): ArbitrageOpportunity | null {
    const insight = this.getInsight(pair.marketId, nowMs);
    const signalConfidence = insight?.confidence ?? 0;
    const hasSignal = typeof insight?.value === 'number' && Number.isFinite(insight.value);
    const signalAllowed = hasSignal && signalConfidence >= this.policy.evModelConfidenceFloor;
    const pSignal = signalAllowed ? clamp01(insight!.value) : undefined;

    if (this.policy.evModelMode === 'llm_only' && pSignal === undefined) {
      this.metrics?.record({
        type: 'ev_signal',
        timestamp: nowMs,
        data: { marketId: pair.marketId, reason: 'ev_missing_signal' }
      });
      return null;
    }

    const pMarket = computeMarketPrior(yesBook, noBook);
    const pFinal = computeFinalProbability(pMarket, pSignal, signalConfidence, this.policy);

    const yesAsk = yesBook.bestAsk?.price;
    const noAsk = noBook.bestAsk?.price;
    if (!Number.isFinite(yesAsk) || !Number.isFinite(noAsk)) return null;

    const evYes = pFinal - yesAsk!;
    const evNo = (1 - pFinal) - noAsk!;
    const side: 'yes' | 'no' = evYes >= evNo ? 'yes' : 'no';
    const evRaw = side === 'yes' ? evYes : evNo;
    const slippageEstimate = this.policy.entrySlippageToleranceBps / 10000;
    const feeEstimate = Math.max(this.policy.evFeeBps, 0) / 10000;
    const evNet = evRaw - feeEstimate - slippageEstimate;
    const modelConfidence = clamp01(signalAllowed ? signalConfidence : 0);

    const lastEvAt = this.lastEvOpportunityAt.get(pair.marketId) ?? 0;
    if (this.policy.evCooldownSeconds > 0 && nowMs - lastEvAt < this.policy.evCooldownSeconds * 1000) {
      this.metrics?.record({
        type: 'ev_signal',
        timestamp: nowMs,
        data: { marketId: pair.marketId, side, evNet, confidence: modelConfidence, reason: 'ev_cooldown' }
      });
      return null;
    }

    const gateDecision = evaluateEvGates({
      yesBook,
      noBook,
      policy: this.policy,
      nowMs,
      side,
      evEdge: evNet,
      confidence: modelConfidence
    });

    if (!gateDecision.passed) {
      this.metrics?.record({
        type: 'ev_signal',
        timestamp: nowMs,
        data: { marketId: pair.marketId, side, evNet, confidence: modelConfidence, reason: gateDecision.reasons }
      });
      return null;
    }

    const price = side === 'yes' ? yesAsk! : noAsk!;
    const minOrderSize = Math.max(side === 'yes' ? yesBook.minOrderSize : noBook.minOrderSize, 0);
    const tickSize = Math.max(yesBook.tickSize, noBook.tickSize);

    this.metrics?.record({
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
  } else {
    combined = pMarket;
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
