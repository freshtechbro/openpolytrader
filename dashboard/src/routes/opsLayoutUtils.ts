import type { AllowlistEntry, FinalIntent, IntentStrategy } from '../pages/Overview';
import type { JsonRecord } from '../lib/json';

export type OpsPage = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk' | 'decisions';
export type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

const MAX_INTENTS = 120;
export const DEFAULT_OPS_PAGE: OpsPage = 'overview';
export const LOGOUT_FAILURE_MESSAGE =
  'Logout failed. Local auth was cleared; the server session may still be active.';

export const OPS_PATHS: Array<{ page: OpsPage; to: string; label: string }> = [
  { page: 'overview', to: '/ops/overview', label: 'Overview' },
  { page: 'markets', to: '/ops/markets', label: 'Markets' },
  { page: 'incidents', to: '/ops/incidents', label: 'Incidents' },
  { page: 'positions', to: '/ops/positions', label: 'Positions' },
  { page: 'risk', to: '/ops/risk', label: 'Risk' },
  { page: 'decisions', to: '/ops/decisions', label: 'Decisions' }
];

export function upsertIntent(intents: FinalIntent[], nextIntent: FinalIntent): FinalIntent[] {
  const others = intents.filter((intent) => intent.opportunityId !== nextIntent.opportunityId);
  return [nextIntent, ...others].sort((a, b) => b.gatedAt - a.gatedAt).slice(0, MAX_INTENTS);
}

export function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object') return null;
  return value as JsonRecord;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function inferMarketId(opportunityId?: string, marketId?: string): string | undefined {
  if (marketId) return marketId;
  if (!opportunityId) return undefined;
  const prefix = opportunityId.split(':')[0];
  if (/^0x[0-9a-f]{32,}$/i.test(prefix)) return prefix;
  const match = opportunityId.match(/0x[0-9a-f]{32,}/i);
  return match?.[0];
}

export function getMarketQuestion(
  allowlist: AllowlistEntry[],
  marketId?: string
): string | undefined {
  if (!marketId) return undefined;
  const entry = allowlist.find((item) => item.key === marketId);
  if (!entry || typeof entry.question !== 'string') return undefined;
  const trimmed = entry.question.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeIntentStrategy(value: unknown): IntentStrategy | undefined {
  if (
    value === 'near_zero' ||
    value === 'ev' ||
    value === 'fw_projection' ||
    value === 'fw_basket' ||
    value === 'unknown'
  ) {
    return value;
  }
  if (value === 'ev_single_side') return 'ev';
  return undefined;
}

export function inferIntentStrategy(
  opportunityId?: string,
  strategy?: IntentStrategy
): IntentStrategy {
  if (strategy && strategy !== 'unknown') return strategy;
  if (!opportunityId) return strategy ?? 'unknown';
  const parts = opportunityId.split(':');
  if (parts[0] === 'fw-basket' || parts[0] === 'fw_basket') return 'fw_basket';
  if (parts[1] === 'fw') return 'fw_projection';
  if (parts[1] === 'fwb' || parts[1] === 'fw_basket') return 'fw_basket';
  if (parts[1] === 'yes' || parts[1] === 'no') return 'ev';
  if (Number.isFinite(Number(parts[1])) && Number.isFinite(Number(parts[2]))) return 'near_zero';
  return strategy ?? 'unknown';
}

export function resolveOpsPage(pathname: string): OpsPage {
  const segments = pathname.split('/').filter(Boolean);
  const value = segments[1] ?? DEFAULT_OPS_PAGE;
  if (value === 'risk-gates') return 'risk';
  if (
    value === 'overview' ||
    value === 'markets' ||
    value === 'incidents' ||
    value === 'positions' ||
    value === 'risk' ||
    value === 'decisions'
  ) {
    return value;
  }
  return DEFAULT_OPS_PAGE;
}

export function canonicalOpsPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/ops/overview';
  const page = resolveOpsPage(pathname);
  return `/ops/${page}`;
}
