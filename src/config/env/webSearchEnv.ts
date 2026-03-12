import { z } from 'zod';

import { envBoolean } from './shared.js';

export const webSearchEnvShape = {
  EXA_API_KEY: z.string().optional(),
  EXA_BASE_URL: z.string().optional(),
  EXA_SEARCH_PATH: z.string().default('/search'),
  EXA_CONTENTS_PATH: z.string().default('/contents'),
  EXA_COOLDOWN_MS: z.coerce.number().int().min(0).default(300000),
  EXA_COOLDOWN_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(1),
  SERPER_API_KEY: z.string().optional(),
  SERPER_BASE_URL: z.string().optional(),
  SERPER_SEARCH_PATH: z.string().default('/search'),
  SERPER_NEWS_PATH: z.string().default('/news'),
  GDELT_BASE_URL: z.string().default('https://api.gdeltproject.org/api/v2/doc/doc'),
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_BASE_URL: z.string().optional(),
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
  FW_ORACLE_BASE_URL: z.string().optional(),
  FW_ORACLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120),
  FW_ORACLE_API_KEY: z.string().optional(),
  FW_ORACLE_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  FW_ORACLE_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000)
};
