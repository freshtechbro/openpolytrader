import { existsSync, statSync } from 'node:fs';

import { loadEnvWithOverrides } from '../config/env.js';
import { generateMarketCatalog } from './marketCatalogGenerator.js';

const DEFAULT_PRESTART_MAX_AGE_MS = 21600000;

type PrestartEnv = {
  MARKET_CATALOG_PATH?: string;
  MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS?: number;
  MARKET_CATALOG_PRESTART_MAX_AGE_MS?: number;
};

export function runMarketCatalogPrestart(deps?: {
  loadEnv?: () => PrestartEnv;
  generateMarketCatalog?: typeof generateMarketCatalog;
  pathExists?: (path: string) => boolean;
  readMtimeMs?: (path: string) => number;
  nowMs?: () => number;
}): Promise<void> {
  const loadEnvFn = deps?.loadEnv ?? (() => loadEnvWithOverrides({ TRADING_ENABLED: 'false', TRADING_MODE: 'off' }));
  const generateFn = deps?.generateMarketCatalog ?? generateMarketCatalog;
  const pathExists = deps?.pathExists ?? existsSync;
  const readMtimeMs = deps?.readMtimeMs ?? ((path: string) => statSync(path).mtimeMs);
  const nowMs = deps?.nowMs ?? (() => Date.now());

  const env = loadEnvFn();

  const outPath = env.MARKET_CATALOG_PATH?.trim();
  if (!outPath) {
    // eslint-disable-next-line no-console
    console.log('Market catalog prestart skipped (MARKET_CATALOG_PATH not set)');
    return Promise.resolve();
  }

  const fileExists = pathExists(outPath);
  const bootstrapMaxPairs = env.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS ?? 80;
  const maxAgeMs = Math.max(env.MARKET_CATALOG_PRESTART_MAX_AGE_MS ?? DEFAULT_PRESTART_MAX_AGE_MS, 0);
  const staleCheck = fileExists ? getCatalogStaleness(outPath, maxAgeMs, nowMs(), readMtimeMs) : null;

  if (fileExists && staleCheck && !staleCheck.stale) {
    // eslint-disable-next-line no-console
    console.log(
      `Market catalog prestart skipped (fresh ageMs=${Math.round(staleCheck.ageMs)} maxAgeMs=${maxAgeMs})`
    );
    return Promise.resolve();
  }

  // Conservative overwrite refresh:
  // - only when file is missing/stale by age gate
  // - bootstrap with configured max pairs
  // - only outcomes exactly Yes/No
  // - near-zero mode with orderbook + metadata verification
  return generateFn({
    outPath,
    mode: 'near-zero',
    merge: false,
    maxPairs: bootstrapMaxPairs,
    yesnoOnly: true,
    verifyBooks: true,
    requireMetadata: true
  }).then((result) => {
    const reason = !fileExists ? 'missing' : 'stale';
    const ageSuffix = staleCheck ? ` ageMs=${Math.round(staleCheck.ageMs)} maxAgeMs=${maxAgeMs}` : '';
    // eslint-disable-next-line no-console
    console.log(
      `Market catalog prestart completed: out=${result.outPath} pairs=${result.pairs.length} pages=${result.pagesScanned} merged=${result.merged} reason=${reason}${ageSuffix}`
    );
  });
}

function getCatalogStaleness(
  path: string,
  maxAgeMs: number,
  nowMs: number,
  readMtimeMs: (path: string) => number
): { stale: boolean; ageMs: number } {
  if (maxAgeMs === 0) {
    return { stale: true, ageMs: Number.POSITIVE_INFINITY };
  }

  try {
    const mtimeMs = readMtimeMs(path);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
      return { stale: true, ageMs: Number.POSITIVE_INFINITY };
    }
    const ageMs = Math.max(0, nowMs - mtimeMs);
    return { stale: ageMs >= maxAgeMs, ageMs };
  } catch {
    return { stale: true, ageMs: Number.POSITIVE_INFINITY };
  }
}
