import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebSearchCache } from '../../src/services/websearch/WebSearchCache.js';
import { ExaClient } from '../../src/services/websearch/ExaClient.js';
import { FirecrawlClient } from '../../src/services/websearch/FirecrawlClient.js';

const BASE_EXA = {
  baseUrl: 'https://api.exa.ai',
  apiKey: 'exa-key',
  timeoutMs: 1000,
  rateLimitPerWindow: 1000,
  rateLimitWindowMs: 1000,
  retryMaxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
  maxContentBytes: 1000,
  searchPath: '/search',
  contentsPath: '/contents',
  cooldownMs: 60000,
  cooldownFailureThreshold: 1
};

const BASE_FIRECRAWL = {
  baseUrl: 'https://api.firecrawl.dev',
  apiKey: 'firecrawl-key',
  timeoutMs: 1000,
  rateLimitPerWindow: 1000,
  rateLimitWindowMs: 1000,
  retryMaxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
  maxContentBytes: 1000,
  searchPath: '/v2/search',
  scrapePath: '/v2/scrape',
  crawlPath: '/v2/crawl',
  crawlEnabled: false,
  crawlMaxDepth: 2,
  crawlMaxPages: 10
};

function stubFetch(responseBody: unknown) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responseBody)
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebSearchCache', () => {
  it('evicts expired entries on read', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache({ maxEntries: 10 });
    cache.setSearch('alpha', [{ url: 'https://example.com' }], 1000, now);

    expect(cache.getSearch('alpha', now + 500)).not.toBeNull();
    expect(cache.getSearch('alpha', now + 1500)).toBeNull();
  });

  it('evicts expired content entries on read', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache({ maxEntries: 10 });
    cache.setContent('expired', { url: 'https://expired.com', text: 'x' }, 1000, now);

    expect(cache.getContent('expired', now + 1500)).toBeNull();
  });

  it('prunes expired content entries on set', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache({ maxEntries: 10 });
    cache.setContent('expired', { url: 'https://expired.com', text: 'x' }, 1000, now);
    cache.setContent('fresh', { url: 'https://fresh.com', text: 'y' }, 1000, now + 1500);

    expect(cache.getContent('expired', now + 1500)).toBeNull();
    expect(cache.getContent('fresh', now + 1500)).not.toBeNull();
  });

  it('evicts oldest entries when max entries exceeded', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache({ maxEntries: 2 });
    cache.setContent('first', { url: 'https://a.com', text: 'a' }, 10000, now);
    cache.setContent('second', { url: 'https://b.com', text: 'b' }, 10000, now + 1);
    cache.setContent('third', { url: 'https://c.com', text: 'c' }, 10000, now + 2);

    expect(cache.getContent('first', now + 2)).toBeNull();
    expect(cache.getContent('second', now + 2)).not.toBeNull();
    expect(cache.getContent('third', now + 2)).not.toBeNull();
  });

  it('does not store entries with non-positive TTL', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache({ maxEntries: 10 });
    cache.setSearch('alpha', [{ url: 'https://example.com' }], 0, now);
    cache.setContent('beta', { url: 'https://example.com', text: 'x' }, -5, now);

    expect(cache.getSearch('alpha', now)).toBeNull();
    expect(cache.getContent('beta', now)).toBeNull();
  });

  it('accepts numeric maxEntries config', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cache = new WebSearchCache(1);
    cache.setSearch('first', [{ url: 'https://a.com' }], 10000, now);
    cache.setSearch('second', [{ url: 'https://b.com' }], 10000, now + 1);

    expect(cache.getSearch('first', now + 1)).toBeNull();
    expect(cache.getSearch('second', now + 1)).not.toBeNull();
  });
});

describe('WebSearchCache provider isolation', () => {
  it('keeps Exa and Firecrawl search caches isolated', async () => {
    const fetchSpy = stubFetch({ results: [], data: { web: [] } });

    const cache = new WebSearchCache({ maxEntries: 10 });
    const exa = new ExaClient({ ...BASE_EXA, cache });
    const firecrawl = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const options = {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 60
    };

    await exa.search('market', options);
    await firecrawl.search('market', options);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
