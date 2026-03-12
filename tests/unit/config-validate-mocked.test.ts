import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../../src/config/schema.js');
});

describe('validateP0Config custom guards', () => {
  it('rejects negative fwSelectionTopK after schema-level validation succeeds', async () => {
    vi.doMock('../../src/config/schema.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/schema.js')>(
        '../../src/config/schema.js'
      );
      return {
        ...actual,
        getConfigSection: vi.fn().mockReturnValue({ fields: [] }),
        assertSectionValues: vi.fn()
      };
    });

    const { validateP0Config } = await import('../../src/config/validate.js');
    const { DEFAULT_TRADE_POLICY } = await import('../../src/config/policy.js');
    const { DEFAULT_RISK_CONFIG } = await import('../../src/config/risk.js');

    expect(() =>
      validateP0Config(
        {
          ...DEFAULT_TRADE_POLICY,
          fwSelectionTopK: -1
        },
        DEFAULT_RISK_CONFIG
      )
    ).toThrow(/fwSelectionTopK/);
  });

  it('accepts fw per-market notional when it stays within the portfolio cap after schema validation', async () => {
    vi.doMock('../../src/config/schema.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/schema.js')>(
        '../../src/config/schema.js'
      );
      return {
        ...actual,
        getConfigSection: vi.fn().mockReturnValue({ fields: [] }),
        assertSectionValues: vi.fn()
      };
    });

    const { validateP0Config } = await import('../../src/config/validate.js');
    const { DEFAULT_TRADE_POLICY } = await import('../../src/config/policy.js');
    const { DEFAULT_RISK_CONFIG } = await import('../../src/config/risk.js');

    expect(() =>
      validateP0Config(
        {
          ...DEFAULT_TRADE_POLICY,
          fwMaxPerMarketNotional: 100,
          fwMaxPortfolioNotional: 500
        },
        DEFAULT_RISK_CONFIG
      )
    ).not.toThrow();
  });

  it('skips fw per-market notional validation when the per-market cap is disabled', async () => {
    vi.doMock('../../src/config/schema.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/schema.js')>(
        '../../src/config/schema.js'
      );
      return {
        ...actual,
        getConfigSection: vi.fn().mockReturnValue({ fields: [] }),
        assertSectionValues: vi.fn()
      };
    });

    const { validateP0Config } = await import('../../src/config/validate.js');
    const { DEFAULT_TRADE_POLICY } = await import('../../src/config/policy.js');
    const { DEFAULT_RISK_CONFIG } = await import('../../src/config/risk.js');

    expect(() =>
      validateP0Config(
        {
          ...DEFAULT_TRADE_POLICY,
          fwMaxPerMarketNotional: 0,
          fwMaxPortfolioNotional: 500
        },
        DEFAULT_RISK_CONFIG
      )
    ).not.toThrow();
  });
});
