import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { IncidentTracker } from '../../src/services/IncidentTracker.js';

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  const base = {
    id: 'opp-test-1',
    marketId: 'market-1',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesPrice: 0.48,
    noPrice: 0.49,
    costPerSet: 0.97,
    edge: 0.03,
    maxSizeByDepth: 1000,
    minOrderSize: 0.001,
    detectedAt: Date.now(),
    gateReasons: [],
    pair: { conditionId: 'cond-1', yesTokenId: 'yes-token', noTokenId: 'no-token' }
  };
  return { ...base, ...overrides } as ArbitrageOpportunity;
}

function makeMockClob(responses: { yes: unknown; no: unknown }): PolymarketClob {
  let callCount = 0;
  return {
    createOrder: vi.fn().mockImplementation(() => {
      const response = callCount === 0 ? responses.yes : responses.no;
      callCount++;
      return Promise.resolve(response);
    })
  } as unknown as PolymarketClob;
}

function makeMockIncidentTracker(): IncidentTracker {
  return {
    record: vi.fn()
  } as unknown as IncidentTracker;
}

describe('ExecutionAgent', () => {
  describe('kill-switch (tradingEnabled)', () => {
    it('blocks execution when tradingEnabled is false', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: false
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('trading_disabled');
      expect(clob.createOrder).not.toHaveBeenCalled();
    });

    it('allows execution when tradingEnabled is true', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: true
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(clob.createOrder).toHaveBeenCalledTimes(2);
    });

    it('defaults to tradingEnabled=false when config not provided', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob);

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('trading_disabled');
    });

    it('isTradingEnabled returns correct state', () => {
      const clob = makeMockClob({ yes: {}, no: {} });

      const enabledAgent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: true
      });
      const disabledAgent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: false
      });

      expect(enabledAgent.isTradingEnabled()).toBe(true);
      expect(disabledAgent.isTradingEnabled()).toBe(false);
    });
  });

  describe('order execution', () => {
    it('returns submitted status on successful FOK orders', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: true
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('submitted');
      expect(result.yesOrder).toBeDefined();
      expect(result.noOrder).toBeDefined();
      expect(result.idempotencyKey).toBeDefined();
    });

    it('records incident and returns failed on delayed orders', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'DELAYED' },
        no: { orderId: 'no-order-1', status: 'LIVE' }
      });
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, {
        tradingEnabled: true
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_delayed');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_delayed' })
      );
    });

    it('records incident and returns failed on rejected orders', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'yes-order-1', status: 'LIVE' },
        no: { errorMsg: 'Insufficient balance', success: false }
      });
      const incidentTracker = makeMockIncidentTracker();

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, incidentTracker, {
        tradingEnabled: true
      });

      const result = await agent.executeArbitrage(makeOpportunity(), 100);

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('order_rejected');
      expect(incidentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_rejected' })
      );
    });
  });

  describe('idempotency', () => {
    it('generates consistent idempotency key for same opportunity', async () => {
      const clob = makeMockClob({
        yes: { orderId: 'o1', status: 'LIVE' },
        no: { orderId: 'o2', status: 'LIVE' }
      });

      const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, {
        tradingEnabled: true
      });

      const opp = makeOpportunity({ detectedAt: 1000 });
      const result1 = await agent.executeArbitrage(opp, 100);
      const result2 = await agent.executeArbitrage(opp, 100);

      expect(result1.idempotencyKey).toBe(result2.idempotencyKey);
    });
  });
});
