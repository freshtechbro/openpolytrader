export type DependencySource = 'deterministic' | 'llm' | 'hybrid';

export type DependencyRelation =
  | 'mutual_exclusive'
  | 'implies'
  | 'complementary'
  | 'partition';

export interface DependencyMarketInput {
  marketId: string;
  question?: string;
  category?: string;
  tags?: string[];
  yesTokenId?: string;
  noTokenId?: string;
}

export interface DependencyEdge {
  marketA: string;
  marketB: string;
  relationType: DependencyRelation;
  confidence: number;
  source: DependencySource;
  evidence: string;
  extractedAtMs: number;
}

export interface DependencyResolutionSummary {
  mode: 'deterministic' | 'llm' | 'hybrid';
  deterministicEdges: number;
  llmEdges: number;
  mergedEdges: number;
}

export interface DependencyResolutionResult {
  edges: DependencyEdge[];
  summary: DependencyResolutionSummary;
}

export function clampDependencyConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function dependencyEdgeKey(edge: Pick<DependencyEdge, 'marketA' | 'marketB' | 'relationType'>): string {
  if (edge.relationType === 'implies') {
    return `${edge.marketA}>${edge.marketB}:${edge.relationType}`;
  }
  const [left, right] = [edge.marketA, edge.marketB].sort();
  return `${left}|${right}:${edge.relationType}`;
}

export function withSortedMarkets(edge: DependencyEdge): DependencyEdge {
  if (edge.relationType === 'implies') return edge;
  if (edge.marketA <= edge.marketB) return edge;
  return {
    ...edge,
    marketA: edge.marketB,
    marketB: edge.marketA
  };
}
