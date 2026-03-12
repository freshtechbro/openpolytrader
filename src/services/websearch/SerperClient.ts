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
import { resolveSerperBaseUrl } from './WebSearchUrls.js';

interface SerperClientConfig {
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
  newsPath: string;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export class SerperClient implements WebSearchClient {
  private static readonly provider = 'serper';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxContentBytes: number;
  private readonly searchPath: string;
  private readonly newsPath: string;
  private readonly cache: WebSearchCache;
  private readonly metrics?: MetricsStore;

  constructor(config: SerperClientConfig) {
    const runtime = createWebSearchClientRuntime(config, {
      resolveBaseUrl: resolveSerperBaseUrl,
      shouldRetry: (error) => error instanceof SerperApiError && (error.status === 429 || error.status >= 500)
    });

    this.baseUrl = runtime.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = runtime.timeoutMs;
    this.limiter = runtime.limiter;
    this.retryPolicy = runtime.retryPolicy;
    this.maxContentBytes = runtime.maxContentBytes;
    this.searchPath = config.searchPath;
    this.newsPath = config.newsPath;
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
    const cacheKey = buildSearchCacheKey(SerperClient.provider, query, lookbackDays, maxResults, allowlist, denylist);
    const cached = getCachedSearchResults(this.cache, SerperClient.provider, cacheKey, nowMs, this.metrics);
    if (cached) {
      return cached;
    }

    const payload: Record<string, unknown> = {
      q: query,
      num: maxResults,
      autocorrect: false
    };
    if (allowlist.length > 0) payload.site = allowlist.join(' OR ');
    if (denylist.length > 0) payload.excludeTerms = denylist.join(' ');

    const newsResponse = await this.request(this.newsPath, payload, 'news');
    let results = normalizeNewsResults(newsResponse);

    if (results.length === 0) {
      const searchResponse = await this.request(this.searchPath, payload, 'search');
      results = normalizeSearchResults(searchResponse);
    }

    cacheSearchResults(this.cache, cacheKey, results, cacheTtlMs, nowMs);
    return results;
  }

  async fetchContents(urls: string[], cacheTtlSeconds?: number): Promise<WebSearchContent[]> {
    const nowMs = Date.now();
    const deduped = Array.from(new Set(urls.filter((url) => typeof url === 'string' && url.length > 0)));
    if (deduped.length === 0) return [];

    const cacheTtlMs = typeof cacheTtlSeconds === 'number' ? Math.max(0, Math.floor(cacheTtlSeconds) * 1000) : 0;
    const { cached, uncached } = splitCachedContents(this.cache, SerperClient.provider, deduped, nowMs);
    if (uncached.length === 0) {
      recordCachedContentsHit(this.metrics, SerperClient.provider, cached.length);
      return cached;
    }

    const contents: WebSearchContent[] = [...cached];
    for (const url of uncached) {
      try {
        contents.push(await this.fetchSingle(url));
      } catch (error) {
        recordWebSearchMetric(this.metrics, 'request_failed', {
          provider: SerperClient.provider,
          kind: 'contents',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    cacheContents(this.cache, SerperClient.provider, contents.filter((content) => uncached.includes(content.url)), cacheTtlMs, nowMs);
    return contents;
  }

  private async request(path: string, body: Record<string, unknown>, kind: 'search' | 'news'): Promise<unknown> {
    return requestWebSearchJson(
      {
        provider: SerperClient.provider,
        providerLabel: 'Serper',
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        limiter: this.limiter,
        retryPolicy: this.retryPolicy,
        metrics: this.metrics,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'openpolytrader/0.1.0',
          'X-API-KEY': this.apiKey
        },
        createError: (message, status, responseBody) => new SerperApiError(message, status, responseBody)
      },
      'POST',
      path,
      body,
      kind
    );
  }

  private async fetchSingle(url: string): Promise<WebSearchContent> {
    await this.limiter.acquire();
    return this.retryPolicy.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'openpolytrader/0.1.0' },
          signal: controller.signal
        });
        const text = await response.text();
        const stripped = trimToBytes(stripHtml(text), this.maxContentBytes);
        return {
          url,
          title: extractTitle(text),
          text: stripped,
          source: extractDomain(url)
        };
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

export class SerperApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'SerperApiError';
  }
}

function normalizeNewsResults(response: unknown): WebSearchResult[] {
  if (!isRecord(response) || !Array.isArray(response.news)) {
    return [];
  }
  return response.news
    .filter(isRecord)
    .map((entry) => ({
      url: typeof entry.link === 'string' ? entry.link : '',
      title: typeof entry.title === 'string' ? entry.title : undefined,
      snippet: typeof entry.snippet === 'string' ? entry.snippet : undefined,
      publishedAt: typeof entry.date === 'string' ? entry.date : undefined,
      source: typeof entry.source === 'string' ? entry.source : extractDomain(typeof entry.link === 'string' ? entry.link : '')
    }))
    .filter((entry) => Boolean(entry.url));
}

function normalizeSearchResults(response: unknown): WebSearchResult[] {
  if (!isRecord(response) || !Array.isArray(response.organic)) {
    return [];
  }
  return normalizeSearchEntries(
    response.organic.filter(isRecord).map((entry) => ({
      url: entry.link,
      title: entry.title,
      snippet: entry.snippet,
      date: entry.date,
      source: entry.source
    })),
    { snippet: ['snippet'], publishedAt: ['date'] },
    extractDomain
  );
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (!match) return undefined;
  return match[1].replace(/\s+/g, ' ').trim() || undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimToBytes(value: string, maxContentBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxContentBytes) return value;
  return value.slice(0, maxContentBytes);
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

export const __serperTestUtils = {
  normalizeNewsResults,
  normalizeSearchResults,
  extractTitle,
  stripHtml,
  trimToBytes,
  extractDomain
};
