import type { EventEmitter } from 'node:events';

import { PolymarketClob } from '../services/PolymarketClob.js';
import { PolymarketRealtime } from '../services/PolymarketRealtime.js';
import type { RawOrderBookSnapshot } from '../domain/orderbook.js';
import type { VenueAdapter, VenueOrderPlacement } from './VenueAdapter.js';

export class PolymarketAdapter implements VenueAdapter {
  readonly venue = 'polymarket';

  constructor(
    private clob: PolymarketClob,
    private realtime: PolymarketRealtime
  ) {}

  async connectMarketData(): Promise<void> {
    await this.realtime.connect();
  }

  subscribeMarkets(tokenIds: string[]): void {
    this.realtime.subscribeMarkets(tokenIds);
  }

  marketDataEmitter(): EventEmitter {
    return this.realtime;
  }

  async getOrderBook(tokenId: string): Promise<RawOrderBookSnapshot> {
    return this.clob.getOrderBook(tokenId);
  }

  async placeOrder(order: VenueOrderPlacement): Promise<unknown> {
    return this.clob.createOrder({
      token_id: order.tokenId,
      side: order.side,
      size: order.size,
      price: order.price,
      order_type: order.orderType,
      client_order_id: order.clientOrderId
    });
  }
}
