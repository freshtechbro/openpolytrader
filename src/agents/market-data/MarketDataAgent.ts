import { resolveMessageBus, type MessageBus } from '../../core/MessageBus.js';
import type { MarketUpdateEvent, RuntimeEventMap } from '../../core/runtimeEvents.js';
import type { TradePolicy } from '../../config/policy.js';
import { PolymarketClob } from '../../services/PolymarketClob.js';
import { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import {
  applyOrderBookDelta,
  coercePositiveNumber,
  isAlignedToTick,
  normalizeOrderBook,
  type RawOrderBookSnapshot,
  type OrderBookDelta,
  type OrderBookState
} from '../../domain/orderbook.js';
import { isOutOfSequence } from '../../domain/sequence.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import type { LLMClientPort } from '../../services/llm/types.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import {
  coerceString,
  coerceTimestampString,
  extractBestLevel,
  extractPriceChangeUpdates,
  extractTokenId,
  normalizeWsBook,
  routeMarketDataMessage
} from './MarketDataEventParsing.js';
import { recordBookParameterMetrics, recordFallbackMetrics } from './MarketDataMetrics.js';
import { detectMarketDataOutlier } from './MarketDataOutlierDetector.js';

interface MarketDataAgentConfig {
  tokenIds: string[];
  policy: TradePolicy;
  messageBus?: MessageBus<RuntimeEventMap>;
  metrics?: MetricsStore;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: LLMClientPort<'MarketDataAgent'>;
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
}

interface SnapshotRefreshResult {
  ok: boolean;
  error?: string;
}

export class MarketDataAgent {
  private orderbooks = new Map<string, OrderBookState>();
  private messageBus: MessageBus<RuntimeEventMap>;
  private metrics?: MetricsStore;
  private store?: EventStore;
  private llm?: NonNullable<MarketDataAgentConfig['llm']>;
  private lastOutlierCheckMs = new Map<string, number>();
  private realtimeHandlersAttached = false;
  private bestBidAskRefreshMs = new Map<string, number>();
  private snapshotResyncMs = new Map<string, number>();
  private snapshotResyncCooldownMs = 2000;

  constructor(
    private config: MarketDataAgentConfig,
    private clob: PolymarketClob,
    private realtime: PolymarketRealtime
  ) {
    this.messageBus = resolveMessageBus<RuntimeEventMap>(config.messageBus, 'MarketDataAgent');
    this.metrics = config.metrics;
    this.store = config.eventStore;
    this.llm = config.llm;
  }

  async start(): Promise<void> {
    if (!this.realtimeHandlersAttached) {
      this.realtimeHandlersAttached = true;
      this.realtime.on('message', (payload) => this.handleMessage(payload));
      this.realtime.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.metrics?.record({
          type: 'error',
          timestamp: Date.now(),
          data: { message: 'realtime_error', detail: message }
        });
      });
    }

    try {
      await this.realtime.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics?.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'realtime_connect_failed', detail: message }
      });
      throw error;
    }

    if (this.config.tokenIds.length > 0) {
      this.realtime.subscribeMarkets(this.config.tokenIds);
    }
  }

  getOrderBook(tokenId: string): OrderBookState | undefined {
    return this.orderbooks.get(tokenId);
  }

  async refreshSnapshot(tokenId: string): Promise<SnapshotRefreshResult> {
    try {
      const snapshot = await this.clob.getOrderBook(tokenId);
      this.updateBook(tokenId, snapshot, Date.now(), { force: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics?.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'snapshot_refresh_failed', tokenId, detail: message }
      });
      return { ok: false, error: message };
    }
  }

  async refreshStaleBooks(maxStalenessMs: number): Promise<{ refreshed: string[]; failed: string[] }> {
    const now = Date.now();
    const refreshed: string[] = [];
    const failed: string[] = [];
    const staleTokenIds: string[] = [];

    for (const [tokenId, book] of this.orderbooks) {
      const age = now - book.lastUpdateMs;
      if (age > maxStalenessMs) {
        staleTokenIds.push(tokenId);
      }
    }

    const refreshConcurrency = 40;
    await mapWithConcurrency(staleTokenIds, refreshConcurrency, async (tokenId) => {
      const result = await this.refreshSnapshot(tokenId);
      if (result.ok) {
        refreshed.push(tokenId);
      } else {
        failed.push(tokenId);
      }
    });

    if (refreshed.length > 0 || failed.length > 0) {
      this.metrics?.record({
        type: 'info',
        timestamp: now,
        data: {
          message: 'stale_books_refreshed',
          refreshed: refreshed.length,
          failed: failed.length,
          maxStalenessMs
        }
      });
    }

    return { refreshed, failed };
  }

  getTokenIds(): string[] {
    return Array.from(this.orderbooks.keys());
  }

  async detectOutlierNow(tokenId: string, nowMs = Date.now()): Promise<{ ok: boolean; error?: string }> {
    const book = this.orderbooks.get(tokenId);
    if (!book) {
      return { ok: false, error: 'orderbook_missing' };
    }
    await this.maybeDetectOutlier(tokenId, book, nowMs, { force: true });
    return { ok: true };
  }

  updateSubscriptions(tokenIds: string[]): void {
    const previous = new Set(this.config.tokenIds);
    const next = new Set(tokenIds);
    const toSubscribe = tokenIds.filter((tokenId) => !previous.has(tokenId));
    const toUnsubscribe = Array.from(previous).filter((tokenId) => !next.has(tokenId));

    this.config.tokenIds = tokenIds;

    if (this.realtime) {
      if (toUnsubscribe.length > 0) this.realtime.unsubscribeMarkets(toUnsubscribe);
      if (toSubscribe.length > 0) this.realtime.subscribeMarkets(toSubscribe);
    }

    for (const tokenId of toUnsubscribe) {
      this.orderbooks.delete(tokenId);
      this.lastOutlierCheckMs.delete(tokenId);
      this.bestBidAskRefreshMs.delete(tokenId);
      this.snapshotResyncMs.delete(tokenId);
    }
  }

  private handleMessage(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === 'object') {
          this.handleEvent(item as Record<string, unknown>);
        }
      }
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    this.handleEvent(payload as Record<string, unknown>);
  }

  private handleEvent(message: Record<string, unknown>): void {
    const routedEvent = routeMarketDataMessage(message);
    if (!routedEvent) return;

    const { kind, payload } = routedEvent;
    if (kind === 'price_change') {
      this.handlePriceChange(payload);
      return;
    }
    if (kind === 'tick_size_change') {
      this.handleTickSizeChange(payload);
      return;
    }
    if (kind === 'best_bid_ask') {
      this.handleBestBidAsk(payload);
      return;
    }

    const tokenId = extractTokenId(payload);
    if (!tokenId) return;

    const normalized = normalizeWsBook(payload);
    this.updateBook(tokenId, normalized, Date.now());
  }

  private updateBook(
    tokenId: string,
    raw: RawOrderBookSnapshot,
    receivedAtMs: number,
    options: { force?: boolean } = {}
  ): void {
    const previous = this.orderbooks.get(tokenId);

    if (!options.force && previous?.exchangeTimestamp && raw.timestamp) {
      if (isOutOfSequence(previous.exchangeTimestamp, raw.timestamp)) {
        this.scheduleSnapshotResync(tokenId, 'out_of_sequence_book', receivedAtMs);
        return;
      }
    }

    const rawTickSize = coercePositiveNumber(raw.tick_size);
    const rawMinOrderSize = coercePositiveNumber(raw.min_order_size);
    const usedTickFallback =
      rawTickSize === null &&
      (!previous || !Number.isFinite(previous.tickSize) || previous.tickSize <= 0);
    const usedMinOrderFallback =
      rawMinOrderSize === null &&
      (!previous || !Number.isFinite(previous.minOrderSize) || previous.minOrderSize <= 0);

    const next = normalizeOrderBook(tokenId, raw, receivedAtMs, {
      tickSize: this.config.policy.fallbackTickSize,
      minOrderSize: this.config.policy.fallbackMinOrderSize
    }, previous);

    recordBookParameterMetrics(this.metrics, tokenId, previous, next, receivedAtMs, rawTickSize, rawMinOrderSize);
    recordFallbackMetrics(
      this.metrics,
      this.config.policy,
      tokenId,
      next,
      receivedAtMs,
      usedTickFallback,
      usedMinOrderFallback,
      rawTickSize,
      rawMinOrderSize
    );
    this.publishBookUpdate(tokenId, next, receivedAtMs);
    void this.maybeDetectOutlier(tokenId, next, receivedAtMs);
  }

  private handlePriceChange(payload: Record<string, unknown>): void {
    const nowMs = Date.now();
    const expectedBest = new Map<string, { bestBid?: number; bestAsk?: number }>();
    const updates = extractPriceChangeUpdates(payload, nowMs);
    if (updates.length === 0) return;

    for (const update of updates) {
      this.applyDelta(update.tokenId, update.delta);
      if (!update.expectedBest) continue;
      const current = expectedBest.get(update.tokenId) ?? {};
      if (update.expectedBest.bestBid !== undefined) current.bestBid = update.expectedBest.bestBid;
      if (update.expectedBest.bestAsk !== undefined) current.bestAsk = update.expectedBest.bestAsk;
      expectedBest.set(update.tokenId, current);
    }

    for (const [tokenId, expected] of expectedBest) {
      const book = this.orderbooks.get(tokenId);
      if (!book) continue;
      const bidMismatch =
        expected.bestBid !== undefined &&
        (!book.bestBid || Math.abs(book.bestBid.price - expected.bestBid) > 1e-9);
      const askMismatch =
        expected.bestAsk !== undefined &&
        (!book.bestAsk || Math.abs(book.bestAsk.price - expected.bestAsk) > 1e-9);
      if (bidMismatch || askMismatch) {
        this.scheduleSnapshotResync(tokenId, 'best_bid_ask_mismatch', nowMs);
      }
    }
  }

  private handleTickSizeChange(payload: Record<string, unknown>): void {
    const tokenId = extractTokenId(payload);
    if (!tokenId) return;

    const book = this.orderbooks.get(tokenId);
    if (!book) {
      void this.refreshSnapshot(tokenId);
      return;
    }

    const tickSize = coercePositiveNumber(
      payload.new_tick_size ?? payload.newTickSize ?? payload.tick_size ?? payload.tickSize
    );
    const minOrderSize = coercePositiveNumber(payload.min_order_size ?? payload.minOrderSize);
    if (tickSize === null && minOrderSize === null) return;

    const receivedAtMs = Date.now();
    const exchangeTimestamp = coerceTimestampString(payload.timestamp ?? payload.ts);
    const next: OrderBookState = {
      ...book,
      tickSize: tickSize ?? book.tickSize,
      minOrderSize: minOrderSize ?? book.minOrderSize,
      exchangeTimestamp: exchangeTimestamp ?? book.exchangeTimestamp,
      hash: coerceString(payload.hash) ?? book.hash,
      lastUpdateMs: receivedAtMs
    };

    this.orderbooks.set(tokenId, next);
    this.messageBus.emit('market:updated', { tokenId, book: next } satisfies MarketUpdateEvent);
  }

  private handleBestBidAsk(payload: Record<string, unknown>): void {
    const tokenId = extractTokenId(payload);
    if (!tokenId) return;

    const bid = extractBestLevel(payload, 'bid');
    const ask = extractBestLevel(payload, 'ask');
    const hasLevel = bid !== null || ask !== null;

    if (!hasLevel) {
      const nowMs = Date.now();
      const lastRefresh = this.bestBidAskRefreshMs.get(tokenId) ?? 0;
      if (nowMs - lastRefresh >= 5000) {
        this.bestBidAskRefreshMs.set(tokenId, nowMs);
        void this.refreshSnapshot(tokenId);
      }
      return;
    }

    const exchangeTimestamp = coerceTimestampString(payload.timestamp ?? payload.ts);
    const tickSize = coercePositiveNumber(payload.tick_size ?? payload.tickSize) ?? undefined;
    const minOrderSize = coercePositiveNumber(payload.min_order_size ?? payload.minOrderSize) ?? undefined;
    if (bid) {
      this.applyDelta(tokenId, {
        side: 'bid',
        price: bid.price,
        size: bid.size,
        receivedAtMs: Date.now(),
        exchangeTimestamp,
        tickSize,
        minOrderSize
      });
    }
    if (ask) {
      this.applyDelta(tokenId, {
        side: 'ask',
        price: ask.price,
        size: ask.size,
        receivedAtMs: Date.now(),
        exchangeTimestamp,
        tickSize,
        minOrderSize
      });
    }
  }

  private applyDelta(tokenId: string, delta: OrderBookDelta): void {
    const book = this.orderbooks.get(tokenId);
    if (!book) {
      void this.refreshSnapshot(tokenId);
      return;
    }

    if (book.exchangeTimestamp && delta.exchangeTimestamp) {
      if (isOutOfSequence(book.exchangeTimestamp, delta.exchangeTimestamp)) {
        this.scheduleSnapshotResync(tokenId, 'out_of_sequence_delta', delta.receivedAtMs);
        return;
      }
    }

    const next = applyOrderBookDelta(book, delta);
    this.publishBookUpdate(tokenId, next, delta.receivedAtMs);
  }

  private scheduleSnapshotResync(tokenId: string, reason: string, nowMs = Date.now()): void {
    const last = this.snapshotResyncMs.get(tokenId) ?? 0;
    if (nowMs - last < this.snapshotResyncCooldownMs) return;
    this.snapshotResyncMs.set(tokenId, nowMs);
    this.metrics?.record({
      type: 'info',
      timestamp: nowMs,
      data: { message: 'orderbook_resync', tokenId, reason }
    });
    void this.refreshSnapshot(tokenId);
  }

  private async maybeDetectOutlier(
    tokenId: string,
    book: OrderBookState,
    nowMs: number,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return;
    if (llm.config.agents.MarketDataAgent.mode === 'disabled') return;

    const last = this.lastOutlierCheckMs.get(tokenId) ?? 0;
    if (!options.force && nowMs - last < 30000) return;
    this.lastOutlierCheckMs.set(tokenId, nowMs);

    await detectMarketDataOutlier({
      tokenId,
      book,
      nowMs,
      llm,
      messageBus: this.messageBus,
      store: this.store
    });
  }

  private publishBookUpdate(tokenId: string, book: OrderBookState, receivedAtMs: number): void {
    this.orderbooks.set(tokenId, book);
    this.messageBus.emit('market:updated', { tokenId, book } satisfies MarketUpdateEvent);
    this.scheduleTickAlignmentResync(tokenId, book, receivedAtMs);
  }

  private scheduleTickAlignmentResync(tokenId: string, book: OrderBookState, receivedAtMs: number): void {
    const bestAsk = book.bestAsk?.price;
    const bestBid = book.bestBid?.price;
    if (book.tickSize <= 0) return;

    const askAligned = bestAsk === undefined || isAlignedToTick(bestAsk, book.tickSize);
    const bidAligned = bestBid === undefined || isAlignedToTick(bestBid, book.tickSize);
    if (askAligned && bidAligned) return;

    this.metrics?.record({
      type: 'info',
      timestamp: receivedAtMs,
      data: {
        message: 'tick_misaligned',
        tokenId,
        tickSize: book.tickSize,
        bestAsk,
        bestBid
      }
    });
    this.scheduleSnapshotResync(tokenId, 'tick_misaligned', receivedAtMs);
  }
}
