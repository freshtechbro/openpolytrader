import { messageBus } from '../../core/MessageBus.js';
import type { TradePolicy } from '../../config/policy.js';
import { PolymarketClob, type OrderBookResponse } from '../../services/PolymarketClob.js';
import { PolymarketRealtime } from '../../services/PolymarketRealtime.js';
import { coercePositiveNumber, normalizeOrderBook, type OrderBookState } from '../../domain/orderbook.js';
import { isOutOfSequence, SequenceTracker } from '../../domain/sequence.js';
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
  private sequenceTracker = new SequenceTracker();

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
    const snapshot = await this.clob.getOrderBook(tokenId);
    this.updateBook(tokenId, snapshot, Date.now());
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
    this.config.tokenIds = tokenIds;
    if (this.realtime) {
      this.realtime.subscribeMarkets(tokenIds);
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
    const eventType = (payload.event_type ?? payload.type ?? envelopeType) as
      | string
      | undefined;
    
    // Handle explicit book/agg_orderbook events OR raw order book data with bids/asks
    const isBookEvent = eventType === 'book' || eventType === 'agg_orderbook';
    const isRawBookData = Array.isArray(payload.bids) || Array.isArray(payload.asks);
    
    if (!isBookEvent && !isRawBookData) {
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

    void this.maybeDetectOutlier(tokenId, next, receivedAtMs);
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
      'Return JSON only, with shape: {"outlier":boolean,"reason":string|null,"confidence":number}. No prose.';

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model,
      messages: [
        { role: 'developer', content: jsonInstruction },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ],
      temperature: 0,
      max_tokens: 200
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
