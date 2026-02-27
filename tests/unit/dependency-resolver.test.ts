import { describe, expect, it } from 'vitest';

import { DependencyResolver } from '../../src/agents/dependency/DependencyResolver.js';
import type { DependencyEdge, DependencyMarketInput } from '../../src/domain/dependency.js';

const MARKET_SET: DependencyMarketInput[] = [
  {
    marketId: 'm-1',
    question: 'Will Candidate A win election 2026?',
    category: 'politics',
    tags: ['election', 'candidate-a', 'usa']
  },
  {
    marketId: 'm-2',
    question: 'Will not Candidate A win election 2026?',
    category: 'politics',
    tags: ['election', 'candidate-a', 'usa']
  },
  {
    marketId: 'm-3',
    question: 'Who wins election 2026 in state X?',
    category: 'politics',
    tags: ['election', 'state-x', 'usa']
  }
];

describe('DependencyResolver', () => {
  it('supports runtime config updates', async () => {
    const resolver = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    });
    resolver.updateConfig({
      mode: 'llm',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => []
    });

    const result = await resolver.resolve(MARKET_SET, 10);
    expect(result.summary.mode).toBe('llm');
    expect(result.edges).toEqual([]);
  });

  it('extracts deterministic edges from opposite markers and shared category/tags', async () => {
    const resolver = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    });

    const result = await resolver.resolve(MARKET_SET, 1_000);
    expect(result.summary.mode).toBe('deterministic');
    expect(result.summary.deterministicEdges).toBeGreaterThan(0);
    expect(result.edges.some((edge) => edge.relationType === 'mutual_exclusive')).toBe(true);
    expect(result.edges.every((edge) => edge.source === 'deterministic')).toBe(true);
    expect(result.edges.every((edge) => edge.extractedAtMs === 1_000)).toBe(true);
  });

  it('extracts deterministic partition edges from partition-style prompts', async () => {
    const resolver = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    });

    const result = await resolver.resolve(
      [
        { marketId: 'p-1', question: 'Which party wins district 7?', category: 'election' },
        { marketId: 'p-2', question: 'What party wins district 7?', category: 'election' }
      ],
      2_000
    );

    expect(result.edges.some((edge) => edge.relationType === 'partition')).toBe(true);
  });

  it('sanitizes llm extractor output', async () => {
    const llmEdges: DependencyEdge[] = [
      {
        marketA: 'm-1',
        marketB: 'm-3',
        relationType: 'implies',
        confidence: 0.8,
        source: 'llm',
        evidence: 'llm',
        extractedAtMs: 0
      },
      {
        marketA: 'm-1',
        marketB: 'missing',
        relationType: 'complementary',
        confidence: 0.9,
        source: 'llm',
        evidence: 'invalid_market',
        extractedAtMs: 0
      },
      {
        marketA: 'm-2',
        marketB: 'm-2',
        relationType: 'mutual_exclusive',
        confidence: 0.9,
        source: 'llm',
        evidence: 'self_edge',
        extractedAtMs: 0
      }
    ];

    const resolver = new DependencyResolver({
      mode: 'llm',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => llmEdges
    });

    const result = await resolver.resolve(MARKET_SET, 5_000);
    expect(result.summary.llmEdges).toBe(1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].relationType).toBe('implies');
    expect(result.edges[0].source).toBe('llm');
    expect(result.edges[0].extractedAtMs).toBe(5_000);
  });

  it('returns empty llm edges when llm extractor is not configured', async () => {
    const resolver = new DependencyResolver({
      mode: 'llm',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    });

    const result = await resolver.resolve(MARKET_SET, 5_100);
    expect(result.edges).toEqual([]);
  });

  it('merges hybrid consensus using intersection only', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => [
        {
          marketA: 'm-1',
          marketB: 'm-2',
          relationType: 'mutual_exclusive',
          confidence: 0.6,
          source: 'llm',
          evidence: 'llm_overlap',
          extractedAtMs: 0
        },
        {
          marketA: 'm-1',
          marketB: 'm-3',
          relationType: 'complementary',
          confidence: 0.9,
          source: 'llm',
          evidence: 'llm_only',
          extractedAtMs: 0
        }
      ]
    });

    const result = await resolver.resolve(MARKET_SET, 2_000);
    expect(result.summary.mode).toBe('hybrid');
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.every((edge) => edge.source === 'hybrid')).toBe(true);
    const overlap = result.edges.find(
      (edge) =>
        edge.marketA === 'm-1' &&
        edge.marketB === 'm-2' &&
        edge.relationType === 'mutual_exclusive'
    );
    expect(overlap).toBeDefined();
    expect(overlap?.confidence).toBeCloseTo(0.75, 6);
  });

  it('falls back to deterministic edges in hybrid consensus when llm output is empty', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => []
    });

    const result = await resolver.resolve(MARKET_SET, 2_500);
    expect(result.summary.mode).toBe('hybrid');
    expect(result.summary.deterministicEdges).toBeGreaterThan(0);
    expect(result.summary.llmEdges).toBe(0);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges.every((edge) => edge.source === 'hybrid')).toBe(true);
  });

  it('falls back to llm edges in hybrid consensus when deterministic output is empty', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => [
        {
          marketA: 'solo-a',
          marketB: 'solo-b',
          relationType: 'complementary',
          confidence: 0.8,
          source: 'llm',
          evidence: 'llm_only',
          extractedAtMs: 0
        }
      ]
    });

    const result = await resolver.resolve(
      [
        { marketId: 'solo-a', question: 'alpha', category: 'x' },
        { marketId: 'solo-b', question: 'beta', category: 'y' }
      ],
      2_600
    );

    expect(result.summary.mode).toBe('hybrid');
    expect(result.summary.deterministicEdges).toBe(0);
    expect(result.summary.llmEdges).toBe(1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe('hybrid');
    expect(result.edges[0].marketA).toBe('solo-a');
    expect(result.edges[0].marketB).toBe('solo-b');
  });

  it('merges hybrid union and enforces confidence/edge caps', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'union',
      minConfidence: 0.7,
      maxEdgesPerMarket: 1,
      llmExtractor: async () => [
        {
          marketA: 'm-1',
          marketB: 'm-2',
          relationType: 'mutual_exclusive',
          confidence: 0.95,
          source: 'llm',
          evidence: 'llm_overlap',
          extractedAtMs: 0
        },
        {
          marketA: 'm-1',
          marketB: 'm-3',
          relationType: 'complementary',
          confidence: 0.4,
          source: 'llm',
          evidence: 'low_confidence',
          extractedAtMs: 0
        }
      ]
    });

    const result = await resolver.resolve(MARKET_SET, 3_000);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe('hybrid');
    expect(result.edges[0].confidence).toBeCloseTo(0.95, 6);
  });

  it('keeps llm-only union edges when deterministic output is empty', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'union',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => [
        {
          marketA: 'solo-a',
          marketB: 'solo-b',
          relationType: 'complementary',
          confidence: 0.8,
          source: 'llm',
          evidence: 'llm_only',
          extractedAtMs: 0
        }
      ]
    });

    const result = await resolver.resolve(
      [
        { marketId: 'solo-a', question: 'alpha', category: 'x' },
        { marketId: 'solo-b', question: 'beta', category: 'y' }
      ],
      6_000
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe('hybrid');
    expect(result.edges[0].marketA).toBe('solo-a');
    expect(result.edges[0].marketB).toBe('solo-b');
  });

  it('returns empty hybrid output when both deterministic and llm edges are empty', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => []
    });

    const result = await resolver.resolve(
      [
        { marketId: 'empty-a', question: 'alpha', category: 'x' },
        { marketId: 'empty-b', question: 'beta', category: 'y' }
      ],
      7_000
    );
    expect(result.edges).toEqual([]);
  });

  it('filters invalid llm relations and handles blank tags in deterministic mode', async () => {
    const resolver = new DependencyResolver({
      mode: 'llm',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () =>
        [
          {
            marketA: 'm-1',
            marketB: 'm-3',
            relationType: 'not_a_relation',
            confidence: 0.8,
            source: 'llm',
            evidence: 'bad',
            extractedAtMs: 0
          }
        ] as unknown as DependencyEdge[]
    });

    const llmResult = await resolver.resolve(MARKET_SET, 8_000);
    expect(llmResult.edges).toEqual([]);

    const deterministic = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10
    });
    const deterministicResult = await deterministic.resolve(
      [
        {
          marketId: 'tag-a',
          question: 'Will Team A win?',
          category: 'sports',
          tags: ['sports', '', 'team-a']
        },
        {
          marketId: 'tag-b',
          question: 'Will Team B win?',
          category: 'sports',
          tags: ['sports', 'team-b', '']
        }
      ],
      8_010
    );
    expect(Array.isArray(deterministicResult.edges)).toBe(true);
  });

  it('keeps existing evidence when union-merged edges have identical evidence', async () => {
    const resolver = new DependencyResolver({
      mode: 'hybrid',
      hybridMerge: 'union',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      llmExtractor: async () => [
        {
          marketA: 'm-1',
          marketB: 'm-2',
          relationType: 'mutual_exclusive',
          confidence: 0.95,
          source: 'llm',
          evidence: 'deterministic:opposite_markers_with_shared_stem',
          extractedAtMs: 0
        }
      ]
    });

    const result = await resolver.resolve(
      [
        { marketId: 'm-1', question: 'Will alpha happen?', category: 'x', tags: ['same', 'x'] },
        { marketId: 'm-2', question: 'Will not alpha happen?', category: 'x', tags: ['same', 'x'] }
      ],
      9_000
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].evidence).toBe('deterministic:opposite_markers_with_shared_stem');
  });
});
