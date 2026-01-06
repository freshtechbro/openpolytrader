import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/schema.js', () => ({
  getConfigSection: () => undefined,
  assertSectionValues: () => {}
}));

import { validateP0Config } from '../../src/config/validate.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';

describe('validateP0Config schema guard', () => {
  it('throws when schema is unavailable', () => {
    expect(() => validateP0Config(DEFAULT_TRADE_POLICY, DEFAULT_RISK_CONFIG)).toThrow(
      /schema not loaded/
    );
  });
});
