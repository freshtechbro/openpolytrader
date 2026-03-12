import { describe, expect, it } from 'vitest';

import {
  clampDependencyConfidence,
  computeDependencyGraphQualityStats,
  dependencyEdgeKey,
  extractDeterministicDependencyEdges,
  normalizeRelationCatalogEntry,
  withSortedMarkets
} from '../../src/domain/dependency.js';

describe('dependency domain helpers', () => {
  it('clamps confidence into [0,1]', () => {
    expect(clampDependencyConfidence(Number.NaN)).toBe(0);
    expect(clampDependencyConfidence(-1)).toBe(0);
    expect(clampDependencyConfidence(0.42)).toBeCloseTo(0.42, 6);
    expect(clampDependencyConfidence(2)).toBe(1);
  });

  it('builds directional keys for implies relations', () => {
    const key = dependencyEdgeKey({
      marketA: 'a',
      marketB: 'b',
      relationType: 'implies'
    });
    expect(key).toBe('a>b:implies');
  });

  it('builds sorted keys for non-directional relations', () => {
    const key = dependencyEdgeKey({
      marketA: 'z',
      marketB: 'a',
      relationType: 'mutual_exclusive'
    });
    expect(key).toBe('a|z:mutual_exclusive');
  });

  it('sorts non-directional edges while preserving implies ordering', () => {
    const sorted = withSortedMarkets({
      marketA: 'z',
      marketB: 'a',
      relationType: 'complementary',
      confidence: 0.5,
      source: 'deterministic',
      evidence: 'test',
      extractedAtMs: 1
    });
    expect(sorted.marketA).toBe('a');
    expect(sorted.marketB).toBe('z');

    const directional = withSortedMarkets({
      marketA: 'z',
      marketB: 'a',
      relationType: 'implies',
      confidence: 0.5,
      source: 'deterministic',
      evidence: 'test',
      extractedAtMs: 1
    });
    expect(directional.marketA).toBe('z');
    expect(directional.marketB).toBe('a');
  });

  it('computes graph stats while excluding invalid/self/out-of-set edges from adjacency', () => {
    const stats = computeDependencyGraphQualityStats(
      ['m-1', 'm-2', 'm-3'],
      [
        {
          marketA: 'm-1',
          marketB: 'm-2',
          relationType: 'complementary',
          confidence: 0.7,
          source: 'deterministic',
          evidence: 'a',
          extractedAtMs: 1
        },
        {
          marketA: 'm-2',
          marketB: 'm-2',
          relationType: 'partition',
          confidence: 0.8,
          source: 'deterministic',
          evidence: 'b',
          extractedAtMs: 1
        },
        {
          marketA: 'm-4',
          marketB: 'm-1',
          relationType: 'mutual_exclusive',
          confidence: 0.6,
          source: 'deterministic',
          evidence: 'c',
          extractedAtMs: 1
        }
      ]
    );

    expect(stats.edgeCount).toBe(3);
    expect(stats.coverage).toBeCloseTo(2 / 3, 6);
    expect(stats.componentCount).toBe(1);
    expect(stats.relationTypeCounts.complementary).toBe(1);
    expect(stats.relationTypeCounts.partition).toBe(1);
    expect(stats.relationTypeCounts.mutual_exclusive).toBe(1);
  });

  it('extracts partition and complementary deterministic relations', () => {
    const now = Date.now();
    const complementaryEdges = extractDeterministicDependencyEdges(
      [
        {
          marketId: 'm-1',
          category: 'politics',
          tags: ['state', 'election', 'governor'],
          question: 'Which party wins governor race?'
        },
        {
          marketId: 'm-2',
          category: 'politics',
          tags: ['state', 'election', 'senate'],
          question: 'Who wins senate race?'
        }
      ],
      now,
      { source: 'deterministic', evidencePrefix: 'test' }
    );

    const partitionEdges = extractDeterministicDependencyEdges(
      [
        {
          marketId: 'm-3',
          category: 'politics',
          tags: ['governor'],
          question: 'Which party wins governor race?'
        },
        {
          marketId: 'm-4',
          category: 'politics',
          tags: ['senate'],
          question: 'Who wins senate race?'
        }
      ],
      now,
      { source: 'deterministic', evidencePrefix: 'test' }
    );

    expect(complementaryEdges.some((edge) => edge.relationType === 'complementary')).toBe(true);
    expect(partitionEdges.some((edge) => edge.relationType === 'partition')).toBe(true);
  });

  it('does not classify uncategorized partition prompts as partitions', () => {
    const now = Date.now();
    const edges = extractDeterministicDependencyEdges(
      [
        {
          marketId: 'm-5',
          question: 'Which party wins governor race?'
        },
        {
          marketId: 'm-6',
          question: 'Who wins senate race?'
        }
      ],
      now,
      { source: 'deterministic', evidencePrefix: 'test' }
    );

    expect(edges.some((edge) => edge.relationType === 'partition')).toBe(false);
  });

  it('normalizes valid catalog entries and rejects malformed records', () => {
    const malformed = normalizeRelationCatalogEntry({
      marketA: 'a',
      marketB: 'b',
      relationType: 'implies',
      evidence: 'proof',
      eventKey: 'evt',
      asOfMs: Number.NaN
    });
    expect(malformed).toBeNull();

    const normalized = normalizeRelationCatalogEntry({
      marketA: ' a ',
      marketB: ' b ',
      relationType: 'implies',
      confidence: '0.62',
      evidence: ' proof ',
      eventKey: ' evt ',
      asOfMs: 1234.9
    });
    expect(normalized).toMatchObject({
      marketA: 'a',
      marketB: 'b',
      relationType: 'implies',
      confidence: 0.62,
      evidence: 'proof',
      eventKey: 'evt',
      asOfMs: 1234
    });
  });
});
