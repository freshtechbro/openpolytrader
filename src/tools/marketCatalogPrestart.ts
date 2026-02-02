import { existsSync } from 'node:fs';

import { loadEnvWithOverrides } from '../config/env.js';
import { generateMarketCatalog } from './marketCatalogGenerator.js';

export async function runMarketCatalogPrestart(deps?: {
  loadEnv?: () => { MARKET_CATALOG_PATH?: string; MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS?: number };
  generateMarketCatalog?: typeof generateMarketCatalog;
  pathExists?: (path: string) => boolean;
}): Promise<void> {
  const loadEnvFn = deps?.loadEnv ?? (() => loadEnvWithOverrides({ TRADING_ENABLED: 'false', TRADING_MODE: 'off' }));
  const generateFn = deps?.generateMarketCatalog ?? generateMarketCatalog;
  const pathExists = deps?.pathExists ?? existsSync;

  const env = loadEnvFn();

  const outPath = env.MARKET_CATALOG_PATH?.trim();
  if (!outPath) {
    // eslint-disable-next-line no-console
    console.log('[prestart] market catalog: skipped (MARKET_CATALOG_PATH not set)');
    return;
  }

  const fileExists = pathExists(outPath);
  const bootstrapMaxPairs = env.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS ?? 80;

  // Conservative default:
  // - merge only (never remove existing pairs)
  // - preserve existing count (generator default in merge mode)
  // - bootstrap conservatively when no file exists yet
  // - only outcomes exactly Yes/No
  // - near-zero mode with orderbook + metadata verification
  const result = await generateFn({
    outPath,
    mode: 'near-zero',
    merge: true,
    maxPairs: fileExists ? undefined : bootstrapMaxPairs,
    yesnoOnly: true,
    verifyBooks: true,
    requireMetadata: true
  });

  // eslint-disable-next-line no-console
  console.log(
    `[prestart] market catalog: out=${result.outPath} pairs=${result.pairs.length} pages=${result.pagesScanned} merged=${result.merged}`
  );
}
