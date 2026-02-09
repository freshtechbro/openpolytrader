import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';

describe('MarketDataAgent subscriptions', () => {
  it('applies unsubscribe before subscribe during pair rotation', () => {
    const subscribeMarkets = vi.fn();
    const unsubscribeMarkets = vi.fn();

    const realtime = {
      subscribeMarkets,
      unsubscribeMarkets
    } as unknown as PolymarketRealtime;

    const clob = {
      getOrderBook: vi.fn()
    } as unknown as PolymarketClob;

    const agent = new MarketDataAgent(
      {
        tokenIds: ['yes-old', 'no-old'],
        policy: DEFAULT_TRADE_POLICY
      },
      clob,
      realtime
    );

    agent.updateSubscriptions(['yes-new', 'no-new']);

    expect(unsubscribeMarkets).toHaveBeenCalledWith(['yes-old', 'no-old']);
    expect(subscribeMarkets).toHaveBeenCalledWith(['yes-new', 'no-new']);
    expect(unsubscribeMarkets.mock.invocationCallOrder[0]).toBeLessThan(
      subscribeMarkets.mock.invocationCallOrder[0]
    );
  });
});
