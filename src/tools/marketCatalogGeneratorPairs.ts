import type { MarketPair } from '../domain/market.js';
import {
  normalizeOptionalString,
  pickCategoryFromTags
} from '../services/MarketCatalogMetadata.js';
import type { GeneratorMode } from './marketCatalogGeneratorArgs.js';

export type RawMarket = {
  enable_order_book?: boolean;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  condition_id?: string;
  question?: unknown;
  tags?: unknown;
  tokens?: Array<{ token_id?: string; outcome?: string }>;
};

function normalizeTag(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['label', 'name', 'slug', 'title']) {
    const candidate = record[key];
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => normalizeTag(entry))
        .filter((entry): entry is string => entry !== null)
    )
  );
}

export function hasTag(market: RawMarket, filter?: string): boolean {
  if (!filter) return true;
  const normalized = filter.trim().toLowerCase();
  for (const tag of normalizeTagList(market.tags)) {
    if (tag.toLowerCase().includes(normalized)) return true;
  }
  return false;
}

function pickCategory(tags: unknown): string | undefined {
  return pickCategoryFromTags(normalizeTagList(tags));
}

function isYes(value?: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'yes';
}

function isNo(value?: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'no';
}

export function marketToPair(
  market: RawMarket,
  opts: { mode: GeneratorMode; yesnoOnly: boolean }
): MarketPair | null {
  if (!market.condition_id) return null;

  if (opts.mode !== 'any') {
    if (!market.active) return null;
    if (market.closed) return null;
    if (market.archived) return null;
    if (!market.accepting_orders) return null;
  }

  if (opts.mode === 'near-zero' && !market.enable_order_book) {
    return null;
  }

  const tokens = market.tokens;
  if (!Array.isArray(tokens) || tokens.length !== 2) return null;

  const [leftToken, rightToken] = tokens;
  if (!leftToken?.token_id || !rightToken?.token_id) return null;

  const leftOutcome = typeof leftToken.outcome === 'string' ? leftToken.outcome : '';
  const rightOutcome = typeof rightToken.outcome === 'string' ? rightToken.outcome : '';

  if (opts.yesnoOnly) {
    const isSupportedPair =
      (isYes(leftOutcome) && isNo(rightOutcome)) ||
      (isNo(leftOutcome) && isYes(rightOutcome));
    if (!isSupportedPair) return null;
  }

  let yesTokenId = leftToken.token_id;
  let noTokenId = rightToken.token_id;

  if (isYes(leftOutcome) && isNo(rightOutcome)) {
    yesTokenId = leftToken.token_id;
    noTokenId = rightToken.token_id;
  } else if (isNo(leftOutcome) && isYes(rightOutcome)) {
    yesTokenId = rightToken.token_id;
    noTokenId = leftToken.token_id;
  } else {
    const sorted = [
      { tokenId: leftToken.token_id, outcome: leftOutcome },
      { tokenId: rightToken.token_id, outcome: rightOutcome }
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
  const indexByMarketId = new Map<string, number>();

  for (const pair of existing) {
    if (indexByMarketId.has(pair.marketId)) continue;
    indexByMarketId.set(pair.marketId, next.length);
    next.push(pair);
  }

  for (const pair of incoming) {
    const existingIndex = indexByMarketId.get(pair.marketId);
    if (existingIndex === undefined) {
      indexByMarketId.set(pair.marketId, next.length);
      next.push(pair);
      if (maxPairs && next.length >= maxPairs) break;
      continue;
    }
    next[existingIndex] = mergePairMetadata(next[existingIndex], pair);
  }

  return maxPairs ? next.slice(0, maxPairs) : next;
}

function mergePairMetadata(existing: MarketPair, incoming: MarketPair): MarketPair {
  const question = incoming.question ?? existing.question;
  const category = incoming.category ?? existing.category;
  const tags = mergeTags(existing.tags, incoming.tags);
  return {
    marketId: existing.marketId,
    yesTokenId: existing.yesTokenId,
    noTokenId: existing.noTokenId,
    ...(question ? { question } : {}),
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {})
  };
}

function mergeTags(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  if (!existing?.length && !incoming?.length) return [];
  if (!existing?.length) return [...(incoming ?? [])];
  if (!incoming?.length) return [...existing];
  return Array.from(new Set([...existing, ...incoming]));
}

export function enrichPairWithMetadata(pair: MarketPair, market: RawMarket): MarketPair {
  const question = normalizeOptionalString(market.question);
  if (!question) return pair;
  const tags = normalizeTagList(market.tags).filter((tag) => tag.toLowerCase() !== 'all');
  return {
    ...pair,
    question,
    ...(tags.length > 0 ? { tags } : {})
  };
}

export function hasRelationMetadata(pair: MarketPair): boolean {
  return typeof pair.question === 'string' && pair.question.trim().length > 0;
}
