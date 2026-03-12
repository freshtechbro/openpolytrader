import type { GammaMarket, MarketCatalogOrder } from './MarketCatalogTypes.js';
import { buildBaseUrl } from '../utils/baseUrl.js';

const DEFAULT_GAMMA_API_HOST = 'gamma-api.polymarket.com';
const DEFAULT_GAMMA_API_BASE_URL = buildBaseUrl('https:', DEFAULT_GAMMA_API_HOST);

export class GammaMarketPageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string
  ) {
    super(message);
    this.name = 'GammaMarketPageError';
  }
}

export async function fetchMarketPage(args: {
  gammaApiBaseUrl: string;
  requestTimeoutMs: number;
  params: {
    limit: number;
    offset: number;
    cursor: string | null;
    order: MarketCatalogOrder;
  };
}): Promise<{ markets: GammaMarket[]; nextCursor: string | null }> {
  const url = new URL('/markets', args.gammaApiBaseUrl);
  const requestLabel = `GET ${url.pathname}`;
  const { order, ascending } = resolveOrderParams(args.params.order);
  url.searchParams.set('limit', String(args.params.limit));
  url.searchParams.set('order', order);
  url.searchParams.set('ascending', String(ascending));
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  if (args.params.cursor) {
    url.searchParams.set('cursor', args.params.cursor);
  } else {
    url.searchParams.set('offset', String(args.params.offset));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), args.requestTimeoutMs);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'openpolytrader/0.1.0'
      },
      signal: controller.signal
    });

    const bodyText = await readResponseBodyText(response);
    if (!response.ok) {
      throw new GammaMarketPageError(
        `Gamma API fetch failed (${response.status}): ${bodyText.slice(0, 200)}`,
        response.status,
        requestLabel
      );
    }

    const data = parseGammaMarketPageBody(bodyText, response.status, requestLabel);
    if (Array.isArray(data)) {
      return { markets: data, nextCursor: null };
    }
    if (isGammaMarketPageEnvelope(data)) {
      return { markets: data.data, nextCursor: extractNextCursor(data) };
    }
    throw new GammaMarketPageError(
      `Gamma API invalid payload (${response.status}) for ${requestLabel}`,
      response.status,
      requestLabel
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export function resolveDefaultGammaApiBaseUrl(): string {
  return DEFAULT_GAMMA_API_BASE_URL;
}

function resolveOrderParams(orderMode: MarketCatalogOrder): { order: string; ascending: boolean } {
  if (orderMode === 'newest') {
    return { order: 'id', ascending: false };
  }
  return { order: 'volume24hr', ascending: false };
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

function parseGammaMarketPageBody(bodyText: string, status: number, endpoint: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new GammaMarketPageError(
      `Gamma API invalid JSON for ${endpoint}: ${bodyText.slice(0, 200)}`,
      status,
      endpoint
    );
  }
}

function isGammaMarketPageEnvelope(
  value: unknown
): value is { data: GammaMarket[]; next_cursor?: string | null; nextCursor?: string | null; cursor?: string | null } {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data);
}

async function readResponseBodyText(response: Response): Promise<string> {
  if (typeof response.text === 'function') {
    return response.text();
  }
  if (typeof response.json === 'function') {
    return JSON.stringify(await response.json());
  }
  return '';
}
