import { describe, it, expect } from 'vitest';

import { RiskAgent } from '../../src/agents/risk/RiskAgent.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';

const DEFAULT_OPTIONS = {
  fallbackTickSize: DEFAULT_TRADE_POLICY.fallbackTickSize,
  maxOpenInventorySeconds: DEFAULT_TRADE_POLICY.maxOpenInventorySeconds,
  depthBufferMultiplier: DEFAULT_TRADE_POLICY.depthBufferMultiplier,
  evMaxPerMarketNotional: DEFAULT_TRADE_POLICY.evMaxPerMarketNotional,
  evMaxPortfolioNotional: DEFAULT_TRADE_POLICY.evMaxPortfolioNotional,
  fwMaxPerMarketNotional: DEFAULT_TRADE_POLICY.fwMaxPerMarketNotional,
  fwMaxPortfolioNotional: DEFAULT_TRADE_POLICY.fwMaxPortfolioNotional
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

describe('RiskAgent', () => {
  it('approves opportunities within limits', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
    expect(decision.positionSize).toBeGreaterThan(0);
    expect(decision.worstCaseLoss).toBeDefined();
    expect(decision.constraints?.binding).toBe('depth');
  });

  it('caps depth sizing by depthBufferMultiplier', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      depthBufferMultiplier: 2
    });

    const decision = agent.evaluate(
      { ...baseOpportunity, maxSizeByDepth: 10, minOrderSize: 0.001 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('depth');
    expect(decision.constraints?.maxByDepth).toBeCloseTo(5);
    expect(decision.positionSize).toBeCloseTo(5);
  });

  it('rejects opportunities with invalid cost per set', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const decision = agent.evaluate(
      { ...baseOpportunity, costPerSet: 0 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('invalid_cost_per_set');
  });

  it('rejects opportunities when unwind loss cannot be bounded', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      fallbackTickSize: 0
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, tickSize: 0 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('unwind_loss_unbounded');
  });

  it('records unwind budget as binding constraint', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        maxPerTradeLossDollars: 1
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate({ ...baseOpportunity, maxSizeByDepth: 1000 }, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('unwind_budget');
    expect(decision.worstCaseLoss).toBeCloseTo(1);
  });

  it('records daily loss as binding constraint', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimitFraction: 0.0005
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate({ ...baseOpportunity, maxSizeByDepth: 1000 }, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('daily_loss');
    expect(decision.worstCaseLoss).toBeCloseTo(0.5);
  });

  it('records exposure as binding constraint', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const decision = agent.evaluate({ ...baseOpportunity, maxSizeByDepth: 1000 }, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: { m1: 490 }
    });

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('exposure');
  });

  it('records EV per-market cap as binding constraint', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      evMaxPerMarketNotional: 10,
      evMaxPortfolioNotional: 1000
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'ev', side: 'yes', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('ev_per_market');
    expect(decision.constraints?.maxByEvMarket).toBeCloseTo(10);
  });

  it('records EV portfolio cap as binding constraint', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      evMaxPerMarketNotional: 1000,
      evMaxPortfolioNotional: 20
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'ev', side: 'yes', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: { m1: 15 }
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('ev_portfolio');
    expect(decision.constraints?.maxByEvPortfolio).toBeCloseTo(5);
  });

  it('rejects EV when portfolio notional cap is exhausted', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      evMaxPerMarketNotional: 1000,
      evMaxPortfolioNotional: 10
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'ev', side: 'yes', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: { m1: 15 }
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('ev_notional_cap');
  });

  it('records FW per-market cap as binding constraint', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      fwMaxPerMarketNotional: 8,
      fwMaxPortfolioNotional: 1000
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'fw_projection', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('fw_per_market');
    expect(decision.constraints?.maxByFwMarket).toBeCloseTo(8);
  });

  it('records FW portfolio cap as binding constraint', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      fwMaxPerMarketNotional: 1000,
      fwMaxPortfolioNotional: 25
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'fw_projection', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: { m1: 20 }
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('fw_portfolio');
    expect(decision.constraints?.maxByFwPortfolio).toBeCloseTo(5);
  });

  it('rejects FW when portfolio notional cap is exhausted', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      fwMaxPerMarketNotional: 1000,
      fwMaxPortfolioNotional: 10
    });
    const decision = agent.evaluate(
      { ...baseOpportunity, type: 'fw_projection', costPerSet: 1, maxSizeByDepth: 1000 },
      {
        totalCapital: 10000,
        availableCapital: 10000,
        dailyPnL: 0,
        marketExposure: { m1: 15 }
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('fw_notional_cap');
  });

  it('updates config and options via updateConfig', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    agent.updateConfig(
      { ...DEFAULT_RISK_CONFIG, dailyLossLimitFraction: 0.001 },
      { ...DEFAULT_OPTIONS, maxOpenInventorySeconds: 1 }
    );

    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: -2,
      marketExposure: {}
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('daily_loss_limit');
  });

  it('rejects when daily drawdown exceeds limit', () => {
    const agent = new RiskAgent(
      { ...DEFAULT_RISK_CONFIG, dailyLossLimitFraction: 0 },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: -30,
      marketExposure: {}
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('daily_drawdown_limit');
  });

  it('ignores drawdown when disabled', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        maxDailyDrawdownFraction: 0,
        dailyLossLimitFraction: 0
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: -30,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
  });

  it('rejects when daily loss limit exceeds threshold', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimitFraction: 0.01
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: -20,
      marketExposure: {}
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('daily_loss_limit');
  });

  it('rejects when open inventory exceeds timeout', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      maxOpenInventorySeconds: 1
    });
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {},
      openInventoryAgeMs: 2000
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('open_inventory_timeout');
  });

  it('rejects when market exposure exceeds limit', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: { m1: 1000 }
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('market_exposure_limit');
  });

  it('rejects when position size is zero', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimitFraction: 0
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate(baseOpportunity, {
      totalCapital: 1000,
      availableCapital: 0,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('position_size_zero');
  });

  it('uses capital sizing when daily loss limit is disabled', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimitFraction: 0
      },
      DEFAULT_OPTIONS
    );
    const decision = agent.evaluate({ ...baseOpportunity, maxSizeByDepth: 1000 }, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: {}
    });

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.maxByDailyLoss).toBeCloseTo(1000 / baseOpportunity.costPerSet);
  });

  it('rejects when below minimum order size', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const decision = agent.evaluate(
      { ...baseOpportunity, minOrderSize: 1000 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('below_min_order_size');
  });

  it('bumps to minimum order size when trade fraction is the only limiter', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        targetTradeFraction: 0.005,
        maxTradeFraction: 0.005
      },
      DEFAULT_OPTIONS
    );

    const decision = agent.evaluate(
      { ...baseOpportunity, minOrderSize: 10, maxSizeByDepth: 1000 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('min_order_size_bump');
    expect(decision.positionSize).toBeCloseTo(10);
    expect(decision.constraints?.binding).toBe('exposure');
  });

  it('rejects when unwind loss fraction exceeds bps tolerance', () => {
    const agent = new RiskAgent(
      {
        ...DEFAULT_RISK_CONFIG,
        unwindSlippageToleranceBps: 300
      },
      DEFAULT_OPTIONS
    );

    const decision = agent.evaluate(
      { ...baseOpportunity, tickSize: 0.02 },
      {
        totalCapital: 1000,
        availableCapital: 1000,
        dailyPnL: 0,
        marketExposure: {}
      }
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('unwind_loss_bps_exceeded');
  });

  it('sizes FW basket opportunities across per-market FW caps', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, {
      ...DEFAULT_OPTIONS,
      fwMaxPerMarketNotional: 20,
      fwMaxPortfolioNotional: 1000
    });
    const basketOpportunity: ArbitrageOpportunity = {
      ...baseOpportunity,
      id: 'fw-basket-1',
      type: 'fw_basket',
      edge: 0.05,
      fwBasket: {
        basketId: 'basket-1',
        executionMode: 'sequential_failfast',
        aggregateEdgeLowerBound: 0.05,
        aggregateProjectedEdge: 0.06,
        loop: {
          loopId: 'loop-1',
          iterationCount: 3,
          activeSetSize: 2,
          contractionSteps: 0,
          terminalGapAbs: 0.0001,
          terminalGapRel: 0.0001,
          terminalReason: 'gap_converged',
          converged: true,
          runtimeMs: 10
        },
        markets: [
          {
            marketId: 'm1',
            yesTokenId: 'yes',
            noTokenId: 'no',
            yesPrice: 0.48,
            noPrice: 0.49,
            costPerSet: 0.97,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          },
          {
            marketId: 'm2',
            yesTokenId: 'yes-2',
            noTokenId: 'no-2',
            yesPrice: 0.47,
            noPrice: 0.49,
            costPerSet: 0.96,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          }
        ]
      }
    };

    const decision = agent.evaluate(basketOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: { m1: 0, m2: 15 }
    });

    expect(decision.approved).toBe(true);
    expect(decision.constraints?.binding).toBe('fw_per_market');
  });

  it('rejects FW basket when any market exposure is exhausted', () => {
    const agent = new RiskAgent(DEFAULT_RISK_CONFIG, DEFAULT_OPTIONS);
    const basketOpportunity: ArbitrageOpportunity = {
      ...baseOpportunity,
      id: 'fw-basket-2',
      type: 'fw_basket',
      edge: 0.04,
      fwBasket: {
        basketId: 'basket-2',
        executionMode: 'sequential_failfast',
        aggregateEdgeLowerBound: 0.04,
        aggregateProjectedEdge: 0.05,
        loop: {
          loopId: 'loop-2',
          iterationCount: 2,
          activeSetSize: 2,
          contractionSteps: 0,
          terminalGapAbs: 0.0001,
          terminalGapRel: 0.0001,
          terminalReason: 'gap_converged',
          converged: true,
          runtimeMs: 8
        },
        markets: [
          {
            marketId: 'm1',
            yesTokenId: 'yes',
            noTokenId: 'no',
            yesPrice: 0.48,
            noPrice: 0.49,
            costPerSet: 0.97,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          },
          {
            marketId: 'm2',
            yesTokenId: 'yes-2',
            noTokenId: 'no-2',
            yesPrice: 0.48,
            noPrice: 0.49,
            costPerSet: 0.97,
            projectedEdge: 0.03,
            edgeLowerBound: 0.02,
            maxSizeByDepth: 100,
            minOrderSize: 1,
            tickSize: 0.01
          }
        ]
      }
    };

    const decision = agent.evaluate(basketOpportunity, {
      totalCapital: 1000,
      availableCapital: 1000,
      dailyPnL: 0,
      marketExposure: { m1: 600, m2: 0 }
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('market_exposure_limit');
  });
});
