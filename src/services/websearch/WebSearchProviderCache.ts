import type { MetricsStore } from '../../telemetry/metrics.js';
import type { WebSearchContent, WebSearchResult } from './WebSearchClient.js';
import { WebSearchCache } from './WebSearchCache.js';
import { recordWebSearchMetric } from './WebSearchProviderMetrics.js';

export function buildSearchCacheKey(
  provider: string,
  query: string,
  lookbackDays: number,
  maxResults: number,
  allowlist: string[],
  denylist: string[]
): string {
  return [
    provider,
    query.trim(),
    `lookback:${lookbackDays}`,
    `max:${maxResults}`,
    `allow:${allowlist.join(',')}`,
    `deny:${denylist.join(',')}`
  ].join('|');
}

export function getCachedSearchResults(
  cache: WebSearchCache,
  provider: string,
  cacheKey: string,
  nowMs: number,
  metrics?: MetricsStore
): WebSearchResult[] | null {
  const cached = cache.getSearch(cacheKey, nowMs);
  if (!cached) return null;
  recordWebSearchMetric(metrics, 'search_cache_hit', { provider });
  return cached;
}

export function cacheSearchResults(
  cache: WebSearchCache,
  cacheKey: string,
  results: WebSearchResult[],
  cacheTtlMs: number,
  nowMs: number
): void {
  if (cacheTtlMs > 0) {
    cache.setSearch(cacheKey, results, cacheTtlMs, nowMs);
  }
}

export function splitCachedContents(
  cache: WebSearchCache,
  provider: string,
  urls: string[],
  nowMs: number
): { cached: WebSearchContent[]; uncached: string[] } {
  const cached: WebSearchContent[] = [];
  const uncached: string[] = [];

  for (const url of urls) {
    const hit = cache.getContent(buildContentCacheKey(provider, url), nowMs);
    if (hit) {
      cached.push(hit);
    } else {
      uncached.push(url);
    }
  }

  return { cached, uncached };
}

export function cacheContents(
  cache: WebSearchCache,
  provider: string,
  contents: WebSearchContent[],
  cacheTtlMs: number,
  nowMs: number
): void {
  if (cacheTtlMs <= 0) return;
  for (const content of contents) {
    if (content.url) {
      cache.setContent(buildContentCacheKey(provider, content.url), content, cacheTtlMs, nowMs);
    }
  }
}

export function recordCachedContentsHit(
  metrics: MetricsStore | undefined,
  provider: string,
  count: number
): void {
  recordWebSearchMetric(metrics, 'contents_cache_hit', { provider, count });
}

function buildContentCacheKey(provider: string, url: string): string {
  return `${provider}:${url}`;
}
