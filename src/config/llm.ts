import { z } from 'zod';

import type { Env } from './env.js';

export const LLMProviderIdSchema = z.enum(['opencode-zen', 'openrouter']);
export type LLMProviderId = z.infer<typeof LLMProviderIdSchema>;

export type LLMExecutionMode = 'disabled' | 'shadow' | 'advisory';
export type LLMLearningMode = 'disabled' | 'active';
export type LLMAdvisoryMode = 'disabled' | 'advisory';
export type LLMEndpoint = 'chat.completions' | 'responses' | 'messages';

export interface LLMProviderConfig {
  id: LLMProviderId;
  baseUrl: string;
  apiKey: string | null;
  defaultHeaders: Record<string, string>;
  openrouter?: {
    sort: 'latency' | 'price' | 'throughput';
    allowFallbacks: boolean;
  };
}

export interface LLMRetryConfig {
  timeoutMs: number;
  maxRetries: number;
}

export interface LLMConfig {
  enabled: boolean;
  dataExportEnabled: boolean;
  fallbackEnabled: boolean;
  primaryRetryCount: number;
  primaryProvider: LLMProviderId;
  fallbackProvider: LLMProviderId;
  providers: Record<LLMProviderId, LLMProviderConfig>;
  retry: LLMRetryConfig;
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
    halfOpenSuccesses: number;
  };
  agents: {
    ExecutionAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMExecutionMode;
      timeoutMs: number;
    };
    RiskAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMExecutionMode;
      timeoutMs: number;
    };
    ScannerAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMExecutionMode;
      timeoutMs: number;
      scoreTopN: number;
      scoreConcurrency: number;
      shadowMinIntervalMs: number;
    };
    LearningAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMLearningMode;
      timeoutMs: number;
    };
    PortfolioAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMAdvisoryMode;
      timeoutMs: number;
    };
    MarketDataAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMAdvisoryMode;
      timeoutMs: number;
    };
    OpsAgent: {
      provider: LLMProviderId;
      model: string;
      backupModel: string | null;
      backupEndpoint?: LLMEndpoint;
      fallbackProviderModel?: string | null;
      mode: LLMAdvisoryMode;
      timeoutMs: number;
    };
  };
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireProviderIdsDistinct(primary: LLMProviderId, fallback: LLMProviderId): void {
  if (primary === fallback) {
    throw new Error(
      `Invalid LLM configuration: LLM_PRIMARY_PROVIDER (${primary}) must differ from LLM_FALLBACK_PROVIDER (${fallback})`
    );
  }
}

function anyAgentUsesLLM(env: Env): boolean {
  return (
    env.LLM_EXECUTION_MODE !== 'disabled' ||
    env.LLM_RISK_MODE !== 'disabled' ||
    env.LLM_SCANNER_MODE !== 'disabled' ||
    env.LLM_LEARNING_MODE !== 'disabled' ||
    env.LLM_PORTFOLIO_MODE !== 'disabled' ||
    env.LLM_MARKETDATA_MODE !== 'disabled' ||
    env.LLM_OPS_MODE !== 'disabled'
  );
}

export function loadLLMConfig(env: Env): LLMConfig {
  const primaryProvider = env.LLM_PRIMARY_PROVIDER;
  const fallbackProvider = env.LLM_FALLBACK_PROVIDER;
  requireProviderIdsDistinct(primaryProvider, fallbackProvider);

  const primaryApiKey = normalizeOptionalString(env.LLM_PRIMARY_API_KEY);
  const fallbackApiKey = normalizeOptionalString(env.LLM_FALLBACK_API_KEY);

  const wantsLLM = env.LLM_ENABLED && anyAgentUsesLLM(env);
  const hasAnyKey = Boolean(primaryApiKey || fallbackApiKey);
  const enabled = wantsLLM && hasAnyKey;

  const openrouterHeaders: Record<string, string> = {};
  const httpReferer = normalizeOptionalString(env.LLM_OPENROUTER_HTTP_REFERER);
  const xTitle = normalizeOptionalString(env.LLM_OPENROUTER_X_TITLE);
  if (httpReferer) openrouterHeaders['HTTP-Referer'] = httpReferer;
  if (xTitle) openrouterHeaders['X-Title'] = xTitle;

  const providers = {
    [primaryProvider]: {
      id: primaryProvider,
      baseUrl: env.LLM_PRIMARY_BASE_URL.trim(),
      apiKey: primaryApiKey,
      defaultHeaders: primaryProvider === 'openrouter' ? openrouterHeaders : {},
      openrouter:
        primaryProvider === 'openrouter'
          ? {
              sort: env.LLM_OPENROUTER_SORT,
              allowFallbacks: env.LLM_OPENROUTER_ALLOW_FALLBACKS
            }
          : undefined
    },
    [fallbackProvider]: {
      id: fallbackProvider,
      baseUrl: env.LLM_FALLBACK_BASE_URL.trim(),
      apiKey: fallbackApiKey,
      defaultHeaders: fallbackProvider === 'openrouter' ? openrouterHeaders : {},
      openrouter:
        fallbackProvider === 'openrouter'
          ? {
              sort: env.LLM_OPENROUTER_SORT,
              allowFallbacks: env.LLM_OPENROUTER_ALLOW_FALLBACKS
            }
          : undefined
    }
  } as unknown as Record<LLMProviderId, LLMProviderConfig>;

  return {
    enabled,
    dataExportEnabled: enabled && env.LLM_DATA_EXPORT_ENABLED,
    fallbackEnabled: env.LLM_FALLBACK_ENABLED,
    primaryRetryCount: Math.max(env.LLM_PRIMARY_RETRY_COUNT, 0),
    primaryProvider,
    fallbackProvider,
    providers,
    retry: {
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES
    },
    circuitBreaker: {
      failureThreshold: env.LLM_CB_FAILURE_THRESHOLD,
      cooldownMs: env.LLM_CB_COOLDOWN_MS,
      halfOpenSuccesses: env.LLM_CB_HALF_OPEN_SUCCESSES
    },
    agents: {
      ExecutionAgent: {
        provider: env.LLM_EXECUTION_PROVIDER,
        model: env.LLM_EXECUTION_MODEL,
        backupModel: normalizeOptionalString(env.LLM_EXECUTION_MODEL_BACKUP),
        backupEndpoint: env.LLM_EXECUTION_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_EXECUTION_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_EXECUTION_MODE,
        timeoutMs: env.LLM_EXECUTION_TIMEOUT_MS
      },
      RiskAgent: {
        provider: env.LLM_RISK_PROVIDER,
        model: env.LLM_RISK_MODEL,
        backupModel: normalizeOptionalString(env.LLM_RISK_MODEL_BACKUP),
        backupEndpoint: env.LLM_RISK_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_RISK_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_RISK_MODE,
        timeoutMs: env.LLM_RISK_TIMEOUT_MS
      },
      ScannerAgent: {
        provider: env.LLM_SCANNER_PROVIDER,
        model: env.LLM_SCANNER_MODEL,
        backupModel: normalizeOptionalString(env.LLM_SCANNER_MODEL_BACKUP),
        backupEndpoint: env.LLM_SCANNER_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_SCANNER_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_SCANNER_MODE,
        timeoutMs: env.LLM_SCANNER_TIMEOUT_MS,
        scoreTopN: env.LLM_SCANNER_SCORE_TOP_N,
        scoreConcurrency: env.LLM_SCANNER_SCORE_CONCURRENCY,
        shadowMinIntervalMs: env.LLM_SCANNER_SHADOW_MIN_INTERVAL_MS
      },
      LearningAgent: {
        provider: env.LLM_LEARNING_PROVIDER,
        model: env.LLM_LEARNING_MODEL,
        backupModel: normalizeOptionalString(env.LLM_LEARNING_MODEL_BACKUP),
        backupEndpoint: env.LLM_LEARNING_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_LEARNING_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_LEARNING_MODE,
        timeoutMs: env.LLM_LEARNING_TIMEOUT_MS
      },
      PortfolioAgent: {
        provider: env.LLM_PORTFOLIO_PROVIDER,
        model: env.LLM_PORTFOLIO_MODEL,
        backupModel: normalizeOptionalString(env.LLM_PORTFOLIO_MODEL_BACKUP),
        backupEndpoint: env.LLM_PORTFOLIO_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_PORTFOLIO_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_PORTFOLIO_MODE,
        timeoutMs: env.LLM_PORTFOLIO_TIMEOUT_MS
      },
      MarketDataAgent: {
        provider: env.LLM_MARKETDATA_PROVIDER,
        model: env.LLM_MARKETDATA_MODEL,
        backupModel: normalizeOptionalString(env.LLM_MARKETDATA_MODEL_BACKUP),
        backupEndpoint: env.LLM_MARKETDATA_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_MARKETDATA_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_MARKETDATA_MODE,
        timeoutMs: env.LLM_MARKETDATA_TIMEOUT_MS
      },
      OpsAgent: {
        provider: env.LLM_OPS_PROVIDER,
        model: env.LLM_OPS_MODEL,
        backupModel: normalizeOptionalString(env.LLM_OPS_MODEL_BACKUP),
        backupEndpoint: env.LLM_OPS_ENDPOINT_BACKUP,
        fallbackProviderModel: normalizeOptionalString(env.LLM_OPS_FALLBACK_PROVIDER_MODEL),
        mode: env.LLM_OPS_MODE,
        timeoutMs: env.LLM_OPS_TIMEOUT_MS
      }
    }
  };
}
