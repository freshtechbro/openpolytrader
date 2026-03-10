import { describe, expect, it, vi } from 'vitest';

import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import type { RawOrderBookSnapshot } from '../../src/domain/orderbook.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';

function seedBook(
  agent: MarketDataAgent,
  tokenId: string,
  snapshot: RawOrderBookSnapshot,
  receivedAtMs = 1
): void {
  (agent as unknown as {
    updateBook: (
      tokenId: string,
      raw: RawOrderBookSnapshot,
      receivedAtMs: number,
      options?: { force?: boolean }
    ) => void;
  }).updateBook(tokenId, snapshot, receivedAtMs, { force: true });
}

describe('MarketDataAgent price_change handling', () => {
  it('applies price_changes updates for multiple assets', () => {
    const clob = { getOrderBook: vi.fn() } as unknown as PolymarketClob;
    const realtime = {} as unknown as PolymarketRealtime;

    const agent = new MarketDataAgent(
      { tokenIds: [], policy: DEFAULT_TRADE_POLICY, messageBus: createMessageBus() },
      clob,
      realtime
    );

    seedBook(agent, 'token-1', {
      bids: [{ price: '0.4', size: '5' }],
      asks: [{ price: '0.6', size: '5' }],
      tick_size: '0.01',
      min_order_size: '0.001',
      timestamp: '1'
    });
    seedBook(agent, 'token-2', {
      bids: [{ price: '0.3', size: '7' }],
      asks: [{ price: '0.7', size: '7' }],
      tick_size: '0.01',
      min_order_size: '0.001',
      timestamp: '1'
    });

    (agent as unknown as { handleEvent: (payload: Record<string, unknown>) => void }).handleEvent({
      event_type: 'price_change',
      price_changes: [
        {
          asset_id: 'token-1',
          side: 'BUY',
          price: '0.41',
          size: '7',
          best_bid: '0.41',
          best_ask: '0.6',
          timestamp: '2'
        },
        {
          asset_id: 'token-2',
          side: 'SELL',
          price: '0.72',
          size: '4',
          best_bid: '0.3',
          best_ask: '0.7',
          timestamp: '2'
        }
      ]
    });

    const book1 = agent.getOrderBook('token-1');
    const book2 = agent.getOrderBook('token-2');

    expect(book1?.bestBid?.price).toBeCloseTo(0.41);
    expect(book1?.bestAsk?.price).toBeCloseTo(0.6);
    expect(book2?.bestBid?.price).toBeCloseTo(0.3);
    expect(book2?.bestAsk?.price).toBeCloseTo(0.7);
    expect(book2?.asks.some((level) => level.price === 0.72)).toBe(true);
  });

  it('triggers snapshot resync on best bid/ask mismatch', async () => {
    const snapshot: RawOrderBookSnapshot = {
      bids: [{ price: '0.4', size: '5' }],
      asks: [{ price: '0.6', size: '5' }],
      tick_size: '0.01',
      min_order_size: '0.001',
      timestamp: '1'
    };

    const clob = {
      getOrderBook: vi.fn(async () => snapshot)
    } as unknown as PolymarketClob;
    const realtime = {} as unknown as PolymarketRealtime;

    const agent = new MarketDataAgent(
      { tokenIds: [], policy: DEFAULT_TRADE_POLICY, messageBus: createMessageBus() },
      clob,
      realtime
    );
    (agent as unknown as { snapshotResyncCooldownMs: number }).snapshotResyncCooldownMs = 0;

    seedBook(agent, 'token-1', snapshot);

    (agent as unknown as { handleEvent: (payload: Record<string, unknown>) => void }).handleEvent({
      event_type: 'price_change',
      price_changes: [
        {
          asset_id: 'token-1',
          side: 'BUY',
          price: '0.4',
          size: '5',
          best_bid: '0.2',
          best_ask: '0.6',
          timestamp: '2'
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clob.getOrderBook).toHaveBeenCalledWith('token-1');
  });

  it('updates tick size from tick_size_change payloads', () => {
    const clob = { getOrderBook: vi.fn() } as unknown as PolymarketClob;
    const realtime = {} as unknown as PolymarketRealtime;

    const agent = new MarketDataAgent(
      { tokenIds: [], policy: DEFAULT_TRADE_POLICY, messageBus: createMessageBus() },
      clob,
      realtime
    );

    seedBook(agent, 'token-1', {
      bids: [{ price: '0.4', size: '5' }],
      asks: [{ price: '0.6', size: '5' }],
      tick_size: '0.01',
      min_order_size: '0.001',
      timestamp: '1'
    });

    (agent as unknown as { handleEvent: (payload: Record<string, unknown>) => void }).handleEvent({
      event_type: 'tick_size_change',
      asset_id: 'token-1',
      new_tick_size: '0.02',
      timestamp: '2'
    });

    const book = agent.getOrderBook('token-1');
    expect(book?.tickSize).toBeCloseTo(0.02);
  });
});
