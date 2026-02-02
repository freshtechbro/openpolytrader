import { RateLimiter } from '../RateLimiter.js';
import { RetryPolicy } from '../RetryPolicy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { WebSearchClient, WebSearchContent, WebSearchQueryOptions, WebSearchResult } from './WebSearchClient.js';
import { WebSearchCache } from './WebSearchCache.js';

export interface FirecrawlClientConfig {
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
  scrapePath: string;
  crawlPath: string;
  crawlEnabled: boolean;
  crawlMaxDepth: number;
  crawlMaxPages: number;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export class FirecrawlClient implements WebSearchClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxContentBytes: number;
  private readonly searchPath: string;
  private readonly scrapePath: string;
  private readonly crawlPath: string;
  private readonly crawlEnabled: boolean;
  private readonly crawlMaxDepth: number;
  private readonly crawlMaxPages: number;
  private readonly cache: WebSearchCache;
  private readonly metrics?: MetricsStore;

  constructor(config: FirecrawlClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.limiter = new RateLimiter(config.rateLimitPerWindow, config.rateLimitWindowMs);
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: (error) => error instanceof FirecrawlApiError && (error.status === 429 || error.status >= 500)
    });
    this.maxContentBytes = Math.max(config.maxContentBytes, 1);
    this.searchPath = config.searchPath;
    this.scrapePath = config.scrapePath;
    this.crawlPath = config.crawlPath;
    this.crawlEnabled = config.crawlEnabled === true;
    this.crawlMaxDepth = Math.max(config.crawlMaxDepth, 0);
    this.crawlMaxPages = Math.max(config.crawlMaxPages, 0);
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
    const providerKey = `firecrawl:${cacheKey}`;

    const cached = this.cache.getSearch(providerKey, nowMs);
    if (cached) {
      this.recordMetric('search_cache_hit', { provider: 'firecrawl' });
      return cached;
    }

    const payload: Record<string, unknown> = {
      query,
      limit: maxResults
    };

    const tbs = toFirecrawlTbs(lookbackDays);
    if (tbs) payload.tbs = tbs;
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
      const key = `firecrawl:${url}`;
      const hit = this.cache.getContent(key, nowMs);
      if (hit) {
        cached.push(hit);
      } else {
        uncached.push(url);
      }
    }

    const fetched: WebSearchContent[] = [];

    for (const url of uncached) {
      const content = await this.fetchSingle(url);
      if (content) {
        fetched.push(content);
        if (cacheTtlMs > 0) {
          const key = `firecrawl:${url}`;
          this.cache.setContent(key, content, cacheTtlMs, nowMs);
        }
      }
    }

    return [...cached, ...fetched];
  }

  private async fetchSingle(url: string): Promise<WebSearchContent | null> {
    const payload = {
      url,
      formats: ['markdown'],
      timeout: this.timeoutMs
    };

    const response = await this.request<unknown>('POST', this.scrapePath, payload, 'scrape');
    const content = normalizeScrapeResult(response, url, this.maxContentBytes);

    if (content?.text) return content;
    if (!this.crawlEnabled) return content;

    const crawlPayload: Record<string, unknown> = { url };
    const crawlerOptions: Record<string, unknown> = {};
    if (this.crawlMaxDepth > 0) {
      crawlerOptions.maxDepth = this.crawlMaxDepth;
    }
    if (this.crawlMaxPages > 0) {
      crawlerOptions.limit = this.crawlMaxPages;
    }
    if (Object.keys(crawlerOptions).length > 0) {
      crawlPayload.crawlerOptions = crawlerOptions;
    }
    const crawlResponse = await this.request<unknown>('POST', this.crawlPath, crawlPayload, 'crawl');
    return normalizeCrawlResult(crawlResponse, url, this.maxContentBytes) ?? content;
  }

  private async request<T>(method: string, path: string, body: Record<string, unknown>, kind: 'search' | 'scrape' | 'crawl'): Promise<T> {
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
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        const text = await response.text();
        const parsedResult = safeParseJson(text);

        if (!response.ok) {
          this.recordMetric('request_failed', { provider: 'firecrawl', kind, status: response.status });
          throw new FirecrawlApiError(
            `Firecrawl API error ${response.status} for ${method} ${path}`,
            response.status,
            parsedResult.failed ? { raw: text } : parsedResult.parsed
          );
        }

        if (parsedResult.failed) {
          const snippet = text.slice(0, 200);
          throw new Error(`Firecrawl API invalid JSON for ${method} ${path}: ${snippet}`);
        }

        const latencyMs = Date.now() - startedAtMs;
        this.recordMetric('request_ok', { provider: 'firecrawl', kind, latencyMs });
        return parsedResult.parsed as T;
      } finally {
        clearTimeout(timeout);
      }
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
}

export class FirecrawlApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'FirecrawlApiError';
  }
}

function normalizeSearchResults(response: unknown): WebSearchResult[] {
  const payload = response as { data?: { web?: Array<Record<string, unknown>> } };
  const results = Array.isArray(payload?.data?.web) ? payload.data.web : Array.isArray(payload?.data) ? payload.data as Array<Record<string, unknown>> : [];

  return results
    .map((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : '';
      if (!url) return null;
      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const snippet = typeof entry.description === 'string' ? entry.description : undefined;
      const publishedAt = typeof entry.publishedDate === 'string' ? entry.publishedDate : undefined;
      const result: WebSearchResult = { url, source: extractDomain(url) };
      if (title) result.title = title;
      if (snippet) result.snippet = snippet;
      if (publishedAt) result.publishedAt = publishedAt;
      return result;
    })
    .filter((entry): entry is WebSearchResult => entry !== null);
}

function normalizeScrapeResult(response: unknown, url: string, maxContentBytes: number): WebSearchContent | null {
  const payload = response as { data?: Record<string, unknown> };
  const data = payload?.data ?? {};
  const title = typeof data.title === 'string' ? data.title : undefined;
  const markdown = typeof data.markdown === 'string' ? data.markdown : undefined;
  const text = trimToBytes(markdown ?? '', maxContentBytes);
  return {
    url,
    title,
    text,
    source: extractDomain(url)
  };
}

function normalizeCrawlResult(response: unknown, url: string, maxContentBytes: number): WebSearchContent | null {
  const payload = response as { data?: { pages?: Array<Record<string, unknown>> } };
  const pages = Array.isArray(payload?.data?.pages) ? payload.data.pages : [];
  const first = pages[0];
  if (!first || typeof first !== 'object') return null;
  const markdown = typeof first.markdown === 'string' ? first.markdown : undefined;
  const text = trimToBytes(markdown ?? '', maxContentBytes);
  return {
    url,
    text,
    source: extractDomain(url)
  };
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

function toFirecrawlTbs(lookbackDays: number): string | undefined {
  if (lookbackDays <= 1) return 'qdr:d';
  if (lookbackDays <= 7) return 'qdr:w';
  if (lookbackDays <= 31) return 'qdr:m';
  if (lookbackDays <= 365) return 'qdr:y';
  return undefined;
}
