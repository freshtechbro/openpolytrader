export type DependencySource = 'deterministic' | 'llm' | 'hybrid' | 'catalog';

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

export interface DependencyRelationCatalogEntry {
  marketA: string;
  marketB: string;
  relationType: DependencyRelation;
  confidence: number;
  evidence: string;
  eventKey: string;
  asOfMs: number;
}

export interface DependencyResolutionSummary {
  mode: 'deterministic' | 'llm' | 'hybrid';
  deterministicEdges: number;
  catalogEdges?: number;
  llmEdges: number;
  mergedEdges: number;
  cacheStatus?: 'bypass' | 'miss' | 'hit' | 'stale';
  fallbackSource?: 'none' | 'cache' | 'deterministic';
  llmReason?: string;
  backoffActive?: boolean;
}

export interface DependencyResolutionResult {
  edges: DependencyEdge[];
  summary: DependencyResolutionSummary;
}

export interface DependencyGraphQualityStats {
  edgeCount: number;
  componentCount: number;
  coverage: number;
  relationTypeCounts: Record<DependencyRelation, number>;
}

export interface DeterministicDependencyExtractOptions {
  source?: DependencySource;
  evidencePrefix?: string;
}

const OPPOSITE_MARKERS: ReadonlyArray<[string, string]> = [
  ['will', 'will not'],
  ['yes', 'no'],
  ['over', 'under'],
  ['for', 'against'],
  ['increase', 'decrease']
];

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

export function isDependencyRelation(value: string): value is DependencyRelation {
  return (
    value === 'mutual_exclusive' ||
    value === 'implies' ||
    value === 'complementary' ||
    value === 'partition'
  );
}

export function toCatalogEdge(entry: DependencyRelationCatalogEntry): DependencyEdge {
  return withSortedMarkets({
    marketA: entry.marketA,
    marketB: entry.marketB,
    relationType: entry.relationType,
    confidence: clampDependencyConfidence(entry.confidence),
    source: 'catalog',
    evidence: entry.evidence,
    extractedAtMs: entry.asOfMs
  });
}

export function normalizeRelationCatalogEntry(
  value: unknown
): DependencyRelationCatalogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.marketA !== 'string' ||
    typeof record.marketB !== 'string' ||
    typeof record.relationType !== 'string' ||
    typeof record.evidence !== 'string' ||
    typeof record.eventKey !== 'string' ||
    typeof record.asOfMs !== 'number' ||
    !Number.isFinite(record.asOfMs)
  ) {
    return null;
  }
  const marketA = record.marketA.trim();
  const marketB = record.marketB.trim();
  const eventKey = record.eventKey.trim();
  const evidence = record.evidence.trim();
  if (!marketA || !marketB || marketA === marketB || !eventKey || !evidence) return null;
  if (!isDependencyRelation(record.relationType)) return null;
  const confidence = clampDependencyConfidence(
    typeof record.confidence === 'number' ? record.confidence : Number(record.confidence)
  );
  return {
    marketA,
    marketB,
    relationType: record.relationType,
    confidence,
    evidence,
    eventKey,
    asOfMs: Math.floor(record.asOfMs)
  };
}

export function extractDeterministicDependencyEdges(
  markets: DependencyMarketInput[],
  nowMs: number,
  options?: DeterministicDependencyExtractOptions
): DependencyEdge[] {
  const source = options?.source ?? 'deterministic';
  const evidencePrefix = options?.evidencePrefix ?? source;
  const edges: DependencyEdge[] = [];

  for (let i = 0; i < markets.length; i += 1) {
    for (let j = i + 1; j < markets.length; j += 1) {
      const left = markets[i];
      const right = markets[j];

      const leftText = normalizeText(left.question ?? left.marketId);
      const rightText = normalizeText(right.question ?? right.marketId);
      const leftStem = textStem(leftText);
      const rightStem = textStem(rightText);

      const hasOppositeMarkers = OPPOSITE_MARKERS.some(([a, b]) => {
        return (
          (leftText.includes(a) && rightText.includes(b)) ||
          (leftText.includes(b) && rightText.includes(a))
        );
      });

      if (hasOppositeMarkers && leftStem === rightStem && leftStem.length > 0) {
        edges.push({
          marketA: left.marketId,
          marketB: right.marketId,
          relationType: 'mutual_exclusive',
          confidence: 0.9,
          source,
          evidence: `${evidencePrefix}:opposite_markers_with_shared_stem`,
          extractedAtMs: nowMs
        });
        continue;
      }

      const sharedTags = countSharedTags(left.tags, right.tags);
      if (sharedTags >= 2 && left.category && right.category && left.category === right.category) {
        edges.push({
          marketA: left.marketId,
          marketB: right.marketId,
          relationType: 'complementary',
          confidence: 0.7,
          source,
          evidence: `${evidencePrefix}:shared_category_and_tags`,
          extractedAtMs: nowMs
        });
        continue;
      }

      if (isPartitionPrompt(leftText) && isPartitionPrompt(rightText) && left.category === right.category) {
        edges.push({
          marketA: left.marketId,
          marketB: right.marketId,
          relationType: 'partition',
          confidence: 0.65,
          source,
          evidence: `${evidencePrefix}:partition_prompt_overlap`,
          extractedAtMs: nowMs
        });
      }
    }
  }

  return edges.map(withSortedMarkets);
}

export function computeDependencyGraphQualityStats(
  markets: DependencyMarketInput[] | string[],
  edges: DependencyEdge[]
): DependencyGraphQualityStats {
  const marketIds = Array.from(
    new Set(
      markets.map((market) =>
        typeof market === 'string' ? market : market.marketId
      )
    )
  ).filter((marketId) => marketId.length > 0);
  const marketSet = new Set(marketIds);
  const adjacency = new Map<string, Set<string>>();
  const relationTypeCounts = initRelationTypeCounts();

  for (const edge of edges) {
    relationTypeCounts[edge.relationType] += 1;
    if (!marketSet.has(edge.marketA) || !marketSet.has(edge.marketB) || edge.marketA === edge.marketB) {
      continue;
    }
    if (!adjacency.has(edge.marketA)) adjacency.set(edge.marketA, new Set());
    if (!adjacency.has(edge.marketB)) adjacency.set(edge.marketB, new Set());
    adjacency.get(edge.marketA)!.add(edge.marketB);
    adjacency.get(edge.marketB)!.add(edge.marketA);
  }

  const coveredMarkets = Array.from(adjacency.keys());
  const coverage = marketIds.length > 0 ? coveredMarkets.length / marketIds.length : 0;
  const seen = new Set<string>();
  let componentCount = 0;

  for (const marketId of coveredMarkets) {
    if (seen.has(marketId)) continue;
    componentCount += 1;
    const queue = [marketId];
    seen.add(marketId);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return {
    edgeCount: edges.length,
    componentCount,
    coverage,
    relationTypeCounts
  };
}

function initRelationTypeCounts(): Record<DependencyRelation, number> {
  return {
    mutual_exclusive: 0,
    implies: 0,
    complementary: 0,
    partition: 0
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function textStem(value: string): string {
  return value
    .replace(/\b(yes|no|will not|will|over|under|for|against|increase|decrease)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countSharedTags(left: string[] | undefined, right: string[] | undefined): number {
  if (!left || !right || left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map((value) => value.trim().toLowerCase()).filter(Boolean));
  let count = 0;
  for (const raw of left) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    if (rightSet.has(tag)) count += 1;
  }
  return count;
}

function isPartitionPrompt(value: string): boolean {
  return value.startsWith('which ') || value.startsWith('who ') || value.startsWith('what ');
}
