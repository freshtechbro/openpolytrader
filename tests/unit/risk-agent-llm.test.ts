import { describe, expect, it } from 'vitest';

import { RiskAgent } from '../../src/agents/risk/RiskAgent.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { RiskAdvisor, RiskAdvisorResult } from '../../src/agents/risk/RiskAdvisor.js';

const DEFAULT_OPTIONS = {
  fallbackTickSize: DEFAULT_TRADE_POLICY.fallbackTickSize,
  maxOpenInventorySeconds: DEFAULT_TRADE_POLICY.maxOpenInventorySeconds,
  depthBufferMultiplier: DEFAULT_TRADE_POLICY.depthBufferMultiplier
};

const baseOpportunity: ArbitrageOpportunity = {
  id: 'op-1',
  marketId: 'm1',
  yesTokenId: 'yes',
  noTokenId: 'no',
  yesPrice: 0.48,
  noPrice: 0.49,
  costPerSet: 0.97,
  edge: 0.03,
  tickSize: 0.01,
  maxSizeByDepth: 100,
  minOrderSize: 1,
  detectedAt: Date.now(),
  gateReasons: [],
  pair: { marketId: 'm1', yesTokenId: 'yes', noTokenId: 'no' }
};

describe('RiskAgent LLM sizing advisor', () => {
  it('applies conservative sizing in advisory mode', async () => {
    const baselineAgent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const baseline = baselineAgent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });
    expect(baseline.approved).toBe(true);
    expect(baseline.positionSize).toBeDefined();

    const advisor: Pick<RiskAdvisor, 'recommendSize'> = {
      recommendSize: async (): Promise<RiskAdvisorResult> => ({
        recommendedSizeRaw: 10,
        clampedSize: Math.max((baseline.positionSize ?? 0) / 2, baseOpportunity.minOrderSize),
        confidence: 0.9,
        reason: 'reduced',
        call: null
      })
    };

    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS, { advisor });
    const decision = await agent.evaluateWithAdvisor(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.positionSize).toBeLessThanOrEqual(baseline.positionSize ?? 0);
  });
});
