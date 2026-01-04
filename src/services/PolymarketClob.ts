import { RateLimiter } from './RateLimiter.js';
import { RetryPolicy } from './RetryPolicy.js';

export interface AuthHeadersProvider {
  getHeaders(input: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<Record<string, string>> | Record<string, string>;
}

export interface PolymarketClobConfig {
  baseUrl?: string;
  requestTimeoutMs?: number;
  rateLimitPerSecond?: number;
  authProvider?: AuthHeadersProvider;
  orderPath?: string;
  batchOrderPath?: string;
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

export class PolymarketClob {
  private baseUrl: string;
  private limiter: RateLimiter;
  private timeoutMs: number;
  private authProvider?: AuthHeadersProvider;
  private retryPolicy: RetryPolicy;
  private orderPath: string;
  private batchOrderPath: string;
  private nextNonce = Date.now() * 1000;

  constructor(config: PolymarketClobConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'https://clob.polymarket.com';
    this.timeoutMs = config.requestTimeoutMs ?? 8000;
    this.limiter = new RateLimiter(config.rateLimitPerSecond ?? 300);
    this.authProvider = config.authProvider;
    this.orderPath = config.orderPath ?? '/orders';
    this.batchOrderPath = config.batchOrderPath ?? '/orders';
    this.retryPolicy = new RetryPolicy({
      maxRetries: 3,
      baseDelayMs: 250,
      maxDelayMs: 2000,
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
    return this.request('POST', this.orderPath, withNonce(payload, () => this.allocateNonce()));
  }

  async createBatchOrders(payload: unknown): Promise<unknown> {
    return this.request('POST', this.batchOrderPath, payload);
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
