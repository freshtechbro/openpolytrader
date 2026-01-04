import { describe, it, expect, beforeEach } from 'vitest';

import { PortfolioAgent, FillUpdate } from '../../src/agents/portfolio/PortfolioAgent.js';

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
});
