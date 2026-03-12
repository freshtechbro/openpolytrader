import { z } from 'zod';

import { coreEnvShape } from './env/coreEnv.js';
import { llmEnvShape } from './env/llmEnv.js';
import { marketCatalogEnvShape } from './env/marketCatalogEnv.js';
import { opsEnvShape } from './env/opsEnv.js';
import { polymarketEnvShape } from './env/polymarketEnv.js';
import { rpcEnvShape } from './env/rpcEnv.js';
import { webSearchEnvShape } from './env/webSearchEnv.js';
import { resolveAlchemyRpcBaseUrl, resolveAlchemyWsBaseUrl } from './rpcUrls.js';

const envSchema = z.object({
  ...coreEnvShape,
  ...opsEnvShape,
  ...marketCatalogEnvShape,
  ...llmEnvShape,
  ...webSearchEnvShape,
  ...rpcEnvShape,
  ...polymarketEnvShape
});

export type Env = z.infer<typeof envSchema>;
export type TradingMode = Env['TRADING_MODE'];
export const ENV_SCHEMA_KEYS = Object.freeze(Object.keys(envSchema.shape));

export function resolveRiskProfileEnvFlags(
  raw: NodeJS.ProcessEnv = process.env
): { profileSet: boolean; profilePathSet: boolean } {
  const profileRaw = typeof raw.RISK_PROFILE === 'string' ? raw.RISK_PROFILE.trim() : '';
  const profilePathRaw =
    typeof raw.RISK_PROFILE_PATH === 'string' ? raw.RISK_PROFILE_PATH.trim() : '';

  return {
    profileSet: profileRaw.length > 0,
    profilePathSet: profilePathRaw.length > 0
  };
}

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;

  if (env.TRADING_ENABLED && env.TRADING_MODE === 'live') {
    const missing: string[] = [];

    if (!env.ALCHEMY_API_KEY) missing.push('ALCHEMY_API_KEY');
    if (!env.POLYMARKET_API_KEY) missing.push('POLYMARKET_API_KEY');
    if (!env.POLYMARKET_API_SECRET) missing.push('POLYMARKET_API_SECRET');
    if (!env.POLYMARKET_PASSPHRASE) missing.push('POLYMARKET_PASSPHRASE');
    if (!env.POLYMARKET_POSITIONS_USER) missing.push('POLYMARKET_POSITIONS_USER');

    if (missing.length > 0) {
      throw new Error(
        `Missing required env vars for trading: ${missing.join(', ')}`
      );
    }
  }

  if (env.ALCHEMY_API_KEY) {
    const alchemyPathSuffix = `/${env.ALCHEMY_API_KEY}`;
    if (resolveAlchemyRpcBaseUrl(env.ALCHEMY_RPC_URL).includes(alchemyPathSuffix)) {
      throw new Error(
        'Invalid environment configuration: ALCHEMY_RPC_URL must be the base URL (do not include ALCHEMY_API_KEY)'
      );
    }
    if (resolveAlchemyWsBaseUrl(env.ALCHEMY_WS_URL).includes(alchemyPathSuffix)) {
      throw new Error(
        'Invalid environment configuration: ALCHEMY_WS_URL must be the base URL (do not include ALCHEMY_API_KEY)'
      );
    }
  }

  return env;
}

export function loadEnvWithOverrides(overrides: NodeJS.ProcessEnv): Env {
  return loadEnv({ ...process.env, ...overrides });
}
