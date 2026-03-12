import type { TradePolicy } from '../../config/policy.js';
import type { TradingMode } from '../../config/env.js';
import { MarketAllowlist } from '../../domain/allowlist.js';
import { createUniformTakerFeeModel } from '../../domain/feeModel.js';
import type { DependencyMarketInput } from '../../domain/dependency.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import type { FwProjectionAgent } from '../projection/FwProjectionAgent.js';
import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { LLMClientPort } from '../../services/llm/types.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import {
  scoreScannerOpportunity,
  type ScannerInsight
} from './ScannerOpportunityScorer.js';
import { evaluateScannerPair } from './ScannerPairEvaluator.js';

interface ScannerAgentConfig {
  tradingMode?: TradingMode;
  messageBus?: MessageBus<RuntimeEventMap>;
  metrics?: MetricsStore;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: LLMClientPort<'ScannerAgent'>;
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
  fwProjectionAgent?: FwProjectionAgent;
}

export class ScannerAgent {
  private tradingMode: TradingMode;
  private messageBus: MessageBus<RuntimeEventMap>;
  private metrics?: MetricsStore;
  private store?: EventStore;
  private llm?: NonNullable<ScannerAgentConfig['llm']>;
  private insightHandler: ((payload: RuntimeEventMap['learning:insight']) => void) | null = null;
  private insightsByMarketId = new Map<string, ScannerInsight & { expiresAtMs: number }>();
  private shadowScoringInFlight = false;
  private lastShadowScoringStartAtMs = 0;
  private lastEvOpportunityAt = new Map<string, number>();
  private gateRejectionEmissionState = new Map<string, { reasonKey: string; timestampMs: number }>();
  private evSignalEmissionState = new Map<string, { reasonKey: string; timestampMs: number }>();
  private nearZeroFeeModel = createUniformTakerFeeModel(0);
  private fwProjectionAgent?: FwProjectionAgent;

  constructor(
    private policy: TradePolicy,
    private allowlist: MarketAllowlist,
    config?: ScannerAgentConfig
  ) {
    this.tradingMode = config?.tradingMode ?? 'off';
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config?.messageBus, 'ScannerAgent');
    this.metrics = config?.metrics;
    this.store = config?.eventStore;
    this.llm = config?.llm;
    this.nearZeroFeeModel = createUniformTakerFeeModel(this.policy.nearZeroFeeBps);
    this.fwProjectionAgent = config?.fwProjectionAgent;

    this.insightHandler = (payload) => {
      const nowMs = Date.now();
      for (const insight of payload.insights) {
        if (!insight || typeof insight.market_id !== 'string' || insight.market_id.length === 0) continue;
        if (typeof insight.ttl_ms !== 'number' || !Number.isFinite(insight.ttl_ms) || insight.ttl_ms <= 0) continue;
        if (typeof insight.value !== 'number' || !Number.isFinite(insight.value)) continue;
        if (typeof insight.confidence !== 'number' || !Number.isFinite(insight.confidence)) continue;
        this.insightsByMarketId.set(insight.market_id, { ...insight, expiresAtMs: nowMs + insight.ttl_ms });
      }
    };
    this.messageBus.on('learning:insight', this.insightHandler);
  }

  stop(): void {
    if (this.insightHandler) {
      this.messageBus.off('learning:insight', this.insightHandler);
      this.insightHandler = null;
    }
  }

  updateTradingMode(mode: TradingMode): void {
    this.tradingMode = mode;
  }

  updatePolicy(next: TradePolicy): void {
    this.policy = next;
    this.nearZeroFeeModel = createUniformTakerFeeModel(next.nearZeroFeeBps);
  }

  async scanFwPair(
    pair: MarketPair,
    orderbooks: Map<string, OrderBookState>,
    nowMs = Date.now(),
    marketUniverse?: DependencyMarketInput[]
  ): Promise<ArbitrageOpportunity | null> {
    const scopedUniverse =
      marketUniverse && marketUniverse.length > 0
        ? marketUniverse
        : [{ marketId: pair.marketId, yesTokenId: pair.yesTokenId, noTokenId: pair.noTokenId }];
    const opportunities = await this.scanFwUniverse(orderbooks, scopedUniverse, nowMs);
    return opportunities.find((opportunity) => opportunity.marketId === pair.marketId) ?? null;
  }

  async scanFwUniverse(
    orderbooks: Map<string, OrderBookState>,
    marketUniverse: DependencyMarketInput[],
    nowMs = Date.now()
  ): Promise<ArbitrageOpportunity[]> {
    if (this.tradingMode === 'off') return [];
    const allowedUniverse = marketUniverse.filter((entry) =>
      entry.marketId ? this.allowlist.isAllowed(entry.marketId, nowMs) : false
    );
    if (allowedUniverse.length === 0) return [];
    if (!this.fwProjectionAgent) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: { event: 'projection_rejected', marketId: 'unknown', reason: 'fw_projection_agent_unconfigured' }
      });
      return [];
    }

    const result = await this.fwProjectionAgent.projectUniverse({
      policy: this.policy,
      nowMs,
      orderbooks,
      marketUniverse: allowedUniverse
    });
    if (result.opportunities.length === 0) {
      this.metrics?.record({
        type: 'fw_projection',
        timestamp: nowMs,
        data: {
          event: 'projection_rejected',
          marketId: allowedUniverse[0]?.marketId ?? 'unknown',
          reason: result.reason ?? 'projection_rejected'
        }
      });
      return [];
    }

    return result.opportunities;
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
        const score = await scoreScannerOpportunity({
          opportunity,
          insight: this.getInsight(opportunity.marketId, nowMs),
          nowMs,
          mode,
          llm,
          messageBus: this.messageBus,
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
              llmPriority: score
            }
          });
        }

        return { opportunity, score };
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

    return evaluateScannerPair({
      pair,
      yesBook,
      noBook,
      policy: this.policy,
      nowMs,
      nearZeroFeeModel: this.nearZeroFeeModel,
      metrics: this.metrics,
      gateRejectionEmissionState: this.gateRejectionEmissionState,
      evSignalEmissionState: this.evSignalEmissionState,
      lastEvOpportunityAt: this.lastEvOpportunityAt,
      getInsight: (marketId, insightNowMs) => this.getInsight(marketId, insightNowMs)
    });
  }

  private getInsight(
    marketId: string,
    nowMs: number
  ): ScannerInsight | null {
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
