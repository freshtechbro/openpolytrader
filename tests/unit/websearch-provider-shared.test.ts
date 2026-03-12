import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../src/services/RateLimiter.js';
import { RetryPolicy } from '../../src/services/RetryPolicy.js';
import { WebSearchCache } from '../../src/services/websearch/WebSearchCache.js';
import { cacheContents, requestWebSearchJson } from '../../src/services/websearch/WebSearchProviderShared.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebSearchProviderShared', () => {
  it('skips cache writes for entries without urls', () => {
    const cache = new WebSearchCache();
    const nowMs = Date.now();

    cacheContents(
      cache,
      'shared',
      [
        { url: '', text: 'skip-me' },
        { url: 'https://example.com', text: 'keep-me' }
      ],
      60_000,
      nowMs
    );

    expect(cache.getContent('shared:https://example.com', nowMs)?.text).toBe('keep-me');
    expect(cache.getContent('shared:', nowMs)).toBeNull();
  });

  it('uses the provider key when no provider label is supplied on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: 'bad gateway' })
    }));

    await expect(
      requestWebSearchJson(
        {
          provider: 'shared-provider',
          baseUrl: 'https://example.com',
          timeoutMs: 1_000,
          limiter: new RateLimiter(10, 1_000),
          retryPolicy: new RetryPolicy({ maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryOn: () => false }),
          headers: { 'Content-Type': 'application/json' },
          createError: (message, status, body) => Object.assign(new Error(message), { status, body })
        },
        'POST',
        '/search',
        { query: 'market news' },
        'search'
      )
    ).rejects.toMatchObject({
      message: 'shared-provider API error 502 for POST /search',
      status: 502
    });
  });

  it('uses the provider key when no provider label is supplied on invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    }));

    await expect(
      requestWebSearchJson(
        {
          provider: 'shared-provider',
          baseUrl: 'https://example.com',
          timeoutMs: 1_000,
          limiter: new RateLimiter(10, 1_000),
          retryPolicy: new RetryPolicy({ maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryOn: () => false }),
          headers: { 'Content-Type': 'application/json' },
          createError: (message, status, body) => Object.assign(new Error(message), { status, body })
        },
        'POST',
        '/search',
        { query: 'market news' },
        'search'
      )
    ).rejects.toThrow('shared-provider API invalid JSON for POST /search: not-json');
  });
});
