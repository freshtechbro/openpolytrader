import { z } from 'zod';

import { envBoolean, riskProfileSchema } from './shared.js';

export const coreEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  EVENT_STORE_PATH: z.string().default('data/openpolytrader.db'),
  EVENT_STORE_METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  EVENT_STORE_METRICS_PRUNE_INTERVAL_MS: z.coerce.number().int().min(0).default(3600000),
  ALLOWLIST_AUTO_RESUME: envBoolean(true),
  TOTAL_CAPITAL: z.coerce.number().int().positive().default(1000),
  TRADING_ENABLED: envBoolean(true),
  TRADING_MODE: z.enum(['off', 'shadow', 'paper', 'live']).default('shadow'),
  RISK_PROFILE: riskProfileSchema,
  RISK_PROFILE_PATH: z.string().optional(),
  RISK_PROFILE_ACTIVE_PATH: z.string().optional(),
  MAX_CONCURRENT_MARKETS: z.coerce.number().int().positive().default(3),
  MAX_CAPITAL_IN_FLIGHT: z.coerce.number().int().positive().default(1000)
};
