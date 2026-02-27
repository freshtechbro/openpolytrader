import type { MarketPair } from './market.js';

export interface FwProjectionMetadata {
  projectionId: string;
  dependencyMode: 'deterministic' | 'llm' | 'hybrid';
  dependencyConfidence: number;
  projectedEdge: number;
  edgeLowerBound: number;
  solverRuntimeMs: number;
  solverStatus: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
  projectionAgeMs: number;
  loop?: FwLoopDiagnostics;
}

export interface FwLoopDiagnostics {
  loopId: string;
  iterationCount: number;
  activeSetSize: number;
  contractionSteps: number;
  terminalGapAbs: number;
  terminalGapRel: number;
  terminalReason:
    | 'gap_converged'
    | 'runtime_budget'
    | 'max_iterations'
    | 'contraction_floor'
    | 'oracle_unavailable';
  converged: boolean;
  runtimeMs: number;
}

export interface FwBasketMarketLeg {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  costPerSet: number;
  projectedEdge: number;
  edgeLowerBound: number;
  maxSizeByDepth: number;
  minOrderSize: number;
  tickSize: number;
}

export interface FwBasketMetadata {
  basketId: string;
  executionMode: 'batch_best_effort' | 'sequential_failfast';
  aggregateEdgeLowerBound: number;
  aggregateProjectedEdge: number;
  markets: FwBasketMarketLeg[];
  loop: FwLoopDiagnostics;
}

export interface ArbitrageOpportunity {
  id: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  costPerSet: number;
  edge: number;
  tickSize: number;
  maxSizeByDepth: number;
  minOrderSize: number;
  detectedAt: number;
  gateReasons: string[];
  pair: MarketPair;
  type?: 'near_zero' | 'ev' | 'fw_projection' | 'fw_basket';
  side?: 'yes' | 'no';
  pFinal?: number;
  evRaw?: number;
  evNet?: number;
  modelConfidence?: number;
  fw?: FwProjectionMetadata;
  fwBasket?: FwBasketMetadata;
}

export function opportunityId(marketId: string, yesPrice: number, noPrice: number, timestamp: number): string {
  return `${marketId}:${yesPrice.toFixed(4)}:${noPrice.toFixed(4)}:${timestamp}`;
}

export function evOpportunityId(
  marketId: string,
  side: 'yes' | 'no',
  price: number,
  pFinal: number,
  timestamp: number
): string {
  return `${marketId}:${side}:${price.toFixed(4)}:${pFinal.toFixed(4)}:${timestamp}`;
}

export function fwOpportunityId(
  marketId: string,
  projectedEdge: number,
  lowerBound: number,
  timestamp: number
): string {
  return `${marketId}:fw:${projectedEdge.toFixed(6)}:${lowerBound.toFixed(6)}:${timestamp}`;
}
