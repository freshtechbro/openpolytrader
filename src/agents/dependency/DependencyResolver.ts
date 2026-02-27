import {
  clampDependencyConfidence,
  dependencyEdgeKey,
  type DependencyEdge,
  type DependencyMarketInput,
  type DependencyResolutionResult,
  withSortedMarkets
} from '../../domain/dependency.js';

type DependencyMode = 'deterministic' | 'llm' | 'hybrid';
type HybridMergeMode = 'consensus' | 'union';

export interface DependencyResolverConfig {
  mode: DependencyMode;
  hybridMerge: HybridMergeMode;
  minConfidence: number;
  maxEdgesPerMarket: number;
  llmExtractor?: (markets: DependencyMarketInput[], nowMs?: number) => Promise<DependencyEdge[]>;
}

const OPPOSITE_MARKERS: ReadonlyArray<[string, string]> = [
  ['will', 'will not'],
  ['yes', 'no'],
  ['over', 'under'],
  ['for', 'against'],
  ['increase', 'decrease']
];

const VALID_RELATIONS = new Set<DependencyEdge['relationType']>([
  'mutual_exclusive',
  'implies',
  'complementary',
  'partition'
]);

export class DependencyResolver {
  constructor(private config: DependencyResolverConfig) {}

  updateConfig(config: DependencyResolverConfig): void {
    this.config = config;
  }

  async resolve(
    markets: DependencyMarketInput[],
    nowMs = Date.now()
  ): Promise<DependencyResolutionResult> {
    const deterministicEdges =
      this.config.mode === 'llm' ? [] : this.extractDeterministic(markets, nowMs);
    const llmEdges =
      this.config.mode === 'deterministic'
        ? []
        : await this.extractLlm(markets, nowMs);

    const merged = this.mergeEdges(deterministicEdges, llmEdges);
    const edges = this.applyPolicyFilters(merged);

    return {
      edges,
      summary: {
        mode: this.config.mode,
        deterministicEdges: deterministicEdges.length,
        llmEdges: llmEdges.length,
        mergedEdges: edges.length
      }
    };
  }

  private extractDeterministic(
    markets: DependencyMarketInput[],
    nowMs: number
  ): DependencyEdge[] {
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
            source: 'deterministic',
            evidence: 'deterministic:opposite_markers_with_shared_stem',
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
            source: 'deterministic',
            evidence: 'deterministic:shared_category_and_tags',
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
            source: 'deterministic',
            evidence: 'deterministic:partition_prompt_overlap',
            extractedAtMs: nowMs
          });
        }
      }
    }

    return edges.map(withSortedMarkets);
  }

  private async extractLlm(
    markets: DependencyMarketInput[],
    nowMs: number
  ): Promise<DependencyEdge[]> {
    if (!this.config.llmExtractor) return [];

    const knownMarkets = new Set(markets.map((market) => market.marketId));
    const raw = await this.config.llmExtractor(markets, nowMs);
    const edges: DependencyEdge[] = [];

    for (const edge of raw) {
      if (!edge || !knownMarkets.has(edge.marketA) || !knownMarkets.has(edge.marketB)) {
        continue;
      }
      if (!VALID_RELATIONS.has(edge.relationType)) continue;
      if (edge.marketA === edge.marketB) continue;

      edges.push(
        withSortedMarkets({
          ...edge,
          confidence: clampDependencyConfidence(edge.confidence),
          source: 'llm',
          extractedAtMs: nowMs
        })
      );
    }

    return edges;
  }

  private mergeEdges(deterministicEdges: DependencyEdge[], llmEdges: DependencyEdge[]): DependencyEdge[] {
    if (this.config.mode === 'deterministic') return deterministicEdges;
    if (this.config.mode === 'llm') return llmEdges;
    if (deterministicEdges.length === 0 && llmEdges.length === 0) return [];

    const deterministicByKey = new Map(deterministicEdges.map((edge) => [dependencyEdgeKey(edge), edge]));
    const llmByKey = new Map(llmEdges.map((edge) => [dependencyEdgeKey(edge), edge]));

    if (this.config.hybridMerge === 'consensus') {
      // Keep FW productive when one source is temporarily unavailable (for example LLM circuit-open).
      if (deterministicEdges.length === 0 || llmEdges.length === 0) {
        const fallback = deterministicEdges.length > 0 ? deterministicEdges : llmEdges;
        return fallback.map((edge) => ({ ...edge, source: 'hybrid' }));
      }
      const result: DependencyEdge[] = [];
      for (const [key, left] of deterministicByKey.entries()) {
        const right = llmByKey.get(key);
        if (!right) continue;
        result.push({
          ...left,
          confidence: clampDependencyConfidence((left.confidence + right.confidence) / 2),
          source: 'hybrid',
          evidence: `${left.evidence} + ${right.evidence}`
        });
      }
      return result;
    }

    const merged = new Map<string, DependencyEdge>();
    for (const edge of deterministicEdges) {
      merged.set(dependencyEdgeKey(edge), { ...edge, source: 'hybrid' });
    }
    for (const edge of llmEdges) {
      const key = dependencyEdgeKey(edge);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...edge, source: 'hybrid' });
        continue;
      }

      const maxConfidence = Math.max(existing.confidence, edge.confidence);
      merged.set(key, {
        ...existing,
        confidence: clampDependencyConfidence(maxConfidence),
        source: 'hybrid',
        evidence: existing.evidence === edge.evidence ? existing.evidence : `${existing.evidence} | ${edge.evidence}`
      });
    }

    return Array.from(merged.values());
  }

  private applyPolicyFilters(edges: DependencyEdge[]): DependencyEdge[] {
    const minConfidence = clampDependencyConfidence(this.config.minConfidence);
    const maxEdgesPerMarket = Math.max(1, Math.floor(this.config.maxEdgesPerMarket));
    const counts = new Map<string, number>();

    const sorted = edges
      .filter((edge) => clampDependencyConfidence(edge.confidence) >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);

    const filtered: DependencyEdge[] = [];
    for (const edge of sorted) {
      const leftCount = counts.get(edge.marketA) ?? 0;
      const rightCount = counts.get(edge.marketB) ?? 0;
      if (leftCount >= maxEdgesPerMarket || rightCount >= maxEdgesPerMarket) {
        continue;
      }

      filtered.push(edge);
      counts.set(edge.marketA, leftCount + 1);
      counts.set(edge.marketB, rightCount + 1);
    }

    return filtered;
  }
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
