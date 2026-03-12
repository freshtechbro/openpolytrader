import type { TradePolicy } from '../../config/policy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import { clamp01 } from '../../utils/math.js';
import type { WebSearchResult } from './WebSearchClient.js';
import type {
  HeartbeatState,
  MarketClass,
  SearchQueryMode,
  SearchRouteContext,
  SearchRouteDecision,
  SearchRouteReason
} from './SearchRoutingTypes.js';

const DEFAULT_HEARTBEAT: HeartbeatState = {
  triggerScore: 0,
  reasons: ['no_trigger'],
  articleCount: 0,
  articleDelta: 0,
  uniqueSourceCount: 0,
  uniqueSourceDelta: 0,
  noveltyScore: 0,
  contradictionScore: 0,
  officialDomainPresent: false,
  updatedAtMs: 0
};

export class SearchRouter {
  private policy: TradePolicy;
  private readonly metrics?: MetricsStore;

  constructor(policy: TradePolicy, metrics?: MetricsStore) {
    this.policy = policy;
    this.metrics = metrics;
  }

  updatePolicy(policy: TradePolicy): void {
    this.policy = policy;
  }

  decide(
    context: SearchRouteContext,
    heartbeat: HeartbeatState | null,
    providers: { exa: boolean; serper: boolean }
  ): SearchRouteDecision {
    const marketClass = classifyMarket(context);
    const heartbeatState = heartbeat ?? DEFAULT_HEARTBEAT;
    const hasHeartbeat = heartbeat !== null;
    const nearResolution = isNearResolution(context, this.policy.evWebSearchNearResolutionMinutes);
    const priceMoveTriggered = (context.priceMoveBps ?? 0) >= Math.max(this.policy.evWebSearchPriceMoveTriggerBps, 0);
    const defaultQueryMode = resolveQueryMode(this.policy.evWebSearchDefaultQueryMode, marketClass);
    const highPriorityBudget = Math.min(this.policy.evWebSearchHighPriorityContentBudget, 8);
    const defaultBudget = Math.min(this.policy.evWebSearchDefaultContentBudget, 8);

    if (this.policy.evWebSearchProviderPolicy === 'exa_only') {
      return {
        route: providers.exa ? 'exa' : 'skip',
        reason: providers.exa ? 'low_priority' : 'no_trigger',
        triggerScore: heartbeatState.triggerScore,
        queryMode: defaultQueryMode,
        contentBudget: providers.exa ? defaultBudget : 0,
        marketClass
      };
    }

    if (nearResolution) {
      return {
        route: providers.serper ? 'serper' : providers.exa ? 'exa' : 'skip',
        reason: 'near_resolution',
        triggerScore: heartbeatState.triggerScore,
        queryMode: 'base_plus_one',
        contentBudget: highPriorityBudget,
        marketClass
      };
    }

    if (
      hasHeartbeat &&
      marketClass === 'official_release' &&
      this.policy.evWebSearchOfficialDomainRequired &&
      !heartbeatState.officialDomainPresent
    ) {
      return {
        route: providers.serper ? 'serper' : providers.exa ? 'exa' : 'skip',
        reason: 'official_confirmation_missing',
        triggerScore: heartbeatState.triggerScore,
        queryMode: 'base_plus_two',
        contentBudget: highPriorityBudget,
        marketClass
      };
    }

    if (priceMoveTriggered) {
      return {
        route: providers.serper ? 'serper' : providers.exa ? 'exa' : 'skip',
        reason: 'price_move_unexplained',
        triggerScore: heartbeatState.triggerScore,
        queryMode: defaultQueryMode,
        contentBudget: highPriorityBudget,
        marketClass
      };
    }

    if (
      hasHeartbeat &&
      this.policy.evWebSearchProviderPolicy === 'gdelt_serper_exa' &&
      heartbeatState.triggerScore < this.policy.evWebSearchGdeltTriggerThreshold
    ) {
      return {
        route: 'skip',
        reason: heartbeatState.reasons[0] ?? 'no_trigger',
        triggerScore: heartbeatState.triggerScore,
        queryMode: defaultQueryMode,
        contentBudget: 0,
        marketClass
      };
    }

    if (providers.serper) {
      return {
        route: 'serper',
        reason:
          hasHeartbeat && heartbeatState.triggerScore >= this.policy.evWebSearchGdeltTriggerThreshold
            ? 'gdelt_spike'
            : 'low_priority',
        triggerScore: heartbeatState.triggerScore,
        queryMode: heartbeatState.contradictionScore >= 0.4 ? 'base_plus_two' : defaultQueryMode,
        contentBudget: marketClass === 'diffuse_sentiment' ? Math.min(defaultBudget, 2) : defaultBudget,
        marketClass
      };
    }

    if (providers.exa) {
      return {
        route: 'exa',
        reason:
          hasHeartbeat && heartbeatState.triggerScore >= this.policy.evWebSearchGdeltTriggerThreshold
            ? 'gdelt_spike'
            : 'low_priority',
        triggerScore: heartbeatState.triggerScore,
        queryMode: defaultQueryMode,
        contentBudget: defaultBudget,
        marketClass
      };
    }

    return {
      route: 'skip',
      reason: 'no_trigger',
      triggerScore: heartbeatState.triggerScore,
      queryMode: defaultQueryMode,
      contentBudget: 0,
      marketClass
    };
  }

  shouldEscalateSerper(
    context: SearchRouteContext,
    decision: SearchRouteDecision,
    results: WebSearchResult[]
  ): SearchRouteDecision | null {
    if (!this.policy.evWebSearchExaEnabled || !this.policy.evWebSearchExaFallbackEnabled) {
      return null;
    }
    if (decision.route !== 'serper') {
      return null;
    }
    if (this.policy.evWebSearchProviderPolicy === 'serper_only') {
      return null;
    }

    const authority = scoreAuthority(results);
    const officialHit = hasOfficialDomain(results);
    const ambiguous = results.length === 0 || authority < 0.55 || countConflictingOutcomeMentions(results, context.outcomes) > 0.35;

    if (!ambiguous && (!this.policy.evWebSearchOfficialDomainRequired || officialHit || decision.marketClass !== 'official_release')) {
      return null;
    }

    const reason: SearchRouteReason =
      this.policy.evWebSearchOfficialDomainRequired && decision.marketClass === 'official_release' && !officialHit
        ? 'serper_low_authority'
        : 'serper_ambiguous';

    const nextDecision: SearchRouteDecision = {
      route: 'serper_then_exa',
      reason,
      triggerScore: decision.triggerScore,
      queryMode: 'base_plus_two',
      contentBudget: Math.min(this.policy.evWebSearchHighPriorityContentBudget, 8),
      marketClass: decision.marketClass
    };

    this.metrics?.record({
      type: 'web_search',
      timestamp: Date.now(),
      data: {
        event: 'provider_disagreement',
        marketId: context.marketId,
        providers: ['serper', 'exa'],
        reason,
        authority
      }
    });

    return nextDecision;
  }
}

function classifyMarket(context: SearchRouteContext): MarketClass {
  const question = context.question.toLowerCase();
  if (isNearResolution(context, 60)) {
    return 'fast_resolution';
  }
  if (/(fed|fomc|cpi|inflation|sec|supreme court|court|judge|agency|report|filing|earnings|gdp|jobs report|department)/.test(question)) {
    return 'official_release';
  }
  if (/(approval|sentiment|hype|buzz|narrative|favorability|reputation|confidence)/.test(question)) {
    return 'diffuse_sentiment';
  }
  return 'event_narrative';
}

function resolveQueryMode(defaultMode: SearchQueryMode, marketClass: MarketClass): SearchQueryMode {
  if (marketClass === 'official_release') return 'base_plus_two';
  if (marketClass === 'diffuse_sentiment' && defaultMode === 'base_plus_two') return 'base_plus_one';
  return defaultMode;
}

function isNearResolution(context: SearchRouteContext, thresholdMinutes: number): boolean {
  const raw = context.info?.end_date_iso;
  if (!raw) return false;
  const endAtMs = Date.parse(raw);
  if (!Number.isFinite(endAtMs)) return false;
  return endAtMs - context.nowMs <= Math.max(thresholdMinutes, 1) * 60_000;
}

function scoreAuthority(results: WebSearchResult[]): number {
  if (results.length === 0) return 0;
  const total = results.reduce((sum, result) => sum + scoreDomain(result.source ?? result.url), 0);
  return clamp01(total / results.length);
}

function hasOfficialDomain(results: WebSearchResult[]): boolean {
  return results.some((result) => isOfficialDomain(result.source ?? result.url));
}

function scoreDomain(value: string): number {
  if (!value) return 0;
  if (isOfficialDomain(value)) return 1;
  if (/(reuters|apnews|bloomberg|wsj|nytimes|bbc|cnn|ft\.com|economist)/.test(value)) return 0.8;
  if (/(wikipedia|substack|medium|youtube|reddit|x\.com|twitter)/.test(value)) return 0.25;
  return 0.5;
}

function isOfficialDomain(value: string): boolean {
  return /\.(gov|mil|int)$/i.test(value) || /federalreserve|supremecourt|uscourts|sec\.gov|whitehouse\.gov|congress\.gov/i.test(value);
}

function countConflictingOutcomeMentions(results: WebSearchResult[], outcomes: string[]): number {
  const [first, second] = outcomes.map((outcome) => outcome.toLowerCase().trim()).filter(Boolean);
  if (!first || !second) return 0;
  let firstMentions = 0;
  let secondMentions = 0;
  for (const result of results) {
    const text = `${result.title ?? ''} ${result.snippet ?? ''}`.toLowerCase();
    if (text.includes(first)) firstMentions += 1;
    if (text.includes(second)) secondMentions += 1;
  }
  const total = firstMentions + secondMentions;
  if (total === 0) return 0;
  return clamp01(Math.min(firstMentions, secondMentions) / total);
}

export const __searchRouterTestUtils = {
  classifyMarket,
  resolveQueryMode,
  isNearResolution,
  scoreAuthority,
  hasOfficialDomain,
  scoreDomain,
  isOfficialDomain,
  countConflictingOutcomeMentions
};
