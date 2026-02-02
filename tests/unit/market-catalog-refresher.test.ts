import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketCatalogRefresher, type GammaMarket } from '../../src/services/MarketCatalogRefresher.js';
import type { MarketPair } from '../../src/domain/market.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { MetricsStore } from '../../src/telemetry/metrics.js';

type FetchMock = ReturnType<typeof vi.fn<Promise<unknown>, Parameters<typeof fetch>>>;

const originalFetch = global.fetch;

const createMockClob = (): Pick<PolymarketClob, 'getOrderBook'> => ({
  getOrderBook: vi.fn()
});

const createMockMetrics = () => ({
  record: vi.fn(),
  recent: vi.fn().mockReturnValue([])
} as unknown as MetricsStore);

const createValidBook = (bestBid = 0.49, bestAsk = 0.50) => ({
  bids: [{ price: String(bestBid), size: '100' }],
  asks: [{ price: String(bestAsk), size: '100' }],
  tick_size: '0.01',
  min_order_size: '5'
});

const createGammaMarket = (overrides: Partial<GammaMarket> = {}): GammaMarket => ({
  condition_id: 'market-123',
  question: 'Test Market?',
  volume24hr: 100000,
  active: true,
  closed: false,
  accepting_orders: true,
  enable_order_book: true,
  clobTokenIds: ['yes-token', 'no-token'],
  ...overrides
});

describe('MarketCatalogRefresher', () => {
  let refresher: MarketCatalogRefresher;
  let mockClob: ReturnType<typeof createMockClob>;
  let mockMetrics: MetricsStore;
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClob = createMockClob();
    mockMetrics = createMockMetrics();

    fetchMock = vi.fn<Promise<unknown>, Parameters<typeof fetch>>();
    global.fetch = fetchMock as typeof fetch;

    refresher = new MarketCatalogRefresher(
      {
        refreshIntervalMs: 60000,
        maxPairs: 10,
        minVolume24h: 50000,
        maxSpread: 0.02,
        gammaApiBaseUrl: 'https://gamma-api.example.com'
      },
      mockClob as unknown as PolymarketClob,
      mockMetrics
    );
  });

  afterEach(() => {
    refresher.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('merges config with defaults', () => {
      const r = new MarketCatalogRefresher(
        { gammaApiBaseUrl: 'https://test.com' },
        mockClob as unknown as PolymarketClob
      );
      expect(r.getPairs()).toEqual([]);
    });
  });

  describe('seed', () => {
    it('populates current pairs', () => {
      const pairs: MarketPair[] = [
        { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' },
        { marketId: 'm2', yesTokenId: 'y2', noTokenId: 'n2' }
      ];
      
      refresher.seed(pairs);
      
      expect(refresher.getPairs()).toHaveLength(2);
      expect(refresher.getPairs()).toEqual(expect.arrayContaining(pairs));
    });

    it('overwrites existing pairs with same marketId', () => {
      refresher.seed([{ marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }]);
      refresher.seed([{ marketId: 'm1', yesTokenId: 'y1-new', noTokenId: 'n1-new' }]);
      
      const pairs = refresher.getPairs();
      expect(pairs).toHaveLength(1);
      expect(pairs[0].yesTokenId).toBe('y1-new');
    });
  });

  describe('start/stop', () => {
    it('starts refresh interval', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });
      
      refresher.start();
      
      expect(global.fetch).toHaveBeenCalledTimes(1);
      
      await vi.advanceTimersByTimeAsync(60000);
      
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does not start twice', () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });
      
      refresher.start();
      refresher.start();
      
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('stops refresh interval', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });
      
      refresher.start();
      refresher.stop();
      
      await vi.advanceTimersByTimeAsync(120000);
      
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('stop is idempotent', () => {
      refresher.stop();
      refresher.stop();
    });
  });

  describe('refresh', () => {
    it('skips concurrent refresh calls', async () => {
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => fetchPromise
      });

      const first = refresher.refresh();
      const second = await refresher.refresh();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second.pagesScanned).toBe(0);

      resolveFetch!([]);
      await first;
    });

    it('fetches markets from gamma API', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });
      
      await refresher.refresh();
      
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('gamma-api.example.com/markets'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('paginates with offset and stops once enough pairs are collected', async () => {
      refresher = new MarketCatalogRefresher(
        {
          refreshIntervalMs: 60000,
          maxPairs: 2,
          minVolume24h: 0,
          maxSpread: 0.02,
          pageSize: 1,
          maxPages: 3,
          gammaApiBaseUrl: 'https://gamma-api.example.com'
        },
        mockClob as unknown as PolymarketClob,
        mockMetrics
      );

      const marketA = createGammaMarket({
        condition_id: 'market-a',
        clobTokenIds: ['yes-a', 'no-a']
      });
      const marketB = createGammaMarket({
        condition_id: 'market-b',
        clobTokenIds: ['yes-b', 'no-b']
      });

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([marketA])
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([marketB])
        });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
      const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
      expect(firstUrl.searchParams.get('offset')).toBe('0');
      expect(secondUrl.searchParams.get('offset')).toBe('1');
      expect(result.totalPairs).toBe(2);
      expect(result.pagesScanned).toBe(2);
    });

    it('uses newest ordering when configured', async () => {
      refresher = new MarketCatalogRefresher(
        {
          refreshIntervalMs: 60000,
          maxPairs: 10,
          minVolume24h: 0,
          maxSpread: 0.02,
          pageSize: 1,
          maxPages: 1,
          order: 'newest',
          gammaApiBaseUrl: 'https://gamma-api.example.com'
        },
        mockClob as unknown as PolymarketClob,
        mockMetrics
      );

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });

      await refresher.refresh();

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.searchParams.get('order')).toBe('id');
      expect(url.searchParams.get('ascending')).toBe('false');
    });

    it('uses cursor pagination when provided', async () => {
      refresher = new MarketCatalogRefresher(
        {
          refreshIntervalMs: 60000,
          maxPairs: 10,
          minVolume24h: 0,
          maxSpread: 0.02,
          pageSize: 1,
          maxPages: 2,
          gammaApiBaseUrl: 'https://gamma-api.example.com'
        },
        mockClob as unknown as PolymarketClob,
        mockMetrics
      );

      const market = createGammaMarket({ accepting_orders: false });

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [market], next_cursor: 'next-1' })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });

      await refresher.refresh();

      const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
      expect(secondUrl.searchParams.get('cursor')).toBe('next-1');
    });

    it('restarts the interval when refresh config changes', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });

      refresher.start();
      await vi.advanceTimersByTimeAsync(60000);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      refresher.updateConfig({ refreshIntervalMs: 120000 });
      await vi.advanceTimersByTimeAsync(60000);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60000);
      expect(global.fetch).toHaveBeenCalledTimes(3);

      refresher.updateConfig({ refreshIntervalMs: 120000 });
      await vi.advanceTimersByTimeAsync(120000);
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('filters out inactive markets', async () => {
      const market = createGammaMarket({ active: false });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out closed markets', async () => {
      const market = createGammaMarket({ closed: true });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets not accepting orders', async () => {
      const market = createGammaMarket({ condition_id: 'market-other', accepting_orders: false });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets when accepting orders flag is missing', async () => {
      const market = createGammaMarket({
        accepting_orders: undefined,
        acceptingOrders: undefined
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets without order book enabled', async () => {
      const market = createGammaMarket({ enable_order_book: false });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets when order book flag is missing', async () => {
      const market = createGammaMarket({
        enable_order_book: undefined,
        enableOrderBook: undefined
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets when enableOrderBook is false', async () => {
      const market = createGammaMarket({
        enable_order_book: undefined,
        enableOrderBook: false
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('filters out low volume markets', async () => {
      const market = createGammaMarket({ volume24hr: 1000 });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets when volume is non-numeric', async () => {
      const market = createGammaMarket({ volume24hr: {} as unknown as number });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets when volume string is invalid', async () => {
      const market = createGammaMarket({
        volume24hr: undefined,
        volume24hrClob: undefined,
        volumeNum: undefined,
        volume: 'not-a-number'
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('accepts camelCase fields and JSON clobTokenIds', async () => {
      const market = createGammaMarket({
        condition_id: undefined,
        conditionId: 'market-camel',
        accepting_orders: undefined,
        acceptingOrders: true,
        enable_order_book: undefined,
        enableOrderBook: true,
        clobTokenIds: JSON.stringify(['yes-camel', 'no-camel']),
        volume24hr: undefined,
        volumeNum: undefined,
        volume: '75000'
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
      expect(refresher.getPairs()[0]).toEqual({
        marketId: 'market-camel',
        yesTokenId: 'yes-camel',
        noTokenId: 'no-camel'
      });
    });

    it('filters out markets with wide spread', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockResolvedValue(createValidBook(0.40, 0.50));
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets without asks', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockResolvedValue({
        bids: [{ price: '0.48', size: '100' }],
        asks: [],
        tick_size: '0.01',
        min_order_size: '5'
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('filters out markets without tick_size', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockResolvedValue({
        bids: [{ price: '0.48', size: '100' }],
        asks: [{ price: '0.50', size: '100' }],
        min_order_size: '5'
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects markets with invalid tokens array', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [{ token_id: 'only-one' }]
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects markets with missing token_id', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [
          { token_id: 'token-1', outcome: 'Yes' },
          { outcome: 'No' }
        ]
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('accepts tokenId fields in tokens array', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [
          { tokenId: 'token-yes', outcome: 'Yes' },
          { tokenId: 'token-no', outcome: 'No' }
        ]
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
    });

    it('accepts volume24hrClob fallback', async () => {
      const market = createGammaMarket({
        volume24hr: undefined,
        volume24hrClob: 90000
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
    });

    it('accepts tokens array when outcomes are reversed', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [
          { token_id: 'token-no', outcome: 'No' },
          { token_id: 'token-yes', outcome: 'Yes' }
        ]
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
      expect(refresher.getPairs()[0]).toEqual({
        marketId: 'market-123',
        yesTokenId: 'token-yes',
        noTokenId: 'token-no'
      });
    });

    it('sorts tokens when outcomes are unknown', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [
          { token_id: 'token-b', outcome: 'Maybe' },
          { token_id: 'token-a', outcome: 'Unknown' }
        ]
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
      expect(refresher.getPairs()[0]).toEqual({
        marketId: 'market-123',
        yesTokenId: 'token-a',
        noTokenId: 'token-b'
      });
    });

    it('sorts tokens when outcomes are missing', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [{ token_id: 'token-b' }, { token_id: 'token-a' }]
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue(createValidBook());

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
      expect(refresher.getPairs()[0]).toEqual({
        marketId: 'market-123',
        yesTokenId: 'token-a',
        noTokenId: 'token-b'
      });
    });

    it('reuses existing pairs without re-fetching books', async () => {
      const existingPair: MarketPair = {
        marketId: 'market-123',
        yesTokenId: 'existing-yes',
        noTokenId: 'existing-no'
      };
      refresher.seed([existingPair]);
      
      const market = createGammaMarket({ condition_id: 'market-123' });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      await refresher.refresh();
      
      expect(mockClob.getOrderBook).not.toHaveBeenCalled();
      
      const pairs = refresher.getPairs();
      expect(pairs[0]).toEqual(existingPair);
    });

    it('keeps previous pairs when refresh returns empty', async () => {
      const existingPair: MarketPair = {
        marketId: 'market-123',
        yesTokenId: 'existing-yes',
        noTokenId: 'existing-no'
      };
      refresher.seed([existingPair]);

      const market = createGammaMarket({ condition_id: 'market-other', accepting_orders: false });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(1);
      expect(refresher.getPairs()).toEqual([existingPair]);
      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          data: expect.objectContaining({
            message: 'market_catalog_refresh_empty'
          })
        })
      );
    });

    it('backs off and logs once on repeated empty refreshes', async () => {
      const existingPair: MarketPair = {
        marketId: 'market-123',
        yesTokenId: 'existing-yes',
        noTokenId: 'existing-no'
      };
      refresher.seed([existingPair]);

      const market = createGammaMarket({ condition_id: 'market-other', accepting_orders: false });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const first = await refresher.refresh();

      expect(first.totalPairs).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30000);

      const second = await refresher.refresh();

      expect(second.totalPairs).toBe(1);
      expect(second.pagesScanned).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const recordMock = mockMetrics.record as unknown as ReturnType<typeof vi.fn>;
      const emptyLogs = recordMock.mock.calls.filter(
        ([entry]) => entry?.data?.message === 'market_catalog_refresh_empty'
      );
      expect(emptyLogs).toHaveLength(1);
    });

    it('records metrics on success', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([])
      });
      
      await refresher.refresh();
      
      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          data: expect.objectContaining({
            message: 'market_catalog_refreshed'
          })
        })
      );
    });

    it('handles API errors gracefully', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      });
      
      const errorHandler = vi.fn();
      refresher.on('error', errorHandler);
      
      const result = await refresher.refresh();
      
      expect(errorHandler).toHaveBeenCalled();
      expect(result.totalPairs).toBe(0);
      expect(result.pagesScanned).toBe(0);
    });

    it('records metrics on error', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));
      
      refresher.on('error', () => {});
      
      await refresher.refresh();
      
      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          data: expect.objectContaining({
            message: 'market_catalog_refresh_failed',
            error: 'Network error'
          })
        })
      );
    });

    it('handles non-Error exceptions', async () => {
      fetchMock.mockRejectedValue('string error');
      
      refresher.on('error', () => {});
      
      await refresher.refresh();
      
      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          data: expect.objectContaining({
            error: 'string error'
          })
        })
      );
    });

    it('handles CLOB book fetch errors', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockRejectedValue(new Error('CLOB error'));
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('accepts spread when no bids exist', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockResolvedValue({
        bids: [],
        asks: [{ price: '0.50', size: '100' }],
        tick_size: '0.01',
        min_order_size: '5'
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(1);
    });

    it('handles non-finite prices in spread check', async () => {
      const market = createGammaMarket();
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      mockClob.getOrderBook.mockResolvedValue({
        bids: [{ price: 'invalid', size: '100' }],
        asks: [{ price: '0.50', size: '100' }],
        tick_size: '0.01',
        min_order_size: '5'
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(1);
    });

    it('filters out markets missing min order size', async () => {
      const market = createGammaMarket();

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      mockClob.getOrderBook.mockResolvedValue({
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        tick_size: '0.01'
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('treats missing asks as acceptable spread', () => {
      const { hasAcceptableSpread } = refresher as unknown as {
        hasAcceptableSpread: (book: {
          bids?: Array<{ price: string | number }>;
          asks?: Array<{ price: string | number }>;
        }) => boolean;
      };

      expect(
        hasAcceptableSpread({
          bids: [{ price: '0.50' }],
          asks: []
        })
      ).toBe(true);
    });

    it('handles empty response', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({})
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market without condition_id', async () => {
      const market = createGammaMarket({ condition_id: '' });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market with only one token in tokens array', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [{ token_id: 'only-one', outcome: 'Yes' }]
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market when tokens array has empty token_id', async () => {
      const market = createGammaMarket({
        clobTokenIds: undefined,
        tokens: [
          { token_id: '', outcome: 'Yes' },
          { token_id: 'valid-token', outcome: 'No' }
        ]
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market when clobTokenIds has only one token', async () => {
      const market = createGammaMarket({
        clobTokenIds: ['only-one-token']
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market when clobTokenIds JSON string is invalid', async () => {
      const market = createGammaMarket({
        clobTokenIds: 'not-json',
        tokens: undefined
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });

    it('rejects market when clobTokenIds has empty token', async () => {
      const market = createGammaMarket({
        clobTokenIds: ['valid-token', '']
      });
      
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });
      
      const result = await refresher.refresh();
      
      expect(result.totalPairs).toBe(0);
    });

    it('rejects market when clobTokenIds contains non-strings', async () => {
      const market = createGammaMarket({
        clobTokenIds: ['valid-token', 123 as unknown as string],
        tokens: undefined
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([market])
      });

      const result = await refresher.refresh();

      expect(result.totalPairs).toBe(0);
    });
  });
});
