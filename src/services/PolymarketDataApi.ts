import { RateLimiter } from './RateLimiter.js';
import { RetryPolicy } from './RetryPolicy.js';
import type { VenuePosition } from '../domain/venue.js';

export interface PolymarketDataApiConfig {
  baseUrl: string;
  requestTimeoutMs: number;
  rateLimitPerSecond: number;
  rateLimitWindowMs: number;
  positionsPath: string;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export interface GetPositionsParams {
  user: string;
  markets?: string[];
  sizeThreshold?: number;
  limit?: number;
  offset?: number;
}

export class PolymarketDataApi {
  private baseUrl: string;
  private limiter: RateLimiter;
  private timeoutMs: number;
  private retryPolicy: RetryPolicy;
  private positionsPath: string;

  constructor(config: PolymarketDataApiConfig) {
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.limiter = new RateLimiter(config.rateLimitPerSecond, config.rateLimitWindowMs);
    this.positionsPath = config.positionsPath;
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryOn: (error) => {
        if (error instanceof DataApiError) {
          return error.status === 429 || error.status >= 500;
        }
        return true;
      }
    });
  }

  async getPositions(params: GetPositionsParams): Promise<VenuePosition[]> {
    const query = new URLSearchParams();
    query.set('user', params.user);
    if (params.markets && params.markets.length > 0) {
      query.set('market', params.markets.join(','));
    }
    if (typeof params.sizeThreshold === 'number') {
      query.set('sizeThreshold', String(params.sizeThreshold));
    }
    if (typeof params.limit === 'number') query.set('limit', String(params.limit));
    if (typeof params.offset === 'number') query.set('offset', String(params.offset));

    const path = `${this.positionsPath}?${query.toString()}`;
    const response = await this.request<unknown>('GET', path);
    if (!Array.isArray(response)) return [];
    return response.map((entry) => normalizeVenuePosition(entry));
  }

  private async request<T>(method: string, path: string): Promise<T> {
    await this.limiter.acquire();

    return this.retryPolicy.execute(async () => {
      const url = new URL(path, this.baseUrl).toString();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'openpolytrader/0.1.0'
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, { method, headers, signal: controller.signal });
        const text = await response.text();
        const parsed = text.length > 0 ? JSON.parse(text) : null;

        if (!response.ok) {
          throw new DataApiError(
            `Polymarket Data API error ${response.status} for ${method} ${path}`,
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

export class DataApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'DataApiError';
  }
}

function normalizeVenuePosition(raw: unknown): VenuePosition {
  const payload = raw as Record<string, unknown>;
  const tokenId =
    typeof payload?.asset === 'string'
      ? payload.asset
      : typeof payload?.asset_id === 'string'
        ? payload.asset_id
        : typeof payload?.assetId === 'string'
          ? payload.assetId
          : '';

  return {
    tokenId,
    marketId: typeof payload?.conditionId === 'string' ? payload.conditionId : undefined,
    size: parseNumber(payload?.size) ?? 0,
    avgPrice:
      parseNumber(payload?.avgPrice) ?? undefined,
    currentPrice:
      parseNumber(payload?.curPrice) ?? undefined,
    raw
  };
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
