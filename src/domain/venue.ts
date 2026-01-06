export interface VenueOpenOrder {
  orderId: string;
  marketId?: string;
  tokenId?: string;
  side?: string;
  price?: number;
  size?: number;
  status?: string;
  raw?: unknown;
}

export interface VenuePosition {
  tokenId: string;
  marketId?: string;
  size: number;
  avgPrice?: number;
  currentPrice?: number;
  raw?: unknown;
}

