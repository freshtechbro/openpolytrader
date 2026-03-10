import { describe, expect, it, vi } from 'vitest';

import { LearningStatsTracker } from '../../src/agents/learning/LearningStatsTracker.js';

describe('LearningStatsTracker', () => {
  it('tracks pending events, computes averages, and prunes stale markets', () => {
    const tracker = new LearningStatsTracker(250, 1, 2);

    tracker.update(
      'market-a',
      { opportunities: 1, approvals: 1, edge: 0.1, slippageSample: 0.02 },
      200,
      { recordPending: true, markDirty: true }
    );
    tracker.update(
      'market-b',
      { opportunities: 2, edge: 0.05, timeouts: 1 },
      300,
      { recordPending: true, markDirty: true }
    );

    expect(tracker.size).toBe(2);
    expect(tracker.shouldSynthesize(2)).toBe(true);
    tracker.resetPendingEvents();
    expect(tracker.shouldSynthesize(1)).toBe(false);

    const selected = tracker.selectMarketsForPrompt(350, 1_000);
    expect(selected.map(([marketId]) => marketId)).toEqual(['market-a', 'market-b']);
    expect(selected[0]?.[1]).toMatchObject({
      opportunities: 1,
      approvals: 1,
      avgEdge: 0.1,
      slippageSamples: 1,
      avgSlippage: 0.02,
      timeouts: 0
    });

    tracker.prune(500, { force: true });
    expect(tracker.size).toBe(1);
    expect(tracker.selectMarketsForPrompt(500, 1_000).map(([marketId]) => marketId)).toEqual([
      'market-b'
    ]);
  });

  it('persists snapshots and restores them with replayed store events', () => {
    const base = Date.now();
    const persistedEvents: Array<{ payload: { stats_by_market?: Record<string, unknown> } }> = [];
    const persistStore = {
      append: vi.fn((event: { payload: { stats_by_market?: Record<string, unknown> } }) => {
        persistedEvents.push(event);
      })
    };

    const tracker = new LearningStatsTracker(5_000, 5, 2);
    tracker.update('market-a', { opportunities: 1, edge: 0.2 }, base, {
      recordPending: false,
      markDirty: true
    });
    tracker.maybePersist(persistStore as never, base + 1_000, { force: true });

    expect(persistStore.append).toHaveBeenCalledOnce();
    expect(persistedEvents[0]?.payload.stats_by_market?.['market-a']).toMatchObject({
      opportunities: 1,
      avg_edge: 0.2
    });

    const restoreStore = {
      getLatestEventByType: vi.fn(() => ({
        payload: persistedEvents[0]?.payload
          ? {
              schema_version: 2,
              at_ms: base + 1_000,
              applied_through_ms: base + 1_000,
              stats_by_market: persistedEvents[0].payload.stats_by_market
            }
          : null
      })),
      listEventsByTypes: vi.fn(() => [
        {
          id: 'risk-approved',
          timestamp: base + 1_100,
          type: 'risk:approved',
          payload: { marketId: 'market-a' },
          metadata: { agent: 'RiskAgent' }
        },
        {
          id: 'fill',
          timestamp: base + 1_200,
          type: 'execution:fill',
          payload: { marketId: 'market-a', slippage: 0.03 },
          metadata: { agent: 'ExecutionAgent' }
        },
        {
          id: 'timeout',
          timestamp: base + 1_300,
          type: 'execution:outcome',
          payload: { marketId: 'market-a', status: 'timeout' },
          metadata: { agent: 'ExecutionAgent' }
        }
      ])
    };

    const restored = new LearningStatsTracker(5_000, 5, 2);
    restored.restore(restoreStore as never);

    const [entry] = restored.selectMarketsForPrompt(base + 1_400, 0);
    expect(entry?.[0]).toBe('market-a');
    expect(entry?.[1]).toMatchObject({
      opportunities: 1,
      approvals: 1,
      avgEdge: 0.2,
      slippageSamples: 1,
      avgSlippage: 0.03,
      timeouts: 1
    });
    expect(restoreStore.getLatestEventByType).toHaveBeenCalledWith('learning:market_stats_snapshot');
    expect(restoreStore.listEventsByTypes).toHaveBeenCalledWith({
      types: ['opportunity:detected', 'risk:approved', 'execution:outcome', 'execution:fill'],
      sinceExclusiveMs: base + 1_000
    });
  });
});
