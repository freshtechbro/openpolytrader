import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { KalshiAdapter } from '../../src/venues/KalshiAdapter.js';
import { PolymarketAdapter } from '../../src/venues/PolymarketAdapter.js';

describe('KalshiAdapter', () => {
  it('is inert when market data is disabled and exposes its emitter', async () => {
    const adapter = new KalshiAdapter(false);

    await expect(adapter.connectMarketData()).resolves.toBeUndefined();
    expect(adapter.venue).toBe('kalshi');
    expect(adapter.marketDataEmitter()).toBeInstanceOf(EventEmitter);
    expect(() => adapter.subscribeMarkets(['token-1'])).not.toThrow();
  });

  it('surfaces its unimplemented methods when enabled', async () => {
    const adapter = new KalshiAdapter(true);

    await expect(adapter.connectMarketData()).rejects.toThrow('KalshiAdapter not implemented');
    await expect(adapter.getOrderBook('token-1')).rejects.toThrow('KalshiAdapter not implemented');
    await expect(
      adapter.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 2,
        price: 0.45,
        orderType: 'gtc'
      })
    ).rejects.toThrow('KalshiAdapter not implemented');
  });
});

describe('PolymarketAdapter', () => {
  it('delegates market data and order operations to its service dependencies', async () => {
    const realtime = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => undefined),
      subscribeMarkets: vi.fn()
    });
    const clob = {
      getOrderBook: vi.fn(async () => ({ bids: [], asks: [] })),
      createOrder: vi.fn(async () => ({ ok: true }))
    };

    const adapter = new PolymarketAdapter(clob as never, realtime as never);

    await expect(adapter.connectMarketData()).resolves.toBeUndefined();
    adapter.subscribeMarkets(['token-a', 'token-b']);
    expect(adapter.marketDataEmitter()).toBe(realtime);
    await expect(adapter.getOrderBook('token-a')).resolves.toEqual({ bids: [], asks: [] });
    await expect(
      adapter.placeOrder({
        tokenId: 'token-a',
        side: 'buy',
        size: 3,
        price: 0.61,
        orderType: 'gtc',
        clientOrderId: 'client-1'
      })
    ).resolves.toEqual({ ok: true });

    expect(realtime.connect).toHaveBeenCalledTimes(1);
    expect(realtime.subscribeMarkets).toHaveBeenCalledWith(['token-a', 'token-b']);
    expect(clob.getOrderBook).toHaveBeenCalledWith('token-a');
    expect(clob.createOrder).toHaveBeenCalledWith({
      token_id: 'token-a',
      side: 'buy',
      size: 3,
      price: 0.61,
      order_type: 'gtc',
      client_order_id: 'client-1'
    });
  });
});
