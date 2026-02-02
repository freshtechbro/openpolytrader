import { describe, it, expect, vi, afterEach } from 'vitest';

import { PolymarketClob } from '../../src/services/PolymarketClob.js';

const BASE_CONFIG = {
  baseUrl: 'https://clob.polymarket.com',
  requestTimeoutMs: 1000,
  rateLimitPerSecond: 1000,
  rateLimitWindowMs: 1000,
  orderPath: '/orders',
  batchOrderPath: '/orders',
  cancelOrderPath: '/order',
  cancelOrdersPath: '/orders',
  cancelAllPath: '/cancel-all',
  cancelMarketOrdersPath: '/cancel-market-orders',
  activeOrdersPath: '/data/orders',
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PolymarketClob cancel endpoints', () => {
  it('sends cancel order with orderID payload', async () => {
    const fetchSpy = stubFetch({ canceled: ['order-1'], not_canceled: {} });
    const clob = new PolymarketClob(BASE_CONFIG);

    await clob.cancelOrder('order-1');

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://clob.polymarket.com/order');
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual({ orderID: 'order-1' });
  });

  it('sends cancel orders with array payload', async () => {
    const fetchSpy = stubFetch({ canceled: ['o1', 'o2'], not_canceled: {} });
    const clob = new PolymarketClob(BASE_CONFIG);

    await clob.cancelOrders(['o1', 'o2']);

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://clob.polymarket.com/orders');
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual(['o1', 'o2']);
  });

  it('sends cancel-all with no payload', async () => {
    const fetchSpy = stubFetch({ canceled: [], not_canceled: {} });
    const clob = new PolymarketClob(BASE_CONFIG);

    await clob.cancelAll();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://clob.polymarket.com/cancel-all');
    expect(options.method).toBe('DELETE');
    expect(options.body).toBeUndefined();
  });

  it('sends cancel-market-orders with market and asset_id payload', async () => {
    const fetchSpy = stubFetch({ canceled: ['o9'], not_canceled: {} });
    const clob = new PolymarketClob(BASE_CONFIG);

    await clob.cancelMarketOrders({ market: 'market-1', assetId: 'asset-1' });

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://clob.polymarket.com/cancel-market-orders');
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual({
      market: 'market-1',
      asset_id: 'asset-1'
    });
  });
});

describe('PolymarketClob order submission', () => {
  it('treats duplicate order errors as success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ errorMsg: 'INVALID_ORDER_DUPLICATED' })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const clob = new PolymarketClob(BASE_CONFIG);
    const response = await clob.createOrder({ token_id: 'token-1', side: 'BUY', size: 1, price: 0.5 });

    expect(response).toEqual(
      expect.objectContaining({ success: true, status: 'LIVE', duplicate: true })
    );
  });

  it('retries on invalid JSON responses', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'not-json'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ ok: true })
      });
    vi.stubGlobal('fetch', fetchSpy);

    const clob = new PolymarketClob({
      ...BASE_CONFIG,
      retryMaxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    });

    const response = await clob.getPrices([{ token_id: 'token-1', side: 'BUY' }]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(response).toEqual({ ok: true });
  });
});
