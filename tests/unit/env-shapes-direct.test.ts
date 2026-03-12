import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { coreEnvShape } from '../../src/config/env/coreEnv.js';
import { llmEnvShape } from '../../src/config/env/llmEnv.js';
import { marketCatalogEnvShape } from '../../src/config/env/marketCatalogEnv.js';
import { opsEnvShape } from '../../src/config/env/opsEnv.js';
import { polymarketEnvShape } from '../../src/config/env/polymarketEnv.js';
import { rpcEnvShape } from '../../src/config/env/rpcEnv.js';
import { envBoolean, llmEndpointSchema, marketCatalogOrderSchema, riskProfileSchema } from '../../src/config/env/shared.js';
import { webSearchEnvShape } from '../../src/config/env/webSearchEnv.js';

describe('direct env shape coverage', () => {
  it('parses core env defaults and coercions', () => {
    const parsed = z.object(coreEnvShape).parse({
      ALLOWLIST_AUTO_RESUME: 'false',
      TRADING_ENABLED: 'true',
      PORT: '3100'
    });

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.PORT).toBe(3100);
    expect(parsed.ALLOWLIST_AUTO_RESUME).toBe(false);
    expect(parsed.TRADING_ENABLED).toBe(true);
    expect(parsed.TRADING_MODE).toBe('shadow');
  });

  it('parses llm env defaults, enums, booleans, and optional overrides', () => {
    const parsed = z.object(llmEnvShape).parse({
      LLM_ENABLED: 'false',
      LLM_PRIMARY_PROVIDER: 'openrouter',
      LLM_PRIMARY_RETRY_COUNT: '2',
      LLM_PRIMARY_BASE_URL: 'https://override.example.com'
    });

    expect(parsed.LLM_ENABLED).toBe(false);
    expect(parsed.LLM_PRIMARY_PROVIDER).toBe('openrouter');
    expect(parsed.LLM_PRIMARY_RETRY_COUNT).toBe(2);
    expect(parsed.LLM_PRIMARY_BASE_URL).toBe('https://override.example.com');
    expect(parsed.LLM_EXECUTION_MODEL).toBe('kimi-k2.5');
    expect(parsed.LLM_LEARNING_MODE).toBe('active');
  });

  it('parses market catalog env defaults and bounded options', () => {
    const parsed = z.object(marketCatalogEnvShape).parse({
      MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS: '120',
      MARKET_CATALOG_EXPLORATION_ENABLED: 'false',
      GAMMA_API_BASE_URL: 'https://gamma.example.com'
    });

    expect(parsed.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS).toBe(120);
    expect(parsed.MARKET_CATALOG_EXPLORATION_ENABLED).toBe(false);
    expect(parsed.MARKET_CATALOG_ORDER).toBe('volume24hr');
    expect(parsed.GAMMA_API_BASE_URL).toBe('https://gamma.example.com');
  });

  it('parses ops env defaults and timing overrides', () => {
    const parsed = z.object(opsEnvShape).parse({
      OPS_API_ENABLED: 'true',
      OPS_HEALTH_INTERVAL_MS: '15000',
      OPS_BOOK_REFRESH_INTERVAL_MS: '2500'
    });

    expect(parsed.OPS_API_ENABLED).toBe(true);
    expect(parsed.OPS_API_HOST).toBe('0.0.0.0');
    expect(parsed.OPS_HEALTH_INTERVAL_MS).toBe(15000);
    expect(parsed.OPS_BOOK_REFRESH_INTERVAL_MS).toBe(2500);
    expect(parsed.METRICS_MAX_EVENTS).toBe(1000);
  });

  it('parses polymarket env defaults and websocket/retry overrides', () => {
    const parsed = z.object(polymarketEnvShape).parse({
      POLYMARKET_CLOB_TIMEOUT_MS: '9000',
      POLYMARKET_WS_RECONNECT_JITTER_PCT: '0.5',
      POLYMARKET_L1_NONCE: '4'
    });

    expect(parsed.POLYMARKET_CLOB_TIMEOUT_MS).toBe(9000);
    expect(parsed.POLYMARKET_CLOB_ORDER_PATH).toBe('/orders');
    expect(parsed.POLYMARKET_WS_RECONNECT_JITTER_PCT).toBe(0.5);
    expect(parsed.POLYMARKET_L1_NONCE).toBe(4);
  });

  it('parses rpc env defaults and provider rate limits', () => {
    const parsed = z.object(rpcEnvShape).parse({
      ALCHEMY_RPC_RPS: '200',
      RPC_WAIT_TIMEOUT_MS: '45000'
    });

    expect(parsed.ALCHEMY_RPC_RPS).toBe(200);
    expect(parsed.CHAINSTACK_RPC_RPS).toBe(600);
    expect(parsed.RPC_WAIT_TIMEOUT_MS).toBe(45000);
    expect(parsed.RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3).toBe(2);
  });

  it('normalizes shared env preprocessors and web search defaults', () => {
    expect(envBoolean(true).parse('off')).toBe(false);
    expect(envBoolean(false).parse('yes')).toBe(true);
    expect(riskProfileSchema.parse('near_zero')).toBe('near_zero');
    expect(llmEndpointSchema.parse('chat.completions')).toBe('chat.completions');
    expect(marketCatalogOrderSchema.parse('newest')).toBe('newest');
    expect(() => riskProfileSchema.parse('default')).toThrow();
    expect(() => riskProfileSchema.parse('near-zero')).toThrow();
    expect(() => llmEndpointSchema.parse('chat')).toThrow();
    expect(() => marketCatalogOrderSchema.parse('recent')).toThrow();

    const parsed = z.object(webSearchEnvShape).parse({
      FIRECRAWL_CRAWL_ENABLED: 'true',
      EV_WEBSEARCH_REQUESTS_PER_MINUTE: '45',
      SERPER_BASE_URL: 'https://serper.example.com'
    });

    expect(parsed.FIRECRAWL_CRAWL_ENABLED).toBe(true);
    expect(parsed.EXA_SEARCH_PATH).toBe('/search');
    expect(parsed.SERPER_BASE_URL).toBe('https://serper.example.com');
    expect(parsed.SERPER_NEWS_PATH).toBe('/news');
    expect(parsed.GDELT_BASE_URL).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(parsed.EV_WEBSEARCH_REQUESTS_PER_MINUTE).toBe(45);
    expect(parsed.FW_ORACLE_TIMEOUT_MS).toBe(120);
  });
});
