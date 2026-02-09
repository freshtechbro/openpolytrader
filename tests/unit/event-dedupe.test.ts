import { describe, expect, it } from 'vitest';

import { normalizeReasonKey, shouldEmitScopedReason } from '../../src/utils/eventDedupe.js';

describe('eventDedupe', () => {
  it('normalizes reasons and drops transient reasons when a core blocker exists', () => {
    expect(normalizeReasonKey(['edge_below_threshold'])).toBe('edge_below_threshold');
    expect(normalizeReasonKey(['unstable_top_of_book', 'edge_below_threshold'])).toBe(
      'edge_below_threshold'
    );
    expect(normalizeReasonKey(['leg_sync_skew', 'ev_edge_below_threshold'])).toBe(
      'ev_edge_below_threshold'
    );
  });

  it('preserves transient-only reason sets', () => {
    expect(normalizeReasonKey(['unstable_top_of_book', 'leg_sync_skew'])).toBe(
      'leg_sync_skew|unstable_top_of_book'
    );
  });

  it('dedupes repeated emissions by scope and reason key inside cooldown', () => {
    const cache = new Map<string, { reasonKey: string; timestampMs: number }>();
    const scope = 'market-1';
    const reason = normalizeReasonKey(['unstable_top_of_book', 'edge_below_threshold']);

    expect(shouldEmitScopedReason(cache, scope, reason, 1_000, 3_000)).toBe(true);
    expect(shouldEmitScopedReason(cache, scope, reason, 2_000, 3_000)).toBe(false);
    expect(shouldEmitScopedReason(cache, scope, reason, 4_100, 3_000)).toBe(true);
  });
});

