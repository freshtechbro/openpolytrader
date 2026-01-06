import type { ExecutionState } from '../domain/execution.js';

export type LatencyStage =
  | 'detected'
  | 'gated'
  | 'risk_approved'
  | 'submitted'
  | 'acked'
  | 'filled'
  | 'complete';

export interface LatencyEvent {
  stage: LatencyStage;
  opportunityId: string;
  marketId: string;
  timestampMs: number;
  latencyMs?: number;
  cumulativeMs?: number;
}

export interface GateRejectionEvent {
  opportunityId: string;
  marketId: string;
  reasons: string[];
  gateDecision: Record<string, unknown>;
  timestampMs: number;
}

export interface ExecutionLifecycleEvent {
  executionId: string;
  opportunityId: string;
  marketId: string;
  state: ExecutionState;
  previousState?: ExecutionState;
  eventType: string;
  action?: string;
  timestampMs: number;
  error?: string;
}

export type SloName =
  | 'decision_latency'
  | 'book_freshness'
  | 'delayed_ack_rate'
  | 'paired_fill_rate';

export interface SloViolationEvent {
  sloName: SloName;
  threshold: number;
  actual: number;
  marketId?: string;
  timestampMs: number;
}
