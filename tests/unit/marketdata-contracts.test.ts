import { describe, expect, it, vi } from 'vitest';

import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

function createMarketDataBook(tokenId: string, lastUpdateMs: number): OrderBookState {
  return {
    tokenId,
    bids: [{ price: 0.48, size: 100 }],
    asks: [{ price: 0.49, size: 100 }],
    tickSize: 0.01,
    minOrderSize: 1,
    lastUpdateMs,
    stableSinceMs: lastUpdateMs,
    bestBid: { price: 0.48, size: 100 },
    bestAsk: { price: 0.49, size: 100 }
  };
}

describe('MarketDataAgent contracts', () => {
  it('rejects start when realtime connect fails', async () => {
    const metrics = new MetricsStore(100);
    const realtime = {
      connect: vi.fn().mockRejectedValue(new Error('ws offline')),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;
    const clob = {
      getOrderBook: vi.fn()
    } as unknown as PolymarketClob;

    const agent = new MarketDataAgent(
      {
        tokenIds: ['yes-1'],
        policy: DEFAULT_TRADE_POLICY,
        metrics
      },
      clob,
      realtime
    );

    await expect(agent.start()).rejects.toThrow('ws offline');
    expect(realtime.subscribeMarkets).not.toHaveBeenCalled();
    expect(metrics.recent('error', 1)[0]?.data).toMatchObject({
      message: 'realtime_connect_failed',
      detail: 'ws offline'
    });
  });

  it('counts stale refresh failures separately from successful refreshes', async () => {
    const metrics = new MetricsStore(100);
    const now = Date.now();
    const staleAt = now - 60_000;
    const realtime = {
      connect: vi.fn(),
      on: vi.fn(),
      subscribeMarkets: vi.fn(),
      unsubscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;
    const clob = {
      getOrderBook: vi.fn(async (tokenId: string) => {
        if (tokenId === 'fail-token') {
          throw new Error('snapshot failed');
        }
        return createMarketDataBook(tokenId, now);
      })
    } as unknown as PolymarketClob;

    const agent = new MarketDataAgent(
      {
        tokenIds: [],
        policy: DEFAULT_TRADE_POLICY,
        metrics
      },
      clob,
      realtime
    );
    const internals = agent as unknown as { orderbooks: Map<string, OrderBookState> };
    internals.orderbooks.set('ok-token', createMarketDataBook('ok-token', staleAt));
    internals.orderbooks.set('fail-token', createMarketDataBook('fail-token', staleAt));

    const result = await agent.refreshStaleBooks(1_000);

    expect(result.refreshed).toEqual(['ok-token']);
    expect(result.failed).toEqual(['fail-token']);
    expect(metrics.recent('error', 1)[0]?.data).toMatchObject({
      message: 'snapshot_refresh_failed',
      tokenId: 'fail-token',
      detail: 'snapshot failed'
    });
    expect(metrics.recent('info', 1)[0]?.data).toMatchObject({
      message: 'stale_books_refreshed',
      refreshed: 1,
      failed: 1,
      maxStalenessMs: 1_000
    });
  });
});
