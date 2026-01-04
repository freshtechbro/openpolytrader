import { describe, it, expect } from 'vitest';

import { RiskAgent } from '../../src/agents/risk/RiskAgent.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';

const baseOpportunity: ArbitrageOpportunity = {
  id: 'op-1',
  marketId: 'm1',
  yesTokenId: 'yes',
  noTokenId: 'no',
  yesPrice: 0.48,
  noPrice: 0.49,
  costPerSet: 0.97,
  edge: 0.03,
  maxSizeByDepth: 100,
  minOrderSize: 1,
  detectedAt: Date.now(),
  gateReasons: [],
  pair: { marketId: 'm1', yesTokenId: 'yes', noTokenId: 'no' }
};

describe('RiskAgent', () => {
  it('approves opportunities within limits', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG);
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
    expect(decision.positionSize).toBeGreaterThan(0);
  });

  it('rejects when daily drawdown exceeds limit', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG);
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: -30,
      marketExposure: {}
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('daily_drawdown_limit');
  });
});
