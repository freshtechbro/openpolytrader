import type { Env } from './env.js';

export type VenueId = 'polymarket' | 'kalshi';

export interface VenueFeatureFlags {
  phase2CrossVenue: boolean;
}

export function venueFlags(env: Env): VenueFeatureFlags {
  return {
    phase2CrossVenue: env.PHASE2_CROSS_VENUE_ENABLED
  };
}
