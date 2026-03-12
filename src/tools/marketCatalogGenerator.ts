import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadEnvWithOverrides } from '../config/env.js';
import type { MarketPair } from '../domain/market.js';
import type { RawOrderBookSnapshot } from '../domain/orderbook.js';
import type { PolymarketClob } from '../services/PolymarketClob.js';
import { createPolymarketClobFromEnv } from '../services/PolymarketEnvHelpers.js';
import { resolvePolymarketClobBaseUrl } from '../services/PolymarketUrls.js';
import {
  enrichPairWithMetadata,
  hasRelationMetadata,
  hasTag,
  marketToPair,
  mergePairs,
  type RawMarket
} from './marketCatalogGeneratorPairs.js';
import {
  parseGeneratorArgs,
  printGeneratorHelp,
  type GeneratorArgs,
  type GeneratorMode
} from './marketCatalogGeneratorArgs.js';

type MarketsPage = {
  data: RawMarket[];
  next_cursor?: string | null;
  count?: number;
};

type MarketCatalogErrorCode =
  | 'catalog_read_failed'
  | 'catalog_content_invalid'
  | 'markets_fetch_failed'
  | 'markets_response_invalid'
  | 'orderbook_verification_failed'
  | 'scan_aborted';

export class MarketCatalogError extends Error {
  override readonly cause?: unknown;

  constructor(
    message: string,
    public readonly code: MarketCatalogErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'MarketCatalogError';
    this.cause = options?.cause;
  }
}

export {
  parseGeneratorArgs,
  marketToPair,
  mergePairs
};

export function cursorForOffset(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return Buffer.from(String(offset)).toString('base64');
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export function readPairsFromFile(path: string): MarketPair[] {
  const resolvedPath = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new MarketCatalogError(`Failed to read market catalog file at ${resolvedPath}: ${formatUnknownError(error)}`, 'catalog_read_failed', {
      cause: error
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MarketCatalogError(
      `Market catalog file at ${resolvedPath} is not valid JSON: ${formatUnknownError(error)}`,
      'catalog_content_invalid',
      { cause: error }
    );
  }

  if (!Array.isArray(parsed)) {
    throw new MarketCatalogError(`Market catalog file at ${resolvedPath} must contain a JSON array`, 'catalog_content_invalid');
  }

  return parsed.filter(isMarketPair);
}

function isMarketPair(value: unknown): value is MarketPair {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.marketId === 'string' &&
    typeof record.yesTokenId === 'string' &&
    typeof record.noTokenId === 'string' &&
    record.marketId.length > 0 &&
    record.yesTokenId.length > 0 &&
    record.noTokenId.length > 0
  );
}

async function fetchMarketsPage(baseUrl: string, cursor?: string | null): Promise<MarketsPage> {
  const url = cursor ? `${baseUrl}/markets?next_cursor=${encodeURIComponent(cursor)}` : `${baseUrl}/markets`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'openpolytrader/0.1.0'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new MarketCatalogError(`CLOB markets fetch failed (${response.status}): ${text.slice(0, 200)}`, 'markets_fetch_failed');
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new MarketCatalogError(`Unexpected CLOB /markets response: invalid JSON from ${url}`, 'markets_response_invalid', {
      cause: error
    });
  }
  const page = json as Partial<MarketsPage>;
  if (!Array.isArray(page.data)) {
    throw new MarketCatalogError('Unexpected CLOB /markets response: missing data[]', 'markets_response_invalid');
  }
  return page as MarketsPage;
}

export async function findFirstOrderbookEnabledOffset(baseUrl: string, pageSize = 1000): Promise<number | null> {
  const first = await fetchMarketsPage(baseUrl, null);
  const total = typeof first.count === 'number' && Number.isFinite(first.count) ? first.count : null;
  const hasEnabled = first.data.some((market) => market.enable_order_book === true);
  if (hasEnabled) return 0;
  if (!total) return null;

  let lo = 0;
  let hi = pageSize;
  while (hi < total) {
    const cursor = cursorForOffset(hi);
    const page = await fetchMarketsPage(baseUrl, cursor);
    if (page.data.some((market) => market.enable_order_book === true)) {
      break;
    }
    lo = hi;
    hi *= 2;
  }
  if (hi >= total) return null;

  const maxOffset = Math.floor((total - 1) / pageSize) * pageSize;
  hi = Math.min(hi, maxOffset);

  while (hi - lo > pageSize) {
    const mid = lo + Math.floor((hi - lo) / (2 * pageSize)) * pageSize;
    const cursor = cursorForOffset(mid);
    const page = await fetchMarketsPage(baseUrl, cursor);
    if (page.data.some((market) => market.enable_order_book === true)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function verifyOrderbooksWithOptions(
  clob: PolymarketClob,
  pair: MarketPair,
  options: { requireMetadata: boolean }
): Promise<boolean> {
  return Promise.all([
      clob.getOrderBook(pair.yesTokenId),
      clob.getOrderBook(pair.noTokenId)
    ])
    .then(([yesBook, noBook]: [RawOrderBookSnapshot, RawOrderBookSnapshot]) => {
      const yesOk = Array.isArray(yesBook.asks) && yesBook.asks.length > 0;
      const noOk = Array.isArray(noBook.asks) && noBook.asks.length > 0;
      if (!(yesOk && noOk)) return false;

      if (options.requireMetadata) {
        const yesTick = parsePositiveNumber(yesBook.tick_size);
        const noTick = parsePositiveNumber(noBook.tick_size);
        const yesMin = parsePositiveNumber(yesBook.min_order_size);
        const noMin = parsePositiveNumber(noBook.min_order_size);
        return Boolean(yesTick && noTick && yesMin && noMin);
      }

      return true;
    })
    .catch((error: unknown) => {
      throw new MarketCatalogError(
        `Orderbook verification failed for market ${pair.marketId}: ${formatUnknownError(error)}`,
        'orderbook_verification_failed',
        { cause: error }
      );
    });
}

function ensureParentDirExists(_path: string): void {
  const parent = dirname(resolve(_path));
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export function generateMarketCatalog(args: GeneratorArgs = {}): Promise<{
  outPath: string;
  pairs: MarketPair[];
  pagesScanned: number;
  mode: GeneratorMode;
  merged: boolean;
  maxPairs: number;
}> {
  return (async () => {
  const env = loadEnvWithOverrides({
    TRADING_ENABLED: 'false',
    TRADING_MODE: 'off'
  });

  const baseUrl = resolvePolymarketClobBaseUrl(env.POLYMARKET_CLOB_BASE_URL).replace(/\/$/, '');
  const mode: GeneratorMode = args.mode ?? 'near-zero';
  const yesnoOnly = Boolean(args.yesnoOnly);
  const verifyBooks = args.verifyBooks ?? mode === 'near-zero';
  const requireMetadata = args.requireMetadata ?? mode === 'near-zero';
  const outPath = resolve(args.outPath ?? env.MARKET_CATALOG_PATH ?? 'data/market-catalog.json');
  const merged = Boolean(args.merge);

  const existingPairs = merged && existsSync(outPath) ? readPairsFromFile(outPath) : [];
  const maxPairs = args.maxPairs ?? (merged && existingPairs.length > 0 ? existingPairs.length : 200);

  ensureParentDirExists(outPath);

  const existingMetadataReady = existingPairs.every(hasRelationMetadata);
  if (merged && existingPairs.length >= maxPairs && existingMetadataReady) {
    const finalPairs = existingPairs.slice(0, maxPairs);
    const tmpPath = `${outPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(finalPairs, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, outPath);
    return { outPath, pairs: finalPairs, pagesScanned: 0, mode, merged, maxPairs };
  }

  const clob = createPolymarketClobFromEnv(env);

  const incoming: MarketPair[] = [];
  const seenIncoming = new Set<string>();

  let cursor: string | null | undefined = null;
  let pagesScanned = 0;

  if (mode === 'near-zero') {
    const startOffset = await findFirstOrderbookEnabledOffset(baseUrl);
    if (typeof startOffset === 'number' && startOffset > 0) {
      cursor = cursorForOffset(startOffset);
    }
  }

  let keepGoing = true;
  while (keepGoing) {
    const page = await fetchMarketsPage(baseUrl, cursor);
    pagesScanned += 1;

    for (const market of page.data) {
      if (!hasTag(market, args.tag)) continue;
      const pair = marketToPair(market, { mode, yesnoOnly });
      if (!pair) continue;
      const enrichedPair = enrichPairWithMetadata(pair, market);
      if (seenIncoming.has(enrichedPair.marketId)) continue;
      if (verifyBooks) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await verifyOrderbooksWithOptions(clob, enrichedPair, { requireMetadata });
        if (!ok) continue;
      }
      seenIncoming.add(enrichedPair.marketId);
      incoming.push(enrichedPair);
      if (incoming.length >= maxPairs) {
        cursor = null;
        break;
      }
    }

    if (!page.next_cursor) {
      keepGoing = false;
      break;
    }
    if (incoming.length >= maxPairs) {
      keepGoing = false;
      break;
    }
    if (page.next_cursor === cursor) {
      keepGoing = false;
      break;
    }
    cursor = page.next_cursor;

    if (pagesScanned > 500) {
      throw new MarketCatalogError(
        'Aborting: too many pages while scanning /markets (possible cursor loop)',
        'scan_aborted'
      );
    }
  }

  const finalPairs = merged ? mergePairs(existingPairs, incoming, maxPairs) : incoming.slice(0, maxPairs);

  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(finalPairs, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, outPath);

  return { outPath, pairs: finalPairs, pagesScanned, mode, merged, maxPairs };
  })();
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = parseGeneratorArgs(argv);
  if (parsed.help) {
    printGeneratorHelp();
    return;
  }

  const { outPath, pairs, pagesScanned, mode, merged, maxPairs } = await generateMarketCatalog(parsed);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        outPath,
        pairs: pairs.length,
        pagesScanned,
        mode,
        merged,
        maxPairs
      },
      null,
      2
    )
  );
}
