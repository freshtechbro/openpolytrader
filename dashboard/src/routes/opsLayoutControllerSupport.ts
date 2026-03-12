import type { StreamEvent } from '../hooks/useEventStream';
import type {
  AllowlistEntry,
  FinalIntent,
  IntentStrategy,
  OpsIncident
} from '../pages/Overview';
import type { SessionState } from './OpsAuthView';
import {
  asRecord,
  asString,
  getMarketQuestion,
  inferIntentStrategy,
  inferMarketId,
  normalizeIntentStrategy,
  type TradingMode,
  upsertIntent
} from './opsLayoutUtils';

function getBasketLegMarketId(source: JsonRecord | null): string | undefined {
  const basket = asRecord(source?.basket);
  const legs = Array.isArray(basket?.legs) ? basket.legs : [];
  for (const leg of legs) {
    const marketId = asString(asRecord(leg)?.marketId);
    if (marketId) return marketId;
  }
  return undefined;
}

export function asAllowlist(data: unknown): AllowlistEntry[] {
  return Array.isArray(data) ? (data as AllowlistEntry[]) : [];
}

export function asIncidents(data: unknown): OpsIncident[] {
  return Array.isArray(data) ? (data as OpsIncident[]) : [];
}

export function asTradingMode(value: unknown): TradingMode | null {
  return value === 'off' || value === 'shadow' || value === 'paper' || value === 'live'
    ? value
    : null;
}

export function createSessionState(
  authenticated: boolean,
  authRequired: boolean,
  error: string | null = null
): SessionState {
  return {
    checking: false,
    authenticated,
    authRequired,
    error
  };
}

export function toLiveDecision(
  event: StreamEvent,
  agentFilter: string,
  subjectFilter: string
): FinalIntent | null {
  if (event.type !== 'latency') return null;
  const data = asRecord(event.data);
  if (!data || data.stage !== 'gated') return null;

  const opportunityId = asString(data.opportunityId);
  if (!opportunityId) return null;

  const strategy = inferIntentStrategy(opportunityId, normalizeIntentStrategy(data.strategy));
  if (agentFilter.trim()) return null;
  if (subjectFilter.trim() && !opportunityId.includes(subjectFilter.trim())) return null;

  return {
    opportunityId,
    marketId: inferMarketId(opportunityId, asString(data.marketId)),
    strategy,
    gatedAt: event.timestamp
  };
}

export function syncLatencyIntent(
  intents: FinalIntent[],
  intent: FinalIntent,
  allowlist: AllowlistEntry[]
): FinalIntent[] {
  const existing = intents.find((entry) => entry.opportunityId === intent.opportunityId);
  return upsertIntent(intents, {
    ...intent,
    marketQuestion: getMarketQuestion(allowlist, intent.marketId) ?? existing?.marketQuestion,
    executedAt: existing?.executedAt,
    orderStatus: existing?.orderStatus,
    orderReason: existing?.orderReason
  });
}

export function syncOrderIntent(
  intents: FinalIntent[],
  event: StreamEvent,
  allowlist: AllowlistEntry[]
): FinalIntent[] {
  if (event.type !== 'order') return intents;

  const data = asRecord(event.data);
  const state = asRecord(data?.state);
  const opportunityId = asString(data?.opportunityId) ?? asString(state?.opportunityId);
  if (!opportunityId) return intents;

  const existing = intents.find((intent) => intent.opportunityId === opportunityId);
  const strategy = inferIntentStrategy(
    opportunityId,
    normalizeIntentStrategy(data?.strategy) ?? normalizeIntentStrategy(state?.strategy)
  );
  const marketId = inferMarketId(
    opportunityId,
    asString(data?.marketId) ?? asString(state?.marketId) ?? getBasketLegMarketId(data)
  );
  const resolvedMarketId = marketId ?? existing?.marketId;

  return upsertIntent(intents, {
    opportunityId,
    marketId: resolvedMarketId,
    marketQuestion: getMarketQuestion(allowlist, resolvedMarketId) ?? existing?.marketQuestion,
    strategy,
    gatedAt: existing?.gatedAt ?? event.timestamp,
    executedAt: asString(data?.status) === 'submitted' ? event.timestamp : existing?.executedAt,
    orderStatus: asString(data?.status) ?? existing?.orderStatus,
    orderReason: asString(data?.reason) ?? existing?.orderReason
  });
}

export function reconcileIntentMetadata(
  intents: FinalIntent[],
  allowlist: AllowlistEntry[]
): FinalIntent[] {
  let changed = false;
  const next = intents.map((intent) => {
    const marketId = inferMarketId(intent.opportunityId, intent.marketId);
    const marketQuestion = getMarketQuestion(allowlist, marketId) ?? intent.marketQuestion;
    const strategy = inferIntentStrategy(intent.opportunityId, intent.strategy as IntentStrategy | undefined);
    if (marketId === intent.marketId && marketQuestion === intent.marketQuestion && strategy === intent.strategy) {
      return intent;
    }
    changed = true;
    return {
      ...intent,
      marketId,
      marketQuestion,
      strategy
    };
  });
  return changed ? next : intents;
}

export function getStreamState(event: StreamEvent): Record<string, unknown> | null {
  return asRecord(asRecord(event.data)?.state);
}

export function shouldRefreshMetrics(event: StreamEvent): boolean {
  return event.type === 'info' || event.type === 'risk' || event.type === 'order' || event.type === 'fill';
}
