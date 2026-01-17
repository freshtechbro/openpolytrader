import type { TradePolicy } from '../../config/policy.js';
import type { TradingMode } from '../../config/env.js';
import { MarketAllowlist } from '../../domain/allowlist.js';
import { evaluateGates } from '../../domain/gates.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity, opportunityId } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';
import { ScannerScoreSchema } from '../../domain/llm.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import { safeParseJSON } from '../../utils/serialization.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

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

  constructor(
    private policy: TradePolicy,
    private allowlist: MarketAllowlist,
    config?: ScannerAgentConfig
  ) {
    this.tradingMode = config?.tradingMode ?? 'off';
    this.metrics = config?.metrics;
    this.store = config?.eventStore;
    this.llm = config?.llm;

    if (this.llm?.config.enabled && this.llm.config.agents.ScannerAgent.mode !== 'disabled') {
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
                'Return JSON only, with shape: {"priority_score":number,"rationale":string,"confidence":number}. No prose.'
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
      return null;
    }

    const bestYes = yesBook.bestAsk!;
    const bestNo = noBook.bestAsk!;
    const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);
    const tickSize = Math.max(yesBook.tickSize, noBook.tickSize);

    return {
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
      pair
    };
  }

  private getInsight(marketId: string, nowMs: number): { market_id: string; signal: string; value: number; ttl_ms: number; confidence: number } | null {
    const cached = this.insightsByMarketId.get(marketId);
    if (!cached) return null;
    if (nowMs >= cached.expiresAtMs) {
      this.insightsByMarketId.delete(marketId);
      return null;
    }
    const { expiresAtMs: _expiresAtMs, ...rest } = cached;
    return rest;
  }


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
