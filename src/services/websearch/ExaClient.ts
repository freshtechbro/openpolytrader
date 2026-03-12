import { RateLimiter } from '../RateLimiter.js';
import { RetryPolicy } from '../RetryPolicy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { WebSearchClient, WebSearchContent, WebSearchQueryOptions, WebSearchResult } from './WebSearchClient.js';
import { WebSearchCache } from './WebSearchCache.js';
import {
  buildSearchCacheKey,
  cacheContents,
  cacheSearchResults,
  createWebSearchClientRuntime,
  getCachedSearchResults,
  normalizeSearchEntries,
  recordCachedContentsHit,
  recordWebSearchMetric,
  requestWebSearchJson,
  splitCachedContents
} from './WebSearchProviderShared.js';
import { resolveExaBaseUrl } from './WebSearchUrls.js';

interface ExaClientConfig {
  baseUrl?: string;
  apiKey: string;
  timeoutMs: number;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxContentBytes: number;
  searchPath: string;
  contentsPath: string;
  cooldownMs: number;
  cooldownFailureThreshold: number;
  inlineContentsEnabled?: boolean;
  inlineContentsMaxResults?: number;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export class ExaClient implements WebSearchClient {
  private static readonly provider = 'exa';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxContentBytes: number;
  private readonly searchPath: string;
  private readonly contentsPath: string;
  private readonly cooldownMs: number;
  private readonly cooldownFailureThreshold: number;
  private readonly inlineContentsEnabled: boolean;
  private readonly inlineContentsMaxResults: number;
  private readonly cache: WebSearchCache;
  private readonly metrics?: MetricsStore;
  private cooldownUntilMs = 0;
  private consecutiveAuthFailures = 0;

  constructor(config: ExaClientConfig) {
    const runtime = createWebSearchClientRuntime(config, {
      resolveBaseUrl: resolveExaBaseUrl,
      shouldRetry: (error) => error instanceof ExaApiError && (error.status === 429 || error.status >= 500)
    });

    this.baseUrl = runtime.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = runtime.timeoutMs;
    this.limiter = runtime.limiter;
    this.retryPolicy = runtime.retryPolicy;
    this.maxContentBytes = runtime.maxContentBytes;
    this.searchPath = config.searchPath;
    this.contentsPath = config.contentsPath;
    this.cooldownMs = Math.max(0, Math.floor(config.cooldownMs));
    this.cooldownFailureThreshold = Math.max(1, Math.floor(config.cooldownFailureThreshold));
    this.inlineContentsEnabled = config.inlineContentsEnabled === true;
    this.inlineContentsMaxResults = Math.max(1, Math.floor(config.inlineContentsMaxResults ?? 10));
    this.cache = runtime.cache;
    this.metrics = runtime.metrics;
  }

  async search(query: string, options: WebSearchQueryOptions): Promise<WebSearchResult[]> {
    const nowMs = Date.now();
    const lookbackDays = Math.max(1, Math.floor(options.lookbackDays));
    const maxResults = Math.max(1, Math.floor(options.maxResults));
    const cacheTtlMs = Math.max(0, Math.floor(options.cacheTtlSeconds) * 1000);
    const allowlist = (options.domainAllowlist ?? []).map((domain) => domain.trim()).filter(Boolean);
    const denylist = (options.domainDenylist ?? []).map((domain) => domain.trim()).filter(Boolean);
    const cacheKey = buildSearchCacheKey(ExaClient.provider, query, lookbackDays, maxResults, allowlist, denylist);
    const cached = getCachedSearchResults(this.cache, ExaClient.provider, cacheKey, nowMs, this.metrics);
    if (cached) {
      return cached;
    }

    if (this.isInCooldown(nowMs)) {
      recordWebSearchMetric(this.metrics, 'provider_cooldown_skip', {
        provider: ExaClient.provider,
        kind: 'search',
        remainingMs: Math.max(0, this.cooldownUntilMs - nowMs)
      });
      return [];
    }

    const start = new Date(nowMs - lookbackDays * 86400000).toISOString();
    const end = new Date(nowMs).toISOString();
    const payload: Record<string, unknown> = {
      query,
      type: 'neural',
      numResults: maxResults,
      startPublishedDate: start,
      endPublishedDate: end
    };
    if (this.inlineContentsEnabled && maxResults <= this.inlineContentsMaxResults) {
      payload.text = true;
    }
    if (allowlist.length > 0) payload.includeDomains = allowlist;
    if (denylist.length > 0) payload.excludeDomains = denylist;

    const response = await this.request('POST', this.searchPath, payload, 'search');
    const results = normalizeSearchResults(response);
    cacheSearchResults(this.cache, cacheKey, results, cacheTtlMs, nowMs);
    if (this.inlineContentsEnabled && maxResults <= this.inlineContentsMaxResults) {
      const inlineContents = normalizeInlineContents(response, this.maxContentBytes);
      cacheContents(this.cache, ExaClient.provider, inlineContents, cacheTtlMs, nowMs);
      if (inlineContents.length > 0) {
        recordWebSearchMetric(this.metrics, 'inline_contents_used', {
          provider: ExaClient.provider,
          count: inlineContents.length
        });
      }
    }
    return results;
  }

  async fetchContents(urls: string[], cacheTtlSeconds?: number): Promise<WebSearchContent[]> {
    const nowMs = Date.now();
    const deduped = Array.from(new Set(urls.filter((url) => typeof url === 'string' && url.length > 0)));
    if (deduped.length === 0) return [];

    const cacheTtlMs = typeof cacheTtlSeconds === 'number' ? Math.max(0, Math.floor(cacheTtlSeconds) * 1000) : 0;
    const { cached, uncached } = splitCachedContents(this.cache, ExaClient.provider, deduped, nowMs);

    if (uncached.length === 0) {
      recordCachedContentsHit(this.metrics, ExaClient.provider, cached.length);
      return cached;
    }

    if (this.isInCooldown(nowMs)) {
      recordWebSearchMetric(this.metrics, 'provider_cooldown_skip', {
        provider: ExaClient.provider,
        kind: 'contents',
        remainingMs: Math.max(0, this.cooldownUntilMs - nowMs),
        cached: cached.length,
        uncached: uncached.length
      });
      return cached;
    }

    const payload = { urls: uncached, text: true };
    const response = await this.request('POST', this.contentsPath, payload, 'contents');
    const contents = normalizeContentResults(response, this.maxContentBytes);
    cacheContents(this.cache, ExaClient.provider, contents, cacheTtlMs, nowMs);

    return [...cached, ...contents];
  }

  private async request(
    method: string,
    path: string,
    body: Record<string, unknown>,
    kind: 'search' | 'contents'
  ): Promise<unknown> {
    return requestWebSearchJson(
      {
        provider: ExaClient.provider,
        providerLabel: 'Exa',
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        limiter: this.limiter,
        retryPolicy: this.retryPolicy,
        metrics: this.metrics,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'openpolytrader/0.1.0',
          'x-api-key': this.apiKey
        },
        createError: (message, status, responseBody) => new ExaApiError(message, status, responseBody),
        onHttpError: (requestKind, status, nowMs) => {
          if (status === 401 || status === 402) {
            this.handleAuthFailure(requestKind as 'search' | 'contents', status, nowMs);
          }
        },
        onSuccess: (requestKind, nowMs) => {
          this.handleSuccess(requestKind as 'search' | 'contents', nowMs);
        }
      },
      method,
      path,
      body,
      kind
    );
  }

  private handleAuthFailure(kind: 'search' | 'contents', status: number, nowMs: number): void {
    this.consecutiveAuthFailures += 1;
    if (this.cooldownMs <= 0) return;
    if (this.consecutiveAuthFailures < this.cooldownFailureThreshold) return;

    const wasCoolingDown = this.isInCooldown(nowMs);
    const nextCooldownUntil = nowMs + this.cooldownMs;
    const previousUntil = this.cooldownUntilMs;
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, nextCooldownUntil);

    if (!wasCoolingDown || this.cooldownUntilMs > previousUntil) {
      recordWebSearchMetric(this.metrics, 'provider_cooldown_started', {
        provider: ExaClient.provider,
        kind,
        status,
        cooldownMs: this.cooldownMs,
        failureCount: this.consecutiveAuthFailures
      });
    }
  }

  private handleSuccess(kind: 'search' | 'contents', nowMs: number): void {
    const shouldRecordRecovery =
      this.cooldownUntilMs > 0 &&
      nowMs >= this.cooldownUntilMs &&
      this.consecutiveAuthFailures >= this.cooldownFailureThreshold;

    this.consecutiveAuthFailures = 0;
    this.cooldownUntilMs = 0;

    if (shouldRecordRecovery) {
      recordWebSearchMetric(this.metrics, 'provider_cooldown_recovered', {
        provider: ExaClient.provider,
        kind
      });
    }
  }

  private isInCooldown(nowMs: number): boolean {
    if (this.cooldownMs <= 0) return false;
    return nowMs < this.cooldownUntilMs;
  }
}

export class ExaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'ExaApiError';
  }
}

function normalizeSearchResults(response: unknown): WebSearchResult[] {
  const results = getResponseResults(response);
  if (results.length === 0) return [];

  return normalizeSearchEntries(results, {
    snippet: ['text'],
    publishedAt: ['publishedDate', 'published_date']
  }, extractDomain);
}

function normalizeContentResults(response: unknown, maxContentBytes: number): WebSearchContent[] {
  const results = getResponseResults(response);
  if (results.length === 0) return [];

  return results
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      if (!url) return null;
      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const publishedAt = typeof entry.publishedDate === 'string' ? entry.publishedDate : undefined;
      const rawText = typeof entry.text === 'string' ? entry.text : '';
      const text = trimToBytes(rawText, maxContentBytes);
      const content: WebSearchContent = { url, source: extractDomain(url), text };
      if (title) content.title = title;
      if (publishedAt) content.publishedAt = publishedAt;
      return content;
    })
    .filter((entry): entry is WebSearchContent => entry !== null);
}

function normalizeInlineContents(response: unknown, maxContentBytes: number): WebSearchContent[] {
  return getResponseResults(response)
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      const rawText = typeof entry.text === 'string' ? entry.text : '';
      if (!url || !rawText) return null;
      const content: WebSearchContent = {
        url,
        source: extractDomain(url),
        text: trimToBytes(rawText, maxContentBytes)
      };
      if (typeof entry.title === 'string') {
        content.title = entry.title;
      }
      if (typeof entry.publishedDate === 'string') {
        content.publishedAt = entry.publishedDate;
      }
      return content;
    })
    .filter((entry): entry is WebSearchContent => entry !== null);
}

function getResponseResults(response: unknown): Array<Record<string, unknown>> {
  if (!isRecord(response) || !Array.isArray(response.results)) {
    return [];
  }
  return response.results.filter(isRecord);
}

function trimToBytes(value: string, maxBytes: number): string {
  if (!value) return value;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return value.slice(0, maxBytes);
}

function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
