import { z } from 'zod';

import { envBoolean, marketCatalogOrderSchema } from './shared.js';

export const marketCatalogEnvShape = {
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
  GAMMA_API_BASE_URL: z.string().optional()
};
