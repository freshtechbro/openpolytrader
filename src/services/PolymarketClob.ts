import { RateLimiter } from './RateLimiter.js';
import { RetryPolicy } from './RetryPolicy.js';
import type { VenueOpenOrder } from '../domain/venue.js';

export interface AuthHeadersProvider {
  getHeaders(input: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<Record<string, string>> | Record<string, string>;
}

export interface PolymarketClobConfig {
  baseUrl: string;
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  if ('nonce' in payload) {
    return payload;
  }

  return { ...(payload as Record<string, unknown>), nonce: allocate() };
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

export interface OrderBookResponse {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size?: string;
  tick_size?: string;
  timestamp?: string;
  hash?: string;
}

export interface MidpointResponse {
  mid: string;
}

export interface PricesRequest {
  token_id: string;
  side: 'BUY' | 'SELL';
}

export interface CancelOrdersResponse {
  canceled?: string[];
  not_canceled?: Record<string, unknown>;
}

export interface CancelMarketOrdersParams {
  market?: string;
  assetId?: string;
}

export interface ActiveOrdersParams {
  orderId?: string;
  market?: string;
  assetId?: string;
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
    this.baseUrl = config.baseUrl;
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

  async getOrderBook(tokenId: string): Promise<OrderBookResponse> {
    return this.request<OrderBookResponse>('GET', `/book?token_id=${tokenId}`);
  }

  async getMidpoint(tokenId: string): Promise<MidpointResponse> {
    return this.request<MidpointResponse>('GET', `/midpoint?token_id=${tokenId}`);
  }

  async getPrices(requests: PricesRequest[]): Promise<Record<string, { BUY?: string; SELL?: string }>> {
    return this.request('POST', '/prices', requests);
  }

  async createOrder(payload: unknown): Promise<unknown> {
    const body = withNonce(payload, () => this.allocateNonce());
    try {
      return await this.request('POST', this.orderPath, body);
    } catch (error) {
      if (isDuplicateOrderError(error)) {
        return buildDuplicateOrderResponse((error as ApiError).body);
      }
      throw error;
    }
  }

  async createBatchOrders(payload: unknown): Promise<unknown> {
    return this.request('POST', this.batchOrderPath, payload);
  }

  reserveNonce(): string {
    return String(this.allocateNonce());
  }

  async cancelOrder(orderId: string): Promise<CancelOrdersResponse> {
    return this.request('DELETE', this.cancelOrderPath, { orderID: orderId });
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrdersResponse> {
    return this.request('DELETE', this.cancelOrdersPath, orderIds);
  }

  async cancelAll(): Promise<CancelOrdersResponse> {
    return this.request('DELETE', this.cancelAllPath);
  }

  async cancelMarketOrders(params: CancelMarketOrdersParams): Promise<CancelOrdersResponse> {
    const payload: Record<string, string> = {};
    if (params.market) payload.market = params.market;
    if (params.assetId) payload.asset_id = params.assetId;
    return this.request('DELETE', this.cancelMarketOrdersPath, payload);
  }

  async getActiveOrders(params?: ActiveOrdersParams): Promise<VenueOpenOrder[]> {
    const query = new URLSearchParams();
    if (params?.orderId) query.set('id', params.orderId);
    if (params?.market) query.set('market', params.market);
    if (params?.assetId) query.set('asset_id', params.assetId);

    const path = query.toString().length > 0 ? `${this.activeOrdersPath}?${query.toString()}` : this.activeOrdersPath;
    const response = await this.request<unknown>('GET', path);
    if (!Array.isArray(response)) return [];

    return response.map((entry) => normalizeVenueOpenOrder(entry));
  }

  private allocateNonce(): number {
    const nonce = this.nextNonce;
    this.nextNonce += 1;
    return nonce;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
        const parsed = text.length > 0 ? JSON.parse(text) : null;

        if (!response.ok) {
          throw new ApiError(
            `Polymarket CLOB error ${response.status} for ${method} ${path}`,
            response.status,
            parsed
          );
        }

        return parsed as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

function isDuplicateOrderError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return isDuplicateOrderBody(error.body);
}

function isDuplicateOrderBody(body: unknown): boolean {
  const payload = body as { error?: string; errorMsg?: string; message?: string };
  const message =
    payload?.error ?? payload?.errorMsg ?? payload?.message ?? '';
  return typeof message === 'string' && message.toUpperCase().includes('INVALID_ORDER_DUPLICATED');
}

function buildDuplicateOrderResponse(body: unknown): Record<string, unknown> {
  const payload = body as { orderID?: string; orderId?: string; id?: string };
  const orderID = payload?.orderID ?? payload?.orderId ?? payload?.id;
  const response: Record<string, unknown> = {
    success: true,
    status: 'LIVE',
    duplicate: true
  };
  if (orderID) response.orderID = orderID;
  return response;
}

function normalizeVenueOpenOrder(raw: unknown): VenueOpenOrder {
  const payload = raw as Record<string, unknown>;
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
