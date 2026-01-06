import type { MarketPair } from './market.js';

export interface ArbitrageOpportunity {
  id: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  costPerSet: number;
  edge: number;
  tickSize: number;
  maxSizeByDepth: number;
  minOrderSize: number;
  detectedAt: number;
  gateReasons: string[];
  pair: MarketPair;
}

export function opportunityId(marketId: string, yesPrice: number, noPrice: number, timestamp: number): string {
  return `${marketId}:${yesPrice.toFixed(4)}:${noPrice.toFixed(4)}:${timestamp}`;
}
