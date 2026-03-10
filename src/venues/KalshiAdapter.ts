import { EventEmitter } from 'node:events';

import type { VenueAdapter, VenueOrderPlacement } from './VenueAdapter.js';

import type { RawOrderBookSnapshot } from '../domain/orderbook.js';

export class KalshiAdapter implements VenueAdapter {
  readonly venue = 'kalshi';
  private emitter = new EventEmitter();

  constructor(private enabled: boolean) {}

  async connectMarketData(): Promise<void> {
    if (!this.enabled) return;
    throw new Error('KalshiAdapter not implemented');
  }

  subscribeMarkets(_tokenIds: string[]): void {
  }

  marketDataEmitter(): EventEmitter {
    return this.emitter;
  }

  async getOrderBook(_tokenId: string): Promise<RawOrderBookSnapshot> {
    throw new Error('KalshiAdapter not implemented');
  }

  async placeOrder(_order: VenueOrderPlacement): Promise<unknown> {
    throw new Error('KalshiAdapter not implemented');
  }
}
