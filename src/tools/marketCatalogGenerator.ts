import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadEnvWithOverrides } from '../config/env.js';
import { PolymarketClob } from '../services/PolymarketClob.js';

export type MarketPair = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  category?: string;
};

type RawMarket = {
  enable_order_book?: boolean;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  condition_id?: string;
  tags?: unknown;
  tokens?: Array<{ token_id?: string; outcome?: string }>;
};

type MarketsPage = {
  data: RawMarket[];
  next_cursor?: string | null;
  count?: number;
};

export type GeneratorMode = 'near-zero' | 'binary' | 'any';

export type GeneratorArgs = {
  outPath?: string;
  maxPairs?: number;
  tag?: string;
  yesnoOnly?: boolean;
  mode?: GeneratorMode;
  merge?: boolean;
  verifyBooks?: boolean;
  requireMetadata?: boolean;
};

export function parseGeneratorArgs(argv: string[]): GeneratorArgs & { help?: boolean } {
  const args = argv.slice(2);
  const result: GeneratorArgs & { help?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      const value = args[++i];
      if (!value) throw new Error('Missing value for --out');
      result.outPath = value;
      continue;
    }
    if (arg === '--max') {
      const value = args[++i];
      if (!value) throw new Error('Missing value for --max');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--max must be a positive number');
      result.maxPairs = Math.floor(parsed);
      continue;
    }
    if (arg === '--tag') {
      const value = args[++i];
      if (!value) throw new Error('Missing value for --tag');
      result.tag = value;
      continue;
    }
    if (arg === '--yesno-only') {
      result.yesnoOnly = true;
      continue;
    }
    if (arg === '--mode') {
      const value = args[++i];
      if (value !== 'near-zero' && value !== 'binary' && value !== 'any') {
        throw new Error('--mode must be one of: near-zero | binary | any');
      }
      result.mode = value;
      continue;
    }
    if (arg === '--merge') {
      result.merge = true;
      continue;
    }
    if (arg === '--overwrite') {
      result.merge = false;
      continue;
    }
    if (arg === '--verify-books') {
      result.verifyBooks = true;
      continue;
    }
    if (arg === '--no-verify-books') {
      result.verifyBooks = false;
      continue;
    }
    if (arg === '--require-metadata') {
      result.requireMetadata = true;
      continue;
    }
    if (arg === '--allow-fallback-metadata') {
      result.requireMetadata = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return result;
}

export function printGeneratorHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`market-catalog-generator

Generates a MarketPair JSON catalog for MARKET_CATALOG_PATH by scanning Polymarket CLOB markets.

Usage:
  npx tsx src/tools/marketCatalogGeneratorCli.ts [options]
  node dist/tools/marketCatalogGeneratorCli.js [options]

Options:
  --out, -o          Output JSON path (default: env MARKET_CATALOG_PATH or data/market-catalog.json)
  --max              Stop after N pairs are collected (default: existing file size when --merge, else 200)
  --tag              Only include markets whose tags include this string (case-insensitive)
  --yesno-only       Only include markets whose outcomes are exactly Yes/No (more conservative)
  --mode             near-zero | binary | any (default: near-zero)
  --merge            Merge new pairs into existing file (never removes)
  --overwrite        Replace the output file (default)
  --verify-books     Verify both token orderbooks exist + have asks (default for near-zero)
  --no-verify-books  Skip orderbook verification
  --require-metadata           Require tick_size + min_order_size from /book (default for near-zero)
  --allow-fallback-metadata    Allow missing metadata (fallbacks may be used at runtime)
`);
}

export function cursorForOffset(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return Buffer.from(String(offset)).toString('base64');
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasTag(market: RawMarket, filter?: string): boolean {
  if (!filter) return true;
  if (!Array.isArray(market.tags)) return false;
  const normalized = filter.trim().toLowerCase();
  for (const entry of market.tags) {
    const tag = normalizeTag(entry);
    if (!tag) continue;
    if (tag.toLowerCase().includes(normalized)) return true;
  }
  return false;
}

function pickCategory(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const entry of tags) {
    const tag = normalizeTag(entry);
    if (!tag) continue;
    if (tag.toLowerCase() === 'all') continue;
    return tag;
  }
  return undefined;
}

function isYes(value?: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'yes';
}

function isNo(value?: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'no';
}

export function marketToPair(market: RawMarket, opts: { mode: GeneratorMode; yesnoOnly: boolean }): MarketPair | null {
  if (!market.condition_id) return null;

  if (opts.mode !== 'any') {
    if (!market.active) return null;
    if (market.closed) return null;
    if (market.archived) return null;
    if (!market.accepting_orders) return null;
  }

  if (opts.mode === 'near-zero') {
    if (!market.enable_order_book) return null;
  }

  const tokens = market.tokens;
  if (!Array.isArray(tokens) || tokens.length !== 2) return null;

  const [a, b] = tokens;
  if (!a?.token_id || !b?.token_id) return null;

  const aOutcome = typeof a.outcome === 'string' ? a.outcome : '';
  const bOutcome = typeof b.outcome === 'string' ? b.outcome : '';

  if (opts.yesnoOnly) {
    const ok = (isYes(aOutcome) && isNo(bOutcome)) || (isNo(aOutcome) && isYes(bOutcome));
    if (!ok) return null;
  }

  let yesTokenId = a.token_id;
  let noTokenId = b.token_id;

  if (isYes(aOutcome) && isNo(bOutcome)) {
    yesTokenId = a.token_id;
    noTokenId = b.token_id;
  } else if (isNo(aOutcome) && isYes(bOutcome)) {
    yesTokenId = b.token_id;
    noTokenId = a.token_id;
  } else {
    const sorted = [
      { tokenId: a.token_id, outcome: aOutcome },
      { tokenId: b.token_id, outcome: bOutcome }
    ].sort((left, right) => {
      const outcomeCompare = left.outcome.localeCompare(right.outcome, undefined, { sensitivity: 'base' });
      if (outcomeCompare !== 0) return outcomeCompare;
      return left.tokenId.localeCompare(right.tokenId);
    });
    yesTokenId = sorted[0].tokenId;
    noTokenId = sorted[1].tokenId;
  }

  return {
    marketId: market.condition_id,
    yesTokenId,
    noTokenId,
    category: pickCategory(market.tags)
  };
}

export function mergePairs(existing: MarketPair[], incoming: MarketPair[], maxPairs?: number): MarketPair[] {
  const next: MarketPair[] = [];
  const seen = new Set<string>();

  for (const pair of existing) {
    if (!seen.has(pair.marketId)) {
      seen.add(pair.marketId);
      next.push(pair);
    }
  }

  for (const pair of incoming) {
    if (!seen.has(pair.marketId)) {
      seen.add(pair.marketId);
      next.push(pair);
    }
    if (maxPairs && next.length >= maxPairs) break;
  }

  return maxPairs ? next.slice(0, maxPairs) : next;
}

export function readPairsFromFile(path: string): MarketPair[] {
  try {
    const raw = readFileSync(resolve(path), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMarketPair);
  } catch {
    return [];
  }
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
    throw new Error(`CLOB markets fetch failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as MarketsPage;
  if (!Array.isArray(json.data)) {
    throw new Error('Unexpected CLOB /markets response: missing data[]');
  }
  return json;
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

async function verifyOrderbooksWithOptions(
  clob: PolymarketClob,
  pair: MarketPair,
  options: { requireMetadata: boolean }
): Promise<boolean> {
  try {
    const [yesBook, noBook] = await Promise.all([
      clob.getOrderBook(pair.yesTokenId),
      clob.getOrderBook(pair.noTokenId)
    ]);

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
  } catch {
    return false;
  }
}

function ensureParentDirExists(_path: string): void {
  const parent = dirname(resolve(_path));
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export async function generateMarketCatalog(args: GeneratorArgs = {}): Promise<{
  outPath: string;
  pairs: MarketPair[];
  pagesScanned: number;
  mode: GeneratorMode;
  merged: boolean;
  maxPairs: number;
}> {
  const env = loadEnvWithOverrides({
    TRADING_ENABLED: 'false',
    TRADING_MODE: 'off'
  });

  const baseUrl = env.POLYMARKET_CLOB_BASE_URL.replace(/\/$/, '');
  const mode: GeneratorMode = args.mode ?? 'near-zero';
  const yesnoOnly = Boolean(args.yesnoOnly);
  const verifyBooks = args.verifyBooks ?? mode === 'near-zero';
  const requireMetadata = args.requireMetadata ?? mode === 'near-zero';
  const outPath = resolve(args.outPath ?? env.MARKET_CATALOG_PATH ?? 'data/market-catalog.json');
  const merged = Boolean(args.merge);

  const existingPairs = merged && existsSync(outPath) ? readPairsFromFile(outPath) : [];
  const maxPairs = args.maxPairs ?? (merged && existingPairs.length > 0 ? existingPairs.length : 200);

  ensureParentDirExists(outPath);

  if (merged && existingPairs.length >= maxPairs) {
    const finalPairs = existingPairs.slice(0, maxPairs);
    const tmpPath = `${outPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(finalPairs, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, outPath);
    return { outPath, pairs: finalPairs, pagesScanned: 0, mode, merged, maxPairs };
  }

  const clob = new PolymarketClob({
    baseUrl: env.POLYMARKET_CLOB_BASE_URL,
    requestTimeoutMs: env.POLYMARKET_CLOB_TIMEOUT_MS,
    rateLimitPerSecond: env.POLYMARKET_CLOB_RATE_LIMIT_PER_SEC,
    rateLimitWindowMs: env.POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS,
    orderPath: env.POLYMARKET_CLOB_ORDER_PATH,
    batchOrderPath: env.POLYMARKET_CLOB_BATCH_ORDER_PATH,
    cancelOrderPath: env.POLYMARKET_CLOB_CANCEL_ORDER_PATH,
    cancelOrdersPath: env.POLYMARKET_CLOB_CANCEL_ORDERS_PATH,
    cancelAllPath: env.POLYMARKET_CLOB_CANCEL_ALL_PATH,
    cancelMarketOrdersPath: env.POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH,
    activeOrdersPath: env.POLYMARKET_CLOB_ACTIVE_ORDERS_PATH,
    retryMaxRetries: env.POLYMARKET_CLOB_RETRY_MAX_RETRIES,
    retryBaseDelayMs: env.POLYMARKET_CLOB_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: env.POLYMARKET_CLOB_RETRY_MAX_DELAY_MS
  });

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
      if (seenIncoming.has(pair.marketId)) continue;
      if (verifyBooks) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await verifyOrderbooksWithOptions(clob, pair, { requireMetadata });
        if (!ok) continue;
      }
      seenIncoming.add(pair.marketId);
      incoming.push(pair);
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
      throw new Error('Aborting: too many pages while scanning /markets (possible cursor loop)');
    }
  }

  const finalPairs = merged ? mergePairs(existingPairs, incoming, maxPairs) : incoming.slice(0, maxPairs);

  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(finalPairs, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, outPath);

  return { outPath, pairs: finalPairs, pagesScanned, mode, merged, maxPairs };
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
