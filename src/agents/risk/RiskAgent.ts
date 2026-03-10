import { calculateMaxSizeByUnwindBudget, effectiveTradeFraction, type RiskConfig } from '../../config/risk.js';
import type { ArbitrageOpportunity } from '../../domain/opportunity.js';
import type { PortfolioSnapshot } from '../../domain/portfolio.js';
import type { RiskAdvisor } from './RiskAdvisor.js';

interface RiskDecision {
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
    maxByEvMarket: number;
    maxByEvPortfolio: number;
    maxByFwMarket: number;
    maxByFwPortfolio: number;
    binding:
      | 'trade_fraction'
      | 'depth'
      | 'unwind_budget'
      | 'daily_loss'
      | 'exposure'
      | 'ev_per_market'
      | 'ev_portfolio'
      | 'fw_per_market'
      | 'fw_portfolio';
  };
  worstCaseLoss?: number;
}

interface RiskAgentOptions {
  maxOpenInventorySeconds: number;
  fallbackTickSize: number;
  depthBufferMultiplier: number;
  evMaxPerMarketNotional: number;
  evMaxPortfolioNotional: number;
  fwMaxPerMarketNotional: number;
  fwMaxPortfolioNotional: number;
}

export class RiskAgent {
  private advisor?: RiskAdvisor;

  constructor(
    private config: RiskConfig,
    private options: RiskAgentOptions,
    deps?: { advisor?: RiskAdvisor }
  ) {
    this.advisor = deps?.advisor;
  }

  updateConfig(config: RiskConfig, options: RiskAgentOptions): void {
    this.config = config;
    this.options = options;
  }

  evaluate(opportunity: ArbitrageOpportunity, snapshot: PortfolioSnapshot): RiskDecision {
    const isFwBasket =
      opportunity.type === 'fw_basket' &&
      Array.isArray(opportunity.fwBasket?.markets) &&
      opportunity.fwBasket.markets.length > 0;
    const basketMarkets = isFwBasket ? opportunity.fwBasket!.markets : [];
    const costPerSet = isFwBasket
      ? basketMarkets.reduce((sum, market) => sum + market.costPerSet, 0)
      : opportunity.costPerSet;
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

    if (
      this.config.maxDailyDrawdownFraction > 0 &&
      snapshot.dailyPnL <= -this.config.maxDailyDrawdownFraction * snapshot.totalCapital
    ) {
      return { approved: false, reason: 'daily_drawdown_limit' };
    }

    const maxMarketExposure = snapshot.totalCapital * this.config.maxMarketExposureFraction;
    const exposureHeadroomByMarket = isFwBasket
      ? basketMarkets.map((market) => ({
          marketId: market.marketId,
          costPerSet: market.costPerSet,
          headroom: maxMarketExposure - (snapshot.marketExposure[market.marketId] ?? 0)
        }))
      : [
          {
            marketId: opportunity.marketId,
            costPerSet: costPerSet,
            headroom: maxMarketExposure - (snapshot.marketExposure[opportunity.marketId] ?? 0)
          }
        ];
    if (exposureHeadroomByMarket.some((entry) => entry.headroom <= 0)) {
      return { approved: false, reason: 'market_exposure_limit' };
    }

    const effectiveTickSize = opportunity.tickSize > 0 ? opportunity.tickSize : this.options.fallbackTickSize;
    const lossPerSet = isFwBasket
      ? basketMarkets.reduce(
          (sum, market) =>
            sum + Math.max(market.tickSize, this.options.fallbackTickSize) * this.config.maxUnwindLossTicks,
          0
        )
      : effectiveTickSize * this.config.maxUnwindLossTicks;
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
    const rawDepthLimit = isFwBasket
      ? Math.min(...basketMarkets.map((market) => market.maxSizeByDepth))
      : opportunity.maxSizeByDepth;
    const maxSizeByDepth =
      depthBufferMultiplier > 0
        ? rawDepthLimit / depthBufferMultiplier
        : rawDepthLimit;
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

    const maxSizeByExposure = Math.min(
      ...exposureHeadroomByMarket.map((entry) => entry.headroom / Math.max(entry.costPerSet, 1e-9))
    );

    const isEv = opportunity.type === 'ev';
    const isFw = opportunity.type === 'fw_projection' || opportunity.type === 'fw_basket';
    const totalExposureNotional = Object.values(snapshot.marketExposure).reduce(
      (sum, value) => sum + Math.max(0, value),
      0
    );
    const maxSizeByEvMarket =
      isEv && this.options.evMaxPerMarketNotional > 0
        ? this.options.evMaxPerMarketNotional / costPerSet
        : Number.POSITIVE_INFINITY;
    const maxSizeByEvPortfolio =
      isEv && this.options.evMaxPortfolioNotional > 0
        ? (this.options.evMaxPortfolioNotional - totalExposureNotional) / costPerSet
        : Number.POSITIVE_INFINITY;
    const maxSizeByFwMarket =
      isFw && this.options.fwMaxPerMarketNotional > 0
        ? isFwBasket
          ? Math.min(
              ...basketMarkets.map((market) => {
                const used = snapshot.marketExposure[market.marketId] ?? 0;
                return (this.options.fwMaxPerMarketNotional - used) / Math.max(market.costPerSet, 1e-9);
              })
            )
          : this.options.fwMaxPerMarketNotional / costPerSet
        : Number.POSITIVE_INFINITY;
    const maxSizeByFwPortfolio =
      isFw && this.options.fwMaxPortfolioNotional > 0
        ? (this.options.fwMaxPortfolioNotional - totalExposureNotional) / costPerSet
        : Number.POSITIVE_INFINITY;

    if (isEv && (maxSizeByEvMarket <= 0 || maxSizeByEvPortfolio <= 0)) {
      return { approved: false, reason: 'ev_notional_cap' };
    }
    if (isFw && (maxSizeByFwMarket <= 0 || maxSizeByFwPortfolio <= 0)) {
      return { approved: false, reason: 'fw_notional_cap' };
    }

    const hardCap = Math.min(
      maxSizeByDepth,
      maxSizeByUnwindBudget,
      maxSizeByDailyLoss,
      maxSizeByExposure,
      maxSizeByEvMarket,
      maxSizeByEvPortfolio,
      maxSizeByFwMarket,
      maxSizeByFwPortfolio
    );

    let positionSize = Math.min(maxSizeByTradeFraction, hardCap);

    if (positionSize <= 0) {
      return { approved: false, reason: 'position_size_zero' };
    }

    const minOrderSize = isFwBasket
      ? Math.max(...basketMarkets.map((market) => market.minOrderSize), 0)
      : Math.max(opportunity.minOrderSize, 0);
    let reason = 'within_risk_limits';

    if (minOrderSize > 0 && positionSize < minOrderSize) {
      if (minOrderSize <= hardCap) {
        positionSize = minOrderSize;
        reason = 'min_order_size_bump';
      } else {
        return { approved: false, reason: 'below_min_order_size' };
      }
    }

    const positionNotional = positionSize * costPerSet;
    const worstCaseLoss = positionSize * lossPerSet;

    const constraints = {
      maxByTradeFraction: maxSizeByTradeFraction,
      maxByDepth: maxSizeByDepth,
      maxByUnwindBudget: maxSizeByUnwindBudget,
      maxByDailyLoss: maxSizeByDailyLoss,
      maxByExposure: maxSizeByExposure,
      maxByEvMarket: maxSizeByEvMarket,
      maxByEvPortfolio: maxSizeByEvPortfolio,
      maxByFwMarket: maxSizeByFwMarket,
      maxByFwPortfolio: maxSizeByFwPortfolio,
      binding: pickBindingConstraint({
        tradeFraction: maxSizeByTradeFraction,
        depth: maxSizeByDepth,
        unwindBudget: maxSizeByUnwindBudget,
        dailyLoss: maxSizeByDailyLoss,
        exposure: maxSizeByExposure,
        evMarket: maxSizeByEvMarket,
        evPortfolio: maxSizeByEvPortfolio,
        fwMarket: maxSizeByFwMarket,
        fwPortfolio: maxSizeByFwPortfolio
      }, reason === 'min_order_size_bump')
    } satisfies RiskDecision['constraints'];

    return {
      approved: true,
      reason,
      positionSize,
      positionNotional,
      worstCaseLoss,
      constraints
    };
  }

  async evaluateWithAdvisor(
    opportunity: ArbitrageOpportunity,
    snapshot: PortfolioSnapshot
  ): Promise<RiskDecision> {
    const deterministic = this.evaluate(opportunity, snapshot);
    if (!deterministic.approved || !deterministic.positionSize) return deterministic;
    if (!this.advisor) return deterministic;

    const minSize = Math.max(opportunity.minOrderSize, 0);
    const deterministicSize = deterministic.positionSize;

    const recommendation = await this.advisor.recommendSize({
      opportunityId: opportunity.id,
      marketId: opportunity.marketId,
      minSize,
      deterministicSize,
      constraints: deterministic.constraints ?? {}
    });

    let adjustedSize = recommendation.clampedSize;
    if (!Number.isFinite(adjustedSize) || adjustedSize <= 0) {
      return deterministic;
    }

    const bumpedToMin = minSize > 0 && adjustedSize < minSize;
    if (bumpedToMin) {
      adjustedSize = minSize;
    }

    if (adjustedSize === deterministicSize) {
      return deterministic;
    }

    const positionNotional = adjustedSize * opportunity.costPerSet;
    const lossPerSet =
      deterministic.worstCaseLoss && deterministic.positionSize
        ? deterministic.worstCaseLoss / deterministic.positionSize
        : 0;
    const worstCaseLoss = adjustedSize * lossPerSet;

    return {
      ...deterministic,
      reason: bumpedToMin ? 'llm_min_order_size_bump' : `llm_${recommendation.reason}`,
      positionSize: adjustedSize,
      positionNotional,
      worstCaseLoss
    };
  }
}

function pickBindingConstraint(
  values: {
    tradeFraction: number;
    depth: number;
    unwindBudget: number;
    dailyLoss: number;
    exposure: number;
    evMarket: number;
    evPortfolio: number;
    fwMarket: number;
    fwPortfolio: number;
  },
  ignoreTradeFraction: boolean
): NonNullable<RiskDecision['constraints']>['binding'] {
  const candidates: Array<[NonNullable<RiskDecision['constraints']>['binding'], number]> = [
    ['depth', values.depth],
    ['unwind_budget', values.unwindBudget],
    ['daily_loss', values.dailyLoss],
    ['exposure', values.exposure],
    ['ev_per_market', values.evMarket],
    ['ev_portfolio', values.evPortfolio],
    ['fw_per_market', values.fwMarket],
    ['fw_portfolio', values.fwPortfolio]
  ];

  if (!ignoreTradeFraction) {
    candidates.push(['trade_fraction', values.tradeFraction]);
  }

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
