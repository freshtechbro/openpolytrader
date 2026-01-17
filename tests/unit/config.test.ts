import { describe, it, expect } from 'vitest';

import { loadEnv, resolveRiskProfileEnvFlags } from '../../src/config/env.js';
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

    expect(env.TRADING_ENABLED).toBe(true);
    expect(env.TRADING_MODE).toBe('shadow');
    expect(env.ALLOWLIST_AUTO_RESUME).toBe(true);
  });

  it('parses boolean env vars from strings', () => {
    const env = loadEnv({
      TRADING_ENABLED: 'false',
      OPS_API_ENABLED: 'false',
      ALLOWLIST_AUTO_RESUME: '0',
      LLM_ENABLED: 'true',
      LLM_DATA_EXPORT_ENABLED: 'no',
      LLM_OPENROUTER_ALLOW_FALLBACKS: 'on',
      PHASE2_CROSS_VENUE_ENABLED: 'off'
    });

    expect(env.TRADING_ENABLED).toBe(false);
    expect(env.OPS_API_ENABLED).toBe(false);
    expect(env.ALLOWLIST_AUTO_RESUME).toBe(false);
    expect(env.LLM_ENABLED).toBe(true);
    expect(env.LLM_DATA_EXPORT_ENABLED).toBe(false);
    expect(env.LLM_OPENROUTER_ALLOW_FALLBACKS).toBe(true);
    expect(env.PHASE2_CROSS_VENUE_ENABLED).toBe(false);
  });

  it('parses boolean env vars from booleans/numbers and rejects unknown strings', () => {
    const withBoolean = loadEnv({ TRADING_ENABLED: true } as unknown as NodeJS.ProcessEnv);
    expect(withBoolean.TRADING_ENABLED).toBe(true);

    const withNumberTrue = loadEnv({ TRADING_ENABLED: 1 } as unknown as NodeJS.ProcessEnv);
    expect(withNumberTrue.TRADING_ENABLED).toBe(true);

    const withNumberFalse = loadEnv({ TRADING_ENABLED: 0 } as unknown as NodeJS.ProcessEnv);
    expect(withNumberFalse.TRADING_ENABLED).toBe(false);

    const withEmptyString = loadEnv({ TRADING_ENABLED: '' } as unknown as NodeJS.ProcessEnv);
    expect(withEmptyString.TRADING_ENABLED).toBe(true);

    expect(() => loadEnv({ TRADING_ENABLED: 'maybe' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/
    );
  });

  it('loads default LLM env values', () => {
    const env = loadEnv({});

    expect(env.LLM_ENABLED).toBe(true);
    expect(env.LLM_DATA_EXPORT_ENABLED).toBe(true);
    expect(env.LLM_TIMEOUT_MS).toBe(10000);
    expect(env.LLM_MAX_RETRIES).toBe(1);
    expect(env.LLM_FALLBACK_ENABLED).toBe(false);
    expect(env.LLM_PRIMARY_RETRY_COUNT).toBe(1);
    expect(env.LLM_PRIMARY_PROVIDER).toBe('opencode-zen');
    expect(env.LLM_FALLBACK_PROVIDER).toBe('openrouter');
    expect(env.LLM_EXECUTION_MODE).toBe('advisory');
    expect(env.LLM_RISK_MODE).toBe('advisory');
    expect(env.LLM_SCANNER_MODE).toBe('advisory');
    expect(env.LLM_LEARNING_MODE).toBe('active');
    expect(env.LLM_PORTFOLIO_MODE).toBe('advisory');
    expect(env.LLM_MARKETDATA_MODE).toBe('advisory');
    expect(env.LLM_OPS_MODE).toBe('advisory');
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

  it('detects explicit risk profile overrides', () => {
    const flags = resolveRiskProfileEnvFlags({
      RISK_PROFILE: 'high',
      RISK_PROFILE_PATH: 'settings/risk-gates/high.json'
    } as NodeJS.ProcessEnv);

    expect(flags.profileSet).toBe(true);
    expect(flags.profilePathSet).toBe(true);
  });

  it('detects missing risk profile overrides', () => {
    const flags = resolveRiskProfileEnvFlags({
      RISK_PROFILE: '   ',
      RISK_PROFILE_PATH: ''
    } as NodeJS.ProcessEnv);

    expect(flags.profileSet).toBe(false);
    expect(flags.profilePathSet).toBe(false);
  });

  it('treats undefined risk profile env values as unset', () => {
    const flags = resolveRiskProfileEnvFlags({} as NodeJS.ProcessEnv);
    expect(flags.profileSet).toBe(false);
    expect(flags.profilePathSet).toBe(false);
  });

  it('normalizes risk profile env values', () => {
    expect(loadEnv({ RISK_PROFILE: 'default' }).RISK_PROFILE).toBe('near_zero');
    expect(loadEnv({ RISK_PROFILE: 'Extra-High' }).RISK_PROFILE).toBe('extra_high');
    expect(loadEnv({ RISK_PROFILE: '   ' }).RISK_PROFILE).toBe('near_zero');
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
