import { EventEmitter } from 'node:events';

import type { MarketPair } from '../domain/market.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import { PolymarketClob } from './PolymarketClob.js';
import {
  coerceNumber,
  enrichExistingPair,
  extractConditionId,
  extractTokenIds,
  fetchMarketPage,
  getEmptyRefreshBackoffMs,
  hasAskLevels,
  isMarketEnded,
  normalizeOptionalString,
  normalizeTags,
  pickCategoryFromTags,
  resolveDefaultGammaApiBaseUrl,
  spreadWithinLimitOrUnavailable as spreadWithinLimitOrUnavailableForBook,
  type GammaMarket,
  type MarketCatalogOrder
} from './MarketCatalogRefresherSupport.js';

export type { GammaMarket } from './MarketCatalogRefresherSupport.js';

interface MarketCatalogRefresherConfig {
  /** Refresh interval in ms (default: 300000 = 5 min) */
  refreshIntervalMs: number;
  /** Max pairs to track (default: 80) */
  maxPairs: number;
  /** Min 24h volume USD (default: 1000) */
  minVolume24h: number;
  /** Max spread (default: 0.02) */
  maxSpread: number;
  /** Gamma page size (default: 100) */
  pageSize: number;
  /** Gamma pagination cap (default: 5 pages) */
  maxPages: number;
  /** Gamma ordering mode (default: volume24hr) */
  order: MarketCatalogOrder;
  /** Exclude markets whose end time has passed */
  excludeEndedMarkets: boolean;
  /** Enable bounded second pass to discover newer markets */
  explorationEnabled: boolean;
  /** Max number of exploration pairs to add per refresh */
  explorationMaxPairs: number;
  /** Min 24h volume USD for exploration pass */
  explorationMinVolume24h: number;
  /** Gamma pagination cap for exploration pass */
  explorationMaxPages: number;
  /** Gamma API base URL */
  gammaApiBaseUrl: string;
  /** Request timeout in ms */
  requestTimeoutMs: number;
}

interface RefreshResult {
  discoveredPairs: MarketPair[];
  removedMarketIds: string[];
  totalPairs: number;
  pagesScanned: number;
  durationMs: number;
}

const DEFAULT_CONFIG: MarketCatalogRefresherConfig = {
  refreshIntervalMs: 300000,
  maxPairs: 80,
  minVolume24h: 1000,
  maxSpread: 0.02,
  pageSize: 100,
  maxPages: 5,
  order: 'volume24hr',
  excludeEndedMarkets: false,
  explorationEnabled: true,
  explorationMaxPairs: 30,
  explorationMinVolume24h: 1000,
  explorationMaxPages: 3,
  gammaApiBaseUrl: resolveDefaultGammaApiBaseUrl(),
  requestTimeoutMs: 10000
};

interface CatalogPassSummary {
  pagesScanned: number;
  candidates: number;
  accepted: number;
  endedExcluded: number;
}

interface CatalogCollectResult {
  validPairs: MarketPair[];
  pagesScanned: number;
  coreMarketIds: Set<string>;
  explorationMarketIds: Set<string>;
  funnel: {
    core: CatalogPassSummary;
    exploration: CatalogPassSummary;
  };
}

/**
 * Emits 'refresh' with { pairs, result } and 'error' on failure.
 */
export class MarketCatalogRefresher extends EventEmitter {
  private config: MarketCatalogRefresherConfig;
  private clob: PolymarketClob;
  private metrics?: MetricsStore;
  private currentPairs: Map<string, MarketPair> = new Map();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private refreshInFlight = false;
  private emptyRefreshBackoffUntil = 0;
  private emptyRefreshLogUntil = 0;

  constructor(
    config: Partial<MarketCatalogRefresherConfig>,
    clob: PolymarketClob,
    metrics?: MetricsStore
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
    };
    this.clob = clob;
    this.metrics = metrics;
  }

  seed(pairs: MarketPair[]): void {
    for (const pair of pairs) {
      this.currentPairs.set(pair.marketId, pair);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    void this.refresh();

    this.intervalHandle = setInterval(() => {
      void this.refresh();
    }, this.config.refreshIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  updateConfig(update: Partial<MarketCatalogRefresherConfig>): void {
    const next = { ...this.config, ...update };
    const intervalChanged = next.refreshIntervalMs !== this.config.refreshIntervalMs;
    this.config = next;
    if (!this.running || !intervalChanged) return;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.intervalHandle = setInterval(() => {
      void this.refresh();
    }, this.config.refreshIntervalMs);
  }

  getPairs(): MarketPair[] {
    return Array.from(this.currentPairs.values());
  }

  async refresh(): Promise<RefreshResult> {
    if (this.refreshInFlight) {
      return {
        discoveredPairs: [],
        removedMarketIds: [],
        totalPairs: this.currentPairs.size,
        pagesScanned: 0,
        durationMs: 0
      };
    }

    const nowMs = Date.now();
    if (nowMs < this.emptyRefreshBackoffUntil) {
      return {
        discoveredPairs: [],
        removedMarketIds: [],
        totalPairs: this.currentPairs.size,
        pagesScanned: 0,
        durationMs: 0
      };
    }

    this.refreshInFlight = true;
    const startMs = Date.now();
    const previousMarketIds = new Set(this.currentPairs.keys());

    try {
      const { validPairs, pagesScanned, coreMarketIds, explorationMarketIds, funnel } =
        await this.collectValidPairs();

      const totalEndedExcluded = funnel.core.endedExcluded + funnel.exploration.endedExcluded;
      if (validPairs.length === 0 && previousMarketIds.size > 0 && totalEndedExcluded === 0) {
        const durationMs = Date.now() - startMs;
        const backoffMs = getEmptyRefreshBackoffMs(this.config.refreshIntervalMs);
        if (Date.now() >= this.emptyRefreshLogUntil) {
          this.metrics?.record({
            type: 'error',
            timestamp: Date.now(),
            data: {
              message: 'market_catalog_refresh_empty',
              previousPairs: previousMarketIds.size,
              backoffMs
            }
          });
          this.emptyRefreshLogUntil = Date.now() + backoffMs;
        }
        this.emptyRefreshBackoffUntil = Date.now() + backoffMs;
        return {
          discoveredPairs: [],
          removedMarketIds: [],
          totalPairs: this.currentPairs.size,
          pagesScanned,
          durationMs
        };
      }

      this.emptyRefreshBackoffUntil = 0;
      this.emptyRefreshLogUntil = 0;

      const newMarketIds = new Set(validPairs.map((p) => p.marketId));
      const discoveredPairs = validPairs.filter((p) => !previousMarketIds.has(p.marketId));
      const removedMarketIds = Array.from(previousMarketIds).filter((id) => !newMarketIds.has(id));

      this.currentPairs.clear();
      for (const pair of validPairs) {
        this.currentPairs.set(pair.marketId, pair);
      }

      const result: RefreshResult = {
        discoveredPairs,
        removedMarketIds,
        totalPairs: validPairs.length,
        pagesScanned,
        durationMs: Date.now() - startMs
      };

      this.metrics?.record({
        type: 'info',
        timestamp: Date.now(),
        data: {
          message: 'market_catalog_funnel',
          corePagesScanned: funnel.core.pagesScanned,
          coreCandidates: funnel.core.candidates,
          coreAccepted: funnel.core.accepted,
          explorationPagesScanned: funnel.exploration.pagesScanned,
          explorationCandidates: funnel.exploration.candidates,
          explorationAccepted: funnel.exploration.accepted
        }
      });

      const discoveredCore = discoveredPairs.filter((pair) => coreMarketIds.has(pair.marketId)).length;
      const discoveredExploration = discoveredPairs.filter((pair) =>
        explorationMarketIds.has(pair.marketId)
      ).length;

      this.metrics?.record({
        type: 'info',
        timestamp: Date.now(),
        data: {
          message: 'market_catalog_refreshed',
          totalPairs: result.totalPairs,
          discovered: discoveredPairs.length,
          discoveredCore,
          discoveredExploration,
          removed: removedMarketIds.length,
          coreTotal: coreMarketIds.size,
          explorationTotal: explorationMarketIds.size,
          durationMs: result.durationMs
        }
      });

      this.emit('refresh', { pairs: validPairs, result });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics?.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'market_catalog_refresh_failed', error: message }
      });
      this.emit('error', error);

      return {
        discoveredPairs: [],
        removedMarketIds: [],
        totalPairs: this.currentPairs.size,
        pagesScanned: 0,
        durationMs: Date.now() - startMs
      };
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async collectValidPairs(): Promise<CatalogCollectResult> {
    const maxPairs = Math.max(1, this.config.maxPairs);
    const corePass = await this.collectPass({
      order: this.config.order,
      minVolume24h: this.config.minVolume24h,
      maxPages: Math.max(1, this.config.maxPages),
      targetPairs: maxPairs,
      seenMarketIds: new Set<string>()
    });

    const validPairs = [...corePass.validPairs];
    const coreMarketIds = new Set(corePass.validPairs.map((pair) => pair.marketId));
    const explorationMarketIds = new Set<string>();
    let pagesScanned = corePass.pagesScanned;
    const funnel = {
      core: {
        pagesScanned: corePass.pagesScanned,
        candidates: corePass.candidates,
        accepted: corePass.validPairs.length,
        endedExcluded: corePass.endedExcluded
      },
      exploration: {
        pagesScanned: 0,
        candidates: 0,
        accepted: 0,
        endedExcluded: 0
      }
    };

    const explorationEnabled = this.config.explorationEnabled;
    const explorationCap = Math.max(0, this.config.explorationMaxPairs);
    if (explorationEnabled && validPairs.length < maxPairs && explorationCap > 0) {
      const remainingSlots = maxPairs - validPairs.length;
      const targetPairs = Math.min(remainingSlots, explorationCap);
      if (targetPairs > 0) {
        const explorationPass = await this.collectPass({
          order: 'newest',
          minVolume24h: this.config.explorationMinVolume24h,
          maxPages: Math.max(1, this.config.explorationMaxPages),
          targetPairs,
          seenMarketIds: new Set(validPairs.map((pair) => pair.marketId))
        });

        pagesScanned += explorationPass.pagesScanned;
        for (const pair of explorationPass.validPairs) {
          validPairs.push(pair);
          explorationMarketIds.add(pair.marketId);
        }
        funnel.exploration.pagesScanned = explorationPass.pagesScanned;
        funnel.exploration.candidates = explorationPass.candidates;
        funnel.exploration.accepted = explorationPass.validPairs.length;
        funnel.exploration.endedExcluded = explorationPass.endedExcluded;
      }
    }

    return { validPairs, pagesScanned, coreMarketIds, explorationMarketIds, funnel };
  }

  private async collectPass(params: {
    order: MarketCatalogOrder;
    minVolume24h: number;
    maxPages: number;
    targetPairs: number;
    seenMarketIds: Set<string>;
  }): Promise<{ validPairs: MarketPair[]; pagesScanned: number; candidates: number; endedExcluded: number }> {
    const validPairs: MarketPair[] = [];
    let pagesScanned = 0;
    let candidates = 0;
    let endedExcluded = 0;
    let offset = 0;
    let cursor: string | null = null;

    const pageSize = Math.max(1, this.config.pageSize);
    const maxPages = Math.max(1, params.maxPages);

    for (let page = 0; page < maxPages; page += 1) {
      const { markets, nextCursor } = await fetchMarketPage({
        gammaApiBaseUrl: this.config.gammaApiBaseUrl,
        requestTimeoutMs: this.config.requestTimeoutMs,
        params: { limit: pageSize, offset, cursor, order: params.order }
      });

      pagesScanned += 1;

      if (markets.length === 0) break;
      candidates += markets.length;

      for (const market of markets) {
        if (validPairs.length >= params.targetPairs) break;

        const conditionId = extractConditionId(market);
        if (conditionId && params.seenMarketIds.has(conditionId)) {
          continue;
        }
        if (this.config.excludeEndedMarkets && isMarketEnded(market, Date.now())) {
          endedExcluded += 1;
          continue;
        }
        if (conditionId && this.currentPairs.has(conditionId)) {
          const existingPair = this.currentPairs.get(conditionId)!;
          validPairs.push(enrichExistingPair(existingPair, market));
          params.seenMarketIds.add(conditionId);
          continue;
        }

        const pair = await this.validateAndConvertMarket(market, params.minVolume24h);
        if (pair) {
          validPairs.push(pair);
          params.seenMarketIds.add(pair.marketId);
        }
      }

      if (validPairs.length >= params.targetPairs) break;

      if (nextCursor) {
        if (nextCursor === cursor) break;
        cursor = nextCursor;
        offset = 0;
        continue;
      }

      if (markets.length < pageSize) break;
      offset += pageSize;
    }

    return { validPairs, pagesScanned, candidates, endedExcluded };
  }

  private async validateAndConvertMarket(
    market: GammaMarket,
    minVolume24h = this.config.minVolume24h
  ): Promise<MarketPair | null> {
    const conditionId = extractConditionId(market);
    if (!conditionId) return null;
    if (!market.active) return null;
    if (market.closed) return null;
    if (this.config.excludeEndedMarkets && isMarketEnded(market, Date.now())) return null;

    const acceptingOrders = market.accepting_orders ?? market.acceptingOrders ?? false;
    if (!acceptingOrders) return null;
    const enableOrderBook = market.enable_order_book ?? market.enableOrderBook ?? false;
    if (!enableOrderBook) return null;

    const volume24h = coerceNumber(
      market.volume24hr ?? market.volume24hrClob ?? market.volumeNum ?? market.volume ?? 0
    );
    if (volume24h < minVolume24h) return null;

    const tokenIds = extractTokenIds(market);
    if (!tokenIds) return null;

    const { yesTokenId, noTokenId } = tokenIds;
    const question = normalizeOptionalString(market.question);
    const tags = normalizeTags(market.tags);
    const category = normalizeOptionalString(market.category) ?? pickCategoryFromTags(tags);

    try {
      const [yesBook, noBook] = await Promise.all([
        this.clob.getOrderBook(yesTokenId),
        this.clob.getOrderBook(noTokenId)
      ]);

      if (!hasAskLevels(yesBook) || !hasAskLevels(noBook)) return null;
      if (!yesBook.tick_size || !noBook.tick_size) return null;
      if (!yesBook.min_order_size || !noBook.min_order_size) return null;

      if (
        !this.spreadWithinLimitOrUnavailable(yesBook) ||
        !this.spreadWithinLimitOrUnavailable(noBook)
      ) {
        return null;
      }

      return {
        marketId: conditionId,
        yesTokenId,
        noTokenId,
        ...(question ? { question } : {}),
        ...(category ? { category } : {}),
        ...(tags ? { tags } : {})
      };
    } catch {
      return null;
    }
  }

  private spreadWithinLimitOrUnavailable = (book: {
    bids?: Array<{ price: string | number }>;
    asks?: Array<{ price: string | number }>;
  }): boolean => spreadWithinLimitOrUnavailableForBook(book, this.config.maxSpread);
}
