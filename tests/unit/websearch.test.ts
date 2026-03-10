import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExaApiError, ExaClient } from '../../src/services/websearch/ExaClient.js';
import { FirecrawlApiError, FirecrawlClient } from '../../src/services/websearch/FirecrawlClient.js';
import { WebSearchCache } from '../../src/services/websearch/WebSearchCache.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExaClient', () => {
  it('uses the canonical Exa base URL when no override is provided', async () => {
    const fetchSpy = stubFetch({ results: [] });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, baseUrl: undefined, cache });

    await client.search('market news', {
      lookbackDays: 1,
      maxResults: 1,
      cacheTtlSeconds: 0
    });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/search');
  });

  it('caches search responses and passes domain filters', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'alpha' }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const options = {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 60,
      domainAllowlist: ['example.com'],
      domainDenylist: ['spam.com']
    };

    await client.search('market news', options);
    await client.search('market news', options);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/search');
    const body = JSON.parse(request.body as string);
    expect(body.type).toBe('neural');
    expect(body.includeDomains).toEqual(['example.com']);
    expect(body.excludeDomains).toEqual(['spam.com']);
  });

  it('skips caching when cacheTtlSeconds is zero', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'alpha' }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const options = {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    };

    await client.search('market news', options);
    await client.search('market news', options);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns empty results when response body is empty', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const results = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0,
      domainAllowlist: ['   '],
      domainDenylist: []
    });

    expect(results).toEqual([]);
  });

  it('retries on retryable errors', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'bad' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({
      ...BASE_EXA,
      retryMaxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      cache
    });

    const promise = client.search('market news', {
      lookbackDays: 1,
      maxResults: 1,
      cacheTtlSeconds: 0
    });

    await vi.runAllTimersAsync();
    const results = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toEqual([]);
    vi.useRealTimers();
  });

  it('records metrics for successful requests', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'alpha' }]
    });

    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new ExaClient({ ...BASE_EXA, cache, metrics });

    await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('request_ok');
  });

  it('starts cooldown on auth/billing failures and skips requests during cooldown', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => JSON.stringify({ error: 'payment_required' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [{ url: 'https://example.com' }] })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new ExaClient({ ...BASE_EXA, cooldownMs: 60000, cooldownFailureThreshold: 1, cache, metrics });

    await expect(
      client.search('market news', {
        lookbackDays: 7,
        maxResults: 5,
        cacheTtlSeconds: 0
      })
    ).rejects.toBeInstanceOf(ExaApiError);

    const skipped = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(skipped).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const events = metrics.recent('web_search', 10);
    expect(events.some((event) => event.data?.event === 'provider_cooldown_started')).toBe(true);
    expect(events.some((event) => event.data?.event === 'provider_cooldown_skip')).toBe(true);

    vi.useRealTimers();
  });

  it('resumes requests after cooldown expiry', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'unauthorized' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [{ url: 'https://example.com', title: 'Recovered' }] })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new ExaClient({ ...BASE_EXA, cooldownMs: 1000, cooldownFailureThreshold: 1, cache, metrics });

    await expect(
      client.search('market news', {
        lookbackDays: 7,
        maxResults: 5,
        cacheTtlSeconds: 0
      })
    ).rejects.toBeInstanceOf(ExaApiError);

    const skipped = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });
    expect(skipped).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(now + 1001);
    const recovered = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(recovered.length).toBe(1);
    const events = metrics.recent('web_search', 20);
    expect(events.some((event) => event.data?.event === 'provider_cooldown_recovered')).toBe(true);

    vi.useRealTimers();
  });

  it('truncates contents and caches by url', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'a'.repeat(50) }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, maxContentBytes: 10, cache });

    const first = await client.fetchContents(['https://example.com'], 60);
    expect(first[0]?.text.length).toBe(10);

    const second = await client.fetchContents(['https://example.com'], 60);
    expect(second[0]?.text.length).toBe(10);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns cached contents when all urls are cached', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'alpha' }]
    });

    const cache = new WebSearchCache();
    cache.setContent('exa:https://example.com', { url: 'https://example.com', text: 'cached' }, 60_000, Date.now());
    const client = new ExaClient({ ...BASE_EXA, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents[0]?.text).toBe('cached');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('returns empty contents when urls list is empty', async () => {
    const fetchSpy = stubFetch({ results: [] });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const contents = await client.fetchContents([], 60);
    expect(contents).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('handles invalid urls and published_date fallback', async () => {
    const fetchSpy = stubFetch({
      results: [
        { url: 'not-a-url', title: 'Example', published_date: '2024-01-01T00:00:00Z' },
        { url: '', title: 'Missing' }
      ]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const results = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results.length).toBe(1);
    expect(results[0]?.source).toBeUndefined();
    expect(results[0]?.publishedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('prefers publishedDate in search results', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', publishedDate: '2024-02-01T00:00:00Z' }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const results = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0]?.publishedAt).toBe('2024-02-01T00:00:00Z');
  });

  it('handles non-string title and text in search results', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 123, text: 456 }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const results = await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0]?.title).toBeUndefined();
    expect(results[0]?.snippet).toBeUndefined();
  });

  it('handles empty content payloads and skips url-less entries', async () => {
    const fetchSpy = stubFetch({
      results: [
        { url: '', title: 'Missing' },
        { url: 'https://example.com', text: 'short', title: 'Example' }
      ]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, maxContentBytes: 100, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(contents.length).toBe(1);
    expect(contents[0]?.text).toBe('short');
  });

  it('preserves publishedDate and empty content text', async () => {
    const fetchSpy = stubFetch({
      results: [
        { url: 'https://example.com', text: '', title: 'Example', publishedDate: '2024-01-01T00:00:00Z' },
        { url: 123, text: 'skip' }
      ]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, maxContentBytes: 100, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(contents.length).toBe(1);
    expect(contents[0]?.text).toBe('');
    expect(contents[0]?.publishedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('handles non-string title and text in content results', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 123, text: 456 }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(contents[0]?.title).toBeUndefined();
    expect(contents[0]?.text).toBe('');
  });

  it('returns empty contents when results payload is missing', async () => {
    const fetchSpy = stubFetch({});

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(contents).toEqual([]);
  });

  it('does not cache contents when cache ttl is omitted', async () => {
    const fetchSpy = stubFetch({
      results: [{ url: 'https://example.com', title: 'Example', text: 'alpha' }]
    });

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    const first = await client.fetchContents(['https://example.com']);
    const second = await client.fetchContents(['https://example.com']);

    expect(first[0]?.text).toBe('alpha');
    expect(second[0]?.text).toBe('alpha');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on non-OK response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'bad' })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    await expect(client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    })).rejects.toBeInstanceOf(ExaApiError);
  });

  it('throws on invalid JSON response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    await expect(client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    })).rejects.toThrow(/invalid JSON/);
  });

  it('does not enter cooldown when cooldown is disabled', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'unauthorized' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cooldownMs: 0, cooldownFailureThreshold: 1, cache });

    await expect(
      client.search('market news', {
        lookbackDays: 7,
        maxResults: 5,
        cacheTtlSeconds: 0
      })
    ).rejects.toBeInstanceOf(ExaApiError);

    await client.search('market news', {
      lookbackDays: 7,
      maxResults: 5,
      cacheTtlSeconds: 0
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('starts cooldown only after threshold failures and skips uncached contents while cooling down', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: 'unauthorized' })
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 402,
          text: async () => JSON.stringify({ error: 'payment_required' })
        });
      vi.stubGlobal('fetch', fetchSpy);

      const cache = new WebSearchCache();
      const metrics = new MetricsStore(100);
      const client = new ExaClient({ ...BASE_EXA, cooldownMs: 60_000, cooldownFailureThreshold: 2, cache, metrics });

      await expect(
        client.search('market news', {
          lookbackDays: 7,
          maxResults: 5,
          cacheTtlSeconds: 0
        })
      ).rejects.toBeInstanceOf(ExaApiError);

      await expect(
        client.search('market news', {
          lookbackDays: 7,
          maxResults: 5,
          cacheTtlSeconds: 0
        })
      ).rejects.toBeInstanceOf(ExaApiError);

      const contents = await client.fetchContents(['https://example.com'], undefined);
      expect(contents).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const events = metrics.recent('web_search', 10);
      expect(events.some((event) => event.data?.event === 'provider_cooldown_started')).toBe(true);
      expect(events.some((event) => event.data?.event === 'provider_cooldown_skip' && event.data?.kind === 'contents')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores raw response text for non-OK invalid JSON error bodies', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'not-json'
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new ExaClient({ ...BASE_EXA, cache });

    await expect(
      client.search('market news', {
        lookbackDays: 7,
        maxResults: 5,
        cacheTtlSeconds: 0
      })
    ).rejects.toMatchObject<Partial<ExaApiError>>({
      status: 500,
      body: { raw: 'not-json' }
    });
  });

  it('does not record duplicate cooldown start events while already cooling down', () => {
    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new ExaClient({ ...BASE_EXA, cooldownMs: 60_000, cooldownFailureThreshold: 1, cache, metrics });
    const internals = client as unknown as {
      cooldownUntilMs: number;
      consecutiveAuthFailures: number;
      handleAuthFailure: (kind: 'search' | 'contents', status: number, nowMs: number) => void;
    };

    const nowMs = Date.now();
    internals.cooldownUntilMs = nowMs + 60_000;
    internals.consecutiveAuthFailures = 1;

    internals.handleAuthFailure('search', 401, nowMs);

    const starts = metrics
      .recent('web_search', 10)
      .filter((event) => event.data?.event === 'provider_cooldown_started');
    expect(starts).toHaveLength(0);
  });
});

describe('FirecrawlClient', () => {
  it('uses the canonical Firecrawl base URL when no override is provided', async () => {
    const fetchSpy = stubFetch({
      data: { web: [] }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, baseUrl: undefined, cache });

    await client.search('polymarket', { lookbackDays: 1, maxResults: 1, cacheTtlSeconds: 0 });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
  });

  it('adds tbs and domain filters to search payload', async () => {
    const fetchSpy = stubFetch({
      data: { web: [{ url: 'https://example.com', title: 'Example', description: 'x' }] }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    await client.search('polymarket', {
      lookbackDays: 7,
      maxResults: 3,
      cacheTtlSeconds: 60,
      domainAllowlist: ['example.com'],
      domainDenylist: ['spam.com']
    });

    const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
    const body = JSON.parse(request.body as string);
    expect(body.tbs).toBe('qdr:w');
    expect(body.includeDomains).toEqual(['example.com']);
    expect(body.excludeDomains).toEqual(['spam.com']);
  });

  it('maps lookbackDays to tbs buckets', async () => {
    const fetchSpy = stubFetch({
      data: { web: [] }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    await client.search('polymarket', { lookbackDays: 1, maxResults: 1, cacheTtlSeconds: 0 });
    await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 0 });
    await client.search('polymarket', { lookbackDays: 31, maxResults: 1, cacheTtlSeconds: 0 });
    await client.search('polymarket', { lookbackDays: 365, maxResults: 1, cacheTtlSeconds: 0 });
    await client.search('polymarket', { lookbackDays: 500, maxResults: 1, cacheTtlSeconds: 0 });

    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0].tbs).toBe('qdr:d');
    expect(bodies[1].tbs).toBe('qdr:w');
    expect(bodies[2].tbs).toBe('qdr:m');
    expect(bodies[3].tbs).toBe('qdr:y');
    expect(bodies[4].tbs).toBeUndefined();
  });

  it('uses cached search results and records cache hit metrics', async () => {
    const fetchSpy = stubFetch({
      data: { web: [{ url: 'https://example.com', title: 'Example', description: 'x' }] }
    });

    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache, metrics });

    await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 60 });
    await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 60 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('search_cache_hit');
  });

  it('retries on retryable errors', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'bad' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { web: [] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({
      ...BASE_FIRECRAWL,
      retryMaxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      cache
    });

    const promise = client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 0 });
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toEqual([]);
    vi.useRealTimers();
  });

  it('records request_ok metrics on successful calls', async () => {
    const fetchSpy = stubFetch({
      data: { web: [{ url: 'https://example.com', title: 'Example', description: 'x' }] }
    });

    const cache = new WebSearchCache();
    const metrics = new MetricsStore(100);
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache, metrics });

    await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 0 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('request_ok');
  });

  it('handles empty search responses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const results = await client.search('polymarket', { lookbackDays: 7, maxResults: 3, cacheTtlSeconds: 0 });
    expect(results).toEqual([]);
  });

  it('throws on invalid JSON responses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    await expect(client.search('polymarket', {
      lookbackDays: 7,
      maxResults: 3,
      cacheTtlSeconds: 0
    })).rejects.toThrow(/invalid JSON/);
  });

  it('supports data array fallback and invalid url sources', async () => {
    const fetchSpy = stubFetch({
      data: [{ url: 'not-a-url', title: 'Example', description: 'x' }]
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const results = await client.search('polymarket', { lookbackDays: 7, maxResults: 3, cacheTtlSeconds: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0]?.source).toBeUndefined();
  });

  it('handles missing title and description in search results', async () => {
    const fetchSpy = stubFetch({
      data: { web: [{ url: 'https://example.com', title: 123, description: 456, publishedDate: '2024-03-01T00:00:00Z' }] }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const results = await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0]?.title).toBeUndefined();
    expect(results[0]?.snippet).toBeUndefined();
    expect(results[0]?.publishedAt).toBe('2024-03-01T00:00:00Z');
  });

  it('skips search entries without urls', async () => {
    const fetchSpy = stubFetch({
      data: { web: [{ url: '', title: 'Missing', description: 'x' }] }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const results = await client.search('polymarket', { lookbackDays: 7, maxResults: 1, cacheTtlSeconds: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });

  it('skips search entries with missing or non-string urls', async () => {
    const fetchSpy = stubFetch({
      data: {
        web: [
          { title: 'Missing url' },
          { url: 123, title: 'Wrong type' },
          { url: 'https://example.com/story', description: 'kept' }
        ]
      }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const results = await client.search('polymarket', { lookbackDays: 7, maxResults: 3, cacheTtlSeconds: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      {
        url: 'https://example.com/story',
        source: 'example.com',
        snippet: 'kept'
      }
    ]);
  });

  it('caches scraped contents', async () => {
    const fetchSpy = stubFetch({
      data: { markdown: 'hello world', title: 'Example' }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const first = await client.fetchContents(['https://example.com'], 60);
    expect(first[0]?.text).toContain('hello world');

    const second = await client.fetchContents(['https://example.com'], 60);
    expect(second[0]?.text).toContain('hello world');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns empty contents when urls list is empty', async () => {
    const fetchSpy = stubFetch({ data: { web: [] } });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const contents = await client.fetchContents([], 60);
    expect(contents).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('does not cache fetched contents when cache ttl is omitted', async () => {
    const fetchSpy = stubFetch({
      data: { markdown: 'hello world', title: 'Example' }
    });

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    const first = await client.fetchContents(['https://example.com']);
    const second = await client.fetchContents(['https://example.com']);

    expect(first[0]?.text).toContain('hello world');
    expect(second[0]?.text).toContain('hello world');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('skips crawl when scrape has content', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { markdown: 'hello' } })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const results = await client.fetchContents(['https://example.com'], 60);
    expect(results[0]?.text).toContain('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles missing crawl pages gracefully', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const empty = await client.fetchContents(['https://example.com'], 60);
    expect(empty[0]?.text).toBe('');
  });

  it('handles missing scrape data safely', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: {} })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: false, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents[0]?.text).toBe('');
  });

  it('handles entirely missing scrape payload data safely', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({})
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: false, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents).toEqual([
      {
        url: 'https://example.com',
        source: 'example.com',
        text: ''
      }
    ]);
  });

  it('returns scrape content when crawl pages are invalid', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [123] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents[0]?.text).toBe('');
  });

  it('returns empty scrape content when crawl is disabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { markdown: '' } })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: false, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents[0]?.text).toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles non-string crawl markdown safely', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [{ markdown: 123 }] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents[0]?.text).toBe('');
  });

  it('returns scrape content when crawl data omits pages', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: {} })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const contents = await client.fetchContents(['https://example.com'], 60);
    expect(contents).toEqual([
      {
        url: 'https://example.com',
        source: 'example.com',
        text: ''
      }
    ]);
  });

  it('truncates crawl content when maxContentBytes is small', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [{ markdown: 'x'.repeat(50) }] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, maxContentBytes: 10, cache });

    const truncated = await client.fetchContents(['https://example.org'], 60);
    expect(truncated[0]?.text.length).toBe(10);
  });

  it('omits crawler options when limits are zero', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [{ markdown: 'crawl' }] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, crawlMaxDepth: 0, crawlMaxPages: 0, cache });

    await client.fetchContents(['https://example.com'], 60);

    const [, request] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(request.body as string) as { crawlerOptions?: Record<string, unknown> };
    expect(body.crawlerOptions).toBeUndefined();
  });

  it('throws on non-OK response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: 'bad' })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    await expect(client.search('polymarket', {
      lookbackDays: 7,
      maxResults: 3,
      cacheTtlSeconds: 0
    })).rejects.toBeInstanceOf(FirecrawlApiError);
  });

  it('uses crawl fallback with limits when scrape is empty', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { markdown: '' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { pages: [{ markdown: 'crawl result' }] } })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, crawlEnabled: true, cache });

    const results = await client.fetchContents(['https://example.com'], 60);
    expect(results[0]?.text).toContain('crawl result');

    const [, request] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(request.body as string) as { crawlerOptions?: { maxDepth?: number; limit?: number } };
    expect(body.crawlerOptions).toEqual({ maxDepth: 2, limit: 10 });
  });

  it('stores raw response text for Firecrawl non-OK invalid JSON error bodies', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'not-json'
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new WebSearchCache();
    const client = new FirecrawlClient({ ...BASE_FIRECRAWL, cache });

    await expect(
      client.search('polymarket', {
        lookbackDays: 7,
        maxResults: 3,
        cacheTtlSeconds: 0
      })
    ).rejects.toMatchObject<Partial<FirecrawlApiError>>({
      status: 502,
      body: { raw: 'not-json' }
    });
  });
});
