import { messageBus } from '../../core/MessageBus.js';
import type { TradePolicy } from '../../config/policy.js';
import { PolymarketClob, type OrderBookResponse } from '../../services/PolymarketClob.js';
import { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import { coercePositiveNumber, normalizeOrderBook, type OrderBookState } from '../../domain/orderbook.js';
import { isOutOfSequence } from '../../domain/sequence.js';
import type { MetricsStore } from '../../telemetry/metrics.js';

export interface MarketDataAgentConfig {
  tokenIds: string[];
  policy: TradePolicy;
  metrics?: MetricsStore;
}

export interface MarketUpdateEvent {
  tokenId: string;
  book: OrderBookState;
}

export class MarketDataAgent {
  private orderbooks = new Map<string, OrderBookState>();
  private metrics?: MetricsStore;

  constructor(
    private config: MarketDataAgentConfig,
    private clob: PolymarketClob,
    private realtime: PolymarketRealtime
  ) {
    this.metrics = config.metrics;
  }

  async start(): Promise<void> {
    await this.realtime.connect();
    this.realtime.on('message', (payload) => this.handleMessage(payload));
    if (this.config.tokenIds.length > 0) {
      this.realtime.subscribeMarkets(this.config.tokenIds);
    }
  }

  getOrderBook(tokenId: string): OrderBookState | undefined {
    return this.orderbooks.get(tokenId);
  }

  async refreshSnapshot(tokenId: string): Promise<void> {
    const snapshot = await this.clob.getOrderBook(tokenId);
    this.updateBook(tokenId, snapshot, Date.now());
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
    const eventType = (payload.event_type ?? payload.type ?? envelopeType) as
      | string
      | undefined;
    if (eventType !== 'book' && eventType !== 'agg_orderbook') {
      return;
    }

    const tokenId = extractTokenId(payload);
    if (!tokenId) {
      return;
    }

    const normalized = normalizeWsBook(payload);
    this.updateBook(tokenId, normalized, Date.now());
  }

  private updateBook(tokenId: string, raw: OrderBookResponse, receivedAtMs: number): void {
    const previous = this.orderbooks.get(tokenId);

    if (previous?.exchangeTimestamp && raw.timestamp) {
      if (isOutOfSequence(previous.exchangeTimestamp, raw.timestamp)) {
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

    if (this.metrics && (usedTickFallback || usedMinOrderFallback)) {
      this.metrics.record({
        type: 'book_fallback',
        timestamp: receivedAtMs,
        data: {
          tokenId,
          usedTickFallback,
          usedMinOrderFallback,
          fallbackTickSize: this.config.policy.fallbackTickSize,
          fallbackMinOrderSize: this.config.policy.fallbackMinOrderSize
        }
      });
    }
    this.orderbooks.set(tokenId, next);
    messageBus.emit('market:updated', { tokenId, book: next } satisfies MarketUpdateEvent);
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

  if (Array.isArray(buys) || Array.isArray(sells)) {
    return {
      bids: Array.isArray(buys) ? (buys as OrderBookResponse['bids']) : [],
      asks: Array.isArray(sells) ? (sells as OrderBookResponse['asks']) : [],
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
      hash: typeof payload.hash === 'string' ? payload.hash : undefined
    };
  }

  const bids = payload.bids;
  const asks = payload.asks;

  return {
    bids: Array.isArray(bids) ? (bids as OrderBookResponse['bids']) : [],
    asks: Array.isArray(asks) ? (asks as OrderBookResponse['asks']) : [],
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
    hash: typeof payload.hash === 'string' ? payload.hash : undefined
  };
}
