export interface PortfolioSnapshot {
  totalCapital: number;
  availableCapital: number;
  dailyPnL: number;
  marketExposure: Record<string, number>;
}

export interface Position {
  tokenId: string;
  size: number;
  averagePrice: number;
  side: 'BUY' | 'SELL';
}
