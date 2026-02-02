import type { TradePolicy } from '../../config/policy.js';
import type { MarketPair } from '../../domain/market.js';
import { messageBus } from '../../core/MessageBus.js';
import { LearningInsightEventSchema } from '../../domain/llm.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { MarketInfo, PolymarketClob } from '../../services/PolymarketClob.js';
import type { WebSearchClient, WebSearchContent, WebSearchQueryOptions, WebSearchResult } from '../../services/websearch/WebSearchClient.js';
import { clamp01 } from '../../utils/math.js';
import { runWithConcurrency } from '../../utils/concurrency.js';

export interface SignalAggregatorConfig {
  policy: TradePolicy;
  marketPairs: MarketPair[];
  clob: PolymarketClob;
  exa?: WebSearchClient;
  firecrawl?: WebSearchClient;
  domainAllowlist?: string[];
  domainDenylist?: string[];
  metrics?: MetricsStore;
}

export class SignalAggregatorAgent {
  private policy: TradePolicy;
  private marketPairs: MarketPair[];
  private readonly clob: PolymarketClob;
  private readonly exa?: WebSearchClient;
  private readonly firecrawl?: WebSearchClient;
  private readonly domainAllowlist: string[];
  private readonly domainDenylist: string[];
  private readonly metrics?: MetricsStore;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private started = false;
  private insightCache = new Map<string, { expiresAtMs: number }>();
  private marketMetaCache = new Map<string, { question: string; outcomes: string[]; expiresAtMs: number }>();

  constructor(config: SignalAggregatorConfig) {
    this.policy = config.policy;
    this.marketPairs = config.marketPairs;
    this.clob = config.clob;
    this.exa = config.exa;
    this.firecrawl = config.firecrawl;
    this.domainAllowlist = config.domainAllowlist ?? [];
    this.domainDenylist = config.domainDenylist ?? [];
    this.metrics = config.metrics;
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
    this.marketPairs = pairs;
  }

  private applySchedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.shouldRun()) {
      return;
    }

    const refreshMs = Math.max(this.policy.evModelRefreshMinutes, 1) * 60_000;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, refreshMs);

    void this.runOnce();
  }

  private shouldRun(): boolean {
    if (this.policy.signalMode === 'near_zero') return false;
    const exaEnabled = this.policy.evWebSearchExaEnabled && Boolean(this.exa);
    const firecrawlEnabled = this.policy.evWebSearchFirecrawlEnabled && Boolean(this.firecrawl);
    return exaEnabled || firecrawlEnabled;
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight || !this.shouldRun()) return;
    this.inFlight = true;

    try {
      const nowMs = Date.now();
      const pending = this.marketPairs.filter((pair) => {
        const cached = this.insightCache.get(pair.marketId);
        return !(cached && nowMs < cached.expiresAtMs);
      });

      if (pending.length === 0) return;

      const maxConcurrency = Math.max(1, Math.floor(this.policy.evWebSearchMaxConcurrency));
      await runWithConcurrency(pending, maxConcurrency, async (pair) => {
        try {
          const meta = await this.getMarketMeta(pair.marketId, nowMs);
          const queries = buildQueries(meta?.question ?? pair.marketId, meta?.outcomes ?? ['yes', 'no']);
          if (queries.length === 0) return;

          const { results, contents } = await this.fetchSignals(queries);
          if (results.length === 0 && contents.length === 0) return;

          const insight = normalizeToInsight(pair.marketId, meta?.outcomes ?? ['yes', 'no'], results, contents, this.policy);
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
          messageBus.emit('learning:insight', payload);
          this.insightCache.set(pair.marketId, { expiresAtMs: nowMs + ttlMs });
          this.recordMetric('insight_emitted', { marketId: pair.marketId, confidence: insight.confidence });
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

  private async fetchSignals(queries: string[]): Promise<{ results: WebSearchResult[]; contents: WebSearchContent[] }> {
    const options: WebSearchQueryOptions = {
      lookbackDays: this.policy.evWebSearchLookbackDays,
      maxResults: this.policy.evWebSearchMaxResults,
      cacheTtlSeconds: this.policy.evWebSearchCacheTtlSeconds,
      domainAllowlist: this.domainAllowlist,
      domainDenylist: this.domainDenylist
    };

    const primary = this.policy.evWebSearchPrimary === 'firecrawl' ? this.firecrawl : this.exa;
    const secondary = this.policy.evWebSearchPrimary === 'firecrawl' ? this.exa : this.firecrawl;

    let results: WebSearchResult[] = [];
    let contents: WebSearchContent[] = [];

    const maxConcurrency = Math.max(1, Math.floor(this.policy.evWebSearchMaxConcurrency));

    if (primary) {
      const searchResults = await runWithConcurrency(queries, maxConcurrency, async (query) => primary.search(query, options));
      results = searchResults.flat();
    }

    if (results.length === 0 && secondary) {
      const searchResults = await runWithConcurrency(queries, maxConcurrency, async (query) => secondary.search(query, options));
      results = searchResults.flat();
    }

    const urls = Array.from(new Set(results.map((result) => result.url).filter(Boolean)));
    if (urls.length > 0) {
      const client = primary ?? secondary;
      contents = client ? await client.fetchContents(urls, options.cacheTtlSeconds) : [];
    }

    return { results, contents };
  }

  private async getMarketMeta(marketId: string, nowMs: number): Promise<{ question: string; outcomes: string[] } | null> {
    const cached = this.marketMetaCache.get(marketId);
    if (cached && nowMs < cached.expiresAtMs) {
      return { question: cached.question, outcomes: cached.outcomes };
    }

    const info = await this.clob.getMarket(marketId);
    if (!info || !info.question) {
      return null;
    }

    const outcomes = extractOutcomes(info);
    const ttlMs = Math.max(this.policy.evModelRefreshMinutes, 1) * 60_000;
    this.marketMetaCache.set(marketId, { question: info.question, outcomes, expiresAtMs: nowMs + ttlMs });
    return { question: info.question, outcomes };
  }

  private recordMetric(event: string, data: Record<string, unknown>): void {
    if (!this.metrics) return;
    this.metrics.record({
      type: 'web_search',
      timestamp: Date.now(),
      data: { event, ...data }
    });
  }
}

function extractOutcomes(info: MarketInfo): string[] {
  if (Array.isArray(info.tokens)) {
    const outcomes = info.tokens
      .map((token) => token.outcome)
      .filter((outcome): outcome is string => typeof outcome === 'string' && outcome.trim().length > 0);
    if (outcomes.length >= 2) {
      return outcomes.map((outcome) => outcome.trim());
    }
  }
  return ['yes', 'no'];
}

function buildQueries(question: string, outcomes: string[]): string[] {
  const base = question.trim();
  if (!base) return [];
  const trimmedOutcomes = outcomes.map((outcome) => outcome.trim()).filter(Boolean);
  const queries = new Set<string>();
  queries.add(base);
  for (const outcome of trimmedOutcomes.slice(0, 2)) {
    queries.add(`${base} ${outcome}`);
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
  const { bias, mentionScore } = computeOutcomeBias(contents, outcomes);
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
  contents: WebSearchContent[],
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
