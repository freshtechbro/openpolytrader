import type { TradePolicy } from '../../config/policy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { clamp01 } from '../../utils/math.js';
import { safeParseJsonBody } from '../../utils/serialization.js';
import { RateLimiter } from '../RateLimiter.js';
import { RetryPolicy } from '../RetryPolicy.js';
import { resolveGdeltBaseUrl } from './WebSearchUrls.js';
import type { HeartbeatState, SearchRouteContext, SearchRouteReason } from './SearchRoutingTypes.js';

interface GdeltHeartbeatServiceConfig {
  policy: TradePolicy;
  baseUrl?: string;
  timeoutMs: number;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  metrics?: MetricsStore;
}

interface CachedHeartbeatState {
  state: HeartbeatState;
  expiresAtMs: number;
  urls: Set<string>;
}

export class GdeltHeartbeatService {
  private policy: TradePolicy;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly retryPolicy: RetryPolicy;
  private readonly metrics?: MetricsStore;
  private readonly cache = new Map<string, CachedHeartbeatState>();

  constructor(config: GdeltHeartbeatServiceConfig) {
    this.policy = config.policy;
    this.baseUrl = resolveGdeltBaseUrl(config.baseUrl);
    this.timeoutMs = Math.max(1, config.timeoutMs);
    this.limiter = new RateLimiter(config.rateLimitPerWindow, config.rateLimitWindowMs);
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: (error) =>
        error instanceof GdeltHeartbeatError &&
        (error.status === 408 || error.status === 429 || error.status >= 500)
    });
    this.metrics = config.metrics;
  }

  updatePolicy(policy: TradePolicy): void {
    this.policy = policy;
  }

  async getState(context: SearchRouteContext): Promise<HeartbeatState> {
    const nowMs = context.nowMs;
    const previous = this.cache.get(context.marketId);
    if (previous && nowMs < previous.expiresAtMs) {
      return previous.state;
    }

    const query = buildQuery(context.question);
    if (!query) {
      return emptyHeartbeat(nowMs);
    }

    try {
      const response = await this.fetchArticles(query, this.policy.evWebSearchLookbackDays);
      const entries = getArticleEntries(response);
      const articleUrls = new Set(entries.map((entry) => entry.url).filter(Boolean));
      const uniqueSources = new Set(entries.map((entry) => entry.source).filter(Boolean));
      const previousUrls = previous?.urls ?? new Set<string>();
      const noveltyScore =
        articleUrls.size === 0 ? 0 : clamp01(Array.from(articleUrls).filter((url) => !previousUrls.has(url)).length / articleUrls.size);
      const contradictionScore = computeContradictionScore(entries, context.outcomes);
      const officialDomainPresent = entries.some((entry) => isOfficialDomain(entry.source));
      const articleCount = entries.length;
      const articleDelta = articleCount - (previous?.state.articleCount ?? 0);
      const uniqueSourceCount = uniqueSources.size;
      const uniqueSourceDelta = uniqueSourceCount - (previous?.state.uniqueSourceCount ?? 0);
      const triggerScore = clamp01(
        0.25 * clamp01(articleCount / 10) +
          0.2 * clamp01(articleDelta / 5) +
          0.15 * clamp01(uniqueSourceDelta / 3) +
          0.2 * noveltyScore +
          0.2 * contradictionScore
      );
      const reasons: SearchRouteReason[] = [];
      if (triggerScore >= this.policy.evWebSearchGdeltTriggerThreshold) {
        reasons.push('gdelt_spike');
      }
      if (!officialDomainPresent && this.policy.evWebSearchOfficialDomainRequired) {
        reasons.push('official_confirmation_missing');
      }
      if (reasons.length === 0) {
        reasons.push('no_trigger');
      }

      const state: HeartbeatState = {
        triggerScore,
        reasons,
        articleCount,
        articleDelta,
        uniqueSourceCount,
        uniqueSourceDelta,
        noveltyScore,
        contradictionScore,
        officialDomainPresent,
        updatedAtMs: nowMs
      };

      this.cache.set(context.marketId, {
        state,
        expiresAtMs: nowMs + Math.max(1, this.policy.evWebSearchGdeltRefreshMinutes) * 60_000,
        urls: articleUrls
      });

      this.metrics?.record({
        type: 'web_search',
        timestamp: nowMs,
        data: {
          event: 'heartbeat_updated',
          marketId: context.marketId,
          triggerScore,
          reasons
        }
      });

      return state;
    } catch (error) {
      if (isHeartbeatBackoffError(error)) {
        const fallbackState = previous?.state ?? emptyHeartbeat(nowMs);
        this.cache.set(context.marketId, {
          state: fallbackState,
          expiresAtMs: nowMs + getFailureBackoffMs(this.policy),
          urls: previous?.urls ?? new Set<string>()
        });
        this.metrics?.record({
          type: 'web_search',
          timestamp: nowMs,
          data: {
            event: 'heartbeat_failed',
            marketId: context.marketId,
            error: error.message
          }
        });
        return fallbackState;
      }
      throw error;
    }
  }

  private async fetchArticles(query: string, lookbackDays: number): Promise<unknown> {
    await this.limiter.acquire();
    return this.retryPolicy.execute(async () => {
      const url = new URL(this.baseUrl);
      url.searchParams.set('query', query);
      url.searchParams.set('mode', 'artlist');
      url.searchParams.set('format', 'json');
      url.searchParams.set('sort', 'datedesc');
      url.searchParams.set('maxrecords', '10');
      url.searchParams.set('timespan', `${Math.max(lookbackDays, 1)}d`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'openpolytrader/0.1.0' },
            signal: controller.signal
          });
        } catch (error) {
          if (isAbortError(error)) {
            throw new GdeltHeartbeatError(`GDELT API timeout for GET ${url.pathname}`, 408, null);
          }
          throw error;
        }
        const text = await response.text();
        const parsed = safeParseJsonBody(text);
        if (!response.ok) {
          throw new GdeltHeartbeatError(
            `GDELT API error ${response.status} for GET ${url.pathname}`,
            response.status,
            parsed.failed ? { raw: text } : parsed.parsed
          );
        }
        if (parsed.failed) {
          throw new Error(`GDELT API invalid JSON for GET ${url.pathname}: ${text.slice(0, 200)}`);
        }
        return parsed.parsed;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

function getFailureBackoffMs(policy: TradePolicy): number {
  return Math.min(Math.max(1, policy.evWebSearchGdeltRefreshMinutes) * 60_000, 60_000);
}

function isHeartbeatBackoffError(error: unknown): error is GdeltHeartbeatError {
  return error instanceof GdeltHeartbeatError && (error.status === 408 || error.status === 429);
}

export class GdeltHeartbeatError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'GdeltHeartbeatError';
  }
}

interface GdeltArticle {
  url: string;
  source?: string;
  title?: string;
  snippet?: string;
}

function getArticleEntries(response: unknown): GdeltArticle[] {
  if (!isRecord(response) || !Array.isArray(response.articles)) {
    return [];
  }
  return response.articles
    .filter(isRecord)
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      const source = typeof entry.domain === 'string' ? entry.domain : extractDomain(url);
      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const snippet =
        typeof entry.seendate === 'string'
          ? `${title ?? ''} ${entry.seendate}`
          : title;
      return { url, source, title, snippet };
    })
    .filter((entry) => Boolean(entry.url));
}

function computeContradictionScore(entries: GdeltArticle[], outcomes: string[]): number {
  const normalized = outcomes.map((outcome) => outcome.toLowerCase().trim()).filter(Boolean);
  const [first, second] = normalized;
  if (!first || !second) {
    return 0;
  }
  let firstHits = 0;
  let secondHits = 0;
  for (const entry of entries) {
    const haystack = `${entry.title ?? ''} ${entry.snippet ?? ''}`.toLowerCase();
    if (haystack.includes(first)) firstHits += 1;
    if (haystack.includes(second)) secondHits += 1;
  }
  const total = firstHits + secondHits;
  if (total === 0) return 0;
  return clamp01(Math.min(firstHits, secondHits) / total);
}

function buildQuery(question: string): string {
  const normalized = question.trim().replace(/\s+/g, ' ');
  return normalized ? `"${normalized}"` : '';
}

function emptyHeartbeat(nowMs: number): HeartbeatState {
  return {
    triggerScore: 0,
    reasons: ['no_trigger'],
    articleCount: 0,
    articleDelta: 0,
    uniqueSourceCount: 0,
    uniqueSourceDelta: 0,
    noveltyScore: 0,
    contradictionScore: 0,
    officialDomainPresent: false,
    updatedAtMs: nowMs
  };
}

function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isOfficialDomain(domain?: string): boolean {
  if (!domain) return false;
  return /\.(gov|mil|int)$/i.test(domain) || /federalreserve|supremecourt|uscourts|sec\.gov|whitehouse\.gov|congress\.gov/i.test(domain);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

export const __gdeltHeartbeatTestUtils = {
  getArticleEntries,
  computeContradictionScore,
  buildQuery,
  emptyHeartbeat,
  extractDomain,
  isOfficialDomain
};
