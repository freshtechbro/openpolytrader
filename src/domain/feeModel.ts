import type { VenueId } from '../config/venues.js';

export interface FeeModelConfig {
  takerFeeBps: Record<VenueId, number>;
}

export class FeeModel {
  constructor(private config: FeeModelConfig) {}

  takerFeeFraction(venue: VenueId): number {
    const bps = this.config.takerFeeBps[venue] ?? 0;
    return bps / 10_000;
  }

  netEdge(venue: VenueId, grossEdge: number): number {
    const fee = this.takerFeeFraction(venue);
    return grossEdge - fee * 2;
  }
}
