export interface TradePolicy {
  edgeRequired: number;
  maxEdge: number;
  depthHeadroomFraction: number;
  maxSpread: number;
  orderbookFreshnessMs: number;
  topOfBookStabilityMs: number;
  maxOpenInventorySeconds: number;
  rejectDelayed: boolean;
}

export const DEFAULT_TRADE_POLICY: TradePolicy = {
  edgeRequired: 0.03,
  maxEdge: 0.05,
  depthHeadroomFraction: 0.25,
  maxSpread: 0.05,
  orderbookFreshnessMs: 500,
  topOfBookStabilityMs: 250,
  maxOpenInventorySeconds: 2,
  rejectDelayed: true
};
