import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';

describe('llm config', () => {
  it('defaults to enabled modes but disables runtime when keys are missing', () => {
    const env = loadEnv({});
    const cfg = loadLLMConfig(env);

    expect(cfg.enabled).toBe(false);
    expect(cfg.dataExportEnabled).toBe(false);
    expect(cfg.fallbackEnabled).toBe(false);
    expect(cfg.primaryRetryCount).toBe(1);
    expect(cfg.primaryProvider).toBe('opencode-zen');
    expect(cfg.fallbackProvider).toBe('openrouter');
    expect(cfg.providers['opencode-zen'].baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(cfg.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');

    expect(cfg.agents.ExecutionAgent.mode).toBe('advisory');
    expect(cfg.agents.ExecutionAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.RiskAgent.mode).toBe('advisory');
    expect(cfg.agents.RiskAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.ScannerAgent.mode).toBe('advisory');
    expect(cfg.agents.ScannerAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.LearningAgent.mode).toBe('active');
    expect(cfg.agents.LearningAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.LearningAgent.model).toBe('kimi-k2.5');
    expect(cfg.agents.LearningAgent.fallbackProviderModel).toBe('qwen/qwen3-coder-next');
    expect(cfg.agents.PortfolioAgent.mode).toBe('advisory');
    expect(cfg.agents.PortfolioAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.MarketDataAgent.mode).toBe('advisory');
    expect(cfg.agents.MarketDataAgent.provider).toBe('opencode-zen');
    expect(cfg.agents.OpsAgent.mode).toBe('advisory');
    expect(cfg.agents.OpsAgent.provider).toBe('opencode-zen');

    expect(cfg.agents.ScannerAgent.scoreTopN).toBe(20);
    expect(cfg.agents.ScannerAgent.scoreConcurrency).toBe(3);
    expect(cfg.agents.ScannerAgent.shadowMinIntervalMs).toBe(500);
  });

  it('uses explicit base-url overrides when provided', () => {
    const env = loadEnv({
      LLM_PRIMARY_BASE_URL: 'https://primary.example/v1',
      LLM_FALLBACK_BASE_URL: 'https://fallback.example/v1'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.providers['opencode-zen'].baseUrl).toBe('https://primary.example/v1');
    expect(cfg.providers.openrouter.baseUrl).toBe('https://fallback.example/v1');
  });

  it('loads per-agent fallback provider model overrides from env', () => {
    const env = loadEnv({
      LLM_RISK_FALLBACK_PROVIDER_MODEL: 'minimax/minimax-m2.1',
      LLM_OPS_FALLBACK_PROVIDER_MODEL: 'qwen/qwen3-coder-next'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.agents.RiskAgent.fallbackProviderModel).toBe('minimax/minimax-m2.1');
    expect(cfg.agents.OpsAgent.fallbackProviderModel).toBe('qwen/qwen3-coder-next');
  });

  it('does not throw when enabled but missing keys (disables at runtime)', () => {
    const env = loadEnv({ LLM_ENABLED: 'true' });
    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(false);
  });

  it('disables at runtime when enabled and an agent mode is active but keys are missing', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(false);
  });

  it('disables at runtime when all agent modes are disabled (even if LLM_ENABLED=true)', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_EXECUTION_MODE: 'disabled',
      LLM_RISK_MODE: 'disabled',
      LLM_SCANNER_MODE: 'disabled',
      LLM_LEARNING_MODE: 'disabled',
      LLM_PORTFOLIO_MODE: 'disabled',
      LLM_MARKETDATA_MODE: 'disabled',
      LLM_OPS_MODE: 'disabled',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(false);
    expect(cfg.dataExportEnabled).toBe(false);
  });

  it('accepts when enabled and required keys are present', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(true);
    expect(cfg.agents.ScannerAgent.mode).toBe('advisory');
  });

  it('enables when only one provider key is present', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(true);
    expect(cfg.providers['opencode-zen'].apiKey).toBe('zen-key');
  });

  it('treats whitespace-only provider keys as missing', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: '   ',
      LLM_FALLBACK_API_KEY: '   '
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.enabled).toBe(false);
    expect(cfg.providers['opencode-zen'].apiKey).toBeNull();
    expect(cfg.providers.openrouter.apiKey).toBeNull();
  });

  it('gates data export behind runtime enablement', () => {
    const enabledEnv = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_DATA_EXPORT_ENABLED: 'false'
    });

    const enabledCfg = loadLLMConfig(enabledEnv);
    expect(enabledCfg.enabled).toBe(true);
    expect(enabledCfg.dataExportEnabled).toBe(false);

    const disabledEnv = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_DATA_EXPORT_ENABLED: 'true'
    });

    const disabledCfg = loadLLMConfig(disabledEnv);
    expect(disabledCfg.enabled).toBe(false);
    expect(disabledCfg.dataExportEnabled).toBe(false);
  });

  it('loads ScannerAgent scoring knobs from env', () => {
    const env = loadEnv({
      LLM_SCANNER_SCORE_TOP_N: '50',
      LLM_SCANNER_SCORE_CONCURRENCY: '7',
      LLM_SCANNER_SHADOW_MIN_INTERVAL_MS: '250'
    });

    const cfg = loadLLMConfig(env);
    expect(cfg.agents.ScannerAgent.scoreTopN).toBe(50);
    expect(cfg.agents.ScannerAgent.scoreConcurrency).toBe(7);
    expect(cfg.agents.ScannerAgent.shadowMinIntervalMs).toBe(250);
  });

  it('throws when primary and fallback provider ids are identical', () => {
    const env = loadEnv({
      LLM_PRIMARY_PROVIDER: 'openrouter',
      LLM_FALLBACK_PROVIDER: 'openrouter'
    });

    expect(() => loadLLMConfig(env)).toThrow(/LLM_PRIMARY_PROVIDER|LLM_FALLBACK_PROVIDER|must differ/i);
  });

  it('applies OpenRouter attribution headers only to OpenRouter providers', () => {
    const env = loadEnv({
      LLM_PRIMARY_PROVIDER: 'openrouter',
      LLM_FALLBACK_PROVIDER: 'opencode-zen',
      LLM_OPENROUTER_HTTP_REFERER: 'https://example.com',
      LLM_OPENROUTER_X_TITLE: 'openpolytrader-tests'
    });

    const cfg = loadLLMConfig(env);

    expect(cfg.providers.openrouter.defaultHeaders).toMatchObject({
      'HTTP-Referer': 'https://example.com',
      'X-Title': 'openpolytrader-tests'
    });
    expect(cfg.providers['opencode-zen'].defaultHeaders).toEqual({});
    expect(cfg.providers.openrouter.openrouter).toBeDefined();
    expect(cfg.providers['opencode-zen'].openrouter).toBeUndefined();
  });
});
