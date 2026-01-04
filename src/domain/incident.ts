export type IncidentReason =
  | 'order_delayed'
  | 'order_rejected'
  | 'order_failed'
  | 'ws_disconnected'
  | 'rpc_degraded'
  | 'unknown';

export interface IncidentRecord {
  marketId: string;
  reason: IncidentReason;
  timestamp: number;
  detail?: Record<string, unknown>;
}
