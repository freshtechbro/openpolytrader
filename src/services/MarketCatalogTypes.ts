export type MarketCatalogOrder = 'volume24hr' | 'newest';

export interface GammaMarket {
  condition_id?: string;
  conditionId?: string;
  question?: string;
  category?: string;
  tags?: unknown;
  volume24hr?: number;
  volume24hrClob?: number;
  volumeNum?: number;
  volume?: number | string;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  accepting_orders?: boolean;
  acceptingOrders?: boolean;
  enable_order_book?: boolean;
  enableOrderBook?: boolean;
  endDate?: string | number | null;
  endDateIso?: string | null;
  end_date?: string | number | null;
  end_date_iso?: string | null;
  clobTokenIds?: string[] | string;
  tokens?: Array<{ token_id?: string; tokenId?: string; outcome?: string }>;
}
