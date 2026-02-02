import type { MarketAllowlist } from '../../domain/allowlist.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { HealthCheckResult } from './OpsAgent.js';

export interface OpsAlertPayload {
  check: string;
  result: HealthCheckResult;
  timestamp: number;
}

export interface BookFreshnessQuarantineConfig {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}

interface StaleCounterState {
  count: number;
  windowStartMs: number;
  lastQuarantineMs: number | null;
}

export function parseBookFreshnessInfo(
  info?: string
): { tokenId: string | null; stalenessMs?: number } {
  if (!info) return { tokenId: null };
  const tokenMatch = info.match(/\bworst=([^\s]+)/);
  const stalenessMatch = info.match(/\bstalenessMs=(\d+)/);
  const tokenId = tokenMatch?.[1] ?? null;
  const stalenessRaw = stalenessMatch ? Number(stalenessMatch[1]) : undefined;
  const stalenessMs = Number.isFinite(stalenessRaw) ? stalenessRaw : undefined;
  return { tokenId, stalenessMs };
}

export function isOpsAlertPayload(value: unknown): value is OpsAlertPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.check !== 'string') return false;
  if (typeof record.timestamp !== 'number') return false;
  const result = record.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object') return false;
  if (typeof result.ok !== 'boolean') return false;
  if (result.info !== undefined && typeof result.info !== 'string') return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;
  if (result.latencyMs !== undefined && typeof result.latencyMs !== 'number') return false;
  return true;
}

export function createBookFreshnessQuarantine(input: {
  config: BookFreshnessQuarantineConfig;
  allowlist: MarketAllowlist;
  incidentTracker: IncidentTracker;
  tokenToMarketId: Record<string, string>;
  now?: () => number;
}): {
  handle: (alert: OpsAlertPayload) => void;
  updateConfig: (next: Partial<BookFreshnessQuarantineConfig>) => void;
} {
  const counters = new Map<string, StaleCounterState>();
  const now = input.now ?? (() => Date.now());
  const config = { ...input.config };

  const normalize = () => {
    config.threshold = Math.max(1, Math.trunc(config.threshold));
    config.windowMs = Math.max(0, Math.trunc(config.windowMs));
    config.cooldownMs = Math.max(0, Math.trunc(config.cooldownMs));
  };

  normalize();

  const handle = (alert: OpsAlertPayload) => {
    if (alert.check !== 'book_freshness') return;
    if (alert.result.ok) return;
    if (config.windowMs <= 0 || config.threshold <= 0) return;

    const info = alert.result.info;
    if (!info) return;
    const { tokenId, stalenessMs } = parseBookFreshnessInfo(info);
    if (!tokenId) return;
    const marketId = input.tokenToMarketId[tokenId];
    if (!marketId) return;

    const timestamp = Number.isFinite(alert.timestamp) ? alert.timestamp : now();
    const status = input.allowlist.getStatus(marketId, timestamp);
    if (status && status.status !== 'allowed') return;

    const state =
      counters.get(marketId) ?? { count: 0, windowStartMs: timestamp, lastQuarantineMs: null };
    if (timestamp - state.windowStartMs > config.windowMs) {
      state.count = 0;
      state.windowStartMs = timestamp;
    }
    state.count += 1;

    const cooldownReady =
      state.lastQuarantineMs === null ||
      config.cooldownMs <= 0 ||
      timestamp - state.lastQuarantineMs >= config.cooldownMs;

    if (state.count >= config.threshold && cooldownReady) {
      input.incidentTracker.record({
        marketId,
        reason: 'book_stale',
        timestamp,
        detail: {
          tokenId,
          stalenessMs: stalenessMs ?? null,
          threshold: config.threshold,
          windowMs: config.windowMs,
          count: state.count,
          info
        }
      });
      state.lastQuarantineMs = timestamp;
      state.count = 0;
      state.windowStartMs = timestamp;
    }

    counters.set(marketId, state);
  };

  const updateConfig = (next: Partial<BookFreshnessQuarantineConfig>) => {
    Object.assign(config, next);
    normalize();
  };

  return { handle, updateConfig };
}
