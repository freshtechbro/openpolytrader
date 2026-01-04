export interface MarketPair {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  category?: string;
}

export function marketKey(pair: MarketPair): string {
  return pair.marketId;
}
