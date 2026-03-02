import { EventEmitter } from 'node:events';

import type { MarketPair } from '../domain/market.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import { PolymarketClob } from './PolymarketClob.js';

export type MarketCatalogOrder = 'volume24hr' | 'newest';

export interface MarketCatalogRefresherConfig {
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

export interface GammaMarket {
  condition_id?: string;
  conditionId?: string;
  question?: string;
  category?: string;
  tags?: unknown;
  volume24hr?: number;
  volume24hrClob?: number;
  volumeNum?: number;
  volume?: number | string;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  accepting_orders?: boolean;
  acceptingOrders?: boolean;
  enable_order_book?: boolean;
  enableOrderBook?: boolean;
  endDate?: string | number | null;
  endDateIso?: string | null;
  end_date?: string | number | null;
  end_date_iso?: string | null;
  clobTokenIds?: string[] | string;
  tokens?: Array<{ token_id?: string; tokenId?: string; outcome?: string }>;
}

export interface RefreshResult {
  discoveredPairs: MarketPair[];
  removedMarketIds: string[];
  totalPairs: number;
  pagesScanned: number;
  durationMs: number;
}

const DEFAULT_CONFIG: Omit<MarketCatalogRefresherConfig, 'gammaApiBaseUrl'> = {
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
    config: Partial<Omit<MarketCatalogRefresherConfig, 'gammaApiBaseUrl'>> & Pick<MarketCatalogRefresherConfig, 'gammaApiBaseUrl'>,
    clob: PolymarketClob,
    metrics?: MetricsStore
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
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
        const backoffMs = this.getEmptyRefreshBackoffMs();
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
      const { markets, nextCursor } = await this.fetchMarketPage({
        limit: pageSize,
        offset,
        cursor,
        order: params.order
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
          validPairs.push(this.enrichExistingPair(existingPair, market));
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

  private resolveOrderParams(orderMode: MarketCatalogOrder): { order: string; ascending: boolean } {
    if (orderMode === 'newest') {
      return { order: 'id', ascending: false };
    }
    return { order: 'volume24hr', ascending: false };
  }

  private async fetchMarketPage(params: {
    limit: number;
    offset: number;
    cursor: string | null;
    order: MarketCatalogOrder;
  }): Promise<{ markets: GammaMarket[]; nextCursor: string | null }> {
    const url = new URL('/markets', this.config.gammaApiBaseUrl);
    const { order, ascending } = this.resolveOrderParams(params.order);
    url.searchParams.set('limit', String(params.limit));
    url.searchParams.set('order', order);
    url.searchParams.set('ascending', String(ascending));
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    if (params.cursor) {
      url.searchParams.set('cursor', params.cursor);
    } else {
      url.searchParams.set('offset', String(params.offset));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'openpolytrader/0.1.0'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gamma API fetch failed (${response.status}): ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as
        | GammaMarket[]
        | { data?: GammaMarket[]; next_cursor?: string | null; nextCursor?: string | null; cursor?: string | null };
      if (Array.isArray(data)) {
        return { markets: data, nextCursor: null };
      }
      if (data && Array.isArray(data.data)) {
        return { markets: data.data, nextCursor: extractNextCursor(data) };
      }
      return { markets: [], nextCursor: null };
    } finally {
      clearTimeout(timeoutId);
    }
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

    const tokenIds = this.extractTokenIds(market);
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

      if (!this.hasValidAsks(yesBook) || !this.hasValidAsks(noBook)) return null;
      if (!yesBook.tick_size || !noBook.tick_size) return null;
      if (!yesBook.min_order_size || !noBook.min_order_size) return null;

      if (!this.hasAcceptableSpread(yesBook) || !this.hasAcceptableSpread(noBook)) return null;

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

  private getEmptyRefreshBackoffMs(): number {
    return Math.min(Math.max(this.config.refreshIntervalMs, 60000), 600000);
  }

  private extractTokenIds(market: GammaMarket): { yesTokenId: string; noTokenId: string } | null {
    const parsedIds = parseClobTokenIds(market.clobTokenIds);
    if (parsedIds && parsedIds.length === 2) {
      return { yesTokenId: parsedIds[0], noTokenId: parsedIds[1] };
    }

    if (!Array.isArray(market.tokens) || market.tokens.length !== 2) return null;

    const [a, b] = market.tokens;
    const aToken = a?.token_id ?? a?.tokenId;
    const bToken = b?.token_id ?? b?.tokenId;
    if (!aToken || !bToken) return null;

    const aOutcome = (a.outcome ?? '').toLowerCase().trim();
    const bOutcome = (b.outcome ?? '').toLowerCase().trim();

    if (aOutcome === 'yes' && bOutcome === 'no') {
      return { yesTokenId: aToken, noTokenId: bToken };
    }
    if (aOutcome === 'no' && bOutcome === 'yes') {
      return { yesTokenId: bToken, noTokenId: aToken };
    }

    const sorted = [
      { tokenId: aToken, outcome: aOutcome },
      { tokenId: bToken, outcome: bOutcome }
    ].sort((x, y) => x.tokenId.localeCompare(y.tokenId));
    return { yesTokenId: sorted[0].tokenId, noTokenId: sorted[1].tokenId };
  }

  private hasValidAsks(book: { asks?: Array<{ price: string | number; size: string | number }> }): boolean {
    return Array.isArray(book.asks) && book.asks.length > 0;
  }

  private hasAcceptableSpread(book: {
    bids?: Array<{ price: string | number }>;
    asks?: Array<{ price: string | number }>;
  }): boolean {
    if (!Array.isArray(book.bids) || book.bids.length === 0) return true;
    if (!Array.isArray(book.asks) || book.asks.length === 0) return true;

    const bestBid = findBestPrice(book.bids, Math.max);
    const bestAsk = findBestPrice(book.asks, Math.min);

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return true;

    return bestAsk - bestBid <= this.config.maxSpread;
  }

  private enrichExistingPair(existingPair: MarketPair, market: GammaMarket): MarketPair {
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
}

function extractConditionId(market: GammaMarket): string | null {
  const value = market.condition_id ?? market.conditionId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
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

function pickCategoryFromTags(tags: string[] | undefined): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  for (const tag of tags) {
    if (tag.toLowerCase() === 'all') continue;
    return tag;
  }
  return undefined;
}

function parseClobTokenIds(value: GammaMarket['clobTokenIds']): string[] | null {
  if (Array.isArray(value)) {
    return value.every((id) => typeof id === 'string') ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isMarketEnded(market: GammaMarket, nowMs: number): boolean {
  const endMs = extractMarketEndTimeMs(market);
  return endMs !== null && endMs <= nowMs;
}

function extractMarketEndTimeMs(market: GammaMarket): number | null {
  const candidates: Array<unknown> = [market.endDate, market.endDateIso, market.end_date, market.end_date_iso];
  for (const value of candidates) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function findBestPrice(
  levels: Array<{ price: string | number }>,
  reducer: (a: number, b: number) => number
): number {
  let best: number | null = null;
  for (const level of levels) {
    const price = Number(level.price);
    if (!Number.isFinite(price)) continue;
    best = best === null ? price : reducer(best, price);
  }
  return best ?? Number.NaN;
}

function extractNextCursor(value: {
  next_cursor?: string | null;
  nextCursor?: string | null;
  cursor?: string | null;
}): string | null {
  if (typeof value.next_cursor === 'string' && value.next_cursor.length > 0) return value.next_cursor;
  if (typeof value.nextCursor === 'string' && value.nextCursor.length > 0) return value.nextCursor;
  if (typeof value.cursor === 'string' && value.cursor.length > 0) return value.cursor;
  return null;
}
