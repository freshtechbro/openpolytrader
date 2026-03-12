import { afterEach, describe, expect, it, vi } from 'vitest';

const { FakeRealtime, getOrderBook, connect, subscribeMarkets, close, clobConstructorSpy } = vi.hoisted(() => {
  class FakeRealtime {
    private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

    connect = connect;
    subscribeMarkets = subscribeMarkets.mockImplementation((tokenIds: string[]) => {
      this.emit('message', { type: 'book', tokenIds });
    });
    close = close;

    on(event: string, listener: (payload: unknown) => void) {
      const next = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
      next.add(listener);
      this.listeners.set(event, next);
      return this;
    }

    off(event: string, listener: (payload: unknown) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, payload: unknown) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(payload);
      }
      return true;
    }
  }

  return {
    FakeRealtime,
    clobConstructorSpy: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => undefined),
      getOrderBook: vi.fn(async () => ({
      bids: [{ price: '0.45', size: '10' }],
      asks: [{ price: '0.46', size: '9' }],
      tick_size: '0.01',
      min_order_size: '1',
      timestamp: '1700000000'
    })),
    subscribeMarkets: vi.fn()
  };
});

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({
    MARKET_CATALOG_PATH: 'data/catalog.json',
    POLYMARKET_WS_URL: 'wss://market.example.com',
    POLYMARKET_WS_HEARTBEAT_MS: 1000,
    POLYMARKET_WS_RECONNECT_BASE_MS: 100,
    POLYMARKET_WS_RECONNECT_MAX_MS: 1000,
    POLYMARKET_WS_RECONNECT_JITTER_PCT: 0.2
  })
}));
vi.mock('../../src/services/MarketCatalog.js', () => ({
  MarketCatalog: class {
    constructor(_options: unknown) {}
    loadPairs() {
      return [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }];
    }
  }
}));
vi.mock('../../src/services/PolymarketRealtime.js', () => ({
  PolymarketRealtime: FakeRealtime
}));
vi.mock('../../src/services/PolymarketClob.js', () => ({
  PolymarketClob: class {
    constructor(options: unknown) {
      clobConstructorSpy(options);
    }

    getOrderBook = getOrderBook;
  }
}));

import { main } from '../../scripts/polymarketLiveCheck.ts';

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('polymarketLiveCheck script', () => {
  it('runs the catalog, CLOB, and websocket checks', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(getOrderBook).toHaveBeenCalledWith('yes-1');
    expect(clobConstructorSpy).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(subscribeMarkets).toHaveBeenCalledWith(['yes-1']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('Polymarket catalog ok', {
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1'
    });
    expect(consoleLog).toHaveBeenCalledWith(
      'Polymarket websocket ok',
      expect.objectContaining({ kind: 'object', type: 'book' })
    );
  });
});
