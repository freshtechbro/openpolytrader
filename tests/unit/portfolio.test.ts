import { describe, it, expect, vi } from 'vitest';

import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import type { IncidentRecord } from '../../src/domain/incident.js';
import type { IncidentTracker } from '../../src/services/IncidentTracker.js';
import type { VenueOpenOrder, VenuePosition } from '../../src/domain/venue.js';

describe('PortfolioAgent', () => {
  describe('initial state', () => {
    it('snapshot returns initial capital with no positions', () => {
      const agent = new PortfolioAgent(1000);
      const snapshot = agent.snapshot();

      expect(snapshot.totalCapital).toBe(1000);
      expect(snapshot.availableCapital).toBe(1000);
      expect(snapshot.dailyPnL).toBe(0);
      expect(snapshot.marketExposure).toEqual({});
    });
  });

  describe('applyFill', () => {
    it('creates new position on first BUY fill', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.50
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBe(950);
      expect(snapshot.marketExposure['market-1']).toBe(50);
    });

    it('accumulates position on multiple BUY fills', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 100,
        price: 0.40
      });

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 100,
        price: 0.60
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBe(900);
    });

    it('reduces position on SELL fill', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 100,
        price: 0.50
      });

      agent.applyFill({
        tokenId: 'token-1',
        side: 'SELL',
        size: 50,
        price: 0.50
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBe(975);
    });

    it('zeroes position when fills net to zero', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 100,
        price: 0.50
      });

      agent.applyFill({
        tokenId: 'token-1',
        side: 'SELL',
        size: 100,
        price: 0.60
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBe(1000);
    });

    it('tracks market exposure separately', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.50
      });

      agent.applyFill({
        tokenId: 'token-2',
        marketId: 'market-2',
        side: 'BUY',
        size: 200,
        price: 0.25
      });

      const snapshot = agent.snapshot();
      expect(snapshot.marketExposure['market-1']).toBe(50);
      expect(snapshot.marketExposure['market-2']).toBe(50);
    });

    it('handles net short positions when sells exceed buys', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'SELL',
        size: 100,
        price: 0.5
      });

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 50,
        price: 0.4
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBeLessThan(1000);
    });

    it('ignores zero-size fills', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 0,
        price: 0.5
      });

      expect(agent.snapshot().marketExposure).toEqual({});
    });

    it('backfills marketId on an existing position', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 10,
        price: 0.5
      });

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 5,
        price: 0.5
      });

      expect(agent.snapshot().marketExposure['market-1']).toBeCloseTo(7.5, 6);
    });
  });

  describe('applyPnL', () => {
    it('accumulates daily PnL', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyPnL(10);
      agent.applyPnL(-3);
      agent.applyPnL(5);

      const snapshot = agent.snapshot();
      expect(snapshot.dailyPnL).toBe(12);
    });

    it('handles negative PnL', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyPnL(-50);

      const snapshot = agent.snapshot();
      expect(snapshot.dailyPnL).toBe(-50);
    });
  });

  describe('availableCapital', () => {
    it('never goes below zero', () => {
      const agent = new PortfolioAgent(100);

      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 500,
        price: 0.50
      });

      const snapshot = agent.snapshot();
      expect(snapshot.availableCapital).toBe(0);
    });
  });

  describe('exposure cleanup', () => {
    it('clearMarketExposure removes positions for a market', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.5
      });

      expect(agent.snapshot().marketExposure['market-1']).toBe(50);

      agent.clearMarketExposure('market-1');

      expect(agent.snapshot().marketExposure['market-1']).toBeUndefined();
    });

    it('clearMarketExposure is a no-op for non-matching markets', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.5
      });

      agent.clearMarketExposure('market-2');

      expect(agent.snapshot().marketExposure['market-1']).toBe(50);
    });

    it('reduceMarketExposure scales down position sizes', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.5
      });

      agent.reduceMarketExposure('market-1', 20);

      expect(agent.snapshot().marketExposure['market-1']).toBeCloseTo(30, 6);
    });

    it('reduceMarketExposure is a no-op for negative reductions', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.5
      });

      const before = agent.snapshot();
      agent.reduceMarketExposure('market-1', -100);
      const after = agent.snapshot();

      expect(after.marketExposure['market-1']).toBe(before.marketExposure['market-1']);
    });

    it('reduceMarketExposure is a no-op when there is no positive exposure', () => {
      const agent = new PortfolioAgent(1000);

      agent.reduceMarketExposure('market-1', 10);

      expect(agent.snapshot().marketExposure).toEqual({});
    });

    it('reduceMarketExposure can scale exposure all the way to zero', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 100,
        price: 0.5
      });

      agent.reduceMarketExposure('market-1', 1_000_000);

      const snapshot = agent.snapshot();
      expect(snapshot.marketExposure['market-1']).toBeUndefined();
      expect(snapshot.availableCapital).toBe(1000);
      expect(snapshot.openInventoryAgeMs).toBe(0);
    });

    it('applyUnwind records PnL and clears exposure', () => {
      const agent = new PortfolioAgent(1000);

      agent.applyUnwind({
        marketId: 'market-1',
        tokenId: 'token-1',
        entryPrice: 0.5,
        unwindPrice: 0.6,
        size: 10
      });

      const snapshot = agent.snapshot();
      expect(snapshot.marketExposure['market-1']).toBeUndefined();
      expect(snapshot.dailyPnL).toBeCloseTo(1, 8);
    });
  });

  describe('reconciliation', () => {
    it('reconciles matching fills', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5,
          timestamp: nowMs + 1
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(agent.checkStalePending(0)).toHaveLength(0);
    });

    it('accepts better-than-expected price for BUY', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.49
        },
        { priceTolerance: 0, sizeTolerance: 0 }
      );

      expect(result.ok).toBe(true);
    });

    it('matches expected fill by tokenId when opportunityId is missing and unambiguous', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5
        },
        { priceTolerance: 0, sizeTolerance: 0 }
      );

      expect(result.ok).toBe(true);
      expect(result.expected?.opportunityId).toBe('opp-1');
    });

    it('uses default reconciliation tolerances when options are omitted', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 9,
        price: 0.51
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'size_mismatch')).toBe(true);
      expect(result.issues.some((issue) => issue.type === 'price_mismatch')).toBe(true);
    });

    it('flags ambiguous expected fills when opportunityId is missing and multiple candidates exist', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs - 10
      });
      agent.expectFill({
        opportunityId: 'opp-2',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5
        },
        { priceTolerance: 0, sizeTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'ambiguous_expected_fill')).toBe(
        true
      );
    });

    it('flags size mismatch beyond tolerance', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 9,
          price: 0.5
        },
        { sizeTolerance: 0.5, priceTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'size_mismatch')).toBe(true);
    });

    it('flags price mismatch beyond tolerance', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.52
        },
        { sizeTolerance: 0, priceTolerance: 0.01 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'price_mismatch')).toBe(true);
    });

    it('flags invalid prices as mismatches', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: Number.NaN,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'price_mismatch')).toBe(true);
    });

    it('accepts better-than-expected price for SELL and flags worse-than-expected', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const ok = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'SELL',
          size: 10,
          price: 0.51
        },
        { priceTolerance: 0, sizeTolerance: 0 }
      );

      expect(ok.ok).toBe(true);

      agent.expectFill({
        opportunityId: 'opp-2',
        tokenId: 'token-2',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const bad = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-2',
          tokenId: 'token-2',
          marketId: 'market-1',
          side: 'SELL',
          size: 10,
          price: 0.49
        },
        { priceTolerance: 0, sizeTolerance: 0 }
      );

      expect(bad.ok).toBe(false);
      expect(bad.issues.some((issue) => issue.type === 'price_mismatch')).toBe(true);
    });

    it('flags unexpected fills', () => {
      const agent = new PortfolioAgent(1000);

      const result = agent.applyFillWithReconciliation(
        {
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'unexpected_fill')).toBe(true);
    });

    it('treats missing expected fill for provided opportunityId as unexpected', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-2',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'unexpected_fill')).toBe(true);
    });

    it('treats expected fills for other tokens as non-candidates', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-expected',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      const result = agent.applyFillWithReconciliation(
        {
          tokenId: 'token-actual',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.5,
          timestamp: nowMs + 1
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'unexpected_fill')).toBe(true);
    });

    it('returns stale pending fills', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 1,
        expectedPrice: 0.1,
        timestamp: nowMs - 1000
      });

      const stale = agent.checkStalePending(500);
      expect(stale).toHaveLength(1);
      expect(stale[0].opportunityId).toBe('opp-1');
    });

    it('does not mark pending fills stale when maxAgeMs is negative and timestamp is now', () => {
      vi.useFakeTimers();
      try {
        const nowMs = 1_700_000_000_000;
        vi.setSystemTime(nowMs);
        const agent = new PortfolioAgent(1000);

        agent.expectFill({
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          expectedSize: 1,
          expectedPrice: 0.1,
          timestamp: nowMs
        });

        expect(agent.checkStalePending(-1)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records incidents on mismatch when tracker present', () => {
      const record = vi.fn<(incident: IncidentRecord) => void>();
      const incidentTracker: Pick<IncidentTracker, 'record'> = { record };
      const agent = new PortfolioAgent(1000, incidentTracker as unknown as IncidentTracker);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          marketId: 'market-1',
          side: 'BUY',
          size: 9,
          price: 0.5
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].reason).toBe('fill_mismatch');
      expect(record.mock.calls[0][0].marketId).toBe('market-1');
    });

    it('does not record incident when marketId missing', () => {
      const record = vi.fn<(incident: IncidentRecord) => void>();
      const incidentTracker: Pick<IncidentTracker, 'record'> = { record };
      const agent = new PortfolioAgent(1000, incidentTracker as unknown as IncidentTracker);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs
      });

      agent.applyFillWithReconciliation(
        {
          opportunityId: 'opp-1',
          tokenId: 'token-1',
          side: 'BUY',
          size: 9,
          price: 0.5
        },
        { sizeTolerance: 0, priceTolerance: 0 }
      );

      expect(record).toHaveBeenCalledTimes(0);
    });

    it('detects stale pending expected fills', () => {
      const agent = new PortfolioAgent(1000);
      const nowMs = Date.now();

      agent.expectFill({
        opportunityId: 'opp-1',
        tokenId: 'token-1',
        expectedSize: 10,
        expectedPrice: 0.5,
        timestamp: nowMs - 1000
      });

      const stale = agent.checkStalePending(500);
      expect(stale).toHaveLength(1);
      expect(stale[0].opportunityId).toBe('opp-1');
    });
  });

  describe('openInventoryAgeMs', () => {
    it('tracks age when inventory is open', () => {
      vi.useFakeTimers();
      try {
        const agent = new PortfolioAgent(1000);
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        agent.applyFill({
          tokenId: 'token-1',
          side: 'BUY',
          size: 1,
          price: 0.5
        });

        vi.setSystemTime(start + 5_000);
        const snapshot = agent.snapshot();
        expect(snapshot.openInventoryAgeMs).toBe(5_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not treat complete sets as open inventory', () => {
      vi.useFakeTimers();
      try {
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        const agent = new PortfolioAgent(1000);

        agent.applyFill({
          tokenId: 'yes-token',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.48
        });
        agent.applyFill({
          tokenId: 'no-token',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.49
        });

        vi.setSystemTime(start + 10_000);
        expect(agent.snapshot().openInventoryAgeMs).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats imbalanced sets as open inventory', () => {
      vi.useFakeTimers();
      try {
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        const agent = new PortfolioAgent(1000);

        agent.applyFill({
          tokenId: 'yes-token',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.48
        });
        agent.applyFill({
          tokenId: 'no-token',
          marketId: 'market-1',
          side: 'BUY',
          size: 9,
          price: 0.49
        });

        vi.setSystemTime(start + 10_000);
        expect(agent.snapshot().openInventoryAgeMs).toBe(10_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats opposite-sign positions as open inventory', () => {
      vi.useFakeTimers();
      try {
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        const agent = new PortfolioAgent(1000);

        agent.applyFill({
          tokenId: 'yes-token',
          marketId: 'market-1',
          side: 'BUY',
          size: 10,
          price: 0.48
        });
        agent.applyFill({
          tokenId: 'no-token',
          marketId: 'market-1',
          side: 'SELL',
          size: 10,
          price: 0.49
        });

        vi.setSystemTime(start + 10_000);
        expect(agent.snapshot().openInventoryAgeMs).toBe(10_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('applies token→market mapping when marketId is missing', () => {
      vi.useFakeTimers();
      try {
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        const agent = new PortfolioAgent(1000, undefined, {
          tokenToMarketId: { 'yes-token': 'market-1', 'no-token': 'market-1' }
        });

        agent.applyFill({
          tokenId: 'yes-token',
          side: 'BUY',
          size: 10,
          price: 0.48
        });
        agent.applyFill({
          tokenId: 'no-token',
          side: 'BUY',
          size: 10,
          price: 0.49
        });

        vi.setSystemTime(start + 10_000);
        expect(agent.snapshot().openInventoryAgeMs).toBe(0);
        expect(agent.snapshot().marketExposure['market-1']).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to now when position update timestamp is missing', () => {
      vi.useFakeTimers();
      try {
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        const agent = new PortfolioAgent(1000);

        agent.applyFill({
          tokenId: 'token-1',
          side: 'BUY',
          size: 1,
          price: 0.5
        });

        const internals = agent as unknown as {
          positionUpdatedAt: Map<string, number>;
        };
        internals.positionUpdatedAt.delete('token-1');

        vi.setSystemTime(start + 10_000);
        expect(agent.snapshot().openInventoryAgeMs).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('venue reconciliation', () => {
    it('returns ok when venue matches internal state', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);
      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 10,
        price: 0.5
      });

      const openOrders: VenueOpenOrder[] = [
        { orderId: 'order-1', marketId: 'market-1', tokenId: 'token-1', status: 'LIVE' }
      ];
      const internalOpenOrders = [{ orderId: 'order-1', marketId: 'market-1', tokenId: 'token-1' }];
      const positions: VenuePosition[] = [{ tokenId: 'token-1', marketId: 'market-1', size: 10, avgPrice: 0.5 }];

      const result = agent.reconcileWithVenue({
        openOrders,
        internalOpenOrders,
        positions,
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(incidents).toHaveLength(0);
    });

    it('accepts empty venue reconciliation input and uses default timestamps', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_700_000_000_000);
        const agent = new PortfolioAgent(1000);

        const result = agent.reconcileWithVenue({});

        expect(result.ok).toBe(true);
        expect(result.issues).toHaveLength(0);
        expect(result.checkedAtMs).toBe(1_700_000_000_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records incidents on open order drift', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [{ orderId: 'order-1', marketId: 'market-1', tokenId: 'token-1' }],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'missing_open_order')).toBe(true);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('market-1');
      expect(incidents[0].reason).toBe('recon_drift');
    });

    it('records incidents on position drift', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);
      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 10,
        price: 0.5
      });

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [{ tokenId: 'token-1', marketId: 'market-1', size: 8, avgPrice: 0.5 }],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'position_size_mismatch')).toBe(true);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('market-1');
      expect(incidents[0].reason).toBe('recon_drift');
    });

    it('flags missing positions when venue is missing an internal token', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);
      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 10,
        price: 0.5
      });

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'missing_position')).toBe(true);
      expect(incidents).toHaveLength(1);
    });

    it('flags extra open orders observed on venue', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);

      const result = agent.reconcileWithVenue({
        openOrders: [{ orderId: 'order-1', marketId: 'market-1', tokenId: 'token-1', status: 'LIVE' }],
        internalOpenOrders: [],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'extra_open_order')).toBe(true);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('market-1');
    });

    it('treats issues with unknown marketId as alert-only incidents', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);

      agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [{ orderId: 'order-1' }],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('unknown');
      expect(incidents[0].recoveryAction).toBe('alert_only');
    });

    it('ignores invalid venue entries without identifiers', () => {
      const agent = new PortfolioAgent(1000);

      const result = agent.reconcileWithVenue({
        openOrders: [{ orderId: '', marketId: 'market-1', tokenId: 'token-1', status: 'LIVE' }],
        internalOpenOrders: [{ orderId: '' }],
        positions: [{ tokenId: '', marketId: 'market-1', size: 1, avgPrice: 0.5 }],
        positionSizeTolerance: 0,
        nowMs: 1
      });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('respects position size tolerance', () => {
      const agent = new PortfolioAgent(1000);
      agent.applyFill({
        tokenId: 'token-1',
        marketId: 'market-1',
        side: 'BUY',
        size: 0.5,
        price: 0.5
      });

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [],
        positionSizeTolerance: 1,
        nowMs: 1
      });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('flags extra positions observed on venue', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [{ tokenId: 'token-1', marketId: 'market-1', size: 10, avgPrice: 0.5 }],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'extra_position')).toBe(true);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('market-1');
    });

    it('uses venue marketId when internal position marketId is missing', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);
      agent.applyFill({
        tokenId: 'token-1',
        side: 'BUY',
        size: 10,
        price: 0.5
      });

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [{ tokenId: 'token-1', marketId: 'market-1', size: 8, avgPrice: 0.5 }],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'position_size_mismatch')).toBe(true);
      expect(incidents[0].marketId).toBe('market-1');
    });

    it('ignores extra positions when size is within tolerance', () => {
      const agent = new PortfolioAgent(1000);

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [],
        positions: [{ tokenId: 'token-1', marketId: 'market-1', size: 0.5, avgPrice: 0.5 }],
        positionSizeTolerance: 1,
        nowMs: 123
      });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('treats whitespace market ids as unknown for drift incidents', () => {
      const incidents: IncidentRecord[] = [];
      const incidentTracker = {
        record: (incident: IncidentRecord) => incidents.push(incident)
      } as unknown as IncidentTracker;

      const agent = new PortfolioAgent(1000, incidentTracker);

      agent.reconcileWithVenue({
        openOrders: [{ orderId: 'order-1', marketId: '   ', tokenId: 'token-1', status: 'LIVE' }],
        internalOpenOrders: [],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(incidents).toHaveLength(1);
      expect(incidents[0].marketId).toBe('unknown');
      expect(incidents[0].recoveryAction).toBe('alert_only');
    });

    it('does not record incidents when incident tracker is missing', () => {
      const agent = new PortfolioAgent(1000);

      const result = agent.reconcileWithVenue({
        openOrders: [],
        internalOpenOrders: [{ orderId: 'order-1', marketId: 'market-1', tokenId: 'token-1' }],
        positions: [],
        positionSizeTolerance: 0,
        nowMs: 123
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.type === 'missing_open_order')).toBe(true);
    });
  });
});
