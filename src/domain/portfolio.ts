export interface PortfolioSnapshot {
  totalCapital: number;
  availableCapital: number;
  dailyPnL: number;
  marketExposure: Record<string, number>;
  openInventoryAgeMs?: number;
}

export interface FillUpdate {
  tokenId: string;
  marketId?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

export interface Position {
  tokenId: string;
  marketId?: string;
  size: number;
  averagePrice: number;
  side: 'BUY' | 'SELL';
}

export interface ExpectedFill {
  opportunityId: string;
  tokenId: string;
  expectedSize: number;
  expectedPrice: number;
  timestamp: number;
}

export interface ObservedFill extends FillUpdate {
  opportunityId?: string;
  timestamp?: number;
}

export interface FillReconciliationOptions {
  sizeTolerance: number;
  priceTolerance: number;
}

export type ReconciliationIssueType =
  | 'size_mismatch'
  | 'price_mismatch'
  | 'unexpected_fill'
  | 'ambiguous_expected_fill';

export interface ReconciliationIssue {
  type: ReconciliationIssueType;
  tokenId: string;
  opportunityId?: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
}

export interface ReconciliationResult {
  ok: boolean;
  expected?: ExpectedFill;
  issues: ReconciliationIssue[];
}

export type VenueReconciliationIssueType =
  | 'missing_open_order'
  | 'extra_open_order'
  | 'missing_position'
  | 'extra_position'
  | 'position_size_mismatch';

export interface VenueReconciliationIssue {
  type: VenueReconciliationIssueType;
  marketId?: string;
  tokenId?: string;
  orderId?: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
}

export interface VenueReconciliationResult {
  ok: boolean;
  checkedAtMs: number;
  issues: VenueReconciliationIssue[];
}
