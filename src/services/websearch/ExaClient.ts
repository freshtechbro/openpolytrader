import { RateLimiter } from '../RateLimiter.js';
import { RetryPolicy } from '../RetryPolicy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { WebSearchClient, WebSearchContent, WebSearchQueryOptions, WebSearchResult } from './WebSearchClient.js';
import { WebSearchCache } from './WebSearchCache.js';

export interface ExaClientConfig {
  baseUrl: string;
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
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export class ExaClient implements WebSearchClient {
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
  private readonly cache: WebSearchCache;
  private readonly metrics?: MetricsStore;
  private cooldownUntilMs = 0;
  private consecutiveAuthFailures = 0;

  constructor(config: ExaClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.limiter = new RateLimiter(config.rateLimitPerWindow, config.rateLimitWindowMs);
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: (error) => error instanceof ExaApiError && (error.status === 429 || error.status >= 500)
    });
    this.maxContentBytes = Math.max(config.maxContentBytes, 1);
    this.searchPath = config.searchPath;
    this.contentsPath = config.contentsPath;
    this.cooldownMs = Math.max(0, Math.floor(config.cooldownMs));
    this.cooldownFailureThreshold = Math.max(1, Math.floor(config.cooldownFailureThreshold));
    this.cache = config.cache;
    this.metrics = config.metrics;
  }

  async search(query: string, options: WebSearchQueryOptions): Promise<WebSearchResult[]> {
    const nowMs = Date.now();
    const lookbackDays = Math.max(1, Math.floor(options.lookbackDays));
    const maxResults = Math.max(1, Math.floor(options.maxResults));
    const cacheTtlMs = Math.max(0, Math.floor(options.cacheTtlSeconds) * 1000);
    const allowlist = (options.domainAllowlist ?? []).map((domain) => domain.trim()).filter(Boolean);
    const denylist = (options.domainDenylist ?? []).map((domain) => domain.trim()).filter(Boolean);
    const cacheKey = [
      query.trim(),
      `lookback:${lookbackDays}`,
      `max:${maxResults}`,
      `allow:${allowlist.join(',')}`,
      `deny:${denylist.join(',')}`
    ].join('|');
    const providerKey = `exa:${cacheKey}`;

    const cached = this.cache.getSearch(providerKey, nowMs);
    if (cached) {
      this.recordMetric('search_cache_hit', { provider: 'exa' });
      return cached;
    }

    if (this.isInCooldown(nowMs)) {
      this.recordMetric('provider_cooldown_skip', {
        provider: 'exa',
        kind: 'search',
        remainingMs: Math.max(0, this.cooldownUntilMs - nowMs)
      });
      return [];
    }

    const start = new Date(nowMs - lookbackDays * 86400000).toISOString();
    const end = new Date(nowMs).toISOString();
    const payload: Record<string, unknown> = {
      query,
      type: 'auto',
      numResults: maxResults,
      startPublishedDate: start,
      endPublishedDate: end
    };
    if (allowlist.length > 0) payload.includeDomains = allowlist;
    if (denylist.length > 0) payload.excludeDomains = denylist;

    const response = await this.request<unknown>('POST', this.searchPath, payload, 'search');
    const results = normalizeSearchResults(response);
    if (cacheTtlMs > 0) {
      this.cache.setSearch(providerKey, results, cacheTtlMs, nowMs);
    }
    return results;
  }

  async fetchContents(urls: string[], cacheTtlSeconds?: number): Promise<WebSearchContent[]> {
    const nowMs = Date.now();
    const deduped = Array.from(new Set(urls.filter((url) => typeof url === 'string' && url.length > 0)));
    if (deduped.length === 0) return [];

    const cached: WebSearchContent[] = [];
    const uncached: string[] = [];
    const cacheTtlMs = typeof cacheTtlSeconds === 'number' ? Math.max(0, Math.floor(cacheTtlSeconds) * 1000) : 0;

    for (const url of deduped) {
      const key = `exa:${url}`;
      const hit = this.cache.getContent(key, nowMs);
      if (hit) {
        cached.push(hit);
      } else {
        uncached.push(url);
      }
    }

    if (uncached.length === 0) {
      this.recordMetric('contents_cache_hit', { provider: 'exa', count: cached.length });
      return cached;
    }

    if (this.isInCooldown(nowMs)) {
      this.recordMetric('provider_cooldown_skip', {
        provider: 'exa',
        kind: 'contents',
        remainingMs: Math.max(0, this.cooldownUntilMs - nowMs),
        cached: cached.length,
        uncached: uncached.length
      });
      return cached;
    }

    const payload = { urls: uncached, text: true };
    const response = await this.request<unknown>('POST', this.contentsPath, payload, 'contents');
    const contents = normalizeContentResults(response, this.maxContentBytes);

    if (cacheTtlMs > 0) {
      for (const content of contents) {
        if (content.url) {
          const key = `exa:${content.url}`;
          this.cache.setContent(key, content, cacheTtlMs, nowMs);
        }
      }
    }

    return [...cached, ...contents];
  }

  private async request<T>(method: string, path: string, body: Record<string, unknown>, kind: 'search' | 'contents'): Promise<T> {
    await this.limiter.acquire();

    return this.retryPolicy.execute(async () => {
      const url = new URL(path, this.baseUrl).toString();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAtMs = Date.now();

      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'openpolytrader/0.1.0',
            'x-api-key': this.apiKey
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        const text = await response.text();
        const parsedResult = safeParseJson(text);

        if (!response.ok) {
          this.recordMetric('request_failed', { provider: 'exa', kind, status: response.status });
          if (response.status === 401 || response.status === 402) {
            this.handleAuthFailure(kind, response.status, Date.now());
          }
          throw new ExaApiError(
            `Exa API error ${response.status} for ${method} ${path}`,
            response.status,
            parsedResult.failed ? { raw: text } : parsedResult.parsed
          );
        }

        if (parsedResult.failed) {
          const snippet = text.slice(0, 200);
          throw new Error(`Exa API invalid JSON for ${method} ${path}: ${snippet}`);
        }

        const latencyMs = Date.now() - startedAtMs;
        this.handleSuccess(kind, Date.now());
        this.recordMetric('request_ok', { provider: 'exa', kind, latencyMs });
        return parsedResult.parsed as T;
      } finally {
        clearTimeout(timeout);
      }
    });
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
      this.recordMetric('provider_cooldown_started', {
        provider: 'exa',
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
      this.recordMetric('provider_cooldown_recovered', {
        provider: 'exa',
        kind
      });
    }
  }

  private isInCooldown(nowMs: number): boolean {
    if (this.cooldownMs <= 0) return false;
    return nowMs < this.cooldownUntilMs;
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
  const payload = response as { results?: Array<Record<string, unknown>> };
  if (!payload?.results || !Array.isArray(payload.results)) return [];

  return payload.results
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      if (!url) return null;
      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const snippet = typeof entry.text === 'string' ? entry.text : undefined;
      const publishedAt =
        typeof entry.publishedDate === 'string'
          ? entry.publishedDate
          : typeof entry.published_date === 'string'
            ? entry.published_date
            : undefined;
      const result: WebSearchResult = { url, source: extractDomain(url) };
      if (title) result.title = title;
      if (snippet) result.snippet = snippet;
      if (publishedAt) result.publishedAt = publishedAt;
      return result;
    })
    .filter((entry): entry is WebSearchResult => entry !== null);
}

function normalizeContentResults(response: unknown, maxContentBytes: number): WebSearchContent[] {
  const payload = response as { results?: Array<Record<string, unknown>> };
  if (!payload?.results || !Array.isArray(payload.results)) return [];

  return payload.results
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

function safeParseJson(text: string): { parsed: unknown; failed: boolean } {
  if (!text || text.trim().length === 0) {
    return { parsed: null, failed: false };
  }
  try {
    return { parsed: JSON.parse(text), failed: false };
  } catch {
    return { parsed: null, failed: true };
  }
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
