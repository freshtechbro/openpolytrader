import type { RiskConfig } from '../../config/risk.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { PortfolioSnapshot } from '../../domain/portfolio.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  positionSize?: number;
  positionNotional?: number;
}

export class RiskAgent {
  constructor(private config: RiskConfig) {}

  evaluate(opportunity: ArbitrageOpportunity, snapshot: PortfolioSnapshot): RiskDecision {
    const maxPositionNotional = snapshot.availableCapital * this.config.maxTradeFraction;
    const maxMarketExposure = snapshot.totalCapital * this.config.maxMarketExposureFraction;
    const currentExposure = snapshot.marketExposure[opportunity.marketId] ?? 0;
    const costPerSet = opportunity.costPerSet;
    const depthLimitedNotional = opportunity.maxSizeByDepth * costPerSet;
    const positionNotional = Math.min(maxPositionNotional, depthLimitedNotional);

    if (snapshot.dailyPnL <= -this.config.maxDailyDrawdownFraction * snapshot.totalCapital) {
      return { approved: false, reason: 'daily_drawdown_limit' };
    }

    if (currentExposure + positionNotional > maxMarketExposure) {
      return { approved: false, reason: 'market_exposure_limit' };
    }

    if (positionNotional <= 0) {
      return { approved: false, reason: 'position_size_zero' };
    }

    const positionSize = positionNotional / costPerSet;
    if (positionSize < opportunity.minOrderSize) {
      return { approved: false, reason: 'below_min_order_size' };
    }

    return {
      approved: true,
      reason: 'within_risk_limits',
      positionSize,
      positionNotional
    };
  }
}
