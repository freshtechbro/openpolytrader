import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  dependencyEdgeKey,
  extractDeterministicDependencyEdges,
  normalizeRelationCatalogEntry,
  type DependencyEdge,
  type DependencyMarketInput,
  type DependencyRelation,
  type DependencyRelationCatalogEntry
} from '../../domain/dependency.js';

interface DependencyRelationCatalogSnapshot {
  path: string;
  loadedAtMs: number;
  entries: DependencyRelationCatalogEntry[];
  malformedEntries: number;
  loadError?: 'missing_file' | 'parse_error';
}

interface DependencyRelationCatalogBuildResult {
  entries: DependencyRelationCatalogEntry[];
  deterministicRelations: number;
  semanticRelations: number;
  relationTypeCounts: Record<DependencyRelation, number>;
}

type RawRelationCatalog =
  | DependencyRelationCatalogEntry[]
  | { relations?: DependencyRelationCatalogEntry[] };

export function loadDependencyRelationCatalog(
  filePath: string,
  nowMs = Date.now()
): DependencyRelationCatalogSnapshot {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return {
      path: absolutePath,
      loadedAtMs: nowMs,
      entries: [],
      malformedEntries: 0,
      loadError: 'missing_file'
    };
  }

  let parsed: RawRelationCatalog;
  try {
    const raw = readFileSync(absolutePath, 'utf8');
    parsed = JSON.parse(raw) as RawRelationCatalog;
  } catch {
    return {
      path: absolutePath,
      loadedAtMs: nowMs,
      entries: [],
      malformedEntries: 0,
      loadError: 'parse_error'
    };
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.relations)
      ? parsed.relations
      : [];

  const entries: DependencyRelationCatalogEntry[] = [];
  let malformedEntries = 0;
  for (const value of rawEntries) {
    const normalized = normalizeRelationCatalogEntry(value);
    if (!normalized) {
      malformedEntries += 1;
      continue;
    }
    entries.push(normalized);
  }

  return {
    path: absolutePath,
    loadedAtMs: nowMs,
    entries,
    malformedEntries
  };
}

export function buildDependencyRelationCatalogEntries(
  markets: DependencyMarketInput[],
  input: {
    nowMs?: number;
    semanticEnabled?: boolean;
  } = {}
): DependencyRelationCatalogBuildResult {
  const nowMs = input.nowMs ?? Date.now();
  const deterministic = extractDeterministicDependencyEdges(markets, nowMs, {
    source: 'catalog',
    evidencePrefix: 'catalog:deterministic'
  });
  const semantic = input.semanticEnabled
    ? buildSemanticAugmentationEdges(markets, nowMs)
    : [];
  const merged = mergeCatalogEdges([...deterministic, ...semantic], nowMs);
  const relationTypeCounts = {
    mutual_exclusive: 0,
    implies: 0,
    complementary: 0,
    partition: 0
  } as Record<DependencyRelation, number>;

  for (const edge of merged) {
    relationTypeCounts[edge.relationType] += 1;
  }

  const entries = merged
    .map((edge) => ({
      marketA: edge.marketA,
      marketB: edge.marketB,
      relationType: edge.relationType,
      confidence: edge.confidence,
      evidence: edge.evidence,
      eventKey: dependencyEdgeKey(edge),
      asOfMs: nowMs
    }))
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.eventKey.localeCompare(right.eventKey);
    });

  return {
    entries,
    deterministicRelations: deterministic.length,
    semanticRelations: semantic.length,
    relationTypeCounts
  };
}

function buildSemanticAugmentationEdges(
  markets: DependencyMarketInput[],
  nowMs: number
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (let i = 0; i < markets.length; i += 1) {
    for (let j = i + 1; j < markets.length; j += 1) {
      const left = markets[i];
      const right = markets[j];
      if (!left.question || !right.question) continue;
      if (!left.category || !right.category || left.category !== right.category) continue;

      const leftTokens = tokenize(left.question);
      const rightTokens = tokenize(right.question);
      if (leftTokens.length === 0 || rightTokens.length === 0) continue;

      const overlap = tokenOverlap(leftTokens, rightTokens);
      if (overlap < 0.35) continue;

      edges.push({
        marketA: left.marketId,
        marketB: right.marketId,
        relationType: inferSemanticRelation(left.question, right.question),
        confidence: Math.min(0.8, 0.5 + overlap * 0.4),
        source: 'catalog',
        evidence: 'catalog:semantic_question_overlap',
        extractedAtMs: nowMs
      });
    }
  }
  return edges;
}

function inferSemanticRelation(
  leftQuestion: string,
  rightQuestion: string
): DependencyRelation {
  const left = normalizeText(leftQuestion);
  const right = normalizeText(rightQuestion);
  if (left.includes(right) || right.includes(left)) {
    return 'implies';
  }
  return 'complementary';
}

function mergeCatalogEdges(edges: DependencyEdge[], nowMs: number): DependencyEdge[] {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of edges) {
    const key = dependencyEdgeKey(edge);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...edge,
        extractedAtMs: nowMs
      });
      continue;
    }

    if (edge.confidence > existing.confidence) {
      merged.set(key, {
        ...edge,
        extractedAtMs: nowMs
      });
      continue;
    }

    if (edge.confidence === existing.confidence && edge.evidence !== existing.evidence) {
      merged.set(key, {
        ...existing,
        evidence: `${existing.evidence} | ${edge.evidence}`,
        extractedAtMs: nowMs
      });
    }
  }
  return Array.from(merged.values());
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function tokenOverlap(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return 0;
  return intersection / union;
}
