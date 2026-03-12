import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  buildDependencyRelationCatalogEntries,
  loadDependencyRelationCatalog
} from '../../src/agents/dependency/DependencyRelationCatalog.js';
import { DependencyResolver } from '../../src/agents/dependency/DependencyResolver.js';
import type { DependencyMarketInput } from '../../src/domain/dependency.js';

describe('DependencyRelationCatalog loader', () => {
  it('loads valid entries and counts malformed rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-rel-catalog-'));
    const filePath = join(dir, 'relations.json');
    try {
      writeFileSync(
        filePath,
        JSON.stringify([
          {
            marketA: 'm-1',
            marketB: 'm-2',
            relationType: 'mutual_exclusive',
            confidence: 0.9,
            evidence: 'seed',
            eventKey: 'm-1|m-2:mutual_exclusive',
            asOfMs: 1000
          },
          {
            marketA: 'm-2',
            marketB: 'm-3',
            relationType: 'complementary',
            confidence: 0.7,
            evidence: 'seed',
            eventKey: 'm-2|m-3:complementary',
            asOfMs: 1000
          },
          {
            marketA: 'm-3',
            marketB: 'm-3',
            relationType: 'not_valid',
            confidence: 0.5,
            evidence: 'bad',
            eventKey: 'bad',
            asOfMs: 1000
          }
        ]),
        'utf8'
      );

      const snapshot = loadDependencyRelationCatalog(filePath, 2000);
      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.malformedEntries).toBe(1);
      expect(snapshot.loadedAtMs).toBe(2000);
      expect(snapshot.loadError).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes parse failures from missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-rel-catalog-'));
    const filePath = join(dir, 'relations.json');
    try {
      writeFileSync(filePath, '{broken json', 'utf8');

      const parsed = loadDependencyRelationCatalog(filePath, 2000);
      const missing = loadDependencyRelationCatalog(join(dir, 'missing.json'), 3000);

      expect(parsed.loadError).toBe('parse_error');
      expect(parsed.loadedAtMs).toBe(2000);
      expect(missing.loadError).toBe('missing_file');
      expect(missing.loadedAtMs).toBe(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DependencyResolver catalog merge', () => {
  it('merges deterministic and catalog edges with confidence filtering', async () => {
    const markets: DependencyMarketInput[] = [
      {
        marketId: 'm-1',
        question: 'Will rain tomorrow?',
        category: 'weather',
        tags: ['rain', 'weather']
      },
      {
        marketId: 'm-2',
        question: 'Will not rain tomorrow?',
        category: 'weather',
        tags: ['rain', 'weather']
      },
      {
        marketId: 'm-3',
        question: 'Will humidity exceed 80%?',
        category: 'weather',
        tags: ['humidity', 'weather']
      }
    ];

    const resolver = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      relationCatalogEnabled: true,
      relationCatalogEntries: [
        {
          marketA: 'm-1',
          marketB: 'm-3',
          relationType: 'implies',
          confidence: 0.92,
          evidence: 'catalog:semantic',
          eventKey: 'm-1>m-3:implies',
          asOfMs: 1000
        },
        {
          marketA: 'm-2',
          marketB: 'm-3',
          relationType: 'complementary',
          confidence: 0.4,
          evidence: 'catalog:low-confidence',
          eventKey: 'm-2|m-3:complementary',
          asOfMs: 1000
        }
      ],
      relationCatalogMinConfidence: 0.6,
      relationCatalogMaxEdgesPerMarket: 10
    });

    const result = await resolver.resolve(markets, 3000);

    expect(result.summary.catalogEdges).toBe(1);
    expect(result.edges.some((edge) => edge.source === 'deterministic')).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.marketA === 'm-1' &&
          edge.marketB === 'm-3' &&
          edge.relationType === 'implies' &&
          edge.source === 'catalog'
      )
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.marketA === 'm-2' && edge.marketB === 'm-3' && edge.confidence < 0.6
      )
    ).toBe(false);
  });

  it('keeps deterministic extraction for markets absent from relation catalog', async () => {
    const resolver = new DependencyResolver({
      mode: 'deterministic',
      hybridMerge: 'consensus',
      minConfidence: 0,
      maxEdgesPerMarket: 10,
      relationCatalogEnabled: true,
      relationCatalogEntries: [
        {
          marketA: 'other-1',
          marketB: 'other-2',
          relationType: 'complementary',
          confidence: 0.9,
          evidence: 'catalog:other',
          eventKey: 'other-1|other-2:complementary',
          asOfMs: 1000
        }
      ]
    });

    const result = await resolver.resolve(
      [
        {
          marketId: 'm-a',
          question: 'Will Team A win?',
          category: 'sports',
          tags: ['sports', 'team-a']
        },
        {
          marketId: 'm-b',
          question: 'Will not Team A win?',
          category: 'sports',
          tags: ['sports', 'team-a']
        }
      ],
      4000
    );

    expect(result.summary.catalogEdges).toBe(0);
    expect(result.edges.some((edge) => edge.relationType === 'mutual_exclusive')).toBe(true);
  });
});

describe('DependencyRelationCatalog builder', () => {
  it('builds deterministic relations from runtime markets without file I/O', () => {
    const result = buildDependencyRelationCatalogEntries(
      [
        {
          marketId: 'm-1',
          question: 'Will team alpha win?',
          category: 'sports',
          tags: ['sports', 'alpha', 'league-a']
        },
        {
          marketId: 'm-2',
          question: 'Will team alpha win finals?',
          category: 'sports',
          tags: ['sports', 'alpha', 'league-a']
        },
        {
          marketId: 'm-3',
          question: 'Will inflation exceed 4%?',
          category: 'macro',
          tags: ['macro', 'inflation']
        }
      ],
      { nowMs: 1234, semanticEnabled: false }
    );

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.deterministicRelations).toBeGreaterThan(0);
    expect(result.semanticRelations).toBe(0);
    expect(result.entries.every((entry) => entry.asOfMs === 1234)).toBe(true);
  });

  it('adds semantic relation entries when semantic mode is enabled', () => {
    const result = buildDependencyRelationCatalogEntries(
      [
        {
          marketId: 'm-1',
          question: 'Will team alpha win the title?',
          category: 'sports',
          tags: ['sports']
        },
        {
          marketId: 'm-2',
          question: 'Will team alpha win the championship?',
          category: 'sports',
          tags: ['sports']
        }
      ],
      { nowMs: 4321, semanticEnabled: true }
    );

    expect(result.semanticRelations).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.evidence.includes('semantic_question_overlap'))).toBe(true);
  });
});
