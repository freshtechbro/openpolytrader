import { describe, expect, it } from 'vitest';

import {
  clampDependencyConfidence,
  dependencyEdgeKey,
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
});

