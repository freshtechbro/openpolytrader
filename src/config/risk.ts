export interface RiskConfig {
  targetTradeFraction: number;
  maxTradeFraction: number;
  maxAttemptLossFraction: number;
  maxDailyDrawdownFraction: number;
  maxMarketExposureFraction: number;
  marketCooldownSeconds: number;
  marketCircuitFailureThreshold: number;
  marketCircuitHalfOpenSuccesses: number;
  maxUnwindLossFraction: number;
  maxUnwindLossTicks: number;
  unwindSlippageToleranceBps: number;
  maxPerTradeLossDollars: number;
  dailyLossLimitFraction: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  targetTradeFraction: 0.1,
  maxTradeFraction: 0.1,
  maxAttemptLossFraction: 0.0025,
  maxDailyDrawdownFraction: 0.02,
  maxMarketExposureFraction: 0.5,
  marketCooldownSeconds: 600,
  marketCircuitFailureThreshold: 3,
  marketCircuitHalfOpenSuccesses: 1,
  maxUnwindLossFraction: 0.025,
  maxUnwindLossTicks: 2,
  unwindSlippageToleranceBps: 500,
  maxPerTradeLossDollars: 25,
  dailyLossLimitFraction: 0.03
};

export function effectiveTradeFraction(
  lossPerAttemptFraction: number,
  config: RiskConfig
): number {
  if (lossPerAttemptFraction <= 0) {
    return Math.min(config.targetTradeFraction, config.maxTradeFraction);
  }

  const bounded =
    config.maxAttemptLossFraction / Math.max(lossPerAttemptFraction, 1e-6);

  return Math.min(config.targetTradeFraction, config.maxTradeFraction, bounded);
}

export function calculateMaxSizeByUnwindBudget(
  _edge: number,
  tickSize: number,
  availableCapital: number,
  config: RiskConfig,
  fallbackTickSize: number
): number {
  const maxLossNotional = Math.min(
    availableCapital * config.maxUnwindLossFraction,
    config.maxPerTradeLossDollars
  );

  if (maxLossNotional <= 0) return 0;

  const effectiveTickSize = tickSize > 0 ? tickSize : fallbackTickSize;
  const lossPerSet = effectiveTickSize * config.maxUnwindLossTicks;
  if (lossPerSet <= 0) return 0;

  return maxLossNotional / lossPerSet;
}
