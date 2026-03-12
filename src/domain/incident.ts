/**
 * Incident reasons for near-zero-risk execution.
 * - order_*: venue order lifecycle failures
 * - ws/rpc/api/auth: infrastructure or auth health
 * - book/latency/slippage/depth/price: market data or execution quality gates
 * - velocity/otr: pre-trade throttles
 * - unwind/recon/fill: post-trade recovery or reconciliation failures
 */
export type IncidentReason =
  | 'order_delayed'
  | 'order_rejected'
  | 'order_failed'
  | 'order_timeout'
  | 'order_cancel_failed'
  | 'ws_disconnected'
  | 'rpc_degraded'
  | 'api_429'
  | 'api_5xx'
  | 'auth_failure'
  | 'partial_fill'
  | 'unwind_triggered'
  | 'unwind_failed'
  | 'book_stale'
  | 'book_inconsistent'
  | 'latency_exceeded'
  | 'slippage_exceeded'
  | 'depth_insufficient'
  | 'price_moved'
  | 'velocity_throttle'
  | 'otr_exceeded'
  | 'circuit_breaker'
  | 'recon_drift'
  | 'fill_mismatch'
  | 'unknown';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface IncidentRecord {
  marketId: string;
  reason: IncidentReason;
  severity?: IncidentSeverity;
  timestamp: number;
  opportunityId?: string;
  detail?: Record<string, unknown>;
  recoveryAction?: 'block' | 'quarantine' | 'pause' | 'alert_only';
}

const DEFAULT_SEVERITY_BY_REASON: Partial<Record<IncidentReason, IncidentSeverity>> = {
  auth_failure: 'critical',
  circuit_breaker: 'critical',
  unwind_failed: 'critical',
  fill_mismatch: 'critical',
  recon_drift: 'critical',
  order_cancel_failed: 'critical',
  order_failed: 'high',
  order_timeout: 'high',
  order_rejected: 'high',
  partial_fill: 'high',
  unwind_triggered: 'high',
  latency_exceeded: 'high',
  slippage_exceeded: 'high',
  depth_insufficient: 'high',
  price_moved: 'high',
  velocity_throttle: 'high',
  otr_exceeded: 'high',
  order_delayed: 'medium',
  ws_disconnected: 'medium',
  rpc_degraded: 'medium',
  api_429: 'medium',
  api_5xx: 'medium',
  book_stale: 'medium',
  book_inconsistent: 'medium'
};

const DEFAULT_RECOVERY_ACTION_BY_REASON: Partial<Record<IncidentReason, IncidentRecord['recoveryAction']>> = {
  auth_failure: 'pause',
  circuit_breaker: 'pause',
  rpc_degraded: 'pause',
  ws_disconnected: 'pause',
  api_429: 'pause',
  api_5xx: 'pause',
  recon_drift: 'pause',
  fill_mismatch: 'pause',
  order_cancel_failed: 'pause',
  unwind_failed: 'block',
  unknown: 'alert_only'
};

export function getDefaultSeverity(reason: IncidentReason): IncidentSeverity {
  return DEFAULT_SEVERITY_BY_REASON[reason] ?? 'low';
}

export function getDefaultRecoveryAction(
  reason: IncidentReason
): IncidentRecord['recoveryAction'] {
  return DEFAULT_RECOVERY_ACTION_BY_REASON[reason] ?? 'quarantine';
}
