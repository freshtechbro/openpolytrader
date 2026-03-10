import { afterEach, describe, expect, it, vi } from 'vitest';

import * as serverRouteContextModule from '../../src/api/serverRouteContext.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { getRpcConfig } from '../../src/config/rpcConfig.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import {
  detectMarketDataOutlier
} from '../../src/agents/market-data/MarketDataOutlierDetector.js';
import { scoreScannerOpportunity } from '../../src/agents/scanner/ScannerOpportunityScorer.js';
import {
  fetchMarketPage,
  resolveDefaultGammaApiBaseUrl
} from '../../src/services/MarketCatalogGammaPage.js';
import {
  coerceNumber,
  extractConditionId,
  extractTokenIds,
  isMarketEnded
} from '../../src/services/MarketCatalogMarketShape.js';
import {
  enrichExistingPair,
  normalizeOptionalString,
  normalizeTags,
  pickCategoryFromTags
} from '../../src/services/MarketCatalogMetadata.js';
import {
  hasAskLevels,
  spreadWithinLimitOrUnavailable
} from '../../src/services/MarketCatalogOrderBook.js';
import { getEmptyRefreshBackoffMs } from '../../src/services/MarketCatalogRefresherSupport.js';
import { normalizeSearchEntries } from '../../src/services/websearch/WebSearchProviderResults.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import {
  parseGeneratorArgs,
  printGeneratorHelp
} from '../../src/tools/marketCatalogGeneratorArgs.js';

const originalFetch = globalThis.fetch;

function buildScannerOpportunity(): ArbitrageOpportunity {
  return {
    id: 'opp-1',
    marketId: 'market-1',
    yesTokenId: 'yes-1',
    noTokenId: 'no-1',
    yesPrice: 0.41,
    noPrice: 0.53,
    costPerSet: 0.94,
    edge: 0.06,
    tickSize: 0.01,
    maxSizeByDepth: 100,
    minOrderSize: 5,
    detectedAt: 1_700_000_000_000,
    gateReasons: [],
    pair: {
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1'
    }
  };
}

function buildOrderBook(): OrderBookState {
  return {
    tokenId: 'token-1',
    bids: [{ price: 0.42, size: 10 }],
    asks: [{ price: 0.75, size: 12 }],
    tickSize: 0.01,
    minOrderSize: 1,
    lastUpdateMs: 1_700_000_000_000,
    stableSinceMs: 1_700_000_000_000,
    bestBid: { price: 0.42, size: 10 },
    bestAsk: { price: 0.75, size: 12 },
    exchangeTimestamp: '1700000000'
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('coverage helper direct imports', () => {
  it('loads the split route context module directly', () => {
    expect(serverRouteContextModule).toBeDefined();
    expect(Object.keys(serverRouteContextModule)).toEqual([]);
  });

  it('covers split market catalog helpers directly', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '[{"condition_id":"market-a"}]'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{"data":[{"condition_id":"market-b"}],"next_cursor":"cursor-2"}'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{"unexpected":true}',
        status: 200
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'slow down'
      });

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 10, offset: 0, cursor: null, order: 'volume24hr' }
      })
    ).resolves.toEqual({
      markets: [{ condition_id: 'market-a' }],
      nextCursor: null
    });

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 5, offset: 0, cursor: 'cursor-1', order: 'newest' }
      })
    ).resolves.toEqual({
      markets: [{ condition_id: 'market-b' }],
      nextCursor: 'cursor-2'
    });

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 2, offset: 0, cursor: null, order: 'volume24hr' }
      })
    ).rejects.toThrow('Gamma API invalid payload (200) for GET /markets');

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 1, offset: 0, cursor: null, order: 'volume24hr' }
      })
    ).rejects.toThrow('Gamma API fetch failed (429): slow down');

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{not-json'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200
      });

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 3, offset: 0, cursor: null, order: 'volume24hr' }
      })
    ).rejects.toThrow('Gamma API invalid JSON for GET /markets: {not-json');

    await expect(
      fetchMarketPage({
        gammaApiBaseUrl: 'https://gamma.example.test',
        requestTimeoutMs: 1_000,
        params: { limit: 4, offset: 0, cursor: null, order: 'volume24hr' }
      })
    ).rejects.toThrow('Gamma API invalid JSON for GET /markets:');

    expect(resolveDefaultGammaApiBaseUrl()).toBe('https://gamma-api.polymarket.com');
    expect(getEmptyRefreshBackoffMs(1_000)).toBe(60_000);
    expect(getEmptyRefreshBackoffMs(900_000)).toBe(600_000);

    expect(extractConditionId({ conditionId: 'market-1' })).toBe('market-1');
    expect(extractConditionId({ condition_id: '' })).toBeNull();
    expect(coerceNumber('4.2')).toBe(4.2);
    expect(coerceNumber('nope')).toBe(0);
    expect(isMarketEnded({ end_date: '2024-01-01T00:00:00Z' }, Date.parse('2024-01-02T00:00:00Z'))).toBe(
      true
    );
    expect(isMarketEnded({ endDate: 1_700_000_000 }, 1_699_999_999_000)).toBe(false);

    expect(extractTokenIds({ clobTokenIds: '["yes-a","no-a"]' })).toEqual({
      yesTokenId: 'yes-a',
      noTokenId: 'no-a'
    });
    expect(
      extractTokenIds({
        tokens: [
          { token_id: 'no-b', outcome: 'No' },
          { token_id: 'yes-b', outcome: 'Yes' }
        ]
      })
    ).toEqual({
      yesTokenId: 'yes-b',
      noTokenId: 'no-b'
    });
    expect(
      extractTokenIds({
        tokens: [
          { token_id: 'z-token', outcome: 'Maybe' },
          { token_id: 'a-token', outcome: 'Later' }
        ]
      })
    ).toEqual({
      yesTokenId: 'a-token',
      noTokenId: 'z-token'
    });

    expect(
      enrichExistingPair(
        {
          marketId: 'market-1',
          yesTokenId: 'yes-1',
          noTokenId: 'no-1',
          question: 'Existing question',
          tags: ['all', 'sports']
        },
        {
          question: ' Updated question ',
          category: '  ',
          tags: ['all', 'politics', 'politics']
        }
      )
    ).toEqual({
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1',
      question: 'Updated question',
      category: 'politics',
      tags: ['all', 'politics']
    });
    expect(normalizeOptionalString('  hello  ')).toBe('hello');
    expect(normalizeOptionalString('   ')).toBeUndefined();
    expect(normalizeTags([' politics ', 'sports', 'sports', 1])).toEqual(['politics', 'sports']);
    expect(normalizeTags('politics')).toBeUndefined();
    expect(normalizeTags([1, '   '])).toBeUndefined();
    expect(pickCategoryFromTags(['all', 'science'])).toBe('science');
    expect(pickCategoryFromTags(['all'])).toBeUndefined();

    expect(hasAskLevels({ asks: [{ price: '0.5', size: '10' }] })).toBe(true);
    expect(hasAskLevels({ asks: [] })).toBe(false);
    expect(
      spreadWithinLimitOrUnavailable(
        {
          bids: [{ price: '0.45' }],
          asks: [{ price: '0.47' }]
        },
        0.03
      )
    ).toBe(true);
    expect(
      spreadWithinLimitOrUnavailable(
        {
          bids: [{ price: '0.45' }],
          asks: [{ price: '0.51' }]
        },
        0.03
      )
    ).toBe(false);

    expect(
      normalizeSearchEntries(
        [
          { url: 'https://example.com/a', summary: 'alpha' },
          { url: '', summary: 'skip' }
        ],
        { snippet: ['summary'] },
        (url) => new URL(url).hostname
      )
    ).toEqual([
      { url: 'https://example.com/a', source: 'example.com', snippet: 'alpha' }
    ]);
  });

  it('covers rpc config phase selection directly', () => {
    const env = loadEnv({
      QUICKNODE_RPC_URL: ' https://quicknode.example ',
      ALCHEMY_RPC_URL: 'https://alchemy.example/base',
      ALCHEMY_WS_URL: 'wss://alchemy.example/ws',
      CHAINSTACK_RPC_URL: 'https://chainstack.example/base',
      CHAINSTACK_WS_URL: 'wss://chainstack.example/ws',
      ANKR_RPC_URL: 'https://ankr.example/base',
      PRIVATE_RPC_URL: 'https://private.example/base',
      PRIVATE_WS_URL: 'wss://private.example/ws'
    });

    const phase1 = getRpcConfig(env, 1_000);
    const phase2 = getRpcConfig(env, 2_000);
    const phase3 = getRpcConfig(env, 5_000);

    expect(phase1).toMatchObject({
      phase: 1,
      primary: {
        name: 'Alchemy',
        url: 'https://alchemy.example/base',
        wsUrl: 'wss://alchemy.example/ws'
      },
      websocket: { url: 'wss://alchemy.example/ws' }
    });
    expect(phase1.fallbacks.map((provider) => provider.name)).toEqual(['QuickNode', 'Ankr']);

    expect(phase2).toMatchObject({
      phase: 2,
      primary: { name: 'Chainstack Pro', url: 'https://chainstack.example/base' },
      websocket: { url: 'wss://chainstack.example/ws' }
    });
    expect(phase2.fallbacks.map((provider) => provider.name)).toEqual(['Alchemy Growth', 'Ankr']);

    expect(phase3).toMatchObject({
      phase: 3,
      primary: { name: 'Private Node', url: 'https://private.example/base' },
      websocket: { url: 'wss://private.example/ws' }
    });
    expect(phase3.fallbacks.map((provider) => provider.name)).toEqual(['Chainstack Pro']);

    const blankFallbackEnv = loadEnv({
      QUICKNODE_RPC_URL: '   '
    });
    expect(getRpcConfig(blankFallbackEnv, 1_000).fallbacks.map((provider) => provider.name)).toEqual([
      'Ankr'
    ]);
  });

  it('covers generator args helpers directly', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(
      parseGeneratorArgs([
        'node',
        'script',
        '--out',
        'catalog.json',
        '--max',
        '7',
        '--tag',
        'election',
        '--yesno-only',
        '--mode',
        'binary',
        '--merge',
        '--verify-books',
        '--require-metadata',
        '--help'
      ])
    ).toEqual({
      outPath: 'catalog.json',
      maxPairs: 7,
      tag: 'election',
      yesnoOnly: true,
      mode: 'binary',
      merge: true,
      verifyBooks: true,
      requireMetadata: true,
      help: true
    });

    printGeneratorHelp();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('market-catalog-generator'));
  });

  it('detects market data outliers directly', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_MARKETDATA_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.MarketDataAgent.timeoutMs
    });
    llmClient.enqueue('MarketDataAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.MarketDataAgent.model,
      outputText: JSON.stringify({ outlier: true, reason: 'wide spread', confidence: 0.95 })
    });

    const messageBus = createMessageBus();
    const outlierEvents: unknown[] = [];
    messageBus.on('marketdata:outlier', (event) => outlierEvents.push(event));

    await detectMarketDataOutlier({
      tokenId: 'token-1',
      book: buildOrderBook(),
      nowMs: 1_700_000_000_500,
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy', riskConfigHash: 'risk' }
      },
      messageBus
    });

    expect(outlierEvents).toEqual([
      expect.objectContaining({
        tokenId: 'token-1',
        outlier: { outlier: true, reason: 'wide spread', confidence: 0.95 }
      })
    ]);
  });

  it('scores scanner opportunities directly', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.ScannerAgent.timeoutMs
    });
    llmClient.enqueue('ScannerAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.ScannerAgent.model,
      outputText: JSON.stringify({
        priority_score: 0.82,
        rationale: 'good edge',
        confidence: 0.9
      })
    });

    const score = await scoreScannerOpportunity({
      opportunity: buildScannerOpportunity(),
      insight: null,
      nowMs: 1_700_000_000_500,
      mode: llmConfig.agents.ScannerAgent.mode,
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy', riskConfigHash: 'risk' }
      },
      messageBus: createMessageBus()
    });

    expect(score).toBe(0.82);
  });
});
