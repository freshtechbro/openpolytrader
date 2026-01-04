import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPS_API_ENABLED: z.coerce.boolean().default(true),
  OPS_API_HOST: z.string().default('0.0.0.0'),
  OPS_API_TOKEN: z.string().optional(),
  TOTAL_CAPITAL: z.coerce.number().int().positive().default(1000),
  MARKET_CATALOG_PATH: z.string().optional(),
  TRADING_ENABLED: z.coerce.boolean().default(false),
  ALCHEMY_API_KEY: z.string().optional(),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_PASSPHRASE: z.string().optional(),
  PHASE2_CROSS_VENUE_ENABLED: z.coerce.boolean().default(false)
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;

  if (env.TRADING_ENABLED) {
    const missing: string[] = [];

    if (!env.ALCHEMY_API_KEY) missing.push('ALCHEMY_API_KEY');
    if (!env.POLYMARKET_API_KEY) missing.push('POLYMARKET_API_KEY');
    if (!env.POLYMARKET_API_SECRET) missing.push('POLYMARKET_API_SECRET');
    if (!env.POLYMARKET_PASSPHRASE) missing.push('POLYMARKET_PASSPHRASE');

    if (missing.length > 0) {
      throw new Error(
        `Missing required env vars for trading: ${missing.join(', ')}`
      );
    }
  }

  return env;
}
