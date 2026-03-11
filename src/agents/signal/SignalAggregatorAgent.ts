import type { TradePolicy } from '../../config/policy.js';
import type { MarketAllowlist } from '../../domain/allowlist.js';
import type { MarketPair } from '../../domain/market.js';
import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { RuntimeEventMap } from '../../core/runtimeEvents.js';
import { LearningInsightEventSchema } from '../../domain/llm.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { MarketInfo, PolymarketClob } from '../../services/PolymarketClob.js';
import type { WebSearchClient, WebSearchContent, WebSearchQueryOptions, WebSearchResult } from '../../services/websearch/WebSearchClient.js';
import { GdeltHeartbeatService } from '../../services/websearch/GdeltHeartbeatService.js';
import { SearchRouter } from '../../services/websearch/SearchRouter.js';
import type {
  HeartbeatState,
  SearchQueryMode,
  SearchRouteContext,
  SearchRouteDecision
} from '../../services/websearch/SearchRoutingTypes.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { clamp01 } from '../../utils/math.js';
import type { OrderBookState } from '../../domain/orderbook.js';

interface SignalAggregatorConfig {
  policy: TradePolicy;
  marketPairs: MarketPair[];
  messageBus?: MessageBus<RuntimeEventMap>;
  allowlist?: Pick<MarketAllowlist, 'isAllowed'>;
  clob: PolymarketClob;
  exa?: WebSearchClient;
  serper?: WebSearchClient;
  firecrawl?: WebSearchClient;
  gdeltHeartbeat?: GdeltHeartbeatService;
  domainAllowlist?: string[];
  domainDenylist?: string[];
  metrics?: MetricsStore;
}

interface CachedMarketMeta {
  info: MarketInfo | null;
  question: string;
  outcomes: string[];
  expiresAtMs: number;
}

interface RecentPriceMove {
  moveBps: number;
  updatedAtMs: number;
}

interface PreparedMarketSearch {
  pair: MarketPair;
  meta?: { info: MarketInfo | null; question: string; outcomes: string[] };
  heartbeat?: HeartbeatState | null;
}

export class SignalAggregatorAgent {
  private policy: TradePolicy;
  private readonly messageBus: MessageBus<RuntimeEventMap>;
  private marketPairs: MarketPair[];
  private readonly allowlist?: Pick<MarketAllowlist, 'isAllowed'>;
  private readonly clob: PolymarketClob;
  private readonly exa?: WebSearchClient;
  private readonly serper?: WebSearchClient;
  private readonly firecrawl?: WebSearchClient;
  private readonly gdeltHeartbeat?: GdeltHeartbeatService;
  private readonly domainAllowlist: string[];
  private readonly domainDenylist: string[];
  private readonly metrics?: MetricsStore;
  private readonly router: SearchRouter;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private started = false;
  private insightCache = new Map<string, { expiresAtMs: number }>();
  private marketMetaCache = new Map<string, CachedMarketMeta>();
  private readonly marketIdByTokenId = new Map<string, string>();
  private readonly recentMidPriceByTokenId = new Map<string, number>();
  private readonly recentPriceMoves = new Map<string, RecentPriceMove>();

  constructor(config: SignalAggregatorConfig) {
    this.policy = config.policy;
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config.messageBus, 'SignalAggregatorAgent');
    this.marketPairs = config.marketPairs;
    this.allowlist = config.allowlist;
    this.clob = config.clob;
    this.exa = config.exa;
    this.serper = config.serper;
    this.firecrawl = config.firecrawl;
    this.gdeltHeartbeat = config.gdeltHeartbeat;
    this.domainAllowlist = config.domainAllowlist ?? [];
    this.domainDenylist = config.domainDenylist ?? [];
    this.metrics = config.metrics;
    this.router = new SearchRouter(config.policy, config.metrics);
    this.rebuildTokenMarketIndex(config.marketPairs);
    this.messageBus.on('market:updated', ({ tokenId, book }) => {
      this.handleMarketUpdated(tokenId, book);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.applySchedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updatePolicy(next: TradePolicy): void {
    this.policy = next;
    this.router.updatePolicy(next);
    this.gdeltHeartbeat?.updatePolicy(next);
    if (!this.started) return;
    this.applySchedule();
  }

  updateMarketPairs(pairs: MarketPair[]): void {
    const nextIds = new Set(pairs.map((pair) => pair.marketId));
    for (const marketId of this.insightCache.keys()) {
      if (!nextIds.has(marketId)) {
        this.insightCache.delete(marketId);
      }
    }
    for (const marketId of this.marketMetaCache.keys()) {
      if (!nextIds.has(marketId)) {
        this.marketMetaCache.delete(marketId);
      }
    }
    for (const marketId of this.recentPriceMoves.keys()) {
      if (!nextIds.has(marketId)) {
        this.recentPriceMoves.delete(marketId);
      }
    }
    this.marketPairs = pairs;
    this.rebuildTokenMarketIndex(pairs);
  }

  private applySchedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.shouldRun()) {
      return;
    }

    const refreshMs = Math.max(this.policy.evWebSearchRefreshMinutes, 1) * 60_000;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, refreshMs);

    void this.runOnce();
  }

  private shouldRun(): boolean {
    if (this.policy.signalMode === 'near_zero') return false;
    return Boolean(this.resolveExaClient() || this.resolveSerperClient() || this.resolveFirecrawlClient());
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight || !this.shouldRun()) return;
    this.inFlight = true;

    try {
      const nowMs = Date.now();
      const maxConcurrency = Math.max(1, Math.floor(this.policy.evWebSearchMaxConcurrency));
      const { pending, skippedByAllowlist } = await this.selectPendingPairs(nowMs, maxConcurrency);

      if (skippedByAllowlist > 0) {
        this.recordMetric('active_pair_skip_allowlist', {
          skipped: skippedByAllowlist,
          totalPairs: this.marketPairs.length
        });
      }

      if (pending.length === 0) {
        this.recordMetric('active_pair_skip_no_pending', {
          totalPairs: this.marketPairs.length
        });
        return;
      }

      await mapWithConcurrency(pending, maxConcurrency, async ({ pair, meta: preparedMeta, heartbeat: preparedHeartbeat }) => {
        try {
          const meta = preparedMeta ?? await this.getMarketMeta(pair.marketId, nowMs);
          const routeContext: SearchRouteContext = {
            marketId: pair.marketId,
            question: meta.question || pair.marketId,
            outcomes: meta.outcomes,
            info: meta.info,
            nowMs,
            priceMoveBps: this.getRecentPriceMoveBps(pair.marketId, nowMs)
          };

          const heartbeat = preparedHeartbeat ?? await this.getHeartbeat(routeContext);
          const initialDecision = this.router.decide(routeContext, heartbeat, {
            exa: Boolean(this.resolveExaClient()),
            serper: Boolean(this.resolveSerperClient())
          });
          this.recordRouteDecision(pair.marketId, initialDecision);

          if (initialDecision.route === 'skip') {
            this.recordMetric('route_skipped', {
              marketId: pair.marketId,
              reason: initialDecision.reason
            });
            return;
          }

          const signalBundle = await this.fetchSignals(routeContext, initialDecision);
          if (signalBundle.results.length === 0 && signalBundle.contents.length === 0) {
            return;
          }

          const insight = normalizeToInsight(
            pair.marketId,
            meta.outcomes,
            signalBundle.results,
            signalBundle.contents,
            this.policy
          );
          const ttlMs = Math.max(this.policy.evWebSearchCacheTtlSeconds, 1) * 1000;

          const payload = {
            insights: [
              {
                ...insight,
                ttl_ms: ttlMs,
                source: 'web_search' as const,
                kind: 'web_signal' as const
              }
            ],
            generatedAtMs: nowMs
          };

          LearningInsightEventSchema.parse(payload);
          this.messageBus.emit('learning:insight', payload);
          this.insightCache.set(pair.marketId, { expiresAtMs: nowMs + ttlMs });
          this.recordMetric('insight_emitted', {
            marketId: pair.marketId,
            confidence: insight.confidence,
            route: signalBundle.decision.route
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.recordMetric('insight_failed', { marketId: pair.marketId, error: message });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordMetric('insight_failed', { error: message });
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchSignals(
    context: SearchRouteContext,
    decision: SearchRouteDecision
  ): Promise<{ decision: SearchRouteDecision; results: WebSearchResult[]; contents: WebSearchContent[] }> {
    const queries = buildQueries(context.question, context.outcomes, decision.queryMode);
    if (queries.length === 0) {
      return { decision, results: [], contents: [] };
    }

    if (decision.route === 'exa' || decision.route === 'serper_then_exa') {
      const provider = this.resolveExaClient();
      if (!provider) {
        return { decision, results: [], contents: [] };
      }
      const bundle = await this.fetchProviderSignals(provider, queries, decision.contentBudget);
      return { decision, ...bundle };
    }

    if (decision.route === 'serper') {
      const resolvedSerper = this.resolveSerperClient();
      if (!resolvedSerper) {
        return { decision, results: [], contents: [] };
      }
      const serperBundle = await this.fetchProviderSignals(resolvedSerper, queries, decision.contentBudget);
      const escalation = this.router.shouldEscalateSerper(context, decision, serperBundle.results);
      const resolvedExa = this.resolveExaClient();
      if (!escalation || !resolvedExa) {
        return { decision, ...serperBundle };
      }

      this.recordRouteDecision(context.marketId, escalation);
      const exaQueries = buildQueries(context.question, context.outcomes, escalation.queryMode);
      const exaBundle = await this.fetchProviderSignals(resolvedExa, exaQueries, escalation.contentBudget);
      if (hasOutcomeDisagreement(serperBundle, exaBundle, context.outcomes)) {
        this.recordMetric('provider_disagreement', {
          marketId: context.marketId,
          providers: ['serper', 'exa'],
          reason: escalation.reason
        });
      }
      return { decision: escalation, ...exaBundle };
    }

    return { decision, results: [], contents: [] };
  }

  private async fetchProviderSignals(
    provider: WebSearchClient,
    queries: string[],
    contentBudget: number
  ): Promise<{ results: WebSearchResult[]; contents: WebSearchContent[] }> {
    const options: WebSearchQueryOptions = {
      lookbackDays: this.policy.evWebSearchLookbackDays,
      maxResults: this.policy.evWebSearchMaxResults,
      cacheTtlSeconds: this.policy.evWebSearchCacheTtlSeconds,
      domainAllowlist: this.domainAllowlist,
      domainDenylist: this.domainDenylist
    };

    const maxConcurrency = Math.max(1, Math.floor(this.policy.evWebSearchMaxConcurrency));
    const searchResults = await mapWithConcurrency(queries, maxConcurrency, async (query) =>
      provider.search(query, options)
    );
    const results = dedupeResults(searchResults.flat());
    const urls = Array.from(new Set(results.map((result) => result.url).filter(Boolean)));
    const urlsForContent = urls.slice(0, Math.max(0, contentBudget));
    const contents =
      urlsForContent.length > 0
        ? await provider.fetchContents(urlsForContent, options.cacheTtlSeconds)
        : [];

    this.recordMetric('content_budget_applied', {
      route: providerRoute(provider, this.exa, this.serper, this.firecrawl),
      requestedUrls: urls.length,
      expandedUrls: urlsForContent.length
    });

    return { results, contents };
  }

  private async getHeartbeat(context: SearchRouteContext) {
    if (!this.gdeltHeartbeat || !this.policy.evWebSearchGdeltEnabled) {
      return null;
    }
    try {
      return await this.gdeltHeartbeat.getState(context);
    } catch (error) {
      this.recordMetric('heartbeat_failed', {
        marketId: context.marketId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async getMarketMeta(marketId: string, nowMs: number): Promise<{ info: MarketInfo | null; question: string; outcomes: string[] }> {
    const cached = this.marketMetaCache.get(marketId);
    if (cached && nowMs < cached.expiresAtMs) {
      return {
        info: cached.info,
        question: cached.question,
        outcomes: cached.outcomes
      };
    }

    const info = await this.clob.getMarket(marketId);
    const question = info?.question ?? marketId;
    const outcomes = extractOutcomes(info);
    const ttlMs = Math.max(this.policy.evWebSearchRefreshMinutes, 1) * 60_000;
    this.marketMetaCache.set(marketId, { info, question, outcomes, expiresAtMs: nowMs + ttlMs });
    return { info, question, outcomes };
  }

  private async selectPendingPairs(nowMs: number, maxConcurrency: number): Promise<{ pending: PreparedMarketSearch[]; skippedByAllowlist: number }> {
    const pending: PreparedMarketSearch[] = [];
    let skippedByAllowlist = 0;

    await mapWithConcurrency(this.marketPairs, maxConcurrency, async (pair) => {
      if (this.allowlist && !this.allowlist.isAllowed(pair.marketId, nowMs)) {
        skippedByAllowlist += 1;
        return;
      }

      const cached = this.insightCache.get(pair.marketId);
      if (!cached || nowMs >= cached.expiresAtMs) {
        pending.push({ pair });
        return;
      }

      const override = await this.prepareCachedOverride(pair, nowMs);
      if (override) {
        pending.push({ pair, ...override });
      }
    });

    return { pending, skippedByAllowlist };
  }

  private async prepareCachedOverride(
    pair: MarketPair,
    nowMs: number
  ): Promise<Omit<PreparedMarketSearch, 'pair'> | null> {
    const meta = await this.getMarketMeta(pair.marketId, nowMs);
    const routeContext: SearchRouteContext = {
      marketId: pair.marketId,
      question: meta.question || pair.marketId,
      outcomes: meta.outcomes,
      info: meta.info,
      nowMs,
      priceMoveBps: this.getRecentPriceMoveBps(pair.marketId, nowMs)
    };
    const heartbeat = await this.getHeartbeat(routeContext);
    const decision = this.router.decide(routeContext, heartbeat, {
      exa: Boolean(this.resolveExaClient()),
      serper: Boolean(this.resolveSerperClient())
    });

    return shouldBypassInsightCache(decision)
      ? {
          meta,
          heartbeat
        }
      : null;
  }

  private recordRouteDecision(marketId: string, decision: SearchRouteDecision): void {
    this.recordMetric('route_decided', {
      marketId,
      route: decision.route,
      reason: decision.reason,
      triggerScore: decision.triggerScore,
      queryMode: decision.queryMode
    });
  }

  private recordMetric(event: string, data: Record<string, unknown>): void {
    if (!this.metrics) return;
    this.metrics.record({
      type: 'web_search',
      timestamp: Date.now(),
      data: { event, ...data }
    });
  }

  private resolveExaClient(): WebSearchClient | undefined {
    return this.policy.evWebSearchExaEnabled ? this.exa : undefined;
  }

  private resolveSerperClient(): WebSearchClient | undefined {
    return this.policy.evWebSearchSerperEnabled ? this.serper : undefined;
  }

  private resolveFirecrawlClient(): WebSearchClient | undefined {
    return this.policy.evWebSearchFirecrawlEnabled ? this.firecrawl : undefined;
  }

  private rebuildTokenMarketIndex(pairs: MarketPair[]): void {
    this.marketIdByTokenId.clear();
    for (const pair of pairs) {
      this.marketIdByTokenId.set(pair.yesTokenId, pair.marketId);
      this.marketIdByTokenId.set(pair.noTokenId, pair.marketId);
    }
  }

  private handleMarketUpdated(tokenId: string, book: OrderBookState): void {
    const marketId = this.marketIdByTokenId.get(tokenId);
    if (!marketId) return;
    const midPrice = computeMidPrice(book);
    if (midPrice === null) return;
    const previousMidPrice = this.recentMidPriceByTokenId.get(tokenId);
    this.recentMidPriceByTokenId.set(tokenId, midPrice);
    if (!previousMidPrice || previousMidPrice <= 0) return;
    const moveBps = Math.abs(midPrice - previousMidPrice) / previousMidPrice * 10_000;
    if (moveBps < Math.max(this.policy.evWebSearchPriceMoveTriggerBps, 0)) return;
    const current = this.recentPriceMoves.get(marketId);
    if (current && current.moveBps >= moveBps && current.updatedAtMs >= book.lastUpdateMs) return;
    this.recentPriceMoves.set(marketId, {
      moveBps,
      updatedAtMs: book.lastUpdateMs
    });
  }

  private getRecentPriceMoveBps(marketId: string, nowMs: number): number {
    const recent = this.recentPriceMoves.get(marketId);
    if (!recent) return 0;
    const ttlMs = Math.max(this.policy.evWebSearchRefreshMinutes, 1) * 60_000;
    if (nowMs - recent.updatedAtMs > ttlMs) {
      this.recentPriceMoves.delete(marketId);
      return 0;
    }
    return recent.moveBps;
  }
}

function extractOutcomes(info: MarketInfo | null | undefined): string[] {
  if (Array.isArray(info?.tokens)) {
    const outcomes = info.tokens
      .map((token) => token.outcome)
      .filter((outcome): outcome is string => typeof outcome === 'string' && outcome.trim().length > 0);
    if (outcomes.length >= 2) {
      return outcomes.map((outcome) => outcome.trim());
    }
  }
  return ['yes', 'no'];
}

function buildQueries(question: string, outcomes: string[], mode: SearchQueryMode): string[] {
  const base = question.trim();
  if (!base) return [];

  const trimmedOutcomes = outcomes.map((outcome) => outcome.trim()).filter(Boolean);
  const queries = new Set<string>();
  queries.add(base);

  if (mode === 'base_only') {
    return Array.from(queries);
  }

  if (trimmedOutcomes[0]) {
    queries.add(`${base} ${trimmedOutcomes[0]}`);
  }

  if (mode === 'base_plus_two' && trimmedOutcomes[1]) {
    queries.add(`${base} ${trimmedOutcomes[1]}`);
  }

  return Array.from(queries);
}

function normalizeToInsight(
  marketId: string,
  outcomes: string[],
  results: WebSearchResult[],
  contents: WebSearchContent[],
  policy: TradePolicy
): { market_id: string; signal: 'high_confidence' | 'medium_confidence' | 'low_confidence' | 'neutral'; value: number; confidence: number } {
  const maxResults = Math.max(policy.evWebSearchMaxResults, 1);
  const coverage = clamp01(results.length / maxResults);
  const recencyScore = computeRecencyScore(results, policy.evWebSearchLookbackDays);
  const contentInputs =
    contents.length > 0
      ? contents
      : results.map((result) => ({
          url: result.url,
          text: `${result.title ?? ''} ${result.snippet ?? ''}`.trim(),
          source: result.source
        }));
  const { bias, mentionScore } = computeOutcomeBias(contentInputs, outcomes);
  const confidence = clamp01(0.2 * coverage + 0.5 * mentionScore + 0.3 * recencyScore);

  const value = clamp01(0.5 + 0.5 * bias);
  const signal = confidence >= 0.75 ? 'high_confidence' : confidence >= 0.5 ? 'medium_confidence' : confidence >= 0.25 ? 'low_confidence' : 'neutral';

  return { market_id: marketId, signal, value, confidence };
}

function computeRecencyScore(results: WebSearchResult[], lookbackDays: number): number {
  const nowMs = Date.now();
  const lookbackMs = Math.max(lookbackDays, 1) * 86400000;
  let total = 0;
  let count = 0;
  for (const result of results) {
    if (!result.publishedAt) continue;
    const ts = Date.parse(result.publishedAt);
    if (!Number.isFinite(ts)) continue;
    const ageMs = Math.max(0, nowMs - ts);
    const score = clamp01(1 - ageMs / lookbackMs);
    total += score;
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function computeOutcomeBias(
  contents: Array<{ text?: string }>,
  outcomes: string[]
): { bias: number; mentionScore: number } {
  const normalized = outcomes.map((outcome) => outcome.toLowerCase().trim()).filter(Boolean);
  const [first, second] = normalized;
  if (!first || !second) {
    return { bias: 0, mentionScore: 0 };
  }

  let countFirst = 0;
  let countSecond = 0;

  for (const content of contents) {
    const text = content.text?.toLowerCase();
    if (!text) continue;
    countFirst += countWord(text, first);
    countSecond += countWord(text, second);
  }

  const total = countFirst + countSecond;
  const bias = total > 0 ? (countFirst - countSecond) / total : 0;
  const mentionScore = clamp01(total / 20);
  return { bias, mentionScore };
}

function countWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'g');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function computeMidPrice(book: OrderBookState): number | null {
  if (!book.bestBid || !book.bestAsk) return null;
  if (book.bestBid.price <= 0 || book.bestAsk.price <= 0) return null;
  return (book.bestBid.price + book.bestAsk.price) / 2;
}

function providerRoute(
  provider: WebSearchClient,
  exa: WebSearchClient | undefined,
  serper: WebSearchClient | undefined,
  firecrawl: WebSearchClient | undefined
): string {
  if (provider === exa) return 'exa';
  if (provider === serper) return 'serper';
  if (provider === firecrawl) return 'firecrawl';
  return 'unknown';
}

function hasOutcomeDisagreement(
  left: { results: WebSearchResult[]; contents: WebSearchContent[] },
  right: { results: WebSearchResult[]; contents: WebSearchContent[] },
  outcomes: string[]
): boolean {
  const leftBias = computeOutcomeBias(
    left.contents.length > 0
      ? left.contents
      : left.results.map((result) => ({ text: `${result.title ?? ''} ${result.snippet ?? ''}` })),
    outcomes
  ).bias;
  const rightBias = computeOutcomeBias(
    right.contents.length > 0
      ? right.contents
      : right.results.map((result) => ({ text: `${result.title ?? ''} ${result.snippet ?? ''}` })),
    outcomes
  ).bias;
  return Math.abs(leftBias - rightBias) >= 0.35;
}

function shouldBypassInsightCache(decision: SearchRouteDecision): boolean {
  return decision.route !== 'skip' && decision.reason !== 'low_priority';
}

export const __signalAggregatorTestUtils = {
  extractOutcomes,
  buildQueries,
  normalizeToInsight,
  computeRecencyScore,
  computeOutcomeBias,
  countWord,
  dedupeResults,
  computeMidPrice,
  providerRoute,
  hasOutcomeDisagreement,
  shouldBypassInsightCache
};
