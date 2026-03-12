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

interface _GateRejectionEvent {
  opportunityId: string;
  marketId: string;
  reasons: string[];
  gateDecision: Record<string, unknown>;
  timestampMs: number;
}

interface _ExecutionLifecycleEvent {
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

interface _EvSignalEvent {
  marketId: string;
  side?: 'yes' | 'no';
  evNet?: number;
  confidence?: number;
  reason?: string | string[];
}

interface _WebSearchMetricEvent {
  event: string;
  provider?: 'exa' | 'firecrawl' | 'serper' | 'gdelt';
  kind?: string;
  marketId?: string;
  confidence?: number;
  count?: number;
  error?: string;
  route?: 'skip' | 'serper' | 'exa' | 'serper_then_exa' | 'firecrawl' | 'unknown';
  reason?: string;
  triggerScore?: number;
  queryMode?: 'base_only' | 'base_plus_one' | 'base_plus_two';
  requestedUrls?: number;
  expandedUrls?: number;
  providers?: string[];
}

interface _FwDependencyMetricEvent {
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

interface _FwOracleMetricEvent {
  event: string;
  status?: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
  runtimeMs?: number;
  timeLimitMs?: number;
  gap?: number;
  error?: string | null;
}

interface _FwProjectionMetricEvent {
  event: string;
  marketId: string;
  projectedEdge?: number;
  edgeLowerBound?: number;
  dependencyMode?: 'deterministic' | 'llm' | 'hybrid';
  reason?: string;
}

interface _FwIterationMetricEvent {
  loopId: string;
  iteration: number;
  objective: number;
  runtimeMs: number;
}

interface _FwGapMetricEvent {
  loopId: string;
  iteration: number;
  abs: number;
  rel: number;
}

interface _FwContractionMetricEvent {
  loopId: string;
  steps: number;
  terminalReason: string;
}

interface _FwActiveSetMetricEvent {
  loopId: string;
  iteration: number;
  size: number;
}

interface _FwBasketMetricEvent {
  event: string;
  basketId?: string;
  markets?: number;
  legs?: number;
  edgeLowerBound?: number;
}

type SloName =
  | 'decision_latency'
  | 'book_freshness'
  | 'delayed_ack_rate'
  | 'paired_fill_rate';

interface _SloViolationEvent {
  sloName: SloName;
  threshold: number;
  actual: number;
  marketId?: string;
  timestampMs: number;
}
