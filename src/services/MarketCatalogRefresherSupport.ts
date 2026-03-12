export type { GammaMarket, MarketCatalogOrder } from './MarketCatalogTypes.js';
export { fetchMarketPage, resolveDefaultGammaApiBaseUrl } from './MarketCatalogGammaPage.js';
export {
  coerceNumber,
  extractConditionId,
  extractTokenIds,
  isMarketEnded
} from './MarketCatalogMarketShape.js';
export {
  enrichExistingPair,
  normalizeOptionalString,
  normalizeTags,
  pickCategoryFromTags
} from './MarketCatalogMetadata.js';
export { hasAskLevels, spreadWithinLimitOrUnavailable } from './MarketCatalogOrderBook.js';

export function getEmptyRefreshBackoffMs(refreshIntervalMs: number): number {
  return Math.min(Math.max(refreshIntervalMs, 60000), 600000);
}
