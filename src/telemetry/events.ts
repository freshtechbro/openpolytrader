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

export interface EvSignalEvent {
  marketId: string;
  side?: 'yes' | 'no';
  evNet?: number;
  confidence?: number;
  reason?: string | string[];
}

export interface WebSearchMetricEvent {
  event: string;
  provider?: 'exa' | 'firecrawl';
  kind?: string;
  marketId?: string;
  confidence?: number;
  count?: number;
  error?: string;
}

export interface FwDependencyMetricEvent {
  event: string;
  mode?: 'deterministic' | 'llm' | 'hybrid';
  hybridMerge?: 'consensus' | 'union';
  edgeCount?: number;
  markets?: number;
  confidenceMin?: number;
  marketId?: string;
  reason?: string;
  deterministicEdges?: number;
  llmEdges?: number;
  mergedEdges?: number;
  fallbackSource?: 'deterministic' | 'llm' | null;
}

export interface FwOracleMetricEvent {
  event: string;
  status?: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
  runtimeMs?: number;
  timeLimitMs?: number;
  gap?: number;
  error?: string | null;
}

export interface FwProjectionMetricEvent {
  event: string;
  marketId: string;
  projectedEdge?: number;
  edgeLowerBound?: number;
  dependencyMode?: 'deterministic' | 'llm' | 'hybrid';
  reason?: string;
}

export interface FwIterationMetricEvent {
  loopId: string;
  iteration: number;
  objective: number;
  runtimeMs: number;
}

export interface FwGapMetricEvent {
  loopId: string;
  iteration: number;
  abs: number;
  rel: number;
}

export interface FwContractionMetricEvent {
  loopId: string;
  steps: number;
  terminalReason: string;
}

export interface FwActiveSetMetricEvent {
  loopId: string;
  iteration: number;
  size: number;
}

export interface FwBasketMetricEvent {
  event: string;
  basketId?: string;
  markets?: number;
  legs?: number;
  edgeLowerBound?: number;
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
