import { describe, expect, it, vi } from 'vitest';

import {
  resolveAlchemyRpcBaseUrl,
  resolveAlchemyWsBaseUrl,
  resolveAnkrRpcBaseUrl,
  resolveChainstackRpcBaseUrl,
  resolveChainstackWsBaseUrl,
  resolvePrivateRpcBaseUrl,
  resolvePrivateWsBaseUrl
} from '../../src/config/rpcUrls.js';
import { recordShutdownMetric, stopWithMetric } from '../../src/core/shutdownSupport.js';
import { normalizeVenuePosition } from '../../src/services/PolymarketPositionNormalization.js';
import {
  coerceNumber,
  coerceString,
  extractBestLevel,
  extractPriceChangeUpdates,
  extractTokenId,
  normalizeSide,
  normalizeWsBook,
  routeMarketDataMessage
} from '../../src/agents/market-data/MarketDataEventParsing.js';
import {
  actualToDetail,
  expectedFillKey,
  expectedToDetail,
  isPriceWithinTolerance,
  resolveExpectedFillCandidates
} from '../../src/agents/portfolio/PortfolioExpectedFill.js';

describe('rpcUrls', () => {
  it('returns overrides when provided and otherwise builds the default provider URLs', () => {
    expect(resolveAlchemyRpcBaseUrl()).toBe('https://polygon-mainnet.g.alchemy.com/v2');
    expect(resolveAlchemyWsBaseUrl()).toBe('wss://polygon-mainnet.g.alchemy.com/v2');
    expect(resolveChainstackRpcBaseUrl()).toBe('https://polygon-mainnet.chainstacklabs.com');
    expect(resolveChainstackWsBaseUrl()).toBe('wss://polygon-mainnet.chainstacklabs.com');
    expect(resolveAnkrRpcBaseUrl()).toBe('https://rpc.ankr.com/polygon');
    expect(resolvePrivateRpcBaseUrl()).toBe('http://localhost:8545');
    expect(resolvePrivateWsBaseUrl()).toBe('ws://localhost:8545');
    expect(resolveAlchemyRpcBaseUrl(' https://override.example/v2 ')).toBe('https://override.example/v2');
  });
});

describe('shutdownSupport', () => {
  it('records shutdown metrics and wraps stop tasks with success/failure status', async () => {
    const record = vi.fn();
    recordShutdownMetric(
      { record },
      'incident',
      'Shutdown failed',
      1_700_000_000_000,
      'boom',
      { phase: 'close_server' }
    );

    expect(record).toHaveBeenCalledWith({
      type: 'incident',
      timestamp: 1_700_000_000_000,
      data: { message: 'Shutdown failed', error: 'boom', phase: 'close_server' }
    });

    await expect(stopWithMetric(async () => undefined, vi.fn())).resolves.toBe(true);

    const onError = vi.fn();
    await expect(
      stopWithMetric(async () => {
        throw new Error('close failed');
      }, onError)
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith('close failed');
  });
});

describe('PolymarketPositionNormalization', () => {
  it('normalizes token, market, and numeric position fields while rejecting tokenless rows', () => {
    expect(
      normalizeVenuePosition({
        asset_id: 'token-1',
        conditionId: 'market-1',
        size: '12.5',
        avgPrice: '0.42',
        curPrice: 0.44
      })
    ).toEqual({
      tokenId: 'token-1',
      marketId: 'market-1',
      size: 12.5,
      avgPrice: 0.42,
      currentPrice: 0.44,
      raw: {
        asset_id: 'token-1',
        conditionId: 'market-1',
        size: '12.5',
        avgPrice: '0.42',
        curPrice: 0.44
      }
    });

    expect(normalizeVenuePosition({ size: '3' })).toBeNull();
  });
});

describe('MarketDataEventParsing', () => {
  it('routes payload kinds, normalizes websocket books, and extracts price-change deltas', () => {
    expect(routeMarketDataMessage({ type: 'agg_orderbook', bids: [], asks: [] })).toEqual({
      kind: 'book',
      payload: { type: 'agg_orderbook', bids: [], asks: [] }
    });
    expect(routeMarketDataMessage({ payload: { event_type: 'best_bid_ask', asset_id: 'token-1' } })).toEqual({
      kind: 'best_bid_ask',
      payload: { event_type: 'best_bid_ask', asset_id: 'token-1' }
    });

    expect(
      normalizeWsBook({
        buys: [{ price: '0.41', size: '6' }],
        sells: [{ price: '0.43', size: '4' }],
        tick_size: '0.01',
        min_order_size: '1',
        timestamp: '1700000000'
      })
    ).toEqual({
      bids: [{ price: '0.41', size: '6' }],
      asks: [{ price: '0.43', size: '4' }],
      tick_size: '0.01',
      min_order_size: '1',
      timestamp: '1700000000',
      hash: undefined
    });

    expect(
      extractPriceChangeUpdates(
        {
          asset_id: 'token-1',
          best_bid: '0.40',
          best_ask: '0.44',
          price_changes: [
            {
              side: 'buy',
              price: '0.41',
              size: '6',
              timestamp: '1700000001',
              tick_size: '0.01'
            }
          ]
        },
        1_700_000_000_123
      )
    ).toEqual([
      {
        tokenId: 'token-1',
        delta: {
          side: 'bid',
          price: 0.41,
          size: 6,
          receivedAtMs: 1_700_000_000_123,
          exchangeTimestamp: '1700000001',
          tickSize: 0.01,
          minOrderSize: undefined
        },
        expectedBest: {
          bestBid: 0.4,
          bestAsk: 0.44
        }
      }
    ]);

    expect(extractTokenId({ marketId: 'token-2' })).toBe('token-2');
    expect(extractBestLevel({ best_bid_price: '0.5', best_bid_size: '7' }, 'bid')).toEqual({
      price: 0.5,
      size: 7
    });
    expect(extractBestLevel({ best_ask: { price: '0.6', size: '8' } }, 'ask')).toEqual({
      price: 0.6,
      size: 8
    });
    expect(normalizeSide('sell')).toBe('ask');
    expect(normalizeSide('hold')).toBeNull();
    expect(coerceNumber('0.75')).toBe(0.75);
    expect(coerceNumber('nan')).toBeNull();
    expect(coerceString(42)).toBe('42');
    expect(coerceString({})).toBeNull();
  });
});

describe('PortfolioExpectedFill', () => {
  it('formats fill details, checks price tolerance, and resolves matching expected fills', () => {
    const expected = {
      opportunityId: 'opp-1',
      tokenId: 'token-1',
      expectedSize: 5,
      expectedPrice: 0.42,
      timestamp: 1_700_000_000_000
    };
    const actual = {
      tokenId: 'token-1',
      marketId: 'market-1',
      opportunityId: 'opp-1',
      side: 'BUY' as const,
      size: 5,
      price: 0.43,
      timestamp: 1_700_000_000_100
    };

    expect(expectedFillKey('opp-1', 'token-1')).toBe('opp-1:token-1');
    expect(expectedToDetail(expected)).toEqual({
      opportunityId: 'opp-1',
      tokenId: 'token-1',
      expectedSize: 5,
      expectedPrice: 0.42,
      timestamp: 1_700_000_000_000
    });
    expect(actualToDetail(actual)).toEqual({
      tokenId: 'token-1',
      marketId: 'market-1',
      opportunityId: 'opp-1',
      side: 'BUY',
      size: 5,
      price: 0.43,
      timestamp: 1_700_000_000_100
    });
    expect(isPriceWithinTolerance(expected, actual, 0.02)).toBe(true);
    expect(
      resolveExpectedFillCandidates(
        new Map([
          ['opp-1:token-1', expected],
          ['opp-2:token-2', { ...expected, opportunityId: 'opp-2', tokenId: 'token-2' }]
        ]),
        actual
      )
    ).toEqual([{ key: 'opp-1:token-1', expected }]);
  });
});
