import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignalAggregatorAgent, __signalAggregatorTestUtils } from '../../src/agents/signal/SignalAggregatorAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import type { MarketPair } from '../../src/domain/market.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { WebSearchClient, WebSearchContent, WebSearchResult } from '../../src/services/websearch/WebSearchClient.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';

class StubWebSearchClient implements WebSearchClient {
  public search = vi.fn(async () => this.results);
  public fetchContents = vi.fn(async (urls: string[]) =>
    this.contents.filter((content) => urls.includes(content.url))
  );

  constructor(
    private results: WebSearchResult[],
    private contents: WebSearchContent[]
  ) {}
}

class StubHeartbeatService {
  public updatePolicy = vi.fn();
  public getState = vi.fn(async () => this.state);

  constructor(private state: { triggerScore: number; reasons: string[]; officialDomainPresent: boolean }) {}
}

let messageBus = createMessageBus();

beforeEach(() => {
  messageBus = createMessageBus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createPair(marketId = 'm1'): MarketPair {
  return { marketId, yesTokenId: `${marketId}-yes`, noTokenId: `${marketId}-no` };
}

function createBook(tokenId: string, bestBid: number, bestAsk: number, lastUpdateMs = Date.now()): OrderBookState {
  return {
    tokenId,
    bids: [{ price: bestBid, size: 10 }],
    asks: [{ price: bestAsk, size: 10 }],
    tickSize: 0.01,
    minOrderSize: 0.001,
    lastUpdateMs,
    stableSinceMs: lastUpdateMs,
    bestBid: { price: bestBid, size: 10 },
    bestAsk: { price: bestAsk, size: 10 }
  };
}

function createClob(question = 'Will it rain tomorrow?', endDate?: string): PolymarketClob {
  return {
    getMarket: vi.fn().mockResolvedValue({
      question,
      end_date_iso: endDate,
      tokens: [{ outcome: 'Yes' }, { outcome: 'No' }]
    })
  } as unknown as PolymarketClob;
}

function basePolicy(overrides: Partial<typeof DEFAULT_TRADE_POLICY> = {}) {
  return {
    ...DEFAULT_TRADE_POLICY,
    signalMode: 'ev' as const,
    evWebSearchMaxConcurrency: 1,
    ...overrides
  };
}

const waitForIdle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('SignalAggregatorAgent', () => {
  it('covers helper normalization branches directly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

    expect(__signalAggregatorTestUtils.extractOutcomes(null)).toEqual(['yes', 'no']);
    expect(
      __signalAggregatorTestUtils.extractOutcomes({
        tokens: [{ outcome: ' Yes ' }, { outcome: '' }, { outcome: 'No' }]
      } as never)
    ).toEqual(['Yes', 'No']);

    expect(__signalAggregatorTestUtils.buildQueries(' ', ['Yes', 'No'], 'base_only')).toEqual([]);
    expect(__signalAggregatorTestUtils.buildQueries('Will it happen?', ['Yes', 'No'], 'base_only')).toEqual(['Will it happen?']);
    expect(__signalAggregatorTestUtils.buildQueries('Will it happen?', [], 'base_plus_two')).toEqual(['Will it happen?']);
    expect(__signalAggregatorTestUtils.buildQueries('Will it happen?', ['Yes', 'No'], 'base_plus_two')).toEqual([
      'Will it happen?',
      'Will it happen? Yes',
      'Will it happen? No'
    ]);

    const high = __signalAggregatorTestUtils.normalizeToInsight(
      'market-1',
      ['Yes', 'No'],
      [
        { url: 'https://example.com/1', title: 'Yes', snippet: 'Yes', publishedAt: '2026-03-10T11:59:59.000Z' },
        { url: 'https://example.com/2', title: 'Yes', snippet: 'Yes', publishedAt: '2026-03-10T11:59:58.000Z' }
      ],
      [{ url: 'https://example.com/1', text: 'yes '.repeat(24).trim() }],
      { ...DEFAULT_TRADE_POLICY, evWebSearchMaxResults: 2 }
    );
    const neutral = __signalAggregatorTestUtils.normalizeToInsight(
      'market-2',
      ['Yes', 'No'],
      [],
      [],
      DEFAULT_TRADE_POLICY
    );
    expect(high.signal).toBe('high_confidence');
    expect(neutral.signal).toBe('neutral');
    expect(__signalAggregatorTestUtils.computeRecencyScore([{ url: 'u', publishedAt: 'not-a-date' }], 7)).toBe(0);
    expect(__signalAggregatorTestUtils.computeRecencyScore([{ url: 'u' }], 7)).toBe(0);
    expect(__signalAggregatorTestUtils.computeOutcomeBias([{ text: '' }], ['Yes']).mentionScore).toBe(0);
    expect(__signalAggregatorTestUtils.computeOutcomeBias([{}], ['Yes', 'No']).mentionScore).toBe(0);
    expect(__signalAggregatorTestUtils.computeOutcomeBias([{ text: 'yes yes no' }], ['Yes', 'No']).bias).toBeGreaterThan(0);
    expect(__signalAggregatorTestUtils.countWord('a.b a.b', 'a.b')).toBe(2);
    expect(__signalAggregatorTestUtils.computeMidPrice(createBook('token-1', 0.4, 0.6))).toBe(0.5);
    expect(__signalAggregatorTestUtils.computeMidPrice({ ...createBook('token-2', 0.4, 0.6), bestBid: undefined })).toBeNull();
    expect(
      __signalAggregatorTestUtils.computeMidPrice({
        ...createBook('token-3', 0.4, 0.6),
        bestBid: { price: 0, size: 10 }
      })
    ).toBeNull();
    expect(
      __signalAggregatorTestUtils.dedupeResults([
        { url: 'https://example.com/1' },
        { url: 'https://example.com/1' },
        { url: '' }
      ])
    ).toEqual([{ url: 'https://example.com/1' }]);

    const exa = new StubWebSearchClient([], []);
    const serper = new StubWebSearchClient([], []);
    const firecrawl = new StubWebSearchClient([], []);
    const external = new StubWebSearchClient([], []);
    expect(__signalAggregatorTestUtils.providerRoute(exa, exa, serper, firecrawl)).toBe('exa');
    expect(__signalAggregatorTestUtils.providerRoute(serper, exa, serper, firecrawl)).toBe('serper');
    expect(__signalAggregatorTestUtils.providerRoute(firecrawl, exa, serper, firecrawl)).toBe('firecrawl');
    expect(__signalAggregatorTestUtils.providerRoute(external, exa, serper, firecrawl)).toBe('unknown');
    expect(
      __signalAggregatorTestUtils.hasOutcomeDisagreement(
        { results: [{ url: 'u1', title: 'yes yes', snippet: '' }], contents: [] },
        { results: [{ url: 'u2', title: 'no no', snippet: '' }], contents: [] },
        ['Yes', 'No']
      )
    ).toBe(true);
    expect(
      __signalAggregatorTestUtils.hasOutcomeDisagreement(
        { results: [], contents: [{ url: 'u1', text: 'yes yes' }] },
        { results: [], contents: [{ url: 'u2', text: 'yes' }] },
        ['Yes', 'No']
      )
    ).toBe(false);
    expect(
      __signalAggregatorTestUtils.normalizeToInsight(
        'market-3',
        ['Yes', 'No'],
        [{ url: 'https://example.com/3' }],
        [],
        { ...DEFAULT_TRADE_POLICY, evWebSearchMaxResults: 1 }
      ).signal
    ).toBe('neutral');
    expect(
      __signalAggregatorTestUtils.hasOutcomeDisagreement(
        { results: [{ url: 'u3' }], contents: [] },
        { results: [{ url: 'u4' }], contents: [] },
        ['Yes', 'No']
      )
    ).toBe(false);
    expect(
      __signalAggregatorTestUtils.shouldBypassInsightCache({
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.9,
        queryMode: 'base_plus_two',
        contentBudget: 4,
        marketClass: 'official_release'
      })
    ).toBe(true);
    expect(
      __signalAggregatorTestUtils.shouldBypassInsightCache({
        route: 'exa',
        reason: 'low_priority',
        triggerScore: 0,
        queryMode: 'base_only',
        contentBudget: 2,
        marketClass: 'event_narrative'
      })
    ).toBe(false);
  });

  it('emits insights through the Exa path when only Exa is available', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString(), snippet: 'yes yes' }],
      [{ url: 'https://example.com', text: 'yes yes yes no' }]
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      messageBus,
      clob,
      exa
    });

    const handler = vi.fn();
    messageBus.on('learning:insight', handler);

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(exa.search).toHaveBeenCalledTimes(2);
    expect(exa.fetchContents).toHaveBeenCalledWith(['https://example.com'], DEFAULT_TRADE_POLICY.evWebSearchCacheTtlSeconds);
  });

  it('applies the default content budget instead of the old fixed cap', async () => {
    const pair = createPair();
    const clob = createClob();
    const urls = Array.from({ length: 8 }, (_, index) => `https://example.com/${index}`);
    const exa = new StubWebSearchClient(
      urls.map((url) => ({ url, title: 'Example', publishedAt: new Date().toISOString() })),
      urls.map((url) => ({ url, text: 'yes yes no' }))
    );
    const policy = basePolicy({
      evWebSearchSerperEnabled: false,
      evWebSearchGdeltEnabled: false,
      evWebSearchDefaultContentBudget: 3
    });
    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.fetchContents).toHaveBeenCalledTimes(1);
    expect(exa.fetchContents.mock.calls[0]?.[0]).toEqual(urls.slice(0, 3));
  });

  it('uses Serper when the provider policy is serper_only', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://reuters.com/story', title: 'Story', publishedAt: new Date().toISOString(), source: 'reuters.com' }],
      [{ url: 'https://reuters.com/story', text: 'yes yes yes' }]
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        evWebSearchProviderPolicy: 'serper_only',
        evWebSearchExaEnabled: false
      }),
      marketPairs: [pair],
      clob,
      serper
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).toHaveBeenCalledTimes(2);
    expect(serper.fetchContents).toHaveBeenCalledTimes(1);
  });

  it('escalates from Serper to Exa when Serper evidence is ambiguous', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://blog.example.com/post', title: 'Could go yes or no', snippet: 'yes no', publishedAt: new Date().toISOString(), source: 'blog.example.com' }],
      [{ url: 'https://blog.example.com/post', text: 'yes no yes no' }]
    );
    const exa = new StubWebSearchClient(
      [{ url: 'https://reuters.com/final', title: 'Final', snippet: 'yes', publishedAt: new Date().toISOString(), source: 'reuters.com' }],
      [{ url: 'https://reuters.com/final', text: 'yes yes yes' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).toHaveBeenCalled();
    expect(exa.search).toHaveBeenCalled();
    expect(
      metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'route_decided' && entry.data?.route === 'serper_then_exa')
    ).toBe(true);
  });

  it('skips paid search when the GDELT heartbeat stays below threshold', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient([], []);
    const heartbeat = new StubHeartbeatService({
      triggerScore: 0.1,
      reasons: ['no_trigger'],
      officialDomainPresent: true
    });
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'gdelt_serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      gdeltHeartbeat: heartbeat as never,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).not.toHaveBeenCalled();
    expect(
      metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'route_skipped' && entry.data?.reason === 'no_trigger')
    ).toBe(true);
  });

  it('uses Serper after a GDELT trigger spike', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://reuters.com/story', title: 'Story', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://reuters.com/story', text: 'yes yes' }]
    );
    const heartbeat = new StubHeartbeatService({
      triggerScore: 0.9,
      reasons: ['gdelt_spike'],
      officialDomainPresent: true
    });
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'gdelt_serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      gdeltHeartbeat: heartbeat as never,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).toHaveBeenCalled();
    expect(
      metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'route_decided' && entry.data?.reason === 'gdelt_spike')
    ).toBe(true);
  });

  it('reopens a cached market when a GDELT spike arrives before the insight ttl expires', async () => {
    const pair = createPair('gdelt-cached');
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://reuters.com/spike', title: 'Spike', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://reuters.com/spike', text: 'yes yes' }]
    );
    const heartbeat = new StubHeartbeatService({
      triggerScore: 0.95,
      reasons: ['gdelt_spike'],
      officialDomainPresent: true
    });
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'gdelt_serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      gdeltHeartbeat: heartbeat as never
    });

    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(pair.marketId, {
      expiresAtMs: Date.now() + 60_000
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(heartbeat.getState).toHaveBeenCalled();
    expect(serper.search).toHaveBeenCalled();
  });

  it('uses the price-move trigger when recent market updates cross the configured threshold', async () => {
    const pair = createPair('price-move');
    const clob = createClob();
    const now = Date.now();
    const serper = new StubWebSearchClient(
      [{ url: 'https://reuters.com/story', title: 'Story', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://reuters.com/story', text: 'yes yes' }]
    );
    const heartbeat = new StubHeartbeatService({
      triggerScore: 0.1,
      reasons: ['no_trigger'],
      officialDomainPresent: true
    });
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        evWebSearchProviderPolicy: 'gdelt_serper_exa',
        evWebSearchPriceMoveTriggerBps: 50
      }),
      marketPairs: [pair],
      messageBus,
      clob,
      serper,
      gdeltHeartbeat: heartbeat as never,
      metrics
    });
    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(pair.marketId, {
      expiresAtMs: now + 60_000
    });

    messageBus.emit('market:updated', {
      tokenId: pair.yesTokenId,
      book: createBook(pair.yesTokenId, 0.49, 0.51, now)
    });
    messageBus.emit('market:updated', {
      tokenId: pair.yesTokenId,
      book: createBook(pair.yesTokenId, 0.44, 0.46, now + 1_000)
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).toHaveBeenCalled();
    expect(
      metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'route_decided' && entry.data?.reason === 'price_move_unexplained')
    ).toBe(true);
  });

  it('records allowlist skips and only searches allowed markets', async () => {
    const active = createPair('active');
    const blocked = createPair('blocked');
    const allowlist = {
      isAllowed: vi.fn((marketId: string) => marketId === active.marketId)
    };
    const clob = createClob();
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes yes no' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [active, blocked],
      allowlist,
      clob,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(allowlist.isAllowed).toHaveBeenCalledTimes(2);
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(
      metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'active_pair_skip_allowlist' && entry.data?.skipped === 1)
    ).toBe(true);
  });

  it('skips runOnce while insight cache is fresh', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(pair.marketId, {
      expiresAtMs: Date.now() + 60_000
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).not.toHaveBeenCalled();
  });

  it('uses evWebSearchRefreshMinutes for market metadata cache ttl and schedule', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        evWebSearchSerperEnabled: false,
        evWebSearchGdeltEnabled: false,
        evWebSearchRefreshMinutes: 2
      }),
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    agent.stop();
  });

  it('does not schedule twice when start is called repeatedly', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    agent.start();
    await waitForIdle();

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it('invokes runOnce from the scheduled interval callback', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com', text: 'yes' }]
    );
    let scheduled: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: TimerHandler) => {
        scheduled = callback as () => void;
        return 1 as unknown as NodeJS.Timeout;
      }) as typeof setInterval
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        evWebSearchSerperEnabled: false,
        evWebSearchGdeltEnabled: false,
        evWebSearchRefreshMinutes: 1,
        evWebSearchCacheTtlSeconds: 0
      }),
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();
    const insightCache = (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache;
    insightCache.set(pair.marketId, { expiresAtMs: 0 });
    scheduled?.();
    await waitForIdle();

    expect(exa.search).toHaveBeenCalledTimes(4);
    agent.stop();
  });

  it('reschedules when updatePolicy changes the refresh cadence', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const policy = basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false, evWebSearchRefreshMinutes: 1 });
    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();

    agent.updatePolicy({ ...policy, evWebSearchRefreshMinutes: 3 });
    await waitForIdle();

    expect(clearSpy).toHaveBeenCalled();
    expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 180_000);
    agent.stop();
  });

  it('clears the schedule when provider policy disables the only live provider', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const policy = basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false });
    const agent = new SignalAggregatorAgent({
      policy,
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();

    agent.updatePolicy({ ...policy, evWebSearchExaEnabled: false });
    await waitForIdle();

    expect(clearSpy).toHaveBeenCalled();
    agent.stop();
  });

  it('does not run when providers are missing', async () => {
    const pair = createPair();
    const clob = createClob();
    const agent = new SignalAggregatorAgent({
      policy: basePolicy(),
      marketPairs: [pair],
      clob
    });

    agent.start();
    await waitForIdle();

    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    agent.stop();
  });

  it('does not run in near_zero mode and does not reschedule when updatePolicy happens before start', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const heartbeat = new StubHeartbeatService({
      triggerScore: 0.2,
      reasons: ['no_trigger'],
      officialDomainPresent: true
    });
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ signalMode: 'near_zero' }),
      marketPairs: [pair],
      clob,
      exa,
      gdeltHeartbeat: heartbeat as never
    });

    agent.updatePolicy(basePolicy({ signalMode: 'near_zero', evWebSearchRefreshMinutes: 3 }));
    agent.start();
    await waitForIdle();

    expect(heartbeat.updatePolicy).toHaveBeenCalledTimes(1);
    expect(intervalSpy).not.toHaveBeenCalled();
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('prunes stale cache entries when market pairs change', () => {
    const pair = createPair('keep');
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob: createClob(),
      exa: new StubWebSearchClient([], [])
    });
    const insightCache = (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache;
    const marketMetaCache = (agent as unknown as {
      marketMetaCache: Map<string, { info: null; question: string; outcomes: string[]; expiresAtMs: number }>;
    }).marketMetaCache;
    insightCache.set('keep', { expiresAtMs: Date.now() + 1000 });
    insightCache.set('drop', { expiresAtMs: Date.now() + 1000 });
    marketMetaCache.set('keep', { info: null, question: 'keep', outcomes: ['Yes', 'No'], expiresAtMs: Date.now() + 1000 });
    marketMetaCache.set('drop', { info: null, question: 'drop', outcomes: ['Yes', 'No'], expiresAtMs: Date.now() + 1000 });

    agent.updateMarketPairs([pair]);

    expect(insightCache.has('keep')).toBe(true);
    expect(insightCache.has('drop')).toBe(false);
    expect(marketMetaCache.has('keep')).toBe(true);
    expect(marketMetaCache.has('drop')).toBe(false);
  });

  it('skips duplicate runOnce calls while a run is already in flight', async () => {
    const clob = createClob();
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [createPair()],
      clob,
      exa: new StubWebSearchClient([], [])
    });

    (agent as unknown as { inFlight: boolean }).inFlight = true;
    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('records per-market failures when provider searches throw', async () => {
    const pair = createPair();
    const clob = createClob();
    const metrics = new MetricsStore(100);
    const exa = {
      search: vi.fn().mockRejectedValue(new Error('search boom')),
      fetchContents: vi.fn()
    } as unknown as WebSearchClient;
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'insight_failed' && entry.data?.marketId === pair.marketId)).toBe(true);
  });

  it('records string failures for per-market provider errors', async () => {
    const pair = createPair('string-error');
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob: createClob(),
      exa: {
        search: vi.fn().mockRejectedValue('search string failure'),
        fetchContents: vi.fn()
      } as unknown as WebSearchClient,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(
      metrics
        .recent('web_search', 20)
        .some((entry) => entry.data?.event === 'insight_failed' && entry.data?.marketId === pair.marketId && entry.data?.error === 'search string failure')
    ).toBe(true);
  });

  it('records outer run failures when allowlist checks throw non-Error values', async () => {
    const pair = createPair('allowlist-throws');
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      allowlist: {
        isAllowed: vi.fn(() => {
          throw 'allowlist string failure';
        })
      },
      clob: createClob(),
      exa: new StubWebSearchClient([], []),
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(
      metrics
        .recent('web_search', 20)
        .some((entry) => entry.data?.event === 'insight_failed' && entry.data?.error === 'allowlist string failure')
    ).toBe(true);
  });

  it('records heartbeat failures and falls back to normal search routing', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString(), snippet: 'yes yes' }],
      [{ url: 'https://example.com', text: 'yes yes' }]
    );
    const metrics = new MetricsStore(100);
    const heartbeat = {
      updatePolicy: vi.fn(),
      getState: vi.fn().mockRejectedValue(new Error('heartbeat boom'))
    };
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false }),
      marketPairs: [pair],
      clob,
      exa,
      gdeltHeartbeat: heartbeat as never,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'heartbeat_failed')).toBe(true);
  });

  it('records string heartbeat failures and still falls back to search routing', async () => {
    const pair = createPair('heartbeat-string');
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com', title: 'Example', publishedAt: new Date().toISOString(), snippet: 'yes' }],
      [{ url: 'https://example.com', text: 'yes' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false }),
      marketPairs: [pair],
      clob: createClob(),
      exa,
      gdeltHeartbeat: {
        updatePolicy: vi.fn(),
        getState: vi.fn().mockRejectedValue('heartbeat string failure')
      } as never,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
    expect(
      metrics
        .recent('web_search', 20)
        .some((entry) => entry.data?.event === 'heartbeat_failed' && entry.data?.error === 'heartbeat string failure')
    ).toBe(true);
  });

  it('does not emit insights when providers return no results and no contents', async () => {
    const pair = createPair();
    const exa = new StubWebSearchClient([], []);
    const handler = vi.fn();
    messageBus.on('learning:insight', handler);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      messageBus,
      clob: createClob(),
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(handler).not.toHaveBeenCalled();
  });

  it('covers fetchSignals short-circuit paths for blank queries and missing providers', async () => {
    const pair = createPair();
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob: createClob(),
      exa: new StubWebSearchClient([], [])
    });
    const internals = agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; info?: unknown; nowMs: number },
        decision: { route: 'exa' | 'serper'; reason: 'low_priority'; triggerScore: number; queryMode: 'base_only'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ results: WebSearchResult[]; contents: WebSearchContent[] }>;
    };

    expect(
      await internals.fetchSignals(
        { marketId: pair.marketId, question: ' ', outcomes: ['Yes', 'No'], nowMs: Date.now() },
        { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }
      )
    ).toEqual({ decision: { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }, results: [], contents: [] });

    const noExaAgent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob: createClob()
    }) as unknown as typeof internals;

    expect(
      await noExaAgent.fetchSignals(
        { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
        { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }
      )
    ).toEqual({ decision: { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }, results: [], contents: [] });

    const noSerperAgent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: true, evWebSearchExaEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob: createClob()
    }) as unknown as typeof internals;

    expect(
      await noSerperAgent.fetchSignals(
        { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
        { route: 'serper', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }
      )
    ).toEqual({ decision: { route: 'serper', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }, results: [], contents: [] });

    expect(
      await noSerperAgent.fetchSignals(
        { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
        { route: 'skip', reason: 'no_trigger', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' } as never
      )
    ).toEqual({ decision: { route: 'skip', reason: 'no_trigger', triggerScore: 0, queryMode: 'base_only', contentBudget: 0, marketClass: 'event_narrative' }, results: [], contents: [] });
  });

  it('keeps Serper results when escalation is requested but exa is missing', async () => {
    const pair = createPair();
    const serper = new StubWebSearchClient(
      [{ url: 'https://blog.example.com/post', title: 'yes no', snippet: 'yes no', publishedAt: new Date().toISOString(), source: 'blog.example.com' }],
      [{ url: 'https://blog.example.com/post', text: 'yes no' }]
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa', evWebSearchExaEnabled: true }),
      marketPairs: [pair],
      clob: createClob(),
      serper
    });
    const internals = agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; info?: unknown; nowMs: number },
        decision: { route: 'serper'; reason: 'gdelt_spike'; triggerScore: number; queryMode: 'base_plus_one'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ decision: { route: string }; results: WebSearchResult[]; contents: WebSearchContent[] }>;
    };

    const result = await internals.fetchSignals(
      { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'serper', reason: 'gdelt_spike', triggerScore: 0.8, queryMode: 'base_plus_one', contentBudget: 1, marketClass: 'event_narrative' }
    );

    expect(result.decision.route).toBe('serper');
    expect(result.results).toHaveLength(1);
  });

  it('escalates to Exa without recording disagreement when both providers support the same outcome', async () => {
    const pair = createPair('agreement');
    const serper = new StubWebSearchClient(
      [{ url: 'https://blog.example.com/post', title: 'yes maybe', snippet: 'yes maybe', publishedAt: new Date().toISOString(), source: 'blog.example.com' }],
      [{ url: 'https://blog.example.com/post', text: 'yes maybe' }]
    );
    const exa = new StubWebSearchClient(
      [{ url: 'https://reuters.com/final', title: 'yes confirmed', snippet: 'yes confirmed', publishedAt: new Date().toISOString(), source: 'reuters.com' }],
      [{ url: 'https://reuters.com/final', text: 'yes confirmed' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa' }),
      marketPairs: [pair],
      clob: createClob(),
      serper,
      exa,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalled();
    expect(metrics.recent('web_search', 20).filter((entry) => entry.data?.event === 'provider_disagreement')).toHaveLength(1);
  });

  it('supports direct serper_then_exa routing and provider-route metrics', async () => {
    const pair = createPair();
    const exa = new StubWebSearchClient(
      [{ url: 'https://exa.example/story', title: 'yes', snippet: 'yes', publishedAt: new Date().toISOString() }],
      [{ url: 'https://exa.example/story', text: 'yes' }]
    );
    const firecrawl = new StubWebSearchClient(
      [
        { url: 'https://dup.example/1', title: 'first' },
        { url: 'https://dup.example/1', title: 'duplicate' }
      ],
      []
    );
    const external = new StubWebSearchClient([{ url: 'https://external.example/1', title: 'x' }], []);
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy(),
      marketPairs: [pair],
      clob: createClob(),
      exa,
      firecrawl,
      metrics
    });
    const internals = agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; info?: unknown; nowMs: number },
        decision: { route: 'serper_then_exa'; reason: 'serper_ambiguous'; triggerScore: number; queryMode: 'base_only'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ decision: { route: string }; results: WebSearchResult[] }>;
      fetchProviderSignals: (provider: WebSearchClient, queries: string[], contentBudget: number) => Promise<{ results: WebSearchResult[]; contents: WebSearchContent[] }>;
    };

    const exaResult = await internals.fetchSignals(
      { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'serper_then_exa', reason: 'serper_ambiguous', triggerScore: 0.8, queryMode: 'base_only', contentBudget: 1, marketClass: 'event_narrative' }
    );
    const firecrawlResult = await internals.fetchProviderSignals(firecrawl, ['Will it happen?'], 0);
    await internals.fetchProviderSignals(external, ['Will it happen?'], 1);

    expect(exaResult.decision.route).toBe('serper_then_exa');
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(firecrawl.fetchContents).not.toHaveBeenCalled();
    expect(firecrawlResult.results).toEqual([{ url: 'https://dup.example/1', title: 'first' }]);
    expect(external.fetchContents).toHaveBeenCalledTimes(1);
    expect(
      metrics
        .recent('web_search', 20)
        .filter((entry) => entry.data?.event === 'content_budget_applied')
        .map((entry) => entry.data?.route)
    ).toEqual(expect.arrayContaining(['firecrawl', 'unknown']));
  });

  it('reuses cached market metadata and falls back to default outcomes when token data is incomplete', async () => {
    const pair = createPair();
    const clob = {
      getMarket: vi.fn().mockResolvedValue({
        question: 'Will it happen?',
        tokens: [{ outcome: 'Yes' }]
      })
    } as unknown as PolymarketClob;
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false, evWebSearchRefreshMinutes: 2 }),
      marketPairs: [pair],
      clob,
      exa: new StubWebSearchClient([], [])
    });
    const internals = agent as unknown as {
      getMarketMeta: (marketId: string, nowMs: number) => Promise<{ question: string; outcomes: string[] }>;
    };

    const first = await internals.getMarketMeta(pair.marketId, 1_000);
    const second = await internals.getMarketMeta(pair.marketId, 1_001);

    expect(first.outcomes).toEqual(['yes', 'no']);
    expect(second.outcomes).toEqual(['yes', 'no']);
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('falls back to marketId when market question is missing', async () => {
    const pair = createPair('missing-question');
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: '', tokens: [{ outcome: 'Yes' }, { outcome: 'No' }] })
    } as unknown as PolymarketClob;
    const exa = new StubWebSearchClient([], []);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalledWith('missing-question', expect.any(Object));
  });

  it('falls back to marketId when market metadata is missing entirely', async () => {
    const pair = createPair('missing-meta');
    const exa = new StubWebSearchClient([], []);
    const clob = {
      getMarket: vi.fn().mockResolvedValue(undefined)
    } as unknown as PolymarketClob;
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(exa.search).toHaveBeenCalledWith('missing-meta', expect.any(Object));
  });

  it('still schedules when firecrawl is the only enabled provider', async () => {
    const pair = createPair('firecrawl-only');
    const firecrawl = new StubWebSearchClient(
      [{ url: 'https://firecrawl.example/story', title: 'Example', publishedAt: new Date().toISOString(), snippet: 'yes' }],
      [{ url: 'https://firecrawl.example/story', text: 'yes' }]
    );
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        evWebSearchExaEnabled: false,
        evWebSearchSerperEnabled: false,
        evWebSearchFirecrawlEnabled: true,
        evWebSearchGdeltEnabled: false
      }),
      marketPairs: [pair],
      clob: createClob(),
      firecrawl
    });

    agent.start();
    await waitForIdle();

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(firecrawl.search).not.toHaveBeenCalled();
    agent.stop();
  });

  it('does not reschedule when updatePolicy is called before start', () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    agent.updatePolicy(basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false, evWebSearchRefreshMinutes: 5 }));

    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('cleans cached state for removed markets when market pairs change', () => {
    const kept = createPair('kept');
    const removed = createPair('removed');
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [kept, removed],
      clob,
      exa
    });

    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(kept.marketId, {
      expiresAtMs: Date.now() + 60_000
    });
    (agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.set(removed.marketId, {
      expiresAtMs: Date.now() + 60_000
    });
    (agent as unknown as { marketMetaCache: Map<string, { expiresAtMs: number }> }).marketMetaCache.set(removed.marketId, {
      info: null,
      question: removed.marketId,
      outcomes: ['Yes', 'No'],
      expiresAtMs: Date.now() + 60_000
    });
    (agent as unknown as { recentPriceMoves: Map<string, { moveBps: number; updatedAtMs: number }> }).recentPriceMoves.set(removed.marketId, {
      moveBps: 120,
      updatedAtMs: Date.now()
    });

    agent.updateMarketPairs([kept]);

    expect((agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.has(kept.marketId)).toBe(true);
    expect((agent as unknown as { insightCache: Map<string, { expiresAtMs: number }> }).insightCache.has(removed.marketId)).toBe(false);
    expect((agent as unknown as { marketMetaCache: Map<string, { expiresAtMs: number }> }).marketMetaCache.has(removed.marketId)).toBe(false);
    expect(
      (agent as unknown as { recentPriceMoves: Map<string, { moveBps: number; updatedAtMs: number }> }).recentPriceMoves.has(removed.marketId)
    ).toBe(false);
  });

  it('expires stale recent price moves after the refresh window', () => {
    const pair = createPair('stale-move');
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchRefreshMinutes: 1 }),
      marketPairs: [pair],
      clob: createClob(),
      serper: new StubWebSearchClient([], [])
    });
    const recentPriceMoves = (agent as unknown as {
      recentPriceMoves: Map<string, { moveBps: number; updatedAtMs: number }>;
      getRecentPriceMoveBps: (marketId: string, nowMs: number) => number;
    });
    recentPriceMoves.recentPriceMoves.set(pair.marketId, {
      moveBps: 250,
      updatedAtMs: 1_000
    });

    expect(recentPriceMoves.getRecentPriceMoveBps(pair.marketId, 62_000)).toBe(0);
    expect(recentPriceMoves.recentPriceMoves.has(pair.marketId)).toBe(false);
  });

  it('keeps the stronger recorded price move when an older weaker update arrives', () => {
    const pair = createPair('keep-move');
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchPriceMoveTriggerBps: 50 }),
      marketPairs: [pair],
      clob: createClob(),
      serper: new StubWebSearchClient([], [])
    });
    const internals = agent as unknown as {
      recentMidPriceByTokenId: Map<string, number>;
      recentPriceMoves: Map<string, { moveBps: number; updatedAtMs: number }>;
      handleMarketUpdated: (tokenId: string, book: OrderBookState) => void;
    };
    internals.recentMidPriceByTokenId.set(pair.yesTokenId, 0.5);
    internals.recentPriceMoves.set(pair.marketId, {
      moveBps: 2_000,
      updatedAtMs: 2_000
    });

    internals.handleMarketUpdated(pair.yesTokenId, createBook(pair.yesTokenId, 0.48, 0.5, 1_500));

    expect(internals.recentPriceMoves.get(pair.marketId)).toEqual({
      moveBps: 2_000,
      updatedAtMs: 2_000
    });
  });

  it('skips runOnce when a prior execution is still in flight', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa
    });

    (agent as unknown as { inFlight: boolean }).inFlight = true;
    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('records heartbeat failures and continues with direct provider routing', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://reuters.com/story', title: 'Story', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://reuters.com/story', text: 'yes yes' }]
    );
    const heartbeat = { getState: vi.fn().mockRejectedValue(new Error('gdelt_down')), updatePolicy: vi.fn() };
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'gdelt_serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      gdeltHeartbeat: heartbeat as never,
      metrics
    });

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(serper.search).toHaveBeenCalled();
    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'heartbeat_failed')).toBe(true);
  });

  it('returns empty signals when the question is blank or the provider is missing', async () => {
    const pair = createPair();
    const clob = createClob();
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob
    });

    const blank = await (agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; nowMs: number },
        decision: { route: 'exa'; reason: 'low_priority'; triggerScore: number; queryMode: 'base_only'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ results: unknown[]; contents: unknown[] }>
    }).fetchSignals(
      { marketId: pair.marketId, question: '   ', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 2, marketClass: 'event_narrative' }
    );
    const missingProvider = await (agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; nowMs: number },
        decision: { route: 'exa'; reason: 'low_priority'; triggerScore: number; queryMode: 'base_only'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ results: unknown[]; contents: unknown[] }>
    }).fetchSignals(
      { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 2, marketClass: 'event_narrative' }
    );

    expect(blank).toEqual({ decision: { route: 'exa', reason: 'low_priority', triggerScore: 0, queryMode: 'base_only', contentBudget: 2, marketClass: 'event_narrative' }, results: [], contents: [] });
    expect(missingProvider.results).toEqual([]);
    expect(missingProvider.contents).toEqual([]);
  });

  it('keeps the serper route when the evidence is already authoritative', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://www.whitehouse.gov/briefing', title: 'Official yes', snippet: 'yes', source: 'whitehouse.gov', publishedAt: new Date().toISOString() }],
      [{ url: 'https://www.whitehouse.gov/briefing', text: 'yes yes yes' }]
    );
    const exa = new StubWebSearchClient([], []);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      exa
    });

    const bundle = await (agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; nowMs: number },
        decision: { route: 'serper'; reason: 'gdelt_spike'; triggerScore: number; queryMode: 'base_plus_two'; contentBudget: number; marketClass: 'official_release' }
      ) => Promise<{ decision: { route: string }; results: WebSearchResult[] }>
    }).fetchSignals(
      { marketId: pair.marketId, question: 'Will the Fed cut rates in June?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'serper', reason: 'gdelt_spike', triggerScore: 0.9, queryMode: 'base_plus_two', contentBudget: 2, marketClass: 'official_release' }
    );

    expect(bundle.decision.route).toBe('serper');
    expect(exa.search).not.toHaveBeenCalled();
  });

  it('records provider disagreements when Serper and Exa disagree on the outcome', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://blog.example.com/post', title: 'Yes edge', snippet: 'yes', source: 'blog.example.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://blog.example.com/post', text: 'yes yes yes yes' }]
    );
    const exa = new StubWebSearchClient(
      [{ url: 'https://reuters.com/final', title: 'No edge', snippet: 'no', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      [{ url: 'https://reuters.com/final', text: 'no no no no' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      exa,
      metrics
    });

    const bundle = await (agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; nowMs: number },
        decision: { route: 'serper'; reason: 'gdelt_spike'; triggerScore: number; queryMode: 'base_plus_one'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ decision: { route: string } }>
    }).fetchSignals(
      { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'serper', reason: 'gdelt_spike', triggerScore: 0.8, queryMode: 'base_plus_one', contentBudget: 2, marketClass: 'event_narrative' }
    );

    expect(bundle.decision.route).toBe('serper_then_exa');
    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'provider_disagreement')).toBe(true);
  });

  it('caches market metadata lookups and records unknown provider routes when needed', async () => {
    const pair = createPair();
    const clob = createClob();
    const metrics = new MetricsStore(100);
    const customProvider = new StubWebSearchClient(
      [{ url: 'https://example.com/custom', title: 'Custom', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com/custom', text: 'yes no' }]
    );
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      metrics
    });

    const first = await (agent as unknown as {
      getMarketMeta: (marketId: string, nowMs: number) => Promise<{ question: string }>
    }).getMarketMeta(pair.marketId, Date.now());
    const second = await (agent as unknown as {
      getMarketMeta: (marketId: string, nowMs: number) => Promise<{ question: string }>
    }).getMarketMeta(pair.marketId, Date.now());
    const bundle = await (agent as unknown as {
      fetchProviderSignals: (provider: StubWebSearchClient, queries: string[], contentBudget: number) => Promise<{ results: WebSearchResult[] }>
    }).fetchProviderSignals(customProvider, ['Will it happen?'], 1);

    expect(first.question).toBe('Will it rain tomorrow?');
    expect(second.question).toBe(first.question);
    expect((clob.getMarket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(bundle.results).toHaveLength(1);
    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'content_budget_applied' && entry.data?.route === 'unknown')).toBe(true);
  });

  it('records firecrawl content-budget metrics when firecrawl is the resolved provider', async () => {
    const pair = createPair();
    const clob = createClob();
    const firecrawl = new StubWebSearchClient(
      [{ url: 'https://example.com/firecrawl', title: 'Firecrawl', publishedAt: new Date().toISOString() }],
      [{ url: 'https://example.com/firecrawl', text: 'yes no' }]
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      firecrawl,
      metrics
    });

    await (agent as unknown as {
      fetchProviderSignals: (provider: StubWebSearchClient, queries: string[], contentBudget: number) => Promise<void>
    }).fetchProviderSignals(firecrawl, ['Will it happen?'], 1);

    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'content_budget_applied' && entry.data?.route === 'firecrawl')).toBe(true);
  });

  it('falls back to search result text when disagreement checks have no fetched contents', async () => {
    const pair = createPair();
    const clob = createClob();
    const serper = new StubWebSearchClient(
      [{ url: 'https://blog.example.com/post', title: 'Yes bias', snippet: 'yes yes', source: 'blog.example.com', publishedAt: new Date().toISOString() }],
      []
    );
    const exa = new StubWebSearchClient(
      [{ url: 'https://reuters.com/final', title: 'No bias', snippet: 'no no', source: 'reuters.com', publishedAt: new Date().toISOString() }],
      []
    );
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchProviderPolicy: 'serper_exa' }),
      marketPairs: [pair],
      clob,
      serper,
      exa,
      metrics
    });

    const bundle = await (agent as unknown as {
      fetchSignals: (
        context: { marketId: string; question: string; outcomes: string[]; nowMs: number },
        decision: { route: 'serper'; reason: 'gdelt_spike'; triggerScore: number; queryMode: 'base_plus_one'; contentBudget: number; marketClass: 'event_narrative' }
      ) => Promise<{ decision: { route: string } }>
    }).fetchSignals(
      { marketId: pair.marketId, question: 'Will it happen?', outcomes: ['Yes', 'No'], nowMs: Date.now() },
      { route: 'serper', reason: 'gdelt_spike', triggerScore: 0.8, queryMode: 'base_plus_one', contentBudget: 0, marketClass: 'event_narrative' }
    );

    expect(bundle.decision.route).toBe('serper_then_exa');
    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'provider_disagreement')).toBe(true);
  });

  it('falls back to default yes/no outcomes when token data is incomplete', async () => {
    const pair = createPair();
    const clob = {
      getMarket: vi.fn().mockResolvedValue({ question: 'Will it happen?', tokens: [{ outcome: 'Yes' }] })
    } as unknown as PolymarketClob;
    const exa = new StubWebSearchClient(
      [{ url: 'https://example.com/story', title: 'Example', snippet: 'yes yes', publishedAt: new Date().toISOString() }],
      []
    );
    const handler = vi.fn();
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      messageBus,
      clob,
      exa
    });
    messageBus.on('learning:insight', handler);

    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0].insights[0]?.value).toBe(1);
  });

  it('records a top-level failure when the market-pair set is corrupted', async () => {
    const pair = createPair();
    const clob = createClob();
    const metrics = new MetricsStore(100);
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({ evWebSearchSerperEnabled: false, evWebSearchGdeltEnabled: false }),
      marketPairs: [pair],
      clob,
      exa: new StubWebSearchClient([], []),
      metrics
    });

    (agent as unknown as { marketPairs: null }).marketPairs = null;
    await (agent as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(metrics.recent('web_search', 20).some((entry) => entry.data?.event === 'insight_failed')).toBe(true);
  });

  it('does not schedule when the signal mode is near_zero', async () => {
    const pair = createPair();
    const clob = createClob();
    const exa = new StubWebSearchClient([], []);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const agent = new SignalAggregatorAgent({
      policy: basePolicy({
        signalMode: 'near_zero',
        evWebSearchSerperEnabled: false,
        evWebSearchGdeltEnabled: false
      }),
      marketPairs: [pair],
      clob,
      exa
    });

    agent.start();
    await waitForIdle();

    expect(intervalSpy).not.toHaveBeenCalled();
    agent.stop();
  });
});
