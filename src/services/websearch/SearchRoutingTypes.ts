import type { MarketInfo } from '../PolymarketClob.js';

export type SearchRoute = 'skip' | 'serper' | 'exa' | 'serper_then_exa';
export type SearchQueryMode = 'base_only' | 'base_plus_one' | 'base_plus_two';
export type SearchRouteReason =
  | 'cached'
  | 'low_priority'
  | 'no_trigger'
  | 'gdelt_spike'
  | 'official_confirmation_missing'
  | 'near_resolution'
  | 'price_move_unexplained'
  | 'serper_ambiguous'
  | 'serper_low_authority';
export type MarketClass =
  | 'official_release'
  | 'event_narrative'
  | 'diffuse_sentiment'
  | 'fast_resolution';

export interface HeartbeatState {
  triggerScore: number;
  reasons: SearchRouteReason[];
  articleCount: number;
  articleDelta: number;
  uniqueSourceCount: number;
  uniqueSourceDelta: number;
  noveltyScore: number;
  contradictionScore: number;
  officialDomainPresent: boolean;
  updatedAtMs: number;
}

export interface SearchRouteDecision {
  route: SearchRoute;
  reason: SearchRouteReason;
  triggerScore: number;
  queryMode: SearchQueryMode;
  contentBudget: number;
  marketClass: MarketClass;
}

export interface SearchRouteContext {
  marketId: string;
  question: string;
  outcomes: string[];
  info?: MarketInfo | null;
  nowMs: number;
  priceMoveBps?: number;
}
