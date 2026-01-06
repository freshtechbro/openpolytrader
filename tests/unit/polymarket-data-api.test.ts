import { afterEach, describe, expect, it, vi } from 'vitest';

import { PolymarketDataApi } from '../../src/services/PolymarketDataApi.js';

const BASE_CONFIG = {
  baseUrl: 'https://data-api.polymarket.com',
  requestTimeoutMs: 1000,
  rateLimitPerSecond: 1000,
  rateLimitWindowMs: 1000,
  positionsPath: '/positions',
  retryMaxRetries: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1
};

function stubFetch(responseBody: unknown) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(responseBody)
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function stubFetchText(text: string) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => text
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PolymarketDataApi', () => {
  it('fetches and normalizes positions', async () => {
    const fetchSpy = stubFetch([
      {
        asset: 'token-1',
        conditionId: 'market-1',
        size: 10,
        avgPrice: 0.5,
        curPrice: 0.55
      }
    ]);
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({
      user: '0xabc',
      markets: ['market-1'],
      sizeThreshold: 0,
      limit: 100,
      offset: 0
    });

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://data-api.polymarket.com/positions?user=0xabc&market=market-1&sizeThreshold=0&limit=100&offset=0'
    );
    expect(options.method).toBe('GET');
    expect(positions).toEqual([
      expect.objectContaining({
        tokenId: 'token-1',
        marketId: 'market-1',
        size: 10,
        avgPrice: 0.5,
        currentPrice: 0.55
      })
    ]);
  });

  it('handles string numeric fields', async () => {
    stubFetch([
      {
        asset: 'token-1',
        conditionId: 'market-1',
        size: '10',
        avgPrice: '0.5',
        curPrice: '0.55'
      }
    ]);
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions[0]).toEqual(
      expect.objectContaining({
        tokenId: 'token-1',
        marketId: 'market-1',
        size: 10,
        avgPrice: 0.5,
        currentPrice: 0.55
      })
    );
  });

  it('returns empty array when response is not an array', async () => {
    stubFetch({ ok: true });
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions).toEqual([]);
  });

  it('retries on 5xx and succeeds on retry', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'server' })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify([{ asset: 'token-1', conditionId: 'market-1', size: 1 }])
      });
    vi.stubGlobal('fetch', fetchSpy);

    const api = new PolymarketDataApi({
      ...BASE_CONFIG,
      retryMaxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    });

    const positions = await api.getPositions({ user: '0xabc' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(positions[0]).toEqual(
      expect.objectContaining({ tokenId: 'token-1', marketId: 'market-1', size: 1 })
    );
  });

  it('does not retry on 4xx errors', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'bad' })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const api = new PolymarketDataApi({
      ...BASE_CONFIG,
      retryMaxRetries: 10,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    });

    await expect(api.getPositions({ user: '0xabc' })).rejects.toThrow(
      /Polymarket Data API error 400/
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate_limited' })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify([{ asset: 'token-1', conditionId: 'market-1', size: 1 }])
      });
    vi.stubGlobal('fetch', fetchSpy);

    const api = new PolymarketDataApi({
      ...BASE_CONFIG,
      retryMaxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    });

    const positions = await api.getPositions({ user: '0xabc' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(positions[0]).toEqual(
      expect.objectContaining({ tokenId: 'token-1', marketId: 'market-1', size: 1 })
    );
  });

  it('retries on non-DataApiError failures (e.g., JSON parse errors)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'not-json'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([])
      });
    vi.stubGlobal('fetch', fetchSpy);

    const api = new PolymarketDataApi({
      ...BASE_CONFIG,
      retryMaxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    });

    const positions = await api.getPositions({ user: '0xabc' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(positions).toEqual([]);
  });

  it('returns empty array when the response body is empty', async () => {
    stubFetchText('');
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions).toEqual([]);
  });

  it('normalizes tokenId from asset_id fallback fields', async () => {
    stubFetch([
      { asset_id: 'token-1', conditionId: 'market-1', size: 1 },
      { assetId: 'token-2', conditionId: 'market-2', size: 2 }
    ]);
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions.map((p) => p.tokenId)).toEqual(['token-1', 'token-2']);
  });

  it('sanitizes invalid numeric fields', async () => {
    stubFetch([
      {
        asset: 'token-1',
        conditionId: 'market-1',
        size: 'not-a-number',
        avgPrice: 'NaN',
        curPrice: 'Infinity'
      }
    ]);
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions[0]).toEqual(
      expect.objectContaining({
        tokenId: 'token-1',
        marketId: 'market-1',
        size: 0,
        avgPrice: undefined,
        currentPrice: undefined
      })
    );
  });

  it('handles missing token identifiers and non-finite numeric values', async () => {
    stubFetch([
      {
        conditionId: 123,
        size: Number.POSITIVE_INFINITY,
        avgPrice: Number.NaN,
        curPrice: Number.NEGATIVE_INFINITY
      }
    ]);
    const api = new PolymarketDataApi(BASE_CONFIG);

    const positions = await api.getPositions({ user: '0xabc' });

    expect(positions[0]).toEqual(
      expect.objectContaining({
        tokenId: '',
        marketId: undefined,
        size: 0,
        avgPrice: undefined,
        currentPrice: undefined
      })
    );
  });
});
