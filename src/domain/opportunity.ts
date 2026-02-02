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
  type?: 'near_zero' | 'ev';
  side?: 'yes' | 'no';
  pFinal?: number;
  evRaw?: number;
  evNet?: number;
  modelConfidence?: number;
}

export function opportunityId(marketId: string, yesPrice: number, noPrice: number, timestamp: number): string {
  return `${marketId}:${yesPrice.toFixed(4)}:${noPrice.toFixed(4)}:${timestamp}`;
}

export function evOpportunityId(
  marketId: string,
  side: 'yes' | 'no',
  price: number,
  pFinal: number,
  timestamp: number
): string {
  return `${marketId}:${side}:${price.toFixed(4)}:${pFinal.toFixed(4)}:${timestamp}`;
}
