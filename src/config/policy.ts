export interface TradePolicy {
  edgeRequired: number;
  maxEdge: number;
  depthHeadroomFraction: number;
  maxSpread: number;
  orderbookFreshnessMs: number;
  topOfBookStabilityMs: number;
  maxOpenInventorySeconds: number;
  rejectDelayed: boolean;
  strategyMode: 'near_zero_risk' | 'standard';
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
}


export const DEFAULT_TRADE_POLICY: TradePolicy = {
  edgeRequired: 0.03,
  maxEdge: 0.05,
  depthHeadroomFraction: 0.25,
  maxSpread: 0.05,
  orderbookFreshnessMs: 500,
  topOfBookStabilityMs: 250,
  maxOpenInventorySeconds: 2,
  rejectDelayed: true,
  strategyMode: 'near_zero_risk',
  requireFreshBook: true,
  maxBookStalenessMs: 500,
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
  fallbackMinOrderSize: 0.001
};

export function isNearZeroRiskMode(policy: TradePolicy): boolean {
  return policy.strategyMode === 'near_zero_risk';
}
