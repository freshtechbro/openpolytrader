import { describe, expect, it } from 'vitest';

import {
  enrichPairWithMetadata,
  hasRelationMetadata,
  hasTag,
  marketToPair,
  mergePairs,
  normalizeTagList
} from '../../src/tools/marketCatalogGeneratorPairs.js';

describe('marketCatalogGeneratorPairs', () => {
  it('normalizes tags, filters by tag, and enriches pairs with metadata', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      question: '  Will it happen? ',
      tags: ['Politics', { label: 'US Election' }, 'Politics', { name: 'All' }],
      tokens: [
        { token_id: 'yes-1', outcome: 'Yes' },
        { token_id: 'no-1', outcome: 'No' }
      ]
    };

    expect(normalizeTagList(market.tags)).toEqual(['Politics', 'US Election', 'All']);
    expect(hasTag(market, 'election')).toBe(true);
    expect(hasTag(market, 'sports')).toBe(false);

    const pair = marketToPair(market, { mode: 'near-zero', yesnoOnly: true });
    expect(pair).toEqual({
      marketId: '0xabc',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1',
      category: 'Politics'
    });

    expect(enrichPairWithMetadata(pair!, market)).toEqual({
      marketId: '0xabc',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1',
      category: 'Politics',
      question: 'Will it happen?',
      tags: ['Politics', 'US Election']
    });
    expect(hasRelationMetadata(enrichPairWithMetadata(pair!, market))).toBe(true);
  });

  it('merges incoming metadata without dropping existing pairs', () => {
    expect(
      mergePairs(
        [{ marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }],
        [
          {
            marketId: 'm1',
            yesTokenId: 'other-yes',
            noTokenId: 'other-no',
            question: 'Question 1',
            category: 'Politics',
            tags: ['tag-1']
          },
          {
            marketId: 'm2',
            yesTokenId: 'y2',
            noTokenId: 'n2',
            question: 'Question 2'
          }
        ]
      )
    ).toEqual([
      {
        marketId: 'm1',
        yesTokenId: 'y1',
        noTokenId: 'n1',
        question: 'Question 1',
        category: 'Politics',
        tags: ['tag-1']
      },
      {
        marketId: 'm2',
        yesTokenId: 'y2',
        noTokenId: 'n2',
        question: 'Question 2'
      }
    ]);
  });
});
