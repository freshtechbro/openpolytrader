import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPS_API_ENABLED: z.coerce.boolean().default(true),
  OPS_API_HOST: z.string().default('0.0.0.0'),
  OPS_API_TOKEN: z.string().optional(),
  OPS_ALERT_WEBHOOK_URL: z.string().optional(),
  OPS_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  OPS_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPS_STREAM_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  OPS_INCIDENTS_LIMIT: z.coerce.number().int().positive().default(100),
  OPS_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(0).default(300000),
  OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS: z.coerce.number().int().min(0).default(0),
  OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE: z.coerce.number().min(0).default(0.000001),
  METRICS_MAX_EVENTS: z.coerce.number().int().positive().default(1000),
  INCIDENTS_MAX_EVENTS: z.coerce.number().int().positive().default(1000),
  ALLOWLIST_AUTO_RESUME: z.coerce.boolean().default(true),
  EVENT_STORE_PATH: z.string().default('data/openpolytrader.db'),
  EVENT_STORE_METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  EVENT_STORE_METRICS_PRUNE_INTERVAL_MS: z.coerce.number().int().min(0).default(3600000),
  POLYMARKET_CLOB_BASE_URL: z.string().default('https://clob.polymarket.com'),
  POLYMARKET_CLOB_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  POLYMARKET_CLOB_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(300),
  POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  POLYMARKET_CLOB_ORDER_PATH: z.string().default('/orders'),
  POLYMARKET_CLOB_BATCH_ORDER_PATH: z.string().default('/orders'),
  POLYMARKET_CLOB_CANCEL_ORDER_PATH: z.string().default('/order'),
  POLYMARKET_CLOB_CANCEL_ORDERS_PATH: z.string().default('/orders'),
  POLYMARKET_CLOB_CANCEL_ALL_PATH: z.string().default('/cancel-all'),
  POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH: z.string().default('/cancel-market-orders'),
  POLYMARKET_CLOB_ACTIVE_ORDERS_PATH: z.string().default('/data/orders'),
  POLYMARKET_CLOB_RETRY_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  POLYMARKET_CLOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  POLYMARKET_CLOB_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  POLYMARKET_WS_URL: z.string().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  POLYMARKET_USER_WS_URL: z.string().default('wss://ws-subscriptions-clob.polymarket.com/ws/user'),
  POLYMARKET_WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(10000),
  POLYMARKET_WS_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(250),
  POLYMARKET_WS_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30000),
  POLYMARKET_WS_RECONNECT_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.2),
  TOTAL_CAPITAL: z.coerce.number().int().positive().default(1000),
  MARKET_CATALOG_PATH: z.string().optional(),
  MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS: z.coerce.number().int().min(1).max(2000).default(50),
  TRADING_ENABLED: z.coerce.boolean().default(false),
  TRADING_MODE: z.enum(['off', 'shadow', 'paper', 'live']).default('off'),
  ALCHEMY_API_KEY: z.string().optional(),
  ALCHEMY_RPC_URL: z.string().default('https://polygon-mainnet.g.alchemy.com/v2'),
  ALCHEMY_WS_URL: z.string().default('wss://polygon-mainnet.g.alchemy.com/v2'),
  ALCHEMY_RPC_RPS: z.coerce.number().int().positive().default(125),
  QUICKNODE_RPC_URL: z.string().optional(),
  QUICKNODE_RPC_RPS: z.coerce.number().int().positive().default(10),
  CHAINSTACK_RPC_URL: z.string().default('https://polygon-mainnet.chainstacklabs.com'),
  CHAINSTACK_WS_URL: z.string().default('wss://polygon-mainnet.chainstacklabs.com'),
  CHAINSTACK_RPC_RPS: z.coerce.number().int().positive().default(600),
  ANKR_RPC_URL: z.string().default('https://rpc.ankr.com/polygon'),
  ANKR_RPC_RPS_PHASE1: z.coerce.number().int().positive().default(30),
  ANKR_RPC_RPS_PHASE2: z.coerce.number().int().positive().default(1500),
  PRIVATE_RPC_URL: z.string().default('http://localhost:8545'),
  PRIVATE_WS_URL: z.string().default('ws://localhost:8545'),
  PRIVATE_RPC_RPS: z.coerce.number().int().positive().default(10000),
  RPC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  RPC_WAIT_CONFIRMATIONS: z.coerce.number().int().positive().default(1),
  RPC_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE1: z.coerce.number().int().positive().default(5),
  RPC_CIRCUIT_TIMEOUT_MS_PHASE1: z.coerce.number().int().positive().default(60000),
  RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE1: z.coerce.number().int().positive().default(3),
  RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE2: z.coerce.number().int().positive().default(3),
  RPC_CIRCUIT_TIMEOUT_MS_PHASE2: z.coerce.number().int().positive().default(30000),
  RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE2: z.coerce.number().int().positive().default(5),
  RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3: z.coerce.number().int().positive().default(2),
  RPC_CIRCUIT_TIMEOUT_MS_PHASE3: z.coerce.number().int().positive().default(15000),
  RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE3: z.coerce.number().int().positive().default(10),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_PASSPHRASE: z.string().optional(),
  POLYMARKET_DATA_API_BASE_URL: z.string().default('https://data-api.polymarket.com'),
  POLYMARKET_DATA_API_POSITIONS_PATH: z.string().default('/positions'),
  POLYMARKET_DATA_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  POLYMARKET_DATA_API_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(300),
  POLYMARKET_DATA_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  POLYMARKET_DATA_API_RETRY_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  POLYMARKET_DATA_API_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  POLYMARKET_DATA_API_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  POLYMARKET_POSITIONS_USER: z.string().optional(),
  POLYMARKET_POSITIONS_SIZE_THRESHOLD: z.coerce.number().min(0).default(0),
  POLYMARKET_POSITIONS_LIMIT: z.coerce.number().int().min(1).max(500).default(200),
  POLYMARKET_POSITIONS_OFFSET: z.coerce.number().int().min(0).max(10000).default(0),
  PHASE2_CROSS_VENUE_ENABLED: z.coerce.boolean().default(false),
  KALSHI_API_KEY_ID: z.string().optional(),
  KALSHI_PRIVATE_KEY_PEM: z.string().optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;
export type TradingMode = Env['TRADING_MODE'];
export const ENV_SCHEMA_KEYS = Object.freeze(Object.keys(envSchema.shape));

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
    const apiKeySegment = `/${env.ALCHEMY_API_KEY}`;
    if (env.ALCHEMY_RPC_URL.includes(apiKeySegment)) {
      throw new Error(
        'Invalid environment configuration: ALCHEMY_RPC_URL must be the base URL (do not include ALCHEMY_API_KEY)'
      );
    }
    if (env.ALCHEMY_WS_URL.includes(apiKeySegment)) {
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
