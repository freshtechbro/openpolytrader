import { calculateMaxSizeByUnwindBudget, effectiveTradeFraction, type RiskConfig } from '../../config/risk.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { PortfolioSnapshot } from '../../domain/portfolio.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  positionSize?: number;
  positionNotional?: number;
  constraints?: {
    maxByTradeFraction: number;
    maxByDepth: number;
    maxByUnwindBudget: number;
    maxByDailyLoss: number;
    maxByExposure: number;
    binding: 'trade_fraction' | 'depth' | 'unwind_budget' | 'daily_loss' | 'exposure';
  };
  worstCaseLoss?: number;
}

export interface RiskAgentOptions {
  maxOpenInventorySeconds: number;
  fallbackTickSize: number;
  depthBufferMultiplier: number;
}

export class RiskAgent {
  constructor(
    private config: RiskConfig,
    private options: RiskAgentOptions
  ) {}

  evaluate(opportunity: ArbitrageOpportunity, snapshot: PortfolioSnapshot): RiskDecision {
    const costPerSet = opportunity.costPerSet;
    const openInventoryAgeMs = snapshot.openInventoryAgeMs ?? 0;
    const maxOpenInventoryMs = this.options.maxOpenInventorySeconds * 1000;

    if (costPerSet <= 0) {
      return { approved: false, reason: 'invalid_cost_per_set' };
    }

    if (maxOpenInventoryMs > 0 && openInventoryAgeMs > maxOpenInventoryMs) {
      return { approved: false, reason: 'open_inventory_timeout' };
    }

    if (
      this.config.dailyLossLimitFraction > 0 &&
      snapshot.dailyPnL <= -this.config.dailyLossLimitFraction * snapshot.totalCapital
    ) {
      return { approved: false, reason: 'daily_loss_limit' };
    }

    if (snapshot.dailyPnL <= -this.config.maxDailyDrawdownFraction * snapshot.totalCapital) {
      return { approved: false, reason: 'daily_drawdown_limit' };
    }

    const maxMarketExposure = snapshot.totalCapital * this.config.maxMarketExposureFraction;
    const currentExposure = snapshot.marketExposure[opportunity.marketId] ?? 0;
    const exposureHeadroomNotional = maxMarketExposure - currentExposure;
    if (exposureHeadroomNotional <= 0) {
      return { approved: false, reason: 'market_exposure_limit' };
    }

    const effectiveTickSize = opportunity.tickSize > 0 ? opportunity.tickSize : this.options.fallbackTickSize;
    const lossPerSet = effectiveTickSize * this.config.maxUnwindLossTicks;
    if (lossPerSet <= 0) {
      return { approved: false, reason: 'unwind_loss_unbounded' };
    }

    const lossPerAttemptFraction = (effectiveTickSize * this.config.maxUnwindLossTicks) / costPerSet;
    const maxLossFractionByBps = Math.max(this.config.unwindSlippageToleranceBps, 0) / 10000;
    if (maxLossFractionByBps > 0 && lossPerAttemptFraction > maxLossFractionByBps) {
      return { approved: false, reason: 'unwind_loss_bps_exceeded' };
    }
    const targetFraction = effectiveTradeFraction(lossPerAttemptFraction, this.config);
    const maxSizeByTradeFraction =
      snapshot.availableCapital > 0 ? (snapshot.availableCapital * targetFraction) / costPerSet : 0;
    const depthBufferMultiplier = this.options.depthBufferMultiplier;
    const maxSizeByDepth =
      depthBufferMultiplier > 0
        ? opportunity.maxSizeByDepth / depthBufferMultiplier
        : opportunity.maxSizeByDepth;
    const maxSizeByUnwindBudget = calculateMaxSizeByUnwindBudget(
      opportunity.edge,
      opportunity.tickSize,
      snapshot.availableCapital,
      this.config,
      this.options.fallbackTickSize
    );

    const maxSizeByDailyLoss =
      this.config.dailyLossLimitFraction > 0
        ? (this.config.dailyLossLimitFraction * snapshot.totalCapital + snapshot.dailyPnL) / lossPerSet
        : snapshot.availableCapital > 0
          ? snapshot.availableCapital / costPerSet
          : 0;

    const maxSizeByExposure = exposureHeadroomNotional / costPerSet;

    const positionSize = Math.min(
      maxSizeByTradeFraction,
      maxSizeByDepth,
      maxSizeByUnwindBudget,
      maxSizeByDailyLoss,
      maxSizeByExposure
    );

    if (positionSize <= 0) {
      return { approved: false, reason: 'position_size_zero' };
    }

    const positionNotional = positionSize * costPerSet;
    const worstCaseLoss = positionSize * lossPerSet;

    if (positionSize < opportunity.minOrderSize) {
      return { approved: false, reason: 'below_min_order_size' };
    }

    const constraints = {
      maxByTradeFraction: maxSizeByTradeFraction,
      maxByDepth: maxSizeByDepth,
      maxByUnwindBudget: maxSizeByUnwindBudget,
      maxByDailyLoss: maxSizeByDailyLoss,
      maxByExposure: maxSizeByExposure,
      binding: pickBindingConstraint({
        tradeFraction: maxSizeByTradeFraction,
        depth: maxSizeByDepth,
        unwindBudget: maxSizeByUnwindBudget,
        dailyLoss: maxSizeByDailyLoss,
        exposure: maxSizeByExposure
      })
    } satisfies RiskDecision['constraints'];

    return {
      approved: true,
      reason: 'within_risk_limits',
      positionSize,
      positionNotional,
      worstCaseLoss,
      constraints
    };
  }
}

function pickBindingConstraint(values: {
  tradeFraction: number;
  depth: number;
  unwindBudget: number;
  dailyLoss: number;
  exposure: number;
}): NonNullable<RiskDecision['constraints']>['binding'] {
  const candidates: Array<[NonNullable<RiskDecision['constraints']>['binding'], number]> = [
    ['trade_fraction', values.tradeFraction],
    ['depth', values.depth],
    ['unwind_budget', values.unwindBudget],
    ['daily_loss', values.dailyLoss],
    ['exposure', values.exposure]
  ];

  let binding: NonNullable<RiskDecision['constraints']>['binding'] = 'trade_fraction';
  let minValue = Number.POSITIVE_INFINITY;

  for (const [name, value] of candidates) {
    if (value < minValue) {
      minValue = value;
      binding = name;
    }
  }

  return binding;
}
