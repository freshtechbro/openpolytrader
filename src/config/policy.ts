export interface TradePolicy {
  edgeRequired: number;
  maxEdge: number;
  evMaxEdge: number;
  depthHeadroomFraction: number;
  maxSpread: number;
  orderbookFreshnessMs: number;
  topOfBookStabilityMs: number;
  maxOpenInventorySeconds: number;
  rejectDelayed: boolean;
  strategyMode: 'near_zero_risk' | 'standard';
  signalMode: 'near_zero' | 'ev' | 'both';
  requireFreshBook: boolean;
  maxBookStalenessMs: number;
  maxDecisionLatencyMs: number;
  maxDelayedAckRate: number;
  minPairedFillRate: number;
  minEdgeTicks: number;
  depthBufferMultiplier: number;
  entrySlippageToleranceBps: number;
  minDepthLevels: number;
  maxOrdersPerMinute: number;
  maxOrderToTradeRatio: number;
  orderVelocityWindowMs: number;
  orderToTradeWindowMs: number;
  priceBandBps: number;
  maxLegSkewMs: number;
  submitTimeoutMs: number;
  ackTimeoutMs: number;
  fillTimeoutMs: number;
  cancelTimeoutMs: number;
  fallbackTickSize: number;
  fallbackMinOrderSize: number;
  nearZeroFeeBps: number;
  evEdgeRequired: number;
  evFeeBps: number;
  evConfidenceMin: number;
  evConfidenceMinFloor: number;
  evMaxPerMarketNotional: number;
  evMaxPortfolioNotional: number;
  evCooldownSeconds: number;
  evModelMode: 'baseline' | 'hybrid' | 'llm_only';
  evModelRefreshMinutes: number;
  evCalibrationMethod: 'sigmoid' | 'isotonic' | 'temperature';
  evModelConfidenceFloor: number;
  evWebSearchExaEnabled: boolean;
  evWebSearchFirecrawlEnabled: boolean;
  evWebSearchPrimary: 'exa' | 'firecrawl';
  evWebSearchLookbackDays: number;
  evWebSearchMaxResults: number;
  evWebSearchCacheTtlSeconds: number;
  evWebSearchMaxConcurrency: number;
  evWebSearchFirecrawlMaxDepth: number;
  evWebSearchFirecrawlMaxPages: number;
}


export const DEFAULT_TRADE_POLICY: TradePolicy = {
  edgeRequired: 0.03,
  maxEdge: 0.05,
  evMaxEdge: 0.05,
  depthHeadroomFraction: 0.25,
  maxSpread: 0.05,
  orderbookFreshnessMs: 15000,
  topOfBookStabilityMs: 250,
  maxOpenInventorySeconds: 2,
  rejectDelayed: true,
  strategyMode: 'near_zero_risk',
  signalMode: 'both',
  requireFreshBook: true,
  maxBookStalenessMs: 15000,
  maxDecisionLatencyMs: 250,
  maxDelayedAckRate: 0.001,
  minPairedFillRate: 0.999,
  minEdgeTicks: 3,
  depthBufferMultiplier: 1.5,
  entrySlippageToleranceBps: 50,
  minDepthLevels: 3,
  maxOrdersPerMinute: 60,
  maxOrderToTradeRatio: 10,
  orderVelocityWindowMs: 60000,
  orderToTradeWindowMs: 600000,
  priceBandBps: 500,
  maxLegSkewMs: 100,
  submitTimeoutMs: 2000,
  ackTimeoutMs: 2500,
  fillTimeoutMs: 5000,
  cancelTimeoutMs: 2000,
  fallbackTickSize: 0.01,
  fallbackMinOrderSize: 0.001,
  nearZeroFeeBps: 0,
  evEdgeRequired: 0.01,
  evFeeBps: 0,
  evConfidenceMin: 0.6,
  evConfidenceMinFloor: 0.4,
  evMaxPerMarketNotional: 100,
  evMaxPortfolioNotional: 300,
  evCooldownSeconds: 120,
  evModelMode: 'hybrid',
  evModelRefreshMinutes: 60,
  evCalibrationMethod: 'sigmoid',
  evModelConfidenceFloor: 0.55,
  evWebSearchExaEnabled: true,
  evWebSearchFirecrawlEnabled: false,
  evWebSearchPrimary: 'exa',
  evWebSearchLookbackDays: 7,
  evWebSearchMaxResults: 10,
  evWebSearchCacheTtlSeconds: 7200,
  evWebSearchMaxConcurrency: 3,
  evWebSearchFirecrawlMaxDepth: 2,
  evWebSearchFirecrawlMaxPages: 10
};

export function isNearZeroRiskMode(policy: TradePolicy): boolean {
  return policy.strategyMode === 'near_zero_risk';
}
