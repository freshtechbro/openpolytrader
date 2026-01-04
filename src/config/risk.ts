export interface RiskConfig {
  targetTradeFraction: number;
  maxTradeFraction: number;
  maxAttemptLossFraction: number;
  maxDailyDrawdownFraction: number;
  maxMarketExposureFraction: number;
  marketCooldownSeconds: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  targetTradeFraction: 0.1,
  maxTradeFraction: 0.1,
  maxAttemptLossFraction: 0.0025,
  maxDailyDrawdownFraction: 0.02,
  maxMarketExposureFraction: 0.5,
  marketCooldownSeconds: 600
};

export function effectiveTradeFraction(
  lossPerAttemptFraction: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  if (lossPerAttemptFraction <= 0) {
    return Math.min(config.targetTradeFraction, config.maxTradeFraction);
  }

  const bounded =
    config.maxAttemptLossFraction / Math.max(lossPerAttemptFraction, 1e-6);

  return Math.min(config.targetTradeFraction, config.maxTradeFraction, bounded);
}
