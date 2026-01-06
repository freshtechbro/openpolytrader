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

export function getDefaultSeverity(reason: IncidentReason): IncidentSeverity {
  switch (reason) {
    case 'auth_failure':
    case 'circuit_breaker':
    case 'unwind_failed':
    case 'fill_mismatch':
    case 'recon_drift':
    case 'order_cancel_failed':
      return 'critical';
    case 'order_failed':
    case 'order_timeout':
    case 'order_rejected':
    case 'partial_fill':
    case 'unwind_triggered':
    case 'latency_exceeded':
    case 'slippage_exceeded':
    case 'depth_insufficient':
    case 'price_moved':
    case 'velocity_throttle':
    case 'otr_exceeded':
      return 'high';
    case 'order_delayed':
    case 'ws_disconnected':
    case 'rpc_degraded':
    case 'api_429':
    case 'api_5xx':
    case 'book_stale':
    case 'book_inconsistent':
      return 'medium';
    case 'unknown':
    default:
      return 'low';
  }
}

export function getDefaultRecoveryAction(
  reason: IncidentReason
): IncidentRecord['recoveryAction'] {
  switch (reason) {
    case 'auth_failure':
    case 'circuit_breaker':
    case 'rpc_degraded':
    case 'ws_disconnected':
    case 'api_429':
    case 'api_5xx':
    case 'recon_drift':
    case 'fill_mismatch':
    case 'order_cancel_failed':
      return 'pause';
    case 'unwind_failed':
      return 'block';
    case 'unknown':
      return 'alert_only';
    default:
      return 'quarantine';
  }
}
