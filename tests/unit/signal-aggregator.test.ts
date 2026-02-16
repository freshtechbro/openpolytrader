import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignalAggregatorAgent } from '../../src/agents/signal/SignalAggregatorAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { messageBus } from '../../src/core/MessageBus.js';
import type { MarketPair } from '../../src/domain/market.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { WebSearchClient, WebSearchContent, WebSearchResult } from '../../src/services/websearch/WebSearchClient.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

class StubWebSearchClient implements WebSearchClient {
  public search = vi.fn(async () => this.results);
  public fetchContents = vi.fn(async () => this.contents);

  constructor(
    private results: WebSearchResult[],
    private contents: WebSearchContent[]
  ) {}
}

const waitForIdle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function captureSignal({
  text,
  publishedAt,
  policyOverrides
}: {
  text?: string;
  publishedAt: string;
  policyOverrides: Partial<typeof DEFAULT_TRADE_POLICY>;
}): Promise<string | undefined> {
  const pair: MarketPair = { marketId: 'signal-test', yesTokenId: 'y1', noTokenId: 'n1' };
  const clob = {
    getMarket: vi.fn().mockResolvedValue({
      question: 'Will it happen?',
      tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
    })
  } as unknown as PolymarketClob;

  const exa = new StubWebSearchClient(
    [{ url: 'https://example.com', title: 'Example', publishedAt }],
    [{ url: 'https://example.com', text }]
  );

  const policy = {
    ...DEFAULT_TRADE_POLICY,
    signalMode: 'ev' as const,
    evWebSearchExaEnabled: true,
    evWebSearchFirecrawlEnabled: false,
    evWebSearchMaxConcurrency: 1,
    ...policyOverrides
  };

  const agent = new SignalAggregatorAgent({
    policy,
    marketPairs: [pair],
    clob,
    exa
  });

  const handler = vi.fn();
  messageBus.on('learning:insight', handler);

  await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

  messageBus.off('learning:insight', handler);

  return handler.mock.calls[0]?.[0]?.insights?.[0]?.signal;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SignalAggregatorAgent', () => {
  it('emits insights from primary provider and caches per market', async () => {
    const pair: MarketPair = { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will it rain tomorrow?',
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes no yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 2
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const handler = vi.fn();
    messageBus.on('learning:insight', handler);

    agent.start();
    await waitForIdle();

    expect(handler).toHaveBeenCalled();
    expect(exa.search).toHaveBeenCalledTimes(3);
    expect(exa.fetchContents).toHaveBeenCalledTimes(1);
    expect(clob.getMarket).toHaveBeenCalledTimes(1);

    agent.stop();
    messageBus.off('learning:insight', handler);

    agent.start();
    await waitForIdle();

    expect(exa.search).toHaveBeenCalledTimes(3);
    expect(clob.getMarket).toHaveBeenCalledTimes(1);

    agent.stop();
  });

  it('caps fetched content URLs to reduce provider costs', async () => {
    const pair: MarketPair = { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will it rain tomorrow?',
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      })
    } as unknown as PolymarketClob;

    const urls = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}`);
    const exa = new StubWebSearchClient(
      urls.map((url) => ({ url, title: 'Example', publishedAt: new Date().toISOString() })),
      urls.map((url) => ({ url, text: 'yes no yes' }))
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.fetchContents).toHaveBeenCalledTimes(1);
    const requestedUrls = exa.fetchContents.mock.calls[0]?.[0] as string[];
    expect(requestedUrls).toEqual(urls.slice(0, 8));
  });

  it('falls back to secondary provider when primary returns no results', async () => {
    const pair: MarketPair = { marketId: 'm2', yesTokenId: 'y2', noTokenId: 'n2' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it snow?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const firecrawl = new StubWebSearchClient(
      [{ url: 'https://example.org', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.org', text: 'yes yes no' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchPrimary: 'exa' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: true,
      evWebSearchMaxConcurrency: 2
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      firecrawl
    });

    agent.start();
    await waitForIdle();

    expect(exa.search).toHaveBeenCalledTimes(3);
    expect(firecrawl.search).toHaveBeenCalledTimes(3);

    agent.stop();
  });

  it('does not run when signalMode is near_zero', async () => {
    const pair: MarketPair = { marketId: 'm3', yesTokenId: 'y3', noTokenId: 'n3' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it hail?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.net', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.net', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'near_zero' as const,
      evWebSearchExaEnabled: true
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();

    expect(exa.search).not.toHaveBeenCalled();
    agent.stop();
  });

  it('runs websearch only for allowlisted active pairs', async () => {
    const active: MarketPair = { marketId: 'active-market', yesTokenId: 'y-active', noTokenId: 'n-active' };
    const inactive: MarketPair = { marketId: 'inactive-market', yesTokenId: 'y-inactive', noTokenId: 'n-inactive' };
    const clob = {
      getMarket: vi.fn().mockImplementation(async (marketId: string) => ({
        question: `Will ${marketId} happen?`,
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      }))
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.net', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.net', text: 'yes' }]
    );

    const allowlist = {
      isAllowed: vi.fn((marketId: string) => marketId === active.marketId)
    };

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };
    const metrics = new MetricsStore(1000);

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [active, inactive],
      allowlist,
      clob,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(allowlist.isAllowed).toHaveBeenCalledTimes(2);
    expect(clob.getMarket).toHaveBeenCalledTimes(1);
    expect(clob.getMarket).toHaveBeenCalledWith(active.marketId);
    expect(exa.search).toHaveBeenCalledTimes(3);
    expect(exa.fetchContents).toHaveBeenCalledTimes(1);
    const event = metrics.recent('web_search', 10).find((entry) => entry.data?.event === 'active_pair_skip_allowlist');
    expect(event?.data?.skipped).toBe(1);
  });

  it('skips run when insight cache is fresh', async () => {
    const pair: MarketPair = { marketId: 'cached-1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const nowMs = Date.now();
    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(pair.marketId, {
      expiresAtMs: nowMs + 60_000
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).not.toHaveBeenCalled();
  });

  it('skips searches when query is empty', async () => {
    const pair: MarketPair = { marketId: '   ', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue(null)
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).not.toHaveBeenCalled();
  });

  it('records insight_failed when provider throws', async () => {
    const pair: MarketPair = { marketId: 'm4', yesTokenId: 'y4', noTokenId: 'n4' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it storm?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = {
      search: vi.fn().mockRejectedValue(new Error('boom')),
      fetchContents: vi.fn()
    } as unknown as WebSearchClient;

    const metrics = new MetricsStore(1000);
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('insight_failed');
  });

  it('records insight_failed when provider throws non-error values', async () => {
    const pair: MarketPair = { marketId: 'm4b', yesTokenId: 'y4', noTokenId: 'n4' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it storm?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = {
      search: vi.fn().mockRejectedValue('boom'),
      fetchContents: vi.fn()
    } as unknown as WebSearchClient;

    const metrics = new MetricsStore(1000);
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('insight_failed');
    expect(event?.data?.error).toBe('boom');
  });

  it('handles invalid publishedAt and cached outcomes safely', async () => {
    const pair: MarketPair = { marketId: 'm5', yesTokenId: 'y5', noTokenId: 'n5' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it be sunny?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [
        { url: 'https://example.com', title: 'Example', publishedAt: 'not-a-date' },
        { url: 'https://example.org', title: 'Example 2' }
      ],
      [{ url: 'https://example.com', text: 'no signal' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxResults: 2,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const nowMs = Date.now();
    (agent as unknown as { marketMetaCache: Map<string, { question: string; outcomes: string[]; expiresAtMs: number }> })
      .marketMetaCache.set(pair.marketId, {
        question: 'Will it be sunny?',
        outcomes: [''],
        expiresAtMs: nowMs + 60_000
      });

    const handler = vi.fn();
    messageBus.on('learning:insight', handler);

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(handler).toHaveBeenCalled();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.insights[0]?.value).toBeCloseTo(0.5, 5);

    messageBus.off('learning:insight', handler);
  });

  it('schedules periodic runs when enabled', async () => {
    const pair: MarketPair = { marketId: 'timer-1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will it rain tomorrow?',
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1,
      evModelRefreshMinutes: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    agent.start();
    await waitForIdle();

    const intervalCallback = intervalSpy.mock.calls[0]?.[0] as (() => void) | undefined;
    if (intervalCallback) {
      intervalCallback();
    }
    await waitForIdle();

    expect(exa.search).toHaveBeenCalled();

    agent.stop();
  });

  it('does not run when provider is missing', async () => {
    const pair: MarketPair = { marketId: 'missing-provider', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob
    });

    agent.start();
    await waitForIdle();

    expect(clob.getMarket).not.toHaveBeenCalled();

    agent.stop();
  });

  it('uses secondary provider when primary is missing and fetches contents from secondary', async () => {
    const pair: MarketPair = { marketId: 'secondary-only', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will secondary provider run?',
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes no' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchPrimary: 'firecrawl' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
    expect(exa.fetchContents).toHaveBeenCalledTimes(1);
  });

  it('updates policy and clears existing schedule when running', async () => {
    const pair: MarketPair = { marketId: 'policy-1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will it rain tomorrow?',
        tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
      })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    agent.start();
    await waitForIdle();

    agent.updatePolicy({ ...policy, evModelRefreshMinutes: 2 });
    await waitForIdle();

    expect(intervalSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();

    agent.stop();
  });

  it('prunes caches when market pairs update', () => {
    const pair: MarketPair = { marketId: 'market-a', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const agent = new SignalAggregatorAgent({
      policy: { ...DEFAULT_TRADE_POLICY, signalMode: 'ev' as const },
      marketPairs: [pair],
      clob
    });

    const caches = agent as unknown as {
      insightCache: Map<string, { expiresAtMs: number }>;
      marketMetaCache: Map<string, { question: string; outcomes: string[]; expiresAtMs: number }>;
    };

    caches.insightCache.set('market-a', { expiresAtMs: Date.now() + 1000 });
    caches.insightCache.set('market-b', { expiresAtMs: Date.now() + 1000 });
    caches.marketMetaCache.set('market-a', { question: 'q', outcomes: ['yes', 'no'], expiresAtMs: Date.now() + 1000 });
    caches.marketMetaCache.set('market-b', { question: 'q2', outcomes: ['yes', 'no'], expiresAtMs: Date.now() + 1000 });

    agent.updateMarketPairs([pair]);

    expect(caches.insightCache.has('market-b')).toBe(false);
    expect(caches.marketMetaCache.has('market-b')).toBe(false);
  });

  it('records insight_failed on fatal runOnce errors', async () => {
    const pair: MarketPair = { marketId: 'fatal-1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const metrics = new MetricsStore(1000);

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      metrics
    });

    (agent as unknown as { marketPairs: unknown }).marketPairs = null;

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('insight_failed');
  });

  it('records insight_failed on fatal non-error runOnce errors', async () => {
    const pair: MarketPair = { marketId: 'fatal-2', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const metrics = new MetricsStore(1000);

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      metrics
    });

    (agent as unknown as { marketPairs: { filter: () => never } }).marketPairs = {
      filter: () => {
        throw 'boom';
      }
    };

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    const event = metrics.recent('web_search', 1)[0];
    expect(event?.data?.event).toBe('insight_failed');
    expect(event?.data?.error).toBe('boom');
  });

  it('falls back to yes/no outcomes when tokens are missing', async () => {
    const pair: MarketPair = { marketId: 'fallback-1', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it snow?', tokens: [] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes no' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalledTimes(3);
  });

  it('emits high confidence signals with fresh and dense coverage', async () => {
    const publishedAt = new Date().toISOString();
    const text = Array.from({ length: 20 }).fill('yes').join(' ');
    const signal = await captureSignal({
      text,
      publishedAt,
      policyOverrides: { evWebSearchMaxResults: 3, evWebSearchLookbackDays: 1 }
    });

    expect(signal).toBe('high_confidence');
  });

  it('emits medium confidence signals with moderate density', async () => {
    const publishedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const text = Array.from({ length: 12 }).fill('yes').join(' ');
    const signal = await captureSignal({
      text,
      publishedAt,
      policyOverrides: { evWebSearchMaxResults: 6, evWebSearchLookbackDays: 1 }
    });

    expect(signal).toBe('medium_confidence');
  });

  it('emits low confidence signals with sparse coverage', async () => {
    const publishedAt = new Date(Date.now() - 17 * 60 * 60 * 1000).toISOString();
    const text = Array.from({ length: 4 }).fill('yes').join(' ');
    const signal = await captureSignal({
      text,
      publishedAt,
      policyOverrides: { evWebSearchMaxResults: 6, evWebSearchLookbackDays: 1 }
    });

    expect(signal).toBe('low_confidence');
  });

  it('emits neutral signals when confidence is minimal', async () => {
    const publishedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const signal = await captureSignal({
      text: '',
      publishedAt,
      policyOverrides: { evWebSearchMaxResults: 30, evWebSearchLookbackDays: 1 }
    });

    expect(signal).toBe('neutral');
  });

  it('does not schedule twice when start is called repeatedly', async () => {
    const pair: MarketPair = { marketId: 'repeat-start', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it rain tomorrow?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    agent.start();
    agent.start();
    await waitForIdle();

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it('does not reschedule when updatePolicy is called before start', () => {
    const pair: MarketPair = { marketId: 'policy-before-start', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    agent.updatePolicy({ ...policy, evModelRefreshMinutes: 2 });

    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('clears schedule when providers are disabled', async () => {
    const pair: MarketPair = { marketId: 'disable-providers', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it rain?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    agent.start();
    await waitForIdle();

    agent.updatePolicy({ ...policy, evWebSearchExaEnabled: false });
    await waitForIdle();

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalled();
    agent.stop();
  });

  it('skips runOnce while in flight', async () => {
    const pair: MarketPair = { marketId: 'inflight', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    (agent as unknown as { inFlight: boolean }).inFlight = true;

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).not.toHaveBeenCalled();
  });

  it('uses firecrawl primary and skips content fetch without urls', async () => {
    const pair: MarketPair = { marketId: 'firecrawl-primary', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it hail?', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const firecrawl = new StubWebSearchClient([{ url: '', title: 'Missing URL' }], []);
    const exa = new StubWebSearchClient([{ url: 'https://fallback.com', title: 'Fallback' }], []);

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchPrimary: 'firecrawl' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: true,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa,
      firecrawl
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(firecrawl.search).toHaveBeenCalled();
    expect(exa.search).not.toHaveBeenCalled();
    expect(firecrawl.fetchContents).not.toHaveBeenCalled();
  });

  it('falls back to marketId when market question is missing', async () => {
    const pair: MarketPair = { marketId: 'missing-question', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: '', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient([], []);
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
    expect(exa.search.mock.calls[0]?.[0]).toBe(pair.marketId);
  });

  it('fetches contents with the primary client when urls are present', async () => {
    const clob = {
      getMarket: vi.fn()
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes no' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [],
      clob,
      exa
    });

    const result = await (agent as unknown as {
      fetchSignals: (queries: string[]) => Promise<{ results: WebSearchResult[]; contents: WebSearchContent[] }>;
    }).fetchSignals(['q1']);

    expect(exa.search).toHaveBeenCalled();
    expect(exa.fetchContents).toHaveBeenCalled();
    expect(result.contents.length).toBe(1);
  });

  it('falls back when tokens are missing from market metadata', async () => {
    const pair: MarketPair = { marketId: 'no-tokens', yesTokenId: 'y1', noTokenId: 'n1' };
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it snow?' })
    } as unknown as PolymarketClob;

    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes no' }]
    );

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'ev' as const,
      evWebSearchExaEnabled: true,
      evWebSearchFirecrawlEnabled: false,
      evWebSearchMaxConcurrency: 1
    };

    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
  });
});
