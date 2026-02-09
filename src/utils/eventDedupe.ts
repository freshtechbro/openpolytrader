export interface ScopedReasonEmissionState {
  reasonKey: string;
  timestampMs: number;
}

const TRANSIENT_REASONS = new Set(['unstable_top_of_book', 'leg_sync_skew']);

function normalizeReasonList(reasons: readonly string[]): string[] {
  const normalized = Array.from(
    new Set(reasons.filter((reason) => typeof reason === 'string' && reason.length > 0))
  );

  if (normalized.length <= 1) {
    return normalized;
  }

  // Treat transient timing instability as a secondary attribute when a core blocker is present.
  const withoutTransient = normalized.filter((reason) => !TRANSIENT_REASONS.has(reason));
  return withoutTransient.length > 0 ? withoutTransient : normalized;
}

export function normalizeReasonKey(reasons: readonly string[] | string): string {
  if (typeof reasons === 'string') {
    return reasons;
  }

  const normalized = normalizeReasonList(reasons).sort();

  return normalized.length > 0 ? normalized.join('|') : 'unknown';
}

export function shouldEmitScopedReason(
  cache: Map<string, ScopedReasonEmissionState>,
  scopeKey: string,
  reasonKey: string,
  nowMs: number,
  cooldownMs: number
): boolean {
  const previous = cache.get(scopeKey);
  if (!previous || previous.reasonKey !== reasonKey || nowMs - previous.timestampMs >= cooldownMs) {
    cache.set(scopeKey, { reasonKey, timestampMs: nowMs });
    return true;
  }
  return false;
}
