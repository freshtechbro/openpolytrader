import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { SearchRouter, __searchRouterTestUtils } from '../../src/services/websearch/SearchRouter.js';

describe('SearchRouter', () => {
  const context = {
    marketId: 'market-1',
    question: 'Will the Fed cut rates in June?',
    outcomes: ['Yes', 'No'],
    info: { question: 'Will the Fed cut rates in June?', end_date_iso: new Date(Date.now() + 86400000).toISOString() },
    nowMs: Date.now()
  };

  it('routes directly to Exa in exa_only mode', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'exa_only',
      evWebSearchSerperEnabled: false,
      evWebSearchGdeltEnabled: false
    });

    const decision = router.decide(context, null, { exa: true, serper: false });
    expect(decision.route).toBe('exa');
  });

  it('skips in exa_only mode when Exa is unavailable', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'exa_only',
      evWebSearchSerperEnabled: false,
      evWebSearchGdeltEnabled: false
    });

    const decision = router.decide(context, null, { exa: false, serper: false });
    expect(decision.route).toBe('skip');
    expect(decision.contentBudget).toBe(0);
  });

  it('prefers the available provider near resolution', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      {
        ...context,
        question: 'Will candidate X win?',
        info: { question: 'Will candidate X win?', end_date_iso: new Date(Date.now() + 30 * 60_000).toISOString() }
      },
      null,
      { exa: true, serper: false }
    );

    expect(decision.route).toBe('exa');
    expect(decision.reason).toBe('near_resolution');
    expect(decision.contentBudget).toBe(DEFAULT_TRADE_POLICY.evWebSearchHighPriorityContentBudget);
  });

  it('classifies near-resolution official markets as fast-resolution routes', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      {
        ...context,
        info: { question: context.question, end_date_iso: new Date(Date.now() + 20 * 60_000).toISOString() }
      },
      null,
      { exa: true, serper: false }
    );

    expect(decision.route).toBe('exa');
    expect(decision.queryMode).toBe('base_plus_one');
    expect(decision.marketClass).toBe('fast_resolution');
  });

  it('uses Serper or skip near resolution for non-official markets', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const nearResolutionContext = {
      ...context,
      question: 'Will candidate X win?',
      info: { question: 'Will candidate X win?', end_date_iso: new Date(Date.now() + 20 * 60_000).toISOString() }
    };

    const serperDecision = router.decide(nearResolutionContext, null, { exa: false, serper: true });
    const skipDecision = router.decide(nearResolutionContext, null, { exa: false, serper: false });

    expect(serperDecision.route).toBe('serper');
    expect(serperDecision.queryMode).toBe('base_plus_one');
    expect(skipDecision.route).toBe('skip');
  });

  it('requires official confirmation for official-release markets without official domains', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      context,
      {
        triggerScore: 0.2,
        reasons: ['official_confirmation_missing'],
        articleCount: 2,
        articleDelta: 1,
        uniqueSourceCount: 2,
        uniqueSourceDelta: 1,
        noveltyScore: 0.4,
        contradictionScore: 0.1,
        officialDomainPresent: false,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: true }
    );

    expect(decision.route).toBe('serper');
    expect(decision.reason).toBe('official_confirmation_missing');
    expect(decision.queryMode).toBe('base_plus_two');
  });

  it('falls back to Exa or skip when official confirmation is missing and Serper is unavailable', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const heartbeat = {
      triggerScore: 0.2,
      reasons: ['official_confirmation_missing'] as const,
      articleCount: 2,
      articleDelta: 1,
      uniqueSourceCount: 2,
      uniqueSourceDelta: 1,
      noveltyScore: 0.4,
      contradictionScore: 0.1,
      officialDomainPresent: false,
      updatedAtMs: Date.now()
    };

    const exaDecision = router.decide(context, heartbeat, { exa: true, serper: false });
    const skipDecision = router.decide(context, heartbeat, { exa: false, serper: false });

    expect(exaDecision.route).toBe('exa');
    expect(skipDecision.route).toBe('skip');
  });

  it('skips when gdelt router has no trigger', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);

    const decision = router.decide(
      context,
      {
        triggerScore: 0.1,
        reasons: ['no_trigger'],
        articleCount: 1,
        articleDelta: 0,
        uniqueSourceCount: 1,
        uniqueSourceDelta: 0,
        noveltyScore: 0,
        contradictionScore: 0,
        officialDomainPresent: true,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: true }
    );

    expect(decision.route).toBe('skip');
  });

  it('routes to serper after a gdelt spike', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);

    const decision = router.decide(
      context,
      {
        triggerScore: 0.9,
        reasons: ['gdelt_spike'],
        articleCount: 5,
        articleDelta: 5,
        uniqueSourceCount: 4,
        uniqueSourceDelta: 4,
        noveltyScore: 1,
        contradictionScore: 0.3,
        officialDomainPresent: true,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: true }
    );

    expect(decision.route).toBe('serper');
    expect(decision.reason).toBe('gdelt_spike');
  });

  it('routes to exa when Serper is unavailable but Exa is live', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      context,
      {
        triggerScore: 0.9,
        reasons: ['gdelt_spike'],
        articleCount: 5,
        articleDelta: 5,
        uniqueSourceCount: 4,
        uniqueSourceDelta: 4,
        noveltyScore: 1,
        contradictionScore: 0.3,
        officialDomainPresent: true,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: false }
    );

    expect(decision.route).toBe('exa');
    expect(decision.reason).toBe('gdelt_spike');
  });

  it('prioritizes unexplained price moves even when heartbeat stays quiet', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      {
        ...context,
        question: 'Will candidate X win?',
        info: { question: 'Will candidate X win?' },
        priceMoveBps: DEFAULT_TRADE_POLICY.evWebSearchPriceMoveTriggerBps + 50
      },
      {
        triggerScore: 0.1,
        reasons: ['no_trigger'],
        articleCount: 1,
        articleDelta: 0,
        uniqueSourceCount: 1,
        uniqueSourceDelta: 0,
        noveltyScore: 0,
        contradictionScore: 0,
        officialDomainPresent: true,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: true }
    );

    expect(decision.route).toBe('serper');
    expect(decision.reason).toBe('price_move_unexplained');
    expect(decision.contentBudget).toBe(DEFAULT_TRADE_POLICY.evWebSearchHighPriorityContentBudget);
  });

  it('falls back to Exa or skip for unexplained price moves when Serper is unavailable', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const priceMoveContext = {
      ...context,
      question: 'Will candidate X win?',
      info: { question: 'Will candidate X win?' },
      priceMoveBps: DEFAULT_TRADE_POLICY.evWebSearchPriceMoveTriggerBps + 50
    };
    const heartbeat = {
      triggerScore: 0.1,
      reasons: ['no_trigger'] as const,
      articleCount: 1,
      articleDelta: 0,
      uniqueSourceCount: 1,
      uniqueSourceDelta: 0,
      noveltyScore: 0,
      contradictionScore: 0,
      officialDomainPresent: true,
      updatedAtMs: Date.now()
    };

    const exaDecision = router.decide(priceMoveContext, heartbeat, { exa: true, serper: false });
    const skipDecision = router.decide(priceMoveContext, heartbeat, { exa: false, serper: false });

    expect(exaDecision.route).toBe('exa');
    expect(skipDecision.route).toBe('skip');
  });

  it('reduces sentiment-market content budgets and upgrades the query mode on contradiction', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchDefaultContentBudget: 4
    });
    const decision = router.decide(
      {
        ...context,
        question: 'Will public sentiment improve?',
        info: { question: 'Will public sentiment improve?' }
      },
      {
        triggerScore: 0.7,
        reasons: ['gdelt_spike'],
        articleCount: 4,
        articleDelta: 2,
        uniqueSourceCount: 3,
        uniqueSourceDelta: 1,
        noveltyScore: 0.5,
        contradictionScore: 0.6,
        officialDomainPresent: true,
        updatedAtMs: Date.now()
      },
      { exa: true, serper: true }
    );

    expect(decision.route).toBe('serper');
    expect(decision.queryMode).toBe('base_plus_two');
    expect(decision.contentBudget).toBe(2);
  });

  it('skips when no paid providers are available', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_exa'
    });
    const decision = router.decide(context, null, { exa: false, serper: false });
    expect(decision.route).toBe('skip');
  });

  it('escalates serper results to exa when authority is weak', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_exa'
    });

    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_one',
        contentBudget: 2,
        marketClass: 'event_narrative'
      },
      [{ url: 'https://blog.example.com/post', source: 'blog.example.com', title: 'yes no', snippet: 'yes no' }]
    );

    expect(escalation?.route).toBe('serper_then_exa');
  });

  it('does not escalate when Serper evidence is already authoritative', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_exa'
    });

    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_two',
        contentBudget: 2,
        marketClass: 'official_release'
      },
      [{ url: 'https://www.whitehouse.gov/briefing', source: 'whitehouse.gov', title: 'Yes wins', snippet: 'yes yes' }]
    );

    expect(escalation).toBeNull();
  });

  it('uses the low-authority escalation reason for official-release markets', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_exa'
    });

    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_two',
        contentBudget: 2,
        marketClass: 'official_release'
      },
      [{ url: 'https://www.reuters.com/story', source: 'reuters.com', title: 'Yes', snippet: 'yes only' }]
    );

    expect(escalation?.reason).toBe('serper_low_authority');
  });

  it('does not escalate when Exa fallback is disabled', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchExaFallbackEnabled: false
    });

    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_one',
        contentBudget: 2,
        marketClass: 'event_narrative'
      },
      []
    );

    expect(escalation).toBeNull();
  });

  it('does not escalate when the current route is not serper', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'exa',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_one',
        contentBudget: 2,
        marketClass: 'event_narrative'
      },
      []
    );

    expect(escalation).toBeNull();
  });

  it('does not escalate in serper_only mode', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_only'
    });
    const escalation = router.shouldEscalateSerper(
      context,
      {
        route: 'serper',
        reason: 'gdelt_spike',
        triggerScore: 0.8,
        queryMode: 'base_plus_one',
        contentBudget: 2,
        marketClass: 'event_narrative'
      },
      []
    );

    expect(escalation).toBeNull();
  });
});

describe('SearchRouter test utils', () => {
  const nowMs = Date.UTC(2026, 2, 10, 12, 0, 0);

  it('covers helper market classification and query-mode branches', () => {
    expect(
      __searchRouterTestUtils.classifyMarket({
        marketId: 'fast',
        question: 'Will this resolve soon?',
        outcomes: ['Yes', 'No'],
        info: { end_date_iso: new Date(nowMs + 10 * 60_000).toISOString() },
        nowMs
      })
    ).toBe('fast_resolution');
    expect(
      __searchRouterTestUtils.classifyMarket({
        marketId: 'diffuse',
        question: 'Will public approval sentiment improve?',
        outcomes: ['Yes', 'No'],
        info: { end_date_iso: new Date(nowMs + 86400000).toISOString() },
        nowMs
      })
    ).toBe('diffuse_sentiment');
    expect(
      __searchRouterTestUtils.classifyMarket({
        marketId: 'narrative',
        question: 'Will the crowd react?',
        outcomes: ['Yes', 'No'],
        info: {},
        nowMs
      })
    ).toBe('event_narrative');

    expect(__searchRouterTestUtils.resolveQueryMode('base_plus_two', 'diffuse_sentiment')).toBe('base_plus_one');
    expect(__searchRouterTestUtils.resolveQueryMode('base_only', 'official_release')).toBe('base_plus_two');
    expect(
      __searchRouterTestUtils.isNearResolution(
        {
          marketId: 'invalid',
          question: 'x',
          outcomes: ['Yes', 'No'],
          info: { end_date_iso: 'not-a-date' },
          nowMs
        },
        30
      )
    ).toBe(false);
  });

  it('covers helper authority, official-domain, and conflict scoring branches', () => {
    expect(__searchRouterTestUtils.scoreAuthority([])).toBe(0);
    expect(__searchRouterTestUtils.scoreDomain('whitehouse.gov')).toBe(1);
    expect(__searchRouterTestUtils.scoreDomain('reuters.com')).toBe(0.8);
    expect(__searchRouterTestUtils.scoreDomain('reddit.com')).toBe(0.25);
    expect(__searchRouterTestUtils.scoreDomain('example.com')).toBe(0.5);
    expect(__searchRouterTestUtils.scoreDomain('')).toBe(0);

    expect(__searchRouterTestUtils.hasOfficialDomain([{ url: 'https://www.sec.gov/doc', source: 'sec.gov' }])).toBe(true);
    expect(__searchRouterTestUtils.hasOfficialDomain([{ url: 'https://example.com/story', source: 'example.com' }])).toBe(false);
    expect(__searchRouterTestUtils.isOfficialDomain('congress.gov')).toBe(true);
    expect(__searchRouterTestUtils.isOfficialDomain('example.com')).toBe(false);

    expect(
      __searchRouterTestUtils.countConflictingOutcomeMentions(
        [{ url: 'https://example.com', title: 'yes', snippet: 'no' }],
        ['Yes']
      )
    ).toBe(0);
    expect(
      __searchRouterTestUtils.countConflictingOutcomeMentions(
        [
          { url: 'https://example.com/1', title: 'Yes', snippet: '' },
          { url: 'https://example.com/2', title: 'No', snippet: 'No' }
        ],
        ['Yes', 'No']
      )
    ).toBeGreaterThan(0);
    expect(
      __searchRouterTestUtils.countConflictingOutcomeMentions(
        [{ url: 'https://example.com/3', title: undefined, snippet: undefined }],
        ['Yes', 'No']
      )
    ).toBe(0);
  });

  it('covers empty-reason fallback and url-derived official-domain branches', () => {
    const router = new SearchRouter(DEFAULT_TRADE_POLICY);
    const decision = router.decide(
      {
        marketId: 'm4',
        question: 'Will the Fed cut rates in June?',
        outcomes: ['Yes', 'No'],
        info: { end_date_iso: new Date(nowMs + 86400000).toISOString() },
        nowMs
      },
      {
        triggerScore: 0,
        reasons: [],
        articleCount: 0,
        articleDelta: 0,
        uniqueSourceCount: 0,
        uniqueSourceDelta: 0,
        noveltyScore: 0,
        contradictionScore: 0,
        officialDomainPresent: true,
        updatedAtMs: nowMs
      },
      { exa: true, serper: true }
    );

    expect(decision.reason).toBe('no_trigger');
    expect(__searchRouterTestUtils.scoreAuthority([{ url: 'https://www.whitehouse.gov/briefing' }])).toBe(1);
    expect(__searchRouterTestUtils.hasOfficialDomain([{ url: 'https://www.whitehouse.gov/briefing' }])).toBe(true);
  });

  it('does not escalate in serper_only mode even when results are ambiguous', () => {
    const router = new SearchRouter({
      ...DEFAULT_TRADE_POLICY,
      evWebSearchProviderPolicy: 'serper_only'
    });

    expect(
      router.shouldEscalateSerper(
        {
          marketId: 'm5',
          question: 'Will it happen?',
          outcomes: ['Yes', 'No'],
          info: {},
          nowMs
        },
        {
          route: 'serper',
          reason: 'low_priority',
          triggerScore: 0.1,
          queryMode: 'base_plus_one',
          contentBudget: 1,
          marketClass: 'event_narrative'
        },
        [{ url: 'https://blog.example.com/post', source: 'blog.example.com', title: 'yes no', snippet: 'yes no' }]
      )
    ).toBeNull();
  });
});
