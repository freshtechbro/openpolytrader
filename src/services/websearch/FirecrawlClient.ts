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
  requestWebSearchJson,
  splitCachedContents
} from './WebSearchProviderShared.js';
import { resolveFirecrawlBaseUrl } from './WebSearchUrls.js';

interface FirecrawlClientConfig {
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
  scrapePath: string;
  crawlPath: string;
  crawlEnabled: boolean;
  crawlMaxDepth: number;
  crawlMaxPages: number;
  cache: WebSearchCache;
  metrics?: MetricsStore;
}

export class FirecrawlClient implements WebSearchClient {
  private static readonly provider = 'firecrawl';
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
    const runtime = createWebSearchClientRuntime(config, {
      resolveBaseUrl: resolveFirecrawlBaseUrl,
      shouldRetry: (error) => error instanceof FirecrawlApiError && (error.status === 429 || error.status >= 500)
    });

    this.baseUrl = runtime.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = runtime.timeoutMs;
    this.limiter = runtime.limiter;
    this.retryPolicy = runtime.retryPolicy;
    this.maxContentBytes = runtime.maxContentBytes;
    this.searchPath = config.searchPath;
    this.scrapePath = config.scrapePath;
    this.crawlPath = config.crawlPath;
    this.crawlEnabled = config.crawlEnabled === true;
    this.crawlMaxDepth = Math.max(config.crawlMaxDepth, 0);
    this.crawlMaxPages = Math.max(config.crawlMaxPages, 0);
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
    const cacheKey = buildSearchCacheKey(FirecrawlClient.provider, query, lookbackDays, maxResults, allowlist, denylist);
    const cached = getCachedSearchResults(this.cache, FirecrawlClient.provider, cacheKey, nowMs, this.metrics);
    if (cached) {
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

    const response = await this.request('POST', this.searchPath, payload, 'search');
    const results = normalizeSearchResults(response);
    cacheSearchResults(this.cache, cacheKey, results, cacheTtlMs, nowMs);
    return results;
  }

  async fetchContents(urls: string[], cacheTtlSeconds?: number): Promise<WebSearchContent[]> {
    const nowMs = Date.now();
    const deduped = Array.from(new Set(urls.filter((url) => typeof url === 'string' && url.length > 0)));
    if (deduped.length === 0) return [];

    const cacheTtlMs = typeof cacheTtlSeconds === 'number' ? Math.max(0, Math.floor(cacheTtlSeconds) * 1000) : 0;
    const { cached, uncached } = splitCachedContents(this.cache, FirecrawlClient.provider, deduped, nowMs);

    if (uncached.length === 0) {
      recordCachedContentsHit(this.metrics, FirecrawlClient.provider, cached.length);
      return cached;
    }

    const fetched: WebSearchContent[] = [];

    for (const url of uncached) {
      fetched.push(await this.fetchSingle(url));
    }
    cacheContents(this.cache, FirecrawlClient.provider, fetched, cacheTtlMs, nowMs);

    return [...cached, ...fetched];
  }

  private async fetchSingle(url: string): Promise<WebSearchContent> {
    const payload = {
      url,
      formats: ['markdown'],
      timeout: this.timeoutMs
    };

    const response = await this.request('POST', this.scrapePath, payload, 'scrape');
    const content = normalizeScrapeResult(response, url, this.maxContentBytes);

    if (content?.text || !this.crawlEnabled) return content;

    const crawlPayload = buildCrawlPayload(url, this.crawlMaxDepth, this.crawlMaxPages);
    const crawlResponse = await this.request('POST', this.crawlPath, crawlPayload, 'crawl');
    return normalizeCrawlResult(crawlResponse, url, this.maxContentBytes) ?? content;
  }

  private async request(
    method: string,
    path: string,
    body: Record<string, unknown>,
    kind: 'search' | 'scrape' | 'crawl'
  ): Promise<unknown> {
    return requestWebSearchJson(
      {
        provider: FirecrawlClient.provider,
        providerLabel: 'Firecrawl',
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        limiter: this.limiter,
        retryPolicy: this.retryPolicy,
        metrics: this.metrics,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'openpolytrader/0.1.0',
          Authorization: `Bearer ${this.apiKey}`
        },
        createError: (message, status, responseBody) => new FirecrawlApiError(message, status, responseBody)
      },
      method,
      path,
      body,
      kind
    );
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
  return normalizeSearchEntries(
    getFirecrawlSearchEntries(response),
    { snippet: ['description'], publishedAt: ['publishedDate'] },
    extractDomain
  );
}

function getFirecrawlSearchEntries(response: unknown): Array<Record<string, unknown>> {
  if (!isRecord(response)) return [];
  const data = response.data;
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data) && Array.isArray(data.web)) {
    return data.web.filter(isRecord);
  }
  return [];
}

function normalizeScrapeResult(response: unknown, url: string, maxContentBytes: number): WebSearchContent {
  const data = isRecord(response) && isRecord(response.data) ? response.data : {};
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
  const pages =
    isRecord(response) && isRecord(response.data) && Array.isArray(response.data.pages)
      ? response.data.pages.filter(isRecord)
      : [];
  const first = pages[0];
  if (!first) return null;
  const markdown = typeof first.markdown === 'string' ? first.markdown : undefined;
  const text = trimToBytes(markdown ?? '', maxContentBytes);
  return {
    url,
    text,
    source: extractDomain(url)
  };
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

function buildCrawlPayload(url: string, crawlMaxDepth: number, crawlMaxPages: number): Record<string, unknown> {
  const crawlPayload: Record<string, unknown> = { url };
  const crawlerOptions: Record<string, unknown> = {};
  if (crawlMaxDepth > 0) {
    crawlerOptions.maxDepth = crawlMaxDepth;
  }
  if (crawlMaxPages > 0) {
    crawlerOptions.limit = crawlMaxPages;
  }
  if (Object.keys(crawlerOptions).length > 0) {
    crawlPayload.crawlerOptions = crawlerOptions;
  }
  return crawlPayload;
}

function toFirecrawlTbs(lookbackDays: number): string | undefined {
  if (lookbackDays <= 1) return 'qdr:d';
  if (lookbackDays <= 7) return 'qdr:w';
  if (lookbackDays <= 31) return 'qdr:m';
  if (lookbackDays <= 365) return 'qdr:y';
  return undefined;
}
