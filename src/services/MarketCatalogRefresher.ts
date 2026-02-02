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
  /** Gamma API base URL */
  gammaApiBaseUrl: string;
  /** Request timeout in ms */
  requestTimeoutMs: number;
}

export interface GammaMarket {
  condition_id?: string;
  conditionId?: string;
  question?: string;
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
  requestTimeoutMs: 10000
};

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
      const { validPairs, pagesScanned } = await this.collectValidPairs();

      if (validPairs.length === 0 && previousMarketIds.size > 0) {
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
          message: 'market_catalog_refreshed',
          totalPairs: result.totalPairs,
          discovered: discoveredPairs.length,
          removed: removedMarketIds.length,
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

  private async collectValidPairs(): Promise<{ validPairs: MarketPair[]; pagesScanned: number }> {
    const validPairs: MarketPair[] = [];
    let pagesScanned = 0;
    let offset = 0;
    let cursor: string | null = null;

    const pageSize = Math.max(1, this.config.pageSize);
    const maxPages = Math.max(1, this.config.maxPages);

    for (let page = 0; page < maxPages; page += 1) {
      const { markets, nextCursor } = await this.fetchMarketPage({
        limit: pageSize,
        offset,
        cursor
      });

      pagesScanned += 1;

      if (markets.length === 0) break;

      for (const market of markets) {
        if (validPairs.length >= this.config.maxPairs) break;

        const conditionId = extractConditionId(market);
        if (conditionId && this.currentPairs.has(conditionId)) {
          validPairs.push(this.currentPairs.get(conditionId)!);
          continue;
        }

        const pair = await this.validateAndConvertMarket(market);
        if (pair) {
          validPairs.push(pair);
        }
      }

      if (validPairs.length >= this.config.maxPairs) break;

      if (nextCursor) {
        if (nextCursor === cursor) break;
        cursor = nextCursor;
        offset = 0;
        continue;
      }

      if (markets.length < pageSize) break;
      offset += pageSize;
    }

    return { validPairs, pagesScanned };
  }

  private resolveOrderParams(): { order: string; ascending: boolean } {
    if (this.config.order === 'newest') {
      return { order: 'id', ascending: false };
    }
    return { order: 'volume24hr', ascending: false };
  }

  private async fetchMarketPage(params: {
    limit: number;
    offset: number;
    cursor: string | null;
  }): Promise<{ markets: GammaMarket[]; nextCursor: string | null }> {
    const url = new URL('/markets', this.config.gammaApiBaseUrl);
    const { order, ascending } = this.resolveOrderParams();
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

  private async validateAndConvertMarket(market: GammaMarket): Promise<MarketPair | null> {
    const conditionId = extractConditionId(market);
    if (!conditionId) return null;
    if (!market.active) return null;
    if (market.closed) return null;

    const acceptingOrders = market.accepting_orders ?? market.acceptingOrders ?? false;
    if (!acceptingOrders) return null;
    const enableOrderBook = market.enable_order_book ?? market.enableOrderBook ?? false;
    if (!enableOrderBook) return null;

    const volume24h = coerceNumber(
      market.volume24hr ?? market.volume24hrClob ?? market.volumeNum ?? market.volume ?? 0
    );
    if (volume24h < this.config.minVolume24h) return null;

    const tokenIds = this.extractTokenIds(market);
    if (!tokenIds) return null;

    const { yesTokenId, noTokenId } = tokenIds;

    try {
      const [yesBook, noBook] = await Promise.all([
        this.clob.getOrderBook(yesTokenId),
        this.clob.getOrderBook(noTokenId)
      ]);

      if (!this.hasValidAsks(yesBook) || !this.hasValidAsks(noBook)) return null;
      if (!yesBook.tick_size || !noBook.tick_size) return null;
      if (!yesBook.min_order_size || !noBook.min_order_size) return null;

      if (!this.hasAcceptableSpread(yesBook) || !this.hasAcceptableSpread(noBook)) return null;

      return { marketId: conditionId, yesTokenId, noTokenId };
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

    const bestBid = parseFloat(String(book.bids[0].price));
    const bestAsk = parseFloat(String(book.asks[0].price));

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return true;

    return bestAsk - bestBid <= this.config.maxSpread;
  }
}

function extractConditionId(market: GammaMarket): string | null {
  const value = market.condition_id ?? market.conditionId;
  return typeof value === 'string' && value.length > 0 ? value : null;
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
