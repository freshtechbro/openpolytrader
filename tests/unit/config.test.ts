import { describe, it, expect } from 'vitest';

import { loadEnv, resolveRiskProfileEnvFlags } from '../../src/config/env.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { DEFAULT_TRADE_POLICY, isNearZeroRiskMode } from '../../src/config/policy.js';
import { loadRiskProfile } from '../../src/config/riskProfile.js';
import { ConfigStore } from '../../src/config/store.js';
import { validateP0Config } from '../../src/config/validate.js';
import {
  CONFIG_SCHEMA,
  assertSectionValues,
  buildUpdateSchema,
  getConfigSection,
  type ConfigField,
  type ConfigSection
} from '../../src/config/schema.js';
import { MARKET_PAIRS } from '../../src/config/markets.js';

describe('config env + store', () => {
  it('loads default env values', () => {
    const env = loadEnv({});

    expect(env.TRADING_ENABLED).toBe(true);
    expect(env.TRADING_MODE).toBe('shadow');
    expect(env.ALLOWLIST_AUTO_RESUME).toBe(true);
  });

  it('loads defaults for catalog and Exa cooldown knobs', () => {
    const env = loadEnv({});

    expect(env.MARKET_CATALOG_MAX_SPREAD).toBe(0.02);
    expect(env.MARKET_CATALOG_EXCLUDE_ENDED_MARKETS).toBe(false);
    expect(env.MARKET_CATALOG_EXPLORATION_ENABLED).toBe(true);
    expect(env.MARKET_CATALOG_EXPLORATION_MAX_PAIRS).toBe(30);
    expect(env.MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H).toBe(1000);
    expect(env.MARKET_CATALOG_EXPLORATION_MAX_PAGES).toBe(3);
    expect(env.MARKET_CATALOG_PRESTART_MAX_AGE_MS).toBe(21600000);
    expect(env.EXA_COOLDOWN_MS).toBe(300000);
    expect(env.EXA_COOLDOWN_FAILURE_THRESHOLD).toBe(1);
  });

  it('parses catalog and Exa cooldown overrides', () => {
    const env = loadEnv({
      MARKET_CATALOG_MAX_SPREAD: '0.015',
      MARKET_CATALOG_EXCLUDE_ENDED_MARKETS: 'true',
      MARKET_CATALOG_EXPLORATION_ENABLED: 'true',
      MARKET_CATALOG_EXPLORATION_MAX_PAIRS: '12',
      MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H: '250',
      MARKET_CATALOG_EXPLORATION_MAX_PAGES: '3',
      MARKET_CATALOG_PRESTART_MAX_AGE_MS: '3600000',
      EXA_COOLDOWN_MS: '45000',
      EXA_COOLDOWN_FAILURE_THRESHOLD: '2'
    });

    expect(env.MARKET_CATALOG_MAX_SPREAD).toBe(0.015);
    expect(env.MARKET_CATALOG_EXCLUDE_ENDED_MARKETS).toBe(true);
    expect(env.MARKET_CATALOG_EXPLORATION_ENABLED).toBe(true);
    expect(env.MARKET_CATALOG_EXPLORATION_MAX_PAIRS).toBe(12);
    expect(env.MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H).toBe(250);
    expect(env.MARKET_CATALOG_EXPLORATION_MAX_PAGES).toBe(3);
    expect(env.MARKET_CATALOG_PRESTART_MAX_AGE_MS).toBe(3600000);
    expect(env.EXA_COOLDOWN_MS).toBe(45000);
    expect(env.EXA_COOLDOWN_FAILURE_THRESHOLD).toBe(2);
  });

  it('loads FW oracle env defaults', () => {
    const env = loadEnv({});

    expect(env.FW_ORACLE_BASE_URL).toBe('http://127.0.0.1:7071');
    expect(env.FW_ORACLE_TIMEOUT_MS).toBe(120);
    expect(env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD).toBe(3);
    expect(env.FW_ORACLE_CIRCUIT_COOLDOWN_MS).toBe(30000);
  });

  it('parses FW oracle env overrides', () => {
    const env = loadEnv({
      FW_ORACLE_BASE_URL: 'http://oracle.internal:9999',
      FW_ORACLE_TIMEOUT_MS: '250',
      FW_ORACLE_API_KEY: 'secret',
      FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD: '5',
      FW_ORACLE_CIRCUIT_COOLDOWN_MS: '45000'
    });

    expect(env.FW_ORACLE_BASE_URL).toBe('http://oracle.internal:9999');
    expect(env.FW_ORACLE_TIMEOUT_MS).toBe(250);
    expect(env.FW_ORACLE_API_KEY).toBe('secret');
    expect(env.FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD).toBe(5);
    expect(env.FW_ORACLE_CIRCUIT_COOLDOWN_MS).toBe(45000);
  });

  it('parses boolean env vars from strings', () => {
    const env = loadEnv({
      TRADING_ENABLED: 'false',
      OPS_API_ENABLED: 'false',
      ALLOWLIST_AUTO_RESUME: '0',
      LLM_ENABLED: 'true',
      LLM_DATA_EXPORT_ENABLED: 'no',
      LLM_OPENROUTER_ALLOW_FALLBACKS: 'on'
    });

    expect(env.TRADING_ENABLED).toBe(false);
    expect(env.OPS_API_ENABLED).toBe(false);
    expect(env.ALLOWLIST_AUTO_RESUME).toBe(false);
    expect(env.LLM_ENABLED).toBe(true);
    expect(env.LLM_DATA_EXPORT_ENABLED).toBe(false);
    expect(env.LLM_OPENROUTER_ALLOW_FALLBACKS).toBe(true);
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
    expect(env.LLM_LEARNING_MODEL).toBe('kimi-k2.5');
    expect(env.LLM_LEARNING_FALLBACK_PROVIDER_MODEL).toBe('qwen/qwen3-coder-next');
    expect(env.LLM_PORTFOLIO_MODE).toBe('advisory');
    expect(env.LLM_MARKETDATA_MODE).toBe('advisory');
    expect(env.LLM_OPS_MODE).toBe('advisory');
  });

  it('normalizes LLM endpoint overrides', () => {
    expect(loadEnv({ LLM_EXECUTION_ENDPOINT_BACKUP: 'chat' }).LLM_EXECUTION_ENDPOINT_BACKUP).toBe(
      'chat.completions'
    );
    expect(loadEnv({ LLM_EXECUTION_ENDPOINT_BACKUP: 'completions' }).LLM_EXECUTION_ENDPOINT_BACKUP).toBe(
      'chat.completions'
    );
    expect(loadEnv({ LLM_EXECUTION_ENDPOINT_BACKUP: 'messages' }).LLM_EXECUTION_ENDPOINT_BACKUP).toBe(
      'messages'
    );
    expect(loadEnv({ LLM_EXECUTION_ENDPOINT_BACKUP: 'responses' }).LLM_EXECUTION_ENDPOINT_BACKUP).toBe(
      'responses'
    );
    expect(loadEnv({ LLM_EXECUTION_ENDPOINT_BACKUP: '   ' }).LLM_EXECUTION_ENDPOINT_BACKUP).toBeUndefined();
  });

  it('normalizes catalog order aliases and rejects non-string catalog order values', () => {
    expect(loadEnv({ MARKET_CATALOG_ORDER: 'volume' }).MARKET_CATALOG_ORDER).toBe('volume24hr');
    expect(loadEnv({ MARKET_CATALOG_ORDER: 'volume24hr' }).MARKET_CATALOG_ORDER).toBe('volume24hr');
    expect(loadEnv({ MARKET_CATALOG_ORDER: 'newest' }).MARKET_CATALOG_ORDER).toBe('newest');
    expect(loadEnv({ MARKET_CATALOG_ORDER: 'recent' }).MARKET_CATALOG_ORDER).toBe('newest');
    expect(loadEnv({ MARKET_CATALOG_ORDER: 'latest' }).MARKET_CATALOG_ORDER).toBe('newest');
    expect(loadEnv({ MARKET_CATALOG_ORDER: '   ' }).MARKET_CATALOG_ORDER).toBe('volume24hr');

    expect(() =>
      loadEnv({ MARKET_CATALOG_ORDER: 123 as unknown as string } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/Invalid environment configuration/);
  });

  it('normalizes responses endpoint aliases', () => {
    expect(loadEnv({ LLM_SCANNER_ENDPOINT_BACKUP: 'RESPONSES' }).LLM_SCANNER_ENDPOINT_BACKUP).toBe('responses');
  });

  it('rejects unknown LLM endpoint aliases', () => {
    expect(() => loadEnv({ LLM_SCANNER_ENDPOINT_BACKUP: 'invalid-endpoint' })).toThrow(
      /Invalid environment configuration/
    );
  });

  it('rejects unknown catalog order aliases', () => {
    expect(() => loadEnv({ MARKET_CATALOG_ORDER: 'most_active' })).toThrow(
      /Invalid environment configuration/
    );
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
    expect(loadEnv({ RISK_PROFILE: 'default' }).RISK_PROFILE).toBe('extra_high');
    expect(loadEnv({ RISK_PROFILE: 'Extra-High' }).RISK_PROFILE).toBe('extra_high');
    expect(loadEnv({ RISK_PROFILE: '   ' }).RISK_PROFILE).toBe('extra_high');
  });

  it('extra_high profile explicitly sets Frank-Wolfe runtime defaults', () => {
    const profile = loadRiskProfile('extra_high', 'settings/risk-gates/extra_high.json');
    expect(profile?.policy.fwMaxLoopRuntimeMs).toBe(350);
    expect(profile?.policy.fwOracleMaxConcurrency).toBe(4);
    expect(profile?.policy.fwSlippageToleranceBps).toBe(50);
    expect(profile?.policy.fwExecutionRiskBufferBps).toBe(5);
    expect(profile?.policy.fwMinEdgeThreshold).toBe(0.001);
    expect(profile?.policy.fwSelectionWeightFloor).toBe(0.35);
    expect(profile?.policy.fwSelectionTopK).toBe(3);
    expect(profile?.policy.fwDependencyMode).toBe('hybrid');
    expect(profile?.policy.fwDependencyHybridMerge).toBe('consensus');
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

  it('replaces policy + risk snapshots', () => {
    const store = new ConfigStore(
      { ...DEFAULT_TRADE_POLICY },
      { ...DEFAULT_RISK_CONFIG }
    );

    const nextPolicy = { ...DEFAULT_TRADE_POLICY, maxDecisionLatencyMs: 400 };
    const nextRisk = { ...DEFAULT_RISK_CONFIG, maxTradeFraction: 0.15 };

    const snapshot = store.replace(nextPolicy, nextRisk);
    expect(snapshot.policy.maxDecisionLatencyMs).toBe(400);
    expect(snapshot.risk.maxTradeFraction).toBe(0.15);
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

  it('rejects fill timeout overrides in near-zero-risk mode', () => {
    const badPolicy = { ...DEFAULT_TRADE_POLICY, fillTimeoutMs: 0 };
    expect(() => validateP0Config(badPolicy, DEFAULT_RISK_CONFIG)).toThrow(
      /fillTimeoutMs/
    );

    const standardPolicy = { ...DEFAULT_TRADE_POLICY, strategyMode: 'standard', fillTimeoutMs: 0 };
    expect(() => validateP0Config(standardPolicy, DEFAULT_RISK_CONFIG)).not.toThrow();
  });

  it('rejects mismatched staleness knobs', () => {
    const badPolicy = {
      ...DEFAULT_TRADE_POLICY,
      orderbookFreshnessMs: 10000,
      maxBookStalenessMs: 15000
    };

    expect(() => validateP0Config(badPolicy, DEFAULT_RISK_CONFIG)).toThrow(
      /orderbookFreshnessMs/
    );
  });

  it('rejects evEdgeRequired when zero', () => {
    const badPolicy = { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0 };
    expect(() => validateP0Config(badPolicy, DEFAULT_RISK_CONFIG)).toThrow(/evEdgeRequired/);
  });

  it('rejects non-positive evMaxEdge and evEdgeRequired >= evMaxEdge', () => {
    const nonPositiveMax = { ...DEFAULT_TRADE_POLICY, evMaxEdge: 0 };
    expect(() => validateP0Config(nonPositiveMax, DEFAULT_RISK_CONFIG)).toThrow(/evMaxEdge/);

    const equalThreshold = { ...DEFAULT_TRADE_POLICY, evEdgeRequired: 0.01, evMaxEdge: 0.01 };
    expect(() => validateP0Config(equalThreshold, DEFAULT_RISK_CONFIG)).toThrow(/evMaxEdge/);
  });

  it('rejects invalid evConfidenceMinFloor ranges', () => {
    const belowZero = { ...DEFAULT_TRADE_POLICY, evConfidenceMinFloor: -0.1 };
    expect(() => validateP0Config(belowZero, DEFAULT_RISK_CONFIG)).toThrow(/evConfidenceMinFloor/);

    const aboveMin = {
      ...DEFAULT_TRADE_POLICY,
      evConfidenceMin: 0.3,
      evConfidenceMinFloor: 0.4
    };
    expect(() => validateP0Config(aboveMin, DEFAULT_RISK_CONFIG)).toThrow(/evConfidenceMinFloor/);
  });

  it('rejects evMaxPerMarketNotional above evMaxPortfolioNotional', () => {
    const badPolicy = {
      ...DEFAULT_TRADE_POLICY,
      evMaxPerMarketNotional: 500,
      evMaxPortfolioNotional: 100
    };
    expect(() => validateP0Config(badPolicy, DEFAULT_RISK_CONFIG)).toThrow(/evMaxPerMarketNotional/);
  });

  it('allows evMaxPerMarketNotional when portfolio cap is disabled', () => {
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      evMaxPerMarketNotional: 500,
      evMaxPortfolioNotional: 0
    };
    expect(() => validateP0Config(policy, DEFAULT_RISK_CONFIG)).not.toThrow();
  });

  it('rejects invalid evWebSearchPrimary settings', () => {
    const badExa = { ...DEFAULT_TRADE_POLICY, evWebSearchPrimary: 'exa' as const, evWebSearchExaEnabled: false };
    expect(() => validateP0Config(badExa, DEFAULT_RISK_CONFIG)).toThrow(/evWebSearchPrimary=exa/);

    const badFirecrawl = {
      ...DEFAULT_TRADE_POLICY,
      evWebSearchPrimary: 'firecrawl' as const,
      evWebSearchFirecrawlEnabled: false
    };
    expect(() => validateP0Config(badFirecrawl, DEFAULT_RISK_CONFIG)).toThrow(/evWebSearchPrimary=firecrawl/);
  });

  it('accepts depth buffer disabled', () => {
    const policy = { ...DEFAULT_TRADE_POLICY, depthBufferMultiplier: 0 };
    expect(() => validateP0Config(policy, DEFAULT_RISK_CONFIG)).not.toThrow();
  });

  it('validates FW policy constraints', () => {
    const validTimeout = { ...DEFAULT_TRADE_POLICY, fwOracleTimeLimitMs: 1 };
    expect(() => validateP0Config(validTimeout, DEFAULT_RISK_CONFIG)).not.toThrow();

    const badTimeout = { ...DEFAULT_TRADE_POLICY, fwOracleTimeLimitMs: 0 };
    expect(() => validateP0Config(badTimeout, DEFAULT_RISK_CONFIG)).toThrow(/fwOracleTimeLimitMs/);

    const lowConfidence = { ...DEFAULT_TRADE_POLICY, fwDependencyMinConfidence: -0.1 };
    expect(() => validateP0Config(lowConfidence, DEFAULT_RISK_CONFIG)).toThrow(/fwDependencyMinConfidence/);

    const badThreshold = { ...DEFAULT_TRADE_POLICY, fwMinEdgeThreshold: 0 };
    expect(() => validateP0Config(badThreshold, DEFAULT_RISK_CONFIG)).toThrow(/fwMinEdgeThreshold/);

    const badAge = { ...DEFAULT_TRADE_POLICY, fwMaxProjectionAgeMs: 0 };
    expect(() => validateP0Config(badAge, DEFAULT_RISK_CONFIG)).toThrow(/fwMaxProjectionAgeMs/);

    const badFwSlippage = { ...DEFAULT_TRADE_POLICY, fwSlippageToleranceBps: -1 };
    expect(() => validateP0Config(badFwSlippage, DEFAULT_RISK_CONFIG)).toThrow(/fwSlippageToleranceBps/);

    const badTopK = { ...DEFAULT_TRADE_POLICY, fwSelectionTopK: -1 };
    expect(() => validateP0Config(badTopK, DEFAULT_RISK_CONFIG)).toThrow(/fwSelectionTopK/);
  });

  it('rejects invalid FW notional and merge combinations', () => {
    const badNotional = {
      ...DEFAULT_TRADE_POLICY,
      fwMaxPerMarketNotional: 500,
      fwMaxPortfolioNotional: 100
    };
    expect(() => validateP0Config(badNotional, DEFAULT_RISK_CONFIG)).toThrow(/fwMaxPerMarketNotional/);

    const invalidMerge = {
      ...DEFAULT_TRADE_POLICY,
      fwDependencyMode: 'deterministic' as const,
      fwDependencyHybridMerge: 'union' as const
    };
    expect(() => validateP0Config(invalidMerge, DEFAULT_RISK_CONFIG)).toThrow(/fwDependencyHybridMerge/);
  });

  it('rejects invalid FW loop contraction and basket bounds', () => {
    const badContraction = {
      ...DEFAULT_TRADE_POLICY,
      fwContractionInitialEpsilon: 0.01,
      fwContractionMinEpsilon: 0.01
    };
    expect(() => validateP0Config(badContraction, DEFAULT_RISK_CONFIG)).toThrow(/fwContractionInitialEpsilon/);

    const badBasketBounds = {
      ...DEFAULT_TRADE_POLICY,
      fwBasketMinMarkets: 4,
      fwBasketMaxMarkets: 2
    };
    expect(() => validateP0Config(badBasketBounds, DEFAULT_RISK_CONFIG)).toThrow(/fwBasketMinMarkets/);
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

  it('buildUpdateSchema rejects enum fields without options', () => {
    const fields: ConfigField[] = [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        options: []
      }
    ];

    expect(() => buildUpdateSchema(fields)).toThrow(/has no options/);
  });

  it('assertSectionValues validates enum field values', () => {
    const section: ConfigSection = {
      key: 'policy',
      label: 'Policy',
      fields: [
        {
          key: 'strategyMode',
          label: 'Strategy Mode',
          type: 'enum',
          options: ['near_zero_risk', 'standard']
        }
      ]
    };

    expect(() => assertSectionValues(section, { strategyMode: 'invalid' })).toThrow(
      /expected near_zero_risk, standard/
    );
    expect(() => assertSectionValues(section, { strategyMode: 'standard' })).not.toThrow();
  });

  it('exposes schema and market helpers', () => {
    expect(CONFIG_SCHEMA.sections.length).toBeGreaterThan(0);
    expect(Array.isArray(MARKET_PAIRS)).toBe(true);
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
