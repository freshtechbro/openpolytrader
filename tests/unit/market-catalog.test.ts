import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';

import { MarketCatalog } from '../../src/services/MarketCatalog.js';

describe('MarketCatalog', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('loads rich metadata fields from file entries', () => {
    const file = `data/market-catalog-${randomUUID()}.json`;
    paths.push(file);

    writeFileSync(
      file,
      JSON.stringify([
        {
          marketId: 'm-rich',
          yesTokenId: 'yes-rich',
          noTokenId: 'no-rich',
          question: 'Will Team A win?',
          category: 'sports',
          tags: ['sports', 'team-a', 'sports', '']
        }
      ])
    );

    const catalog = new MarketCatalog({ filePath: file });
    const pairs = catalog.loadPairs().filter((pair) => pair.marketId === 'm-rich');

    expect(pairs).toEqual([
      {
        marketId: 'm-rich',
        yesTokenId: 'yes-rich',
        noTokenId: 'no-rich',
        question: 'Will Team A win?',
        category: 'sports',
        tags: ['sports', 'team-a']
      }
    ]);
  });

  it('dedupes by marketId and keeps richer metadata from merged entries', () => {
    const file = `data/market-catalog-${randomUUID()}.json`;
    paths.push(file);

    writeFileSync(
      file,
      JSON.stringify([
        {
          marketId: 'm-dupe',
          yesTokenId: 'yes-old',
          noTokenId: 'no-old',
          category: 'election'
        },
        {
          marketId: 'm-dupe',
          yesTokenId: 'yes-new',
          noTokenId: 'no-new',
          question: 'Will Candidate X win?',
          tags: ['election', 'candidate-x']
        }
      ])
    );

    const catalog = new MarketCatalog({ filePath: file });
    const pair = catalog.loadPairs().find((entry) => entry.marketId === 'm-dupe');

    expect(pair).toEqual({
      marketId: 'm-dupe',
      yesTokenId: 'yes-new',
      noTokenId: 'no-new',
      question: 'Will Candidate X win?',
      category: 'election',
      tags: ['election', 'candidate-x']
    });
  });
});
