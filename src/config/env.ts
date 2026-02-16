import { z } from 'zod';

function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') return undefined;
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
      return value;
    }
    if (typeof value === 'number') return value !== 0;
    return value;
  }, z.boolean().default(defaultValue));
}

const riskProfileSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return undefined;
    const canonical = normalized.replace(/-/g, '_');
    if (canonical === 'default') return 'extra_high';
    return canonical;
  }
  return value;
}, z.enum(['near_zero', 'moderate', 'high', 'extra_high']).default('extra_high'));

const llmEndpointSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === 'chat' || normalized === 'chat.completions' || normalized === 'completions') {
    return 'chat.completions';
  }
  if (normalized === 'messages') return 'messages';
  if (normalized === 'responses') return 'responses';
  return value;
}, z.enum(['chat.completions', 'messages', 'responses']).optional());

const marketCatalogOrderSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === 'volume' || normalized === 'volume24hr') return 'volume24hr';
  if (normalized === 'newest' || normalized === 'recent' || normalized === 'latest') return 'newest';
  return value;
}, z.enum(['volume24hr', 'newest']).default('volume24hr'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPS_API_ENABLED: envBoolean(true),
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
  OPS_BOOK_REFRESH_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
  OPS_BOOK_REFRESH_STALE_MS: z.coerce.number().int().min(0).default(10000),
  OPS_BOOK_STALE_QUARANTINE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  OPS_BOOK_STALE_QUARANTINE_WINDOW_MS: z.coerce.number().int().min(1000).default(300000),
  OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS: z.coerce.number().int().min(0).default(0),
  METRICS_MAX_EVENTS: z.coerce.number().int().positive().default(1000),
  INCIDENTS_MAX_EVENTS: z.coerce.number().int().positive().default(1000),
  ALLOWLIST_AUTO_RESUME: envBoolean(true),
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
  MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS: z.coerce.number().int().min(1).max(2000).default(80),
  MARKET_CATALOG_MIN_VOLUME_24H: z.coerce.number().min(0).default(1000),
  MARKET_CATALOG_MAX_SPREAD: z.coerce.number().min(0).max(1).default(0.02),
  MARKET_CATALOG_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  MARKET_CATALOG_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(5),
  MARKET_CATALOG_ORDER: marketCatalogOrderSchema,
  MARKET_CATALOG_EXCLUDE_ENDED_MARKETS: envBoolean(false),
  MARKET_CATALOG_EXPLORATION_ENABLED: envBoolean(true),
  MARKET_CATALOG_EXPLORATION_MAX_PAIRS: z.coerce.number().int().min(0).max(500).default(30),
  MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H: z.coerce.number().min(0).default(1000),
  MARKET_CATALOG_EXPLORATION_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(3),
  MARKET_CATALOG_PRESTART_MAX_AGE_MS: z.coerce.number().int().min(0).default(21600000),
  GAMMA_API_BASE_URL: z.string().default('https://gamma-api.polymarket.com'),
  TRADING_ENABLED: envBoolean(true),
  TRADING_MODE: z.enum(['off', 'shadow', 'paper', 'live']).default('shadow'),
  RISK_PROFILE: riskProfileSchema,
  RISK_PROFILE_PATH: z.string().optional(),
  RISK_PROFILE_ACTIVE_PATH: z.string().optional(),
  MAX_CONCURRENT_MARKETS: z.coerce.number().int().positive().default(3),
  MAX_CAPITAL_IN_FLIGHT: z.coerce.number().int().positive().default(1000),

  // EV web search (direct API)
  EXA_API_KEY: z.string().optional(),
  EXA_BASE_URL: z.string().default('https://api.exa.ai'),
  EXA_SEARCH_PATH: z.string().default('/search'),
  EXA_CONTENTS_PATH: z.string().default('/contents'),
  EXA_COOLDOWN_MS: z.coerce.number().int().min(0).default(300000),
  EXA_COOLDOWN_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(1),
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_BASE_URL: z.string().default('https://api.firecrawl.dev'),
  FIRECRAWL_SEARCH_PATH: z.string().default('/v2/search'),
  FIRECRAWL_SCRAPE_PATH: z.string().default('/v2/scrape'),
  FIRECRAWL_CRAWL_PATH: z.string().default('/v2/crawl'),
  FIRECRAWL_CRAWL_ENABLED: envBoolean(false),
  EV_WEBSEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  EV_WEBSEARCH_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  EV_WEBSEARCH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  EV_WEBSEARCH_MAX_CONTENT_BYTES: z.coerce.number().int().positive().default(500000),
  EV_WEBSEARCH_DOMAIN_ALLOWLIST: z.string().optional(),
  EV_WEBSEARCH_DOMAIN_DENYLIST: z.string().optional(),

  // LLM (advisory-only; enabled by default, but runtime requires a key)
  LLM_ENABLED: envBoolean(true),
  LLM_DATA_EXPORT_ENABLED: envBoolean(true),
  LLM_PRIMARY_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_FALLBACK_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('openrouter'),
  LLM_PRIMARY_BASE_URL: z.string().default('https://opencode.ai/zen/v1'),
  LLM_FALLBACK_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  LLM_PRIMARY_API_KEY: z.string().optional(),
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_ENABLED: envBoolean(false),
  LLM_PRIMARY_RETRY_COUNT: z.coerce.number().int().min(0).default(1),
  LLM_OPENROUTER_SORT: z.enum(['latency', 'price', 'throughput']).default('latency'),
  LLM_OPENROUTER_ALLOW_FALLBACKS: envBoolean(true),
  LLM_OPENROUTER_HTTP_REFERER: z.string().optional(),
  LLM_OPENROUTER_X_TITLE: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(1),
  LLM_CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  LLM_CB_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  LLM_CB_HALF_OPEN_SUCCESSES: z.coerce.number().int().positive().default(2),

  LLM_EXECUTION_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_EXECUTION_MODEL: z.string().default('kimi-k2.5'),
  LLM_EXECUTION_MODE: z.enum(['disabled', 'shadow', 'advisory']).default('advisory'),
  LLM_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  LLM_EXECUTION_MODEL_BACKUP: z.string().optional(),
  LLM_EXECUTION_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_EXECUTION_FALLBACK_PROVIDER_MODEL: z.string().optional(),

  LLM_RISK_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_RISK_MODEL: z.string().default('minimax-m2.1'),
  LLM_RISK_MODE: z.enum(['disabled', 'shadow', 'advisory']).default('advisory'),
  LLM_RISK_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  LLM_RISK_MODEL_BACKUP: z.string().optional(),
  LLM_RISK_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_RISK_FALLBACK_PROVIDER_MODEL: z.string().optional(),

  LLM_SCANNER_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_SCANNER_MODEL: z.string().default('glm-4.7'),
  LLM_SCANNER_MODE: z.enum(['disabled', 'shadow', 'advisory']).default('advisory'),
  LLM_SCANNER_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  LLM_SCANNER_SCORE_TOP_N: z.coerce.number().int().min(0).default(20),
  LLM_SCANNER_SCORE_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  LLM_SCANNER_SHADOW_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(500),
  LLM_SCANNER_MODEL_BACKUP: z.string().optional(),
  LLM_SCANNER_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_SCANNER_FALLBACK_PROVIDER_MODEL: z.string().optional(),

  LLM_LEARNING_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_LEARNING_MODEL: z.string().default('kimi-k2.5'),
  LLM_LEARNING_MODE: z.enum(['disabled', 'active']).default('active'),
  LLM_LEARNING_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  LLM_LEARNING_MODEL_BACKUP: z.string().optional(),
  LLM_LEARNING_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_LEARNING_FALLBACK_PROVIDER_MODEL: z.string().default('qwen/qwen3-coder-next'),

  LLM_PORTFOLIO_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_PORTFOLIO_MODEL: z.string().default('minimax-m2.1'),
  LLM_PORTFOLIO_MODE: z.enum(['disabled', 'advisory']).default('advisory'),
  LLM_PORTFOLIO_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  LLM_PORTFOLIO_MODEL_BACKUP: z.string().optional(),
  LLM_PORTFOLIO_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_PORTFOLIO_FALLBACK_PROVIDER_MODEL: z.string().optional(),

  LLM_MARKETDATA_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_MARKETDATA_MODEL: z.string().default('glm-4.7'),
  LLM_MARKETDATA_MODE: z.enum(['disabled', 'advisory']).default('advisory'),
  LLM_MARKETDATA_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  LLM_MARKETDATA_MODEL_BACKUP: z.string().optional(),
  LLM_MARKETDATA_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_MARKETDATA_FALLBACK_PROVIDER_MODEL: z.string().optional(),

  LLM_OPS_PROVIDER: z.enum(['opencode-zen', 'openrouter']).default('opencode-zen'),
  LLM_OPS_MODEL: z.string().default('glm-4.7'),
  LLM_OPS_MODE: z.enum(['disabled', 'advisory']).default('advisory'),
  LLM_OPS_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  LLM_OPS_MODEL_BACKUP: z.string().optional(),
  LLM_OPS_ENDPOINT_BACKUP: llmEndpointSchema,
  LLM_OPS_FALLBACK_PROVIDER_MODEL: z.string().optional(),

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
  PHASE2_CROSS_VENUE_ENABLED: envBoolean(false),
  KALSHI_API_KEY_ID: z.string().optional(),
  KALSHI_PRIVATE_KEY_PEM: z.string().optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().optional(),

  // Optional L1 wallet for deriving/rotating CLOB API credentials
  POLYMARKET_L1_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_L1_NONCE: z.coerce.number().int().min(0).optional()
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
