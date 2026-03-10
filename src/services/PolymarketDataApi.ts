import { RateLimiter } from './RateLimiter.js';
import { RetryPolicy } from './RetryPolicy.js';
import { resolvePolymarketDataApiBaseUrl } from './PolymarketUrls.js';
import { DataApiError, executeDataApiRequest } from './PolymarketDataApiRequest.js';
import { normalizeVenuePosition } from './PolymarketPositionNormalization.js';
import type { VenuePosition } from '../domain/venue.js';

interface PolymarketDataApiConfig {
  baseUrl?: string;
  requestTimeoutMs: number;
  rateLimitPerSecond: number;
  rateLimitWindowMs: number;
  positionsPath: string;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

interface GetPositionsParams {
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
    this.baseUrl = resolvePolymarketDataApiBaseUrl(config.baseUrl);
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
    return response.map((entry) => normalizeVenuePosition(entry)).filter((entry): entry is VenuePosition => entry !== null);
  }

  private async request<T>(method: string, path: string): Promise<T> {
    await this.limiter.acquire();

    return this.retryPolicy.execute(() =>
      executeDataApiRequest<T>({ baseUrl: this.baseUrl, method, path, timeoutMs: this.timeoutMs })
    );
  }
}
