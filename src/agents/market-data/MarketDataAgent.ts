import { messageBus } from '../../core/MessageBus.js';
import type { TradePolicy } from '../../config/policy.js';
import { PolymarketClob, type OrderBookResponse } from '../../services/PolymarketClob.js';
import { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import {
  applyOrderBookDelta,
  coercePositiveNumber,
  isAlignedToTick,
  normalizeOrderBook,
  type OrderBookDelta,
  type OrderBookState
} from '../../domain/orderbook.js';
import { isOutOfSequence } from '../../domain/sequence.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { EventStore } from '../../core/EventStore.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import { MarketDataOutlierSchema } from '../../domain/llm.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { safeParseJSON } from '../../utils/serialization.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

export interface MarketDataAgentConfig {
  tokenIds: string[];
  policy: TradePolicy;
  metrics?: MetricsStore;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: 'MarketDataAgent', request: LLMRequest) => Promise<LLMCallResult> };
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
}

export interface MarketUpdateEvent {
  tokenId: string;
  book: OrderBookState;
}

export class MarketDataAgent {
  private orderbooks = new Map<string, OrderBookState>();
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
      return;
    }

    if (this.config.tokenIds.length > 0) {
      this.realtime.subscribeMarkets(this.config.tokenIds);
    }
  }

  getOrderBook(tokenId: string): OrderBookState | undefined {
    return this.orderbooks.get(tokenId);
  }

  async refreshSnapshot(tokenId: string): Promise<void> {
    try {
      const snapshot = await this.clob.getOrderBook(tokenId);
      this.updateBook(tokenId, snapshot, Date.now(), { force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics?.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'snapshot_refresh_failed', tokenId, detail: message }
      });
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
      try {
        await this.refreshSnapshot(tokenId);
        refreshed.push(tokenId);
      } catch {
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
    const envelopeType = typeof message.type === 'string' ? message.type : undefined;
    const payload =
      message.payload && typeof message.payload === 'object'
        ? (message.payload as Record<string, unknown>)
        : message;
    const eventTypeRaw = (payload.event_type ?? payload.type ?? envelopeType) as
      | string
      | undefined;
    const eventType = typeof eventTypeRaw === 'string' ? eventTypeRaw.toLowerCase() : undefined;
    
    // Handle explicit book/agg_orderbook events OR raw order book data with bids/asks
    const isBookEvent = eventType === 'book' || eventType === 'agg_orderbook';
    const isRawBookData =
      Array.isArray(payload.bids) ||
      Array.isArray(payload.asks) ||
      Array.isArray(payload.buys) ||
      Array.isArray(payload.sells);
    
    if (!isBookEvent && !isRawBookData) {
      if (eventType === 'price_change') {
        this.handlePriceChange(payload);
        return;
      }
      if (eventType === 'tick_size_change') {
        this.handleTickSizeChange(payload);
        return;
      }
      if (eventType === 'best_bid_ask') {
        this.handleBestBidAsk(payload);
        return;
      }
      return;
    }

    const tokenId = extractTokenId(payload);
    if (!tokenId) {
      return;
    }

    const normalized = normalizeWsBook(payload);
    this.updateBook(tokenId, normalized, Date.now());
  }

  private updateBook(
    tokenId: string,
    raw: OrderBookResponse,
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

    if (this.metrics && (rawTickSize !== null || rawMinOrderSize !== null)) {
      const previousTickSize = previous?.tickSize;
      const previousMinOrderSize = previous?.minOrderSize;
      if (previousTickSize !== next.tickSize || previousMinOrderSize !== next.minOrderSize) {
        this.metrics.record({
          type: 'info',
          timestamp: receivedAtMs,
          data: {
            message: 'book_params_updated',
            tokenId,
            rawTickSize,
            rawMinOrderSize,
            previousTickSize,
            previousMinOrderSize,
            resolvedTickSize: next.tickSize,
            resolvedMinOrderSize: next.minOrderSize
          }
        });
      }
    }

    if (this.metrics && (usedTickFallback || usedMinOrderFallback)) {
      this.metrics.record({
        type: 'book_fallback',
        timestamp: receivedAtMs,
        data: {
          tokenId,
          usedTickFallback,
          usedMinOrderFallback,
          fallbackTickSize: this.config.policy.fallbackTickSize,
          fallbackMinOrderSize: this.config.policy.fallbackMinOrderSize,
          rawTickSize,
          rawMinOrderSize,
          resolvedTickSize: next.tickSize,
          resolvedMinOrderSize: next.minOrderSize
        }
      });
    }
    this.orderbooks.set(tokenId, next);
    messageBus.emit('market:updated', { tokenId, book: next } satisfies MarketUpdateEvent);

    const bestAsk = next.bestAsk?.price;
    const bestBid = next.bestBid?.price;
    if (next.tickSize > 0) {
      const askAligned = bestAsk === undefined || isAlignedToTick(bestAsk, next.tickSize);
      const bidAligned = bestBid === undefined || isAlignedToTick(bestBid, next.tickSize);
      if (!askAligned || !bidAligned) {
        this.metrics?.record({
          type: 'info',
          timestamp: receivedAtMs,
          data: {
            message: 'tick_misaligned',
            tokenId,
            tickSize: next.tickSize,
            bestAsk,
            bestBid
          }
        });
        this.scheduleSnapshotResync(tokenId, 'tick_misaligned', receivedAtMs);
      }
    }

    void this.maybeDetectOutlier(tokenId, next, receivedAtMs);
  }

  private handlePriceChange(payload: Record<string, unknown>): void {
    const changes = extractPriceChanges(payload);
    const nowMs = Date.now();

    if (changes.length > 0) {
      const expectedBest = new Map<string, { bestBid?: number; bestAsk?: number }>();
      for (const change of changes) {
        const tokenId = extractTokenId(change) ?? extractTokenId(payload);
        if (!tokenId) continue;

        const sideRaw = change.side ?? change.book_side ?? change.order_side;
        const side = normalizeSide(sideRaw);
        const price = coerceNumber(change.price);
        const size = coerceNumber(change.size);
        if (!side || price === null || size === null) continue;

        const exchangeTimestamp = coerceTimestampString(change.timestamp ?? change.ts ?? payload.timestamp ?? payload.ts);
        const delta: OrderBookDelta = {
          side,
          price,
          size,
          receivedAtMs: nowMs,
          exchangeTimestamp,
          tickSize: coercePositiveNumber(change.tick_size ?? change.tickSize ?? payload.tick_size ?? payload.tickSize) ?? undefined,
          minOrderSize:
            coercePositiveNumber(change.min_order_size ?? change.minOrderSize ?? payload.min_order_size ?? payload.minOrderSize) ??
            undefined
        };

        this.applyDelta(tokenId, delta);

        const bestBid = coerceNumber(change.best_bid ?? change.best_bid_price ?? payload.best_bid ?? payload.best_bid_price);
        const bestAsk = coerceNumber(change.best_ask ?? change.best_ask_price ?? payload.best_ask ?? payload.best_ask_price);
        if (bestBid !== null || bestAsk !== null) {
          const current = expectedBest.get(tokenId) ?? {};
          if (bestBid !== null) current.bestBid = bestBid;
          if (bestAsk !== null) current.bestAsk = bestAsk;
          expectedBest.set(tokenId, current);
        }
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

      return;
    }

    const tokenId = extractTokenId(payload);
    if (!tokenId) return;

    const sideRaw = payload.side ?? payload.book_side ?? payload.order_side;
    const side = normalizeSide(sideRaw);
    const price = coerceNumber(payload.price);
    const size = coerceNumber(payload.size);
    if (!side || price === null || size === null) return;

    const exchangeTimestamp = coerceTimestampString(payload.timestamp ?? payload.ts);
    const delta: OrderBookDelta = {
      side,
      price,
      size,
      receivedAtMs: nowMs,
      exchangeTimestamp,
      tickSize: coercePositiveNumber(payload.tick_size ?? payload.tickSize) ?? undefined,
      minOrderSize: coercePositiveNumber(payload.min_order_size ?? payload.minOrderSize) ?? undefined
    };

    this.applyDelta(tokenId, delta);
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
    messageBus.emit('market:updated', { tokenId, book: next } satisfies MarketUpdateEvent);
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
    this.orderbooks.set(tokenId, next);
    messageBus.emit('market:updated', { tokenId, book: next } satisfies MarketUpdateEvent);

    const bestAsk = next.bestAsk?.price;
    const bestBid = next.bestBid?.price;
    if (next.tickSize > 0) {
      const askAligned = bestAsk === undefined || isAlignedToTick(bestAsk, next.tickSize);
      const bidAligned = bestBid === undefined || isAlignedToTick(bestBid, next.tickSize);
      if (!askAligned || !bidAligned) {
        this.metrics?.record({
          type: 'info',
          timestamp: delta.receivedAtMs,
          data: {
            message: 'tick_misaligned',
            tokenId,
            tickSize: next.tickSize,
            bestAsk,
            bestBid
          }
        });
        this.scheduleSnapshotResync(tokenId, 'tick_misaligned', delta.receivedAtMs);
      }
    }
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

    const bestBid = book.bestBid?.price ?? null;
    const bestAsk = book.bestAsk?.price ?? null;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

    const promptEnvelope = {
      task: 'detect_outlier',
      inputs: {
        orderbook: {
          mid_price: mid,
          spread,
          top_bid: bestBid,
          top_ask: bestAsk,
          depth_top: book.bestAsk?.size ?? null,
          timestamp: book.exchangeTimestamp ?? null
        }
      },
      output: { outlier: false, reason: null, confidence: 0.0 }
    };

    const model = llm.config.agents.MarketDataAgent.model;
    const jsonInstruction =
      'Return JSON only, with shape: {"outlier":boolean,"reason":string|null,"confidence":number}. Use only the inputs. If best bid/ask or spread is missing, return outlier=false, reason=null, confidence=0. Only flag outlier=true for extreme or clearly inconsistent prices/spreads. Confidence must be between 0 and 1. No prose.';

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model,
      messages: [
        { role: 'developer', content: jsonInstruction },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    };

    const call = await llm.client.call('MarketDataAgent', request);

    const hasOutputText = Boolean(call.outputText);
    const parsed = hasOutputText ? safeParseJSON(call.outputText) : null;
    const validated = hasOutputText
      ? MarketDataOutlierSchema.safeParse(parsed)
      : ({ success: false } as const);

    const missingOutput = !hasOutputText;
    const outputOnMissing = missingOutput
      ? { error: 'missing_output_text', status: call.status, llm_error: call.error ?? null }
      : null;
    const outputOnInvalid = { error: 'invalid_output' };
    const output = missingOutput ? outputOnMissing : validated.success ? validated.data : outputOnInvalid;
    const applied = validated.success && validated.data.outlier;
    const confidence = validated.success ? validated.data.confidence : 0;
    const violations = missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output'];

    if (applied) {
      messageBus.emit('marketdata:outlier', { tokenId, outlier: validated.data, at_ms: nowMs });
    }

    logLLMDecision({
      agent: 'MarketDataAgent',
      mode: llm.config.agents.MarketDataAgent.mode,
      task: 'detect_outlier',
      subject: tokenId,
      baseline: promptEnvelope.inputs,
      output,
      confidence,
      applied,
      clamp: { raw: parsed, final: validated.success ? validated.data : undefined, violations },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: promptEnvelope.inputs,
      promptVersion: llm.promptVersion,
      policyHashes: llm.policyHashes,
      providerFallback: {
        providerId: llm.config.agents.MarketDataAgent.provider,
        baseUrl: llm.config.providers[llm.config.agents.MarketDataAgent.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      store: this.store
    });
  }
}

function extractTokenId(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.asset_id,
    payload.token_id,
    payload.market_id,
    payload.marketId
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
}

function normalizeWsBook(payload: Record<string, unknown>): OrderBookResponse {
  const buys = payload.buys;
  const sells = payload.sells;
  const tickSize = coerceString(payload.tick_size ?? payload.tickSize);
  const minOrderSize = coerceString(payload.min_order_size ?? payload.minOrderSize);
  const timestamp = coerceString(payload.timestamp ?? payload.ts);
  const hash = coerceString(payload.hash);

  if (Array.isArray(buys) || Array.isArray(sells)) {
    return {
      bids: Array.isArray(buys) ? (buys as OrderBookResponse['bids']) : [],
      asks: Array.isArray(sells) ? (sells as OrderBookResponse['asks']) : [],
      timestamp: timestamp ?? undefined,
      hash: hash ?? undefined,
      tick_size: tickSize ?? undefined,
      min_order_size: minOrderSize ?? undefined
    };
  }

  const bids = payload.bids;
  const asks = payload.asks;

  return {
    bids: Array.isArray(bids) ? (bids as OrderBookResponse['bids']) : [],
    asks: Array.isArray(asks) ? (asks as OrderBookResponse['asks']) : [],
    timestamp: timestamp ?? undefined,
    hash: hash ?? undefined,
    tick_size: tickSize ?? undefined,
    min_order_size: minOrderSize ?? undefined
  };
}

function extractPriceChanges(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [payload.price_changes, payload.priceChanges, payload.changes];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function normalizeSide(value: unknown): 'bid' | 'ask' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'buy' || normalized === 'bid') return 'bid';
  if (normalized === 'sell' || normalized === 'ask') return 'ask';
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function coerceString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function coerceTimestampString(value: unknown): string | undefined {
  const asString = coerceString(value);
  return asString ?? undefined;
}

function extractBestLevel(
  payload: Record<string, unknown>,
  side: 'bid' | 'ask'
): { price: number; size: number } | null {
  const priceKey = side === 'bid' ? 'best_bid_price' : 'best_ask_price';
  const sizeKey = side === 'bid' ? 'best_bid_size' : 'best_ask_size';
  const altKey = side === 'bid' ? 'best_bid' : 'best_ask';

  const price = coerceNumber(payload[priceKey] ?? payload[`${side}_price`]);
  const size = coerceNumber(payload[sizeKey] ?? payload[`${side}_size`]);
  if (price !== null && size !== null) {
    return { price, size };
  }

  const alt = payload[altKey];
  if (alt && typeof alt === 'object' && !Array.isArray(alt)) {
    const record = alt as Record<string, unknown>;
    const altPrice = coerceNumber(record.price);
    const altSize = coerceNumber(record.size);
    if (altPrice !== null && altSize !== null) {
      return { price: altPrice, size: altSize };
    }
  }

  return null;
}
