import { describe, it, expect } from 'vitest';

import {
  DEFAULT_RISK_CONFIG,
  calculateMaxSizeByUnwindBudget,
  effectiveTradeFraction
} from '../../src/config/risk.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';

const FALLBACK_TICK_SIZE = DEFAULT_TRADE_POLICY.fallbackTickSize;

describe('calculateMaxSizeByUnwindBudget', () => {
  it('caps size using unwind budget and tick loss', () => {
    const maxSize = calculateMaxSizeByUnwindBudget(
      0.03,
      0.01,
      1000,
      DEFAULT_RISK_CONFIG,
      FALLBACK_TICK_SIZE
    );

    expect(maxSize).toBeCloseTo(1250);
  });

  it('returns zero when unwind budget is zero', () => {
    const config = {
      ...DEFAULT_RISK_CONFIG,
      maxUnwindLossFraction: 0,
      maxPerTradeLossDollars: 0
    };

    const maxSize = calculateMaxSizeByUnwindBudget(0.03, 0.01, 1000, config, FALLBACK_TICK_SIZE);

    expect(maxSize).toBe(0);
  });

  it('uses finite fallback when tick size is zero', () => {
    const maxSize = calculateMaxSizeByUnwindBudget(
      0.03,
      0,
      1000,
      DEFAULT_RISK_CONFIG,
      FALLBACK_TICK_SIZE
    );

    expect(maxSize).toBeCloseTo(1250);
  });

  it('returns zero when tick size is unavailable and fallback is zero', () => {
    const maxSize = calculateMaxSizeByUnwindBudget(0.03, 0, 1000, DEFAULT_RISK_CONFIG, 0);

    expect(maxSize).toBe(0);
  });
});

describe('effectiveTradeFraction', () => {
  it('returns target fraction when loss per attempt is zero', () => {
    const fraction = effectiveTradeFraction(0, DEFAULT_RISK_CONFIG);
    expect(fraction).toBe(DEFAULT_RISK_CONFIG.targetTradeFraction);
  });

  it('caps fraction based on loss per attempt', () => {
    const fraction = effectiveTradeFraction(0.05, DEFAULT_RISK_CONFIG);
    expect(fraction).toBeLessThanOrEqual(DEFAULT_RISK_CONFIG.maxTradeFraction);
  });
});
