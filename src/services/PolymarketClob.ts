import { RateLimiter } from './RateLimiter.js';
import { RetryPolicy } from './RetryPolicy.js';
import { resolvePolymarketClobBaseUrl } from './PolymarketUrls.js';
import type { RawOrderBookSnapshot } from '../domain/orderbook.js';
import type { VenueOpenOrder } from '../domain/venue.js';
import { safeParseJsonBody } from '../utils/serialization.js';

export interface AuthHeadersProvider {
  getHeaders(input: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<Record<string, string>> | Record<string, string>;
}

interface PolymarketClobConfig {
  baseUrl?: string;
  requestTimeoutMs: number;
  rateLimitPerSecond: number;
  rateLimitWindowMs: number;
  authProvider?: AuthHeadersProvider;
  orderPath: string;
  batchOrderPath: string;
  cancelOrderPath: string;
  cancelOrdersPath: string;
  cancelAllPath: string;
  cancelMarketOrdersPath: string;
  activeOrdersPath: string;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

function withNonce(
  payload: unknown,
  allocate: () => number
): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if ('nonce' in payload) {
    return payload;
  }

  return { ...payload, nonce: allocate() };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
  }
}

interface MidpointResponse {
  mid: string;
}

interface PricesRequest {
  token_id: string;
  side: 'BUY' | 'SELL';
}

export interface CancelOrdersResponse {
  canceled?: string[];
  not_canceled?: Record<string, unknown>;
}

interface CancelMarketOrdersParams {
  market?: string;
  assetId?: string;
}

interface ActiveOrdersParams {
  orderId?: string;
  market?: string;
  assetId?: string;
}

export interface MarketInfo {
  condition_id: string;
  question: string;
  description?: string;
  market_slug?: string;
  end_date_iso?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
}

export class PolymarketClob {
  private baseUrl: string;
  private limiter: RateLimiter;
  private timeoutMs: number;
  private authProvider?: AuthHeadersProvider;
  private retryPolicy: RetryPolicy;
  private orderPath: string;
  private batchOrderPath: string;
  private cancelOrderPath: string;
  private cancelOrdersPath: string;
  private cancelAllPath: string;
  private cancelMarketOrdersPath: string;
  private activeOrdersPath: string;
  private nextNonce = Date.now() * 1000;

  constructor(config: PolymarketClobConfig) {
    this.baseUrl = resolvePolymarketClobBaseUrl(config.baseUrl);
    this.timeoutMs = config.requestTimeoutMs;
    this.limiter = new RateLimiter(config.rateLimitPerSecond, config.rateLimitWindowMs);
    this.authProvider = config.authProvider;
    this.orderPath = config.orderPath;
    this.batchOrderPath = config.batchOrderPath;
    this.cancelOrderPath = config.cancelOrderPath;
    this.cancelOrdersPath = config.cancelOrdersPath;
    this.cancelAllPath = config.cancelAllPath;
    this.cancelMarketOrdersPath = config.cancelMarketOrdersPath;
    this.activeOrdersPath = config.activeOrdersPath;
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: (error) => {
        if (error instanceof ApiError) {
          return error.status === 429 || error.status >= 500;
        }
        return true;
      }
    });
  }

  async getMarket(conditionId: string): Promise<MarketInfo | null> {
    try {
      return parseMarketInfo(await this.requestJson('GET', `/markets/${conditionId}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getOrderBook(tokenId: string): Promise<RawOrderBookSnapshot> {
    return parseOrderBookResponse(await this.requestJson('GET', `/book?token_id=${tokenId}`));
  }

  async getMidpoint(tokenId: string): Promise<MidpointResponse> {
    return parseMidpointResponse(await this.requestJson('GET', `/midpoint?token_id=${tokenId}`));
  }

  async getPrices(requests: PricesRequest[]): Promise<Record<string, { BUY?: string; SELL?: string }>> {
    return parsePricesResponse(await this.requestJson('POST', '/prices', requests));
  }

  async createOrder(payload: unknown): Promise<unknown> {
    const body = withNonce(payload, () => this.allocateNonce());
    try {
      return await this.requestJson('POST', this.orderPath, body);
    } catch (error) {
      if (isDuplicateOrderError(error)) {
        return buildDuplicateOrderResponse((error as ApiError).body);
      }
      throw error;
    }
  }

  async createBatchOrders(payload: unknown): Promise<unknown> {
    return this.requestJson('POST', this.batchOrderPath, payload);
  }

  reserveNonce(): string {
    return String(this.allocateNonce());
  }

  async cancelOrder(orderId: string): Promise<CancelOrdersResponse> {
    return parseCancelOrdersResponse(
      await this.requestJson('DELETE', this.cancelOrderPath, { orderID: orderId })
    );
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrdersResponse> {
    return parseCancelOrdersResponse(await this.requestJson('DELETE', this.cancelOrdersPath, orderIds));
  }

  async cancelAll(): Promise<CancelOrdersResponse> {
    return parseCancelOrdersResponse(await this.requestJson('DELETE', this.cancelAllPath));
  }

  async cancelMarketOrders(params: CancelMarketOrdersParams): Promise<CancelOrdersResponse> {
    const payload: Record<string, string> = {};
    if (params.market) payload.market = params.market;
    if (params.assetId) payload.asset_id = params.assetId;
    return parseCancelOrdersResponse(
      await this.requestJson('DELETE', this.cancelMarketOrdersPath, payload)
    );
  }

  async getActiveOrders(params?: ActiveOrdersParams): Promise<VenueOpenOrder[]> {
    const query = new URLSearchParams();
    if (params?.orderId) query.set('id', params.orderId);
    if (params?.market) query.set('market', params.market);
    if (params?.assetId) query.set('asset_id', params.assetId);

    const path = query.toString().length > 0 ? `${this.activeOrdersPath}?${query.toString()}` : this.activeOrdersPath;
    const response = await this.requestJson('GET', path);
    if (!Array.isArray(response)) return [];

    return response.map((entry) => normalizeVenueOpenOrder(entry));
  }

  private allocateNonce(): number {
    const nonce = this.nextNonce;
    this.nextNonce += 1;
    return nonce;
  }

  private async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.limiter.acquire();

    return this.retryPolicy.execute(async () => {
      const url = new URL(path, this.baseUrl).toString();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'openpolytrader/0.1.0'
      };

      if (this.authProvider) {
        const authHeaders = await this.authProvider.getHeaders({ method, path, body });
        Object.assign(headers, authHeaders);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });

        const text = await response.text();
        const parsedResult = safeParseJsonBody(text);

        if (!response.ok) {
          throw new ApiError(
            `Polymarket CLOB error ${response.status} for ${method} ${path}`,
            response.status,
            parsedResult.failed ? { raw: text } : parsedResult.parsed
          );
        }

        if (parsedResult.failed) {
          const snippet = text.slice(0, 200);
          throw new Error(`Polymarket CLOB invalid JSON for ${method} ${path}: ${snippet}`);
        }

        return parsedResult.parsed;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

function parseMarketInfo(payload: unknown): MarketInfo {
  if (!isRecord(payload) || typeof payload.condition_id !== 'string' || typeof payload.question !== 'string') {
    throw new Error('Polymarket CLOB returned invalid market payload');
  }

  return {
    condition_id: payload.condition_id,
    question: payload.question,
    ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
    ...(typeof payload.market_slug === 'string' ? { market_slug: payload.market_slug } : {}),
    ...(typeof payload.end_date_iso === 'string' ? { end_date_iso: payload.end_date_iso } : {}),
    ...(Array.isArray(payload.tokens) ? { tokens: parseMarketTokens(payload.tokens) } : {})
  };
}

function parseMarketTokens(tokens: unknown[]): MarketInfo['tokens'] {
  return tokens.flatMap((token) =>
    isRecord(token) && typeof token.token_id === 'string' && typeof token.outcome === 'string'
      ? [{ token_id: token.token_id, outcome: token.outcome }]
      : []
  );
}

function parseOrderBookResponse(payload: unknown): RawOrderBookSnapshot {
  if (!isRecord(payload) || !isOrderLevels(payload.bids) || !isOrderLevels(payload.asks)) {
    throw new Error('Polymarket CLOB returned invalid order book payload');
  }

  return {
    bids: payload.bids,
    asks: payload.asks,
    ...(typeof payload.min_order_size === 'string' || typeof payload.min_order_size === 'number'
      ? { min_order_size: String(payload.min_order_size) }
      : {}),
    ...(typeof payload.tick_size === 'string' || typeof payload.tick_size === 'number'
      ? { tick_size: String(payload.tick_size) }
      : {}),
    ...(typeof payload.timestamp === 'string' ? { timestamp: payload.timestamp } : {}),
    ...(typeof payload.hash === 'string' ? { hash: payload.hash } : {})
  };
}

function parseMidpointResponse(payload: unknown): MidpointResponse {
  if (!isRecord(payload) || typeof payload.mid !== 'string') {
    throw new Error('Polymarket CLOB returned invalid midpoint payload');
  }
  return { mid: payload.mid };
}

function parsePricesResponse(payload: unknown): Record<string, { BUY?: string; SELL?: string }> {
  if (!isRecord(payload)) {
    throw new Error('Polymarket CLOB returned invalid prices payload');
  }

  const prices: Record<string, { BUY?: string; SELL?: string }> = {};
  for (const [tokenId, value] of Object.entries(payload)) {
    if (!isRecord(value)) continue;
    const entry: { BUY?: string; SELL?: string } = {};
    if (typeof value.BUY === 'string') entry.BUY = value.BUY;
    if (typeof value.SELL === 'string') entry.SELL = value.SELL;
    prices[tokenId] = entry;
  }
  return prices;
}

function parseCancelOrdersResponse(payload: unknown): CancelOrdersResponse {
  if (!isRecord(payload)) {
    throw new Error('Polymarket CLOB returned invalid cancel response payload');
  }

  const response: CancelOrdersResponse = {};
  if (Array.isArray(payload.canceled)) {
    response.canceled = payload.canceled.filter((entry): entry is string => typeof entry === 'string');
  }
  if (isRecord(payload.not_canceled)) {
    response.not_canceled = payload.not_canceled;
  }
  return response;
}

function isOrderLevels(value: unknown): value is RawOrderBookSnapshot['bids'] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.price === 'string' && typeof entry.size === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDuplicateOrderError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return isDuplicateOrderBody(error.body);
}

function isDuplicateOrderBody(body: unknown): boolean {
  const message =
    isRecord(body) && typeof body.error === 'string'
      ? body.error
      : isRecord(body) && typeof body.errorMsg === 'string'
        ? body.errorMsg
        : isRecord(body) && typeof body.message === 'string'
          ? body.message
          : '';
  return typeof message === 'string' && message.toUpperCase().includes('INVALID_ORDER_DUPLICATED');
}

function buildDuplicateOrderResponse(body: unknown): Record<string, unknown> {
  const orderID =
    isRecord(body) && typeof body.orderID === 'string'
      ? body.orderID
      : isRecord(body) && typeof body.orderId === 'string'
        ? body.orderId
        : isRecord(body) && typeof body.id === 'string'
          ? body.id
          : undefined;
  const response: Record<string, unknown> = {
    success: true,
    status: 'LIVE',
    duplicate: true
  };
  if (orderID) response.orderID = orderID;
  return response;
}

function normalizeVenueOpenOrder(raw: unknown): VenueOpenOrder {
  const payload = isRecord(raw) ? raw : {};
  const orderId =
    typeof payload?.id === 'string'
      ? payload.id
      : typeof payload?.orderID === 'string'
        ? payload.orderID
        : typeof payload?.orderId === 'string'
          ? payload.orderId
          : '';

  return {
    orderId,
    marketId: typeof payload?.market === 'string' ? payload.market : undefined,
    tokenId: typeof payload?.asset_id === 'string' ? payload.asset_id : typeof payload?.assetId === 'string' ? payload.assetId : undefined,
    side: typeof payload?.side === 'string' ? payload.side : undefined,
    price: typeof payload?.price === 'number' ? payload.price : typeof payload?.price === 'string' ? Number(payload.price) : undefined,
    size:
      typeof payload?.size === 'number'
        ? payload.size
        : typeof payload?.size === 'string'
          ? Number(payload.size)
          : undefined,
    status: typeof payload?.status === 'string' ? payload.status : undefined,
    raw
  };
}
