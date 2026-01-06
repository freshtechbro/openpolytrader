import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { DEFAULT_TRADE_POLICY, isNearZeroRiskMode } from '../../src/config/policy.js';
import { ConfigStore } from '../../src/config/store.js';
import { validateP0Config } from '../../src/config/validate.js';
import {
  CONFIG_SCHEMA,
  assertSectionValues,
  buildUpdateSchema,
  getConfigSection,
  type ConfigSection
} from '../../src/config/schema.js';
import { MARKET_PAIRS } from '../../src/config/markets.js';
import { venueFlags } from '../../src/config/venues.js';

describe('config env + store', () => {
  it('loads default env values', () => {
    const env = loadEnv({});

    expect(env.TRADING_ENABLED).toBe(false);
    expect(env.TRADING_MODE).toBe('off');
    expect(env.ALLOWLIST_AUTO_RESUME).toBe(true);
  });

  it('requires keys for live trading', () => {
    expect(() =>
      loadEnv({ TRADING_ENABLED: 'true', TRADING_MODE: 'live' })
    ).toThrow(/Missing required env vars/);
  });

  it('accepts live trading when keys are present', () => {
    const env = loadEnv({
      TRADING_ENABLED: 'true',
      TRADING_MODE: 'live',
      ALCHEMY_API_KEY: 'alchemy',
      POLYMARKET_API_KEY: 'key',
      POLYMARKET_API_SECRET: 'secret',
      POLYMARKET_PASSPHRASE: 'phrase',
      POLYMARKET_POSITIONS_USER: '0xabc'
    });

    expect(env.TRADING_ENABLED).toBe(true);
    expect(env.TRADING_MODE).toBe('live');
  });

  it('rejects alchemy URLs that already include the API key', () => {
    expect(() =>
      loadEnv({
        TRADING_ENABLED: 'true',
        TRADING_MODE: 'live',
        ALCHEMY_API_KEY: 'key123',
        ALCHEMY_RPC_URL: 'https://polygon-mainnet.g.alchemy.com/v2/key123',
        POLYMARKET_API_KEY: 'key',
        POLYMARKET_API_SECRET: 'secret',
        POLYMARKET_PASSPHRASE: 'phrase',
        POLYMARKET_POSITIONS_USER: '0xabc'
      })
    ).toThrow(/ALCHEMY_RPC_URL must be the base URL/);
  });

  it('rejects alchemy websocket URLs that already include the API key', () => {
    expect(() =>
      loadEnv({
        TRADING_ENABLED: 'true',
        TRADING_MODE: 'live',
        ALCHEMY_API_KEY: 'key123',
        ALCHEMY_WS_URL: 'wss://polygon-mainnet.g.alchemy.com/v2/key123',
        POLYMARKET_API_KEY: 'key',
        POLYMARKET_API_SECRET: 'secret',
        POLYMARKET_PASSPHRASE: 'phrase',
        POLYMARKET_POSITIONS_USER: '0xabc'
      })
    ).toThrow(/ALCHEMY_WS_URL must be the base URL/);
  });

  it('surfaces schema validation errors', () => {
    expect(() => loadEnv({ TRADING_MODE: 'invalid' })).toThrow(
      /Invalid environment configuration/
    );
  });

  it('updates config store with validation', () => {
    const store = new ConfigStore(
      { ...DEFAULT_TRADE_POLICY },
      { ...DEFAULT_RISK_CONFIG }
    );

    expect(store.getPolicy().edgeRequired).toBe(DEFAULT_TRADE_POLICY.edgeRequired);
    expect(store.getRisk().maxTradeFraction).toBe(DEFAULT_RISK_CONFIG.maxTradeFraction);

    const updated = store.updatePolicy({ maxDecisionLatencyMs: 300 });
    expect(updated.maxDecisionLatencyMs).toBe(300);

    expect(() => store.updatePolicy({ edgeRequired: 0.5, maxEdge: 0.4 })).toThrow(
      /edgeRequired/
    );
  });
});

describe('config validation + schema helpers', () => {
  it('accepts defaults and rejects invalid ranges', () => {
    expect(() => validateP0Config(DEFAULT_TRADE_POLICY, DEFAULT_RISK_CONFIG)).not.toThrow();

    const badRisk = { ...DEFAULT_RISK_CONFIG, maxPerTradeLossDollars: 0 };
    expect(() => validateP0Config(DEFAULT_TRADE_POLICY, badRisk)).toThrow(
      /maxPerTradeLossDollars/
    );
  });

  it('identifies near-zero-risk mode', () => {
    expect(isNearZeroRiskMode(DEFAULT_TRADE_POLICY)).toBe(true);
    expect(isNearZeroRiskMode({ ...DEFAULT_TRADE_POLICY, strategyMode: 'standard' })).toBe(
      false
    );
  });

  it('builds update schema and asserts section values', () => {
    const policySection = getConfigSection('policy');
    expect(policySection).toBeDefined();

    const schema = buildUpdateSchema(policySection!.fields);
    const parsed = schema.partial().safeParse({ maxDecisionLatencyMs: 250 });
    expect(parsed.success).toBe(true);

    expect(() => assertSectionValues(policySection!, {})).toThrow(/missing/);

    const fullPolicy = {
      ...DEFAULT_TRADE_POLICY,
      rejectDelayed: true,
      strategyMode: 'near_zero_risk'
    };
    expect(() => assertSectionValues(policySection!, fullPolicy)).not.toThrow();

    expect(() =>
      assertSectionValues(policySection!, {
        ...fullPolicy,
        maxDecisionLatencyMs: 250.5
      })
    ).toThrow(/integer/);

    expect(() =>
      assertSectionValues(policySection!, {
        ...fullPolicy,
        entrySlippageToleranceBps: 999
      })
    ).toThrow(/max/);

    expect(() =>
      assertSectionValues(policySection!, {
        ...fullPolicy,
        rejectDelayed: 'true'
      })
    ).toThrow(/boolean/);

    expect(() =>
      assertSectionValues(policySection!, {
        ...fullPolicy,
        strategyMode: 'invalid'
      })
    ).toThrow(/expected/);

    expect(() =>
      assertSectionValues(policySection!, {
        ...fullPolicy,
        maxDecisionLatencyMs: '250'
      })
    ).toThrow(/expected number/);
  });

  it('exposes schema and market/venue helpers', () => {
    expect(CONFIG_SCHEMA.sections.length).toBeGreaterThan(0);
    expect(Array.isArray(MARKET_PAIRS)).toBe(true);

    const env = loadEnv({ PHASE2_CROSS_VENUE_ENABLED: 'true' });
    expect(venueFlags(env).phase2CrossVenue).toBe(true);
  });

  it('rejects enum fields without options', () => {
    expect(() =>
      buildUpdateSchema([
        { key: 'mode', label: 'Mode', type: 'enum', options: [] }
      ])
    ).toThrow(/no options/);
  });

  it('builds schemas for number fields without bounds', () => {
    const schema = buildUpdateSchema([{ key: 'ratio', label: 'Ratio', type: 'number' }]);
    expect(schema.safeParse({ ratio: 2 }).success).toBe(true);
  });

  it('builds enum schemas and validates enum values', () => {
    const section: ConfigSection = {
      key: 'policy',
      label: 'Policy',
      fields: [{ key: 'mode', label: 'Mode', type: 'enum', options: ['a', 'b'] }]
    };
    const schema = buildUpdateSchema(section.fields);

    expect(schema.safeParse({ mode: 'a' }).success).toBe(true);
    expect(() => assertSectionValues(section, { mode: 'c' })).toThrow(/expected/);
  });
});
