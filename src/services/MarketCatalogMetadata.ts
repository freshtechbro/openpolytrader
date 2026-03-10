import type { MarketPair } from '../domain/market.js';
import type { GammaMarket } from './MarketCatalogTypes.js';

export function enrichExistingPair(existingPair: MarketPair, market: GammaMarket): MarketPair {
  const marketQuestion = normalizeOptionalString(market.question);
  const marketTags = normalizeTags(market.tags);
  const existingTags = existingPair.tags;
  const tags = marketTags ?? existingTags;
  const category =
    normalizeOptionalString(market.category) ??
    pickCategoryFromTags(marketTags) ??
    existingPair.category ??
    pickCategoryFromTags(existingTags);
  const question = marketQuestion ?? existingPair.question;

  return {
    marketId: existingPair.marketId,
    yesTokenId: existingPair.yesTokenId,
    noTokenId: existingPair.noTokenId,
    ...(question ? { question } : {}),
    ...(category ? { category } : {}),
    ...(tags ? { tags } : {})
  };
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
  return tags.length > 0 ? tags : undefined;
}

export function pickCategoryFromTags(tags: string[] | undefined): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  for (const tag of tags) {
    if (tag.toLowerCase() === 'all') continue;
    return tag;
  }
  return undefined;
}
