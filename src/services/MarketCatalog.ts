import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MARKET_PAIRS } from '../config/markets.js';
import type { MarketPair } from '../domain/market.js';

export interface MarketCatalogOptions {
  filePath?: string;
}

export class MarketCatalog {
  constructor(private options: MarketCatalogOptions = {}) {}

  loadPairs(): MarketPair[] {
    const filePairs = this.options.filePath
      ? this.loadFromFile(this.options.filePath)
      : [];
    const merged = [...MARKET_PAIRS, ...filePairs];
    return dedupe(merged);
  }

  private loadFromFile(path: string): MarketPair[] {
    try {
      const raw = readFileSync(resolve(path), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('market catalog JSON must be an array');
      }
      return parsed.filter(isMarketPair);
    } catch {
      return [];
    }
  }
}

function isMarketPair(value: unknown): value is MarketPair {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.marketId === 'string' &&
    typeof record.yesTokenId === 'string' &&
    typeof record.noTokenId === 'string'
  );
}

function dedupe(pairs: MarketPair[]): MarketPair[] {
  const seen = new Map<string, MarketPair>();
  for (const pair of pairs) {
    if (!seen.has(pair.marketId)) {
      seen.set(pair.marketId, pair);
    }
  }
  return Array.from(seen.values());
}
