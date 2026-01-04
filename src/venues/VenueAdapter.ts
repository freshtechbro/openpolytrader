import type { EventEmitter } from 'node:events';

import type { OrderBookResponse } from '../services/PolymarketClob.js';

export type VenueSide = 'BUY' | 'SELL';

export interface VenueOrderPlacement {
  tokenId: string;
  side: VenueSide;
  size: number;
  price: number;
  orderType: 'FOK' | 'FAK' | 'GTC' | 'GTD';
  clientOrderId?: string;
}

export interface VenueAdapter {
  readonly venue: string;

  connectMarketData(): Promise<void>;
  subscribeMarkets(tokenIds: string[]): void;
  marketDataEmitter(): EventEmitter;

  getOrderBook(tokenId: string): Promise<OrderBookResponse>;
  placeOrder(order: VenueOrderPlacement): Promise<unknown>;
}
