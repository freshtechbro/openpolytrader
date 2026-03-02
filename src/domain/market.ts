export interface MarketPair {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  question?: string;
  category?: string;
  tags?: string[];
}

export function marketKey(pair: MarketPair): string {
  return pair.marketId;
}
