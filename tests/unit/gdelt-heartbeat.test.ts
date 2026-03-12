import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { GdeltHeartbeatService, __gdeltHeartbeatTestUtils } from '../../src/services/websearch/GdeltHeartbeatService.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GdeltHeartbeatService', () => {
  it('covers helper normalization branches directly', () => {
    expect(__gdeltHeartbeatTestUtils.buildQuery('  spaced   question  ')).toBe('"spaced question"');
    expect(__gdeltHeartbeatTestUtils.buildQuery('   ')).toBe('');
    expect(__gdeltHeartbeatTestUtils.emptyHeartbeat(42)).toMatchObject({
      triggerScore: 0,
      reasons: ['no_trigger'],
      updatedAtMs: 42
    });
    expect(__gdeltHeartbeatTestUtils.extractDomain('https://example.com/path')).toBe('example.com');
    expect(__gdeltHeartbeatTestUtils.extractDomain('notaurl')).toBeUndefined();
    expect(__gdeltHeartbeatTestUtils.isOfficialDomain(undefined)).toBe(false);
    expect(__gdeltHeartbeatTestUtils.isOfficialDomain('sec.gov')).toBe(true);
    expect(__gdeltHeartbeatTestUtils.isOfficialDomain('example.com')).toBe(false);
    expect(__gdeltHeartbeatTestUtils.getArticleEntries({ articles: 'bad-shape' })).toEqual([]);
    expect(
      __gdeltHeartbeatTestUtils.getArticleEntries({
        articles: [
          { url: 'https://example.com/a', domain: 'example.com', title: 'A', seendate: '20260310' },
          { url: 'notaurl', title: 'B' },
          { title: 'missing url' }
        ]
      })
    ).toEqual([
      { url: 'https://example.com/a', source: 'example.com', title: 'A', snippet: 'A 20260310' },
      { url: 'notaurl', source: undefined, title: 'B', snippet: 'B' }
    ]);
    expect(__gdeltHeartbeatTestUtils.computeContradictionScore([], ['Yes', 'No'])).toBe(0);
    expect(__gdeltHeartbeatTestUtils.computeContradictionScore([{ url: 'u', title: 'Yes', snippet: 'No' }], ['Yes'])).toBe(0);
    expect(
      __gdeltHeartbeatTestUtils.computeContradictionScore(
        [
          { url: 'u1', title: 'Yes wins' },
          { url: 'u2', title: 'No wins' }
        ],
        ['Yes', 'No']
      )
    ).toBeGreaterThan(0);
    expect(__gdeltHeartbeatTestUtils.computeContradictionScore([{ url: 'u3', title: undefined, snippet: undefined }], ['Yes', 'No'])).toBe(0);
    expect(
      __gdeltHeartbeatTestUtils.getArticleEntries({
        articles: [{ url: 'https://example.com/c', title: 123, seendate: '20260310' }]
      })
    ).toEqual([{ url: 'https://example.com/c', source: 'example.com', title: undefined, snippet: ' 20260310' }]);
  });

  it('computes a trigger state and caches it until refresh ttl expires', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [
            { url: 'https://www.whitehouse.gov/briefing', domain: 'whitehouse.gov', title: 'Yes update' },
            { url: 'https://www.reuters.com/story', domain: 'reuters.com', title: 'No counterpoint' }
          ]
        })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const metrics = new MetricsStore(100);
    const service = new GdeltHeartbeatService({
      policy: { ...DEFAULT_TRADE_POLICY, evWebSearchOfficialDomainRequired: false },
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      metrics
    });

    const first = await service.getState({
      marketId: 'market-1',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now
    });
    const second = await service.getState({
      marketId: 'market-1',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now + 1000
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.officialDomainPresent).toBe(true);
    expect(first.triggerScore).toBeGreaterThanOrEqual(0);
    expect(second.updatedAtMs).toBe(first.updatedAtMs);
    expect(metrics.recent('web_search', 10).some((entry) => entry.data?.event === 'heartbeat_updated')).toBe(true);
  });

  it('returns an empty heartbeat when the question is blank', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const service = new GdeltHeartbeatService({
      policy: { ...DEFAULT_TRADE_POLICY, evWebSearchOfficialDomainRequired: false },
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    const state = await service.getState({
      marketId: 'market-blank',
      question: '   ',
      outcomes: ['Yes', 'No'],
      nowMs: Date.now()
    });

    expect(state).toMatchObject({
      triggerScore: 0,
      reasons: ['no_trigger'],
      officialDomainPresent: false
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks official confirmation missing when only non-official sources are found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [
            { url: 'https://blog.example.com/post', domain: 'blog.example.com', title: 'Yes case' },
            { url: 'https://forum.example.com/post', domain: 'forum.example.com', title: 'No case' }
          ]
        })
    }));

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    const state = await service.getState({
      marketId: 'market-official',
      question: 'Will the Fed cut rates in June?',
      outcomes: ['Yes', 'No'],
      nowMs: Date.now()
    });

    expect(state.reasons).toContain('official_confirmation_missing');
    expect(state.officialDomainPresent).toBe(false);
  });

  it('tracks novelty and source deltas after the cache expires', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            articles: [{ url: 'https://reuters.com/first', domain: 'reuters.com', title: 'Yes first' }]
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            articles: [
              { url: 'https://reuters.com/first', domain: 'reuters.com', title: 'Yes first' },
              { url: 'https://apnews.com/second', domain: 'apnews.com', title: 'No second' }
            ]
          })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const service = new GdeltHeartbeatService({
      policy: { ...DEFAULT_TRADE_POLICY, evWebSearchGdeltRefreshMinutes: 1 },
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    const first = await service.getState({
      marketId: 'market-delta',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now
    });
    const second = await service.getState({
      marketId: 'market-delta',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now + 61_000
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.articleDelta).toBe(1);
    expect(second.articleDelta).toBe(1);
    expect(second.uniqueSourceDelta).toBe(1);
    expect(second.noveltyScore).toBeGreaterThan(0);
  });

  it('returns zero novelty when refreshed payloads contain no usable urls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [{ title: 'Missing url should be dropped' }]
        })
    }));

    const service = new GdeltHeartbeatService({
      policy: { ...DEFAULT_TRADE_POLICY, evWebSearchOfficialDomainRequired: false },
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    const state = await service.getState({
      marketId: 'market-empty-urls',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: Date.now()
    });

    expect(state.articleCount).toBe(0);
    expect(state.noveltyScore).toBe(0);
    expect(state.reasons).toEqual(['no_trigger']);
  });

  it('throws a typed error when GDELT returns an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: 'bad_gateway' })
    }));

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    await expect(
      service.getState({
        marketId: 'market-http-error',
        question: 'Will it happen?',
        outcomes: ['Yes', 'No'],
        nowMs: Date.now()
      })
    ).rejects.toMatchObject({
      name: 'GdeltHeartbeatError',
      status: 502
    });
  });

  it('preserves raw bodies for non-json http failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'not-json'
    }));

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    await expect(
      service.getState({
        marketId: 'market-http-raw',
        question: 'Will it happen?',
        outcomes: ['Yes', 'No'],
        nowMs: Date.now()
      })
    ).rejects.toMatchObject({
      name: 'GdeltHeartbeatError',
      status: 503,
      body: { raw: 'not-json' }
    });
  });

  it('throws on invalid JSON payloads and tolerates malformed articles', async () => {
    const invalidJsonFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not-json'
    });
    vi.stubGlobal('fetch', invalidJsonFetch);

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    await expect(
      service.getState({
        marketId: 'market-invalid-json',
        question: 'Will it happen?',
        outcomes: ['Yes', 'No'],
        nowMs: Date.now()
      })
    ).rejects.toThrow(/invalid JSON/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [
            { url: 'notaurl', title: 'Yes maybe', seendate: '20260101' },
            { title: 'Missing url should be dropped' }
          ]
        })
    }));

    const state = await service.getState({
      marketId: 'market-malformed-articles',
      question: 'Will it happen?',
      outcomes: ['Yes'],
      nowMs: Date.now()
    });

    expect(state.articleCount).toBe(1);
    expect(state.contradictionScore).toBe(0);
  });

  it('retries retryable GDELT failures and respects policy updates', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'server_error' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            articles: [{ url: 'https://reuters.com/recovered', domain: 'reuters.com', title: 'Recovered' }]
          })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });
    service.updatePolicy({ ...DEFAULT_TRADE_POLICY, evWebSearchOfficialDomainRequired: false });

    const promise = service.getState({
      marketId: 'market-retry',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: Date.now()
    });

    await vi.runAllTimersAsync();
    const state = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(state.articleCount).toBe(1);
  });

  it('caches a fallback heartbeat after failure to avoid immediate refetch noise', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate_limited' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            articles: [{ url: 'https://reuters.com/recovered', domain: 'reuters.com', title: 'Recovered' }]
          })
      });
    vi.stubGlobal('fetch', fetchSpy);
    const metrics = new MetricsStore(100);

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      metrics
    });

    const initial = await service.getState({
      marketId: 'market-failure-cache',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now
    });

    const cached = await service.getState({
      marketId: 'market-failure-cache',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now + 1_000
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(initial).toMatchObject({
      triggerScore: 0,
      reasons: ['no_trigger'],
      articleCount: 0
    });
    expect(cached).toMatchObject({
      triggerScore: 0,
      reasons: ['no_trigger'],
      articleCount: 0
    });
    expect(metrics.recent('web_search', 10).some((entry) => entry.data?.event === 'heartbeat_failed')).toBe(true);

    const recovered = await service.getState({
      marketId: 'market-failure-cache',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: now + 61_000
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(recovered.articleCount).toBe(1);
  });

  it('retries aborted requests as timeout failures', async () => {
    vi.useFakeTimers();
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            articles: [{ url: 'https://apnews.com/recovered', domain: 'apnews.com', title: 'Recovered' }]
          })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const service = new GdeltHeartbeatService({
      policy: DEFAULT_TRADE_POLICY,
      timeoutMs: 1000,
      rateLimitPerWindow: 100,
      rateLimitWindowMs: 1000,
      retryMaxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    const promise = service.getState({
      marketId: 'market-timeout-retry',
      question: 'Will it happen?',
      outcomes: ['Yes', 'No'],
      nowMs: Date.now()
    });

    await vi.runAllTimersAsync();
    const state = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(state.articleCount).toBe(1);
  });
});
