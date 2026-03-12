import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MARKET_PAIRS } from '../config/markets.js';
import type { MarketPair } from '../domain/market.js';
import { normalizeOptionalString, normalizeTags } from './MarketCatalogMetadata.js';

interface MarketCatalogOptions {
  filePath?: string;
}

export class MarketCatalog {
  constructor(private options: MarketCatalogOptions = {}) {}

  loadPairs(): MarketPair[] {
    const filePairs = this.options.filePath
      ? this.loadFromFile(this.options.filePath)
      : [];
    return dedupe([...MARKET_PAIRS, ...filePairs]);
  }

  private loadFromFile(path: string): MarketPair[] {
    try {
      const raw = readFileSync(resolve(path), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('market catalog JSON must be an array');
      }
      return parsed
        .map(toMarketPair)
        .filter((pair): pair is MarketPair => pair !== null);
    } catch {
      return [];
    }
  }
}

function toMarketPair(value: unknown): MarketPair | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.marketId !== 'string' ||
    typeof record.yesTokenId !== 'string' ||
    typeof record.noTokenId !== 'string'
  ) {
    return null;
  }

  const marketId = record.marketId.trim();
  const yesTokenId = record.yesTokenId.trim();
  const noTokenId = record.noTokenId.trim();
  if (!marketId || !yesTokenId || !noTokenId) return null;

  const question = normalizeOptionalString(record.question);
  const category = normalizeOptionalString(record.category);
  const tags = normalizeTags(record.tags);

  return (
    {
      marketId,
      yesTokenId,
      noTokenId,
      ...(question ? { question } : {}),
      ...(category ? { category } : {}),
      ...(tags ? { tags } : {})
    }
  );
}

function dedupe(pairs: MarketPair[]): MarketPair[] {
  const seen = new Map<string, MarketPair>();
  for (const pair of pairs) {
    const previous = seen.get(pair.marketId);
    seen.set(pair.marketId, mergePair(previous, pair));
  }
  return Array.from(seen.values());
}

function mergePair(previous: MarketPair | undefined, incoming: MarketPair): MarketPair {
  if (!previous) return incoming;
  const question = incoming.question ?? previous.question;
  const category = incoming.category ?? previous.category;
  const tags = incoming.tags ?? previous.tags;
  return {
    marketId: incoming.marketId,
    yesTokenId: incoming.yesTokenId,
    noTokenId: incoming.noTokenId,
    ...(question ? { question } : {}),
    ...(category ? { category } : {}),
    ...(tags ? { tags } : {})
  };
}
