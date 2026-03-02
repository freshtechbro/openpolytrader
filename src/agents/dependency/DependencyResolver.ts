import {
  clampDependencyConfidence,
  dependencyEdgeKey,
  type DependencyEdge,
  extractDeterministicDependencyEdges,
  normalizeRelationCatalogEntry,
  toCatalogEdge,
  type DependencyRelationCatalogEntry,
  type DependencyMarketInput,
  type DependencyResolutionResult,
  withSortedMarkets
} from '../../domain/dependency.js';

type DependencyMode = 'deterministic' | 'llm' | 'hybrid';
type HybridMergeMode = 'consensus' | 'union';

export interface DependencyExtractorResult {
  edges: DependencyEdge[];
  reason?: string;
}

type DependencyExtractorResponse = DependencyEdge[] | DependencyExtractorResult;

export interface DependencyResolverConfig {
  mode: DependencyMode;
  hybridMerge: HybridMergeMode;
  minConfidence: number;
  maxEdgesPerMarket: number;
  relationCatalogEnabled?: boolean;
  relationCatalogEntries?: DependencyRelationCatalogEntry[];
  relationCatalogMinConfidence?: number;
  relationCatalogMaxEdgesPerMarket?: number;
  cacheTtlMs?: number;
  cacheGraceMs?: number;
  cacheMaxEntries?: number;
  backoffInvalidMs?: number;
  backoffTimeoutMs?: number;
  backoffErrorMs?: number;
  llmExtractor?: (
    markets: DependencyMarketInput[],
    nowMs?: number
  ) => Promise<DependencyExtractorResponse>;
}

interface DependencyCacheEntry {
  edges: DependencyEdge[];
  updatedAtMs: number;
}

type DependencyCacheStatus = 'bypass' | 'miss' | 'hit' | 'stale';
type FallbackSource = 'none' | 'cache' | 'deterministic';

const DEFAULT_CACHE_TTL_MS = 120_000;
const DEFAULT_CACHE_GRACE_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const DEFAULT_BACKOFF_INVALID_MS = 5_000;
const DEFAULT_BACKOFF_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_ERROR_MS = 15_000;

const VALID_RELATIONS = new Set<DependencyEdge['relationType']>([
  'mutual_exclusive',
  'implies',
  'complementary',
  'partition'
]);

export class DependencyResolver {
  private readonly llmCache = new Map<string, DependencyCacheEntry>();
  private llmBackoffUntilMs = 0;
  private relationCatalogEdges: DependencyEdge[] = [];

  constructor(private config: DependencyResolverConfig) {
    this.relationCatalogEdges = normalizeRelationCatalog(config.relationCatalogEntries);
  }

  updateConfig(config: DependencyResolverConfig): void {
    this.config = config;
    this.relationCatalogEdges = normalizeRelationCatalog(config.relationCatalogEntries);
  }

  async resolve(
    markets: DependencyMarketInput[],
    nowMs = Date.now()
  ): Promise<DependencyResolutionResult> {
    const deterministicEdges = extractDeterministicDependencyEdges(markets, nowMs, {
      source: 'deterministic',
      evidencePrefix: 'deterministic'
    });
    const catalogEdges = this.resolveCatalogEdges(markets, nowMs);
    const staticEdges = mergeStaticEdges(deterministicEdges, catalogEdges);

    let llmEdges: DependencyEdge[] = [];
    let cacheStatus: DependencyCacheStatus =
      this.config.mode === 'deterministic' ? 'bypass' : 'miss';
    let fallbackSource: FallbackSource = 'none';
    let llmReason = this.config.mode === 'deterministic' ? 'mode_deterministic' : 'not_invoked';
    let backoffActive = false;

    if (this.config.mode !== 'deterministic') {
      const cacheTtlMs = toPositiveInt(this.config.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
      const cacheGraceMs = toNonNegativeInt(this.config.cacheGraceMs, DEFAULT_CACHE_GRACE_MS);
      const cacheMaxEntries = toPositiveInt(this.config.cacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES);
      const cacheKey = buildMarketUniverseCacheKey(markets);
      const cached = this.readCachedEdges(cacheKey, nowMs, cacheTtlMs, cacheGraceMs);
      const backoffOpen = nowMs < this.llmBackoffUntilMs;

      if (!backoffOpen && cached.status === 'hit' && cached.edges) {
        llmEdges = cached.edges;
        cacheStatus = 'hit';
        fallbackSource = 'cache';
        llmReason = 'cache_hit';
      } else if (backoffOpen) {
        backoffActive = true;
        llmReason = 'resolver_backoff_active';
        cacheStatus = cached.status;
        if (cached.edges) {
          llmEdges = cached.edges;
          fallbackSource = 'cache';
        } else if (staticEdges.length > 0) {
          fallbackSource = 'deterministic';
          if (this.config.mode === 'llm') {
            llmEdges = staticEdges;
          }
        }
      } else {
        const extracted = await this.extractLlm(markets, nowMs);
        llmEdges = extracted.edges;
        llmReason = extracted.reason ?? 'ok';
        const backoffMs = this.backoffDurationForReason(llmReason);

        if (backoffMs > 0) {
          this.llmBackoffUntilMs = nowMs + backoffMs;
          cacheStatus = cached.status;
          if (cached.edges) {
            llmEdges = cached.edges;
            fallbackSource = 'cache';
          } else if (staticEdges.length > 0) {
            fallbackSource = 'deterministic';
            if (this.config.mode === 'llm') {
              llmEdges = staticEdges;
            } else {
              llmEdges = [];
            }
          } else {
            llmEdges = [];
          }
        } else {
          this.llmBackoffUntilMs = 0;
          this.writeCachedEdges(cacheKey, llmEdges, nowMs, cacheMaxEntries);
          cacheStatus = cached.status === 'stale' ? 'stale' : 'miss';
        }
      }
    }

    const merged = this.mergeEdges(staticEdges, llmEdges);
    const edges = this.applyPolicyFilters(merged);

    return {
      edges,
      summary: {
        mode: this.config.mode,
        deterministicEdges: deterministicEdges.length,
        catalogEdges: catalogEdges.length,
        llmEdges: llmEdges.length,
        mergedEdges: edges.length,
        cacheStatus,
        fallbackSource,
        llmReason,
        backoffActive
      }
    };
  }

  private resolveCatalogEdges(
    markets: DependencyMarketInput[],
    nowMs: number
  ): DependencyEdge[] {
    if (this.config.relationCatalogEnabled === false) return [];
    if (this.relationCatalogEdges.length === 0) return [];
    const marketSet = new Set(markets.map((market) => market.marketId));
    const minConfidence = clampDependencyConfidence(
      typeof this.config.relationCatalogMinConfidence === 'number'
        ? this.config.relationCatalogMinConfidence
        : this.config.minConfidence
    );
    const maxPerMarket = Math.max(
      1,
      Math.floor(
        typeof this.config.relationCatalogMaxEdgesPerMarket === 'number'
          ? this.config.relationCatalogMaxEdgesPerMarket
          : this.config.maxEdgesPerMarket
      )
    );
    const counts = new Map<string, number>();
    const selected: DependencyEdge[] = [];
    const sorted = this.relationCatalogEdges
      .filter((edge) => marketSet.has(edge.marketA) && marketSet.has(edge.marketB))
      .filter((edge) => edge.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    for (const edge of sorted) {
      const leftCount = counts.get(edge.marketA) ?? 0;
      const rightCount = counts.get(edge.marketB) ?? 0;
      if (leftCount >= maxPerMarket || rightCount >= maxPerMarket) continue;
      selected.push({
        ...edge,
        extractedAtMs: Number.isFinite(edge.extractedAtMs) ? edge.extractedAtMs : nowMs
      });
      counts.set(edge.marketA, leftCount + 1);
      counts.set(edge.marketB, rightCount + 1);
    }
    return selected;
  }

  private async extractLlm(
    markets: DependencyMarketInput[],
    nowMs: number
  ): Promise<DependencyExtractorResult> {
    if (!this.config.llmExtractor) return { edges: [], reason: 'llm_unconfigured' };

    const knownMarkets = new Set(markets.map((market) => market.marketId));
    let response: DependencyExtractorResponse;
    try {
      response = await this.config.llmExtractor(markets, nowMs);
    } catch {
      return { edges: [], reason: 'llm_error_extractor_exception' };
    }
    const normalized = normalizeExtractorResponse(response);
    const edges: DependencyEdge[] = [];

    for (const edge of normalized.edges) {
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

    return { edges, reason: normalized.reason };
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

  private readCachedEdges(
    key: string,
    nowMs: number,
    ttlMs: number,
    graceMs: number
  ): { edges: DependencyEdge[] | null; status: DependencyCacheStatus } {
    const cached = this.llmCache.get(key);
    if (!cached) {
      return { edges: null, status: 'miss' };
    }

    const ageMs = Math.max(0, nowMs - cached.updatedAtMs);
    if (ageMs <= ttlMs) {
      this.touchCacheEntry(key, cached);
      return { edges: cached.edges, status: 'hit' };
    }

    if (ageMs <= ttlMs + graceMs) {
      this.touchCacheEntry(key, cached);
      return { edges: cached.edges, status: 'stale' };
    }

    this.llmCache.delete(key);
    return { edges: null, status: 'miss' };
  }

  private writeCachedEdges(
    key: string,
    edges: DependencyEdge[],
    nowMs: number,
    maxEntries: number
  ): void {
    const entry: DependencyCacheEntry = {
      edges: edges.map((edge) => ({ ...edge })),
      updatedAtMs: nowMs
    };
    this.llmCache.delete(key);
    this.llmCache.set(key, entry);

    while (this.llmCache.size > maxEntries) {
      const oldestKey = this.llmCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.llmCache.delete(oldestKey);
    }
  }

  private touchCacheEntry(key: string, entry: DependencyCacheEntry): void {
    this.llmCache.delete(key);
    this.llmCache.set(key, entry);
  }

  private backoffDurationForReason(reason: string): number {
    if (
      reason === 'invalid_output' ||
      reason === 'missing_output_text' ||
      reason === 'invalid_extractor_output'
    ) {
      return toNonNegativeInt(this.config.backoffInvalidMs, DEFAULT_BACKOFF_INVALID_MS);
    }
    if (reason === 'llm_timeout') {
      return toNonNegativeInt(this.config.backoffTimeoutMs, DEFAULT_BACKOFF_TIMEOUT_MS);
    }
    if (
      reason === 'llm_circuit_backoff' ||
      reason === 'llm_error_extractor_exception' ||
      reason.startsWith('llm_error_') ||
      reason.startsWith('llm_fallback_')
    ) {
      return toNonNegativeInt(this.config.backoffErrorMs, DEFAULT_BACKOFF_ERROR_MS);
    }
    return 0;
  }
}

function normalizeExtractorResponse(response: DependencyExtractorResponse): DependencyExtractorResult {
  if (Array.isArray(response)) {
    return { edges: response, reason: 'ok' };
  }
  if (!response || !Array.isArray(response.edges)) {
    return { edges: [], reason: 'invalid_extractor_output' };
  }
  return {
    edges: response.edges,
    reason: typeof response.reason === 'string' && response.reason.trim().length > 0
      ? response.reason.trim()
      : 'ok'
  };
}

function normalizeRelationCatalog(
  entries: DependencyRelationCatalogEntry[] | undefined
): DependencyEdge[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const normalized: DependencyEdge[] = [];
  for (const entry of entries) {
    const parsed = normalizeRelationCatalogEntry(entry);
    if (!parsed) continue;
    normalized.push(toCatalogEdge(parsed));
  }
  return normalized;
}

function mergeStaticEdges(
  deterministicEdges: DependencyEdge[],
  catalogEdges: DependencyEdge[]
): DependencyEdge[] {
  if (catalogEdges.length === 0) return deterministicEdges;
  if (deterministicEdges.length === 0) return catalogEdges;
  const merged = new Map<string, DependencyEdge>();
  for (const edge of deterministicEdges) {
    merged.set(dependencyEdgeKey(edge), edge);
  }
  for (const edge of catalogEdges) {
    const key = dependencyEdgeKey(edge);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, edge);
      continue;
    }
    if (edge.confidence > existing.confidence) {
      merged.set(key, {
        ...edge,
        source: existing.source === edge.source ? edge.source : 'hybrid',
        evidence:
          existing.evidence === edge.evidence
            ? edge.evidence
            : `${existing.evidence} | ${edge.evidence}`
      });
    } else if (edge.confidence === existing.confidence && existing.source !== edge.source) {
      merged.set(key, {
        ...existing,
        source: 'hybrid',
        evidence:
          existing.evidence === edge.evidence
            ? existing.evidence
            : `${existing.evidence} | ${edge.evidence}`
      });
    }
  }
  return Array.from(merged.values()).map(withSortedMarkets);
}

function buildMarketUniverseCacheKey(markets: DependencyMarketInput[]): string {
  return markets
    .map((market) => {
      const tags = Array.isArray(market.tags)
        ? market.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean).sort().join(',')
        : '';
      const question = normalizeText(market.question ?? '');
      const category = normalizeText(market.category ?? '');
      return `${market.marketId}|${question}|${category}|${tags}`;
    })
    .sort()
    .join('||');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function toNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
