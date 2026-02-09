import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';

function createRealtime(): PolymarketRealtime {
  return new PolymarketRealtime({
    url: 'wss://example.invalid/ws/market',
    heartbeatIntervalMs: 10000,
    reconnectBaseDelayMs: 250,
    reconnectMaxDelayMs: 30000,
    reconnectJitterPct: 0.2
  });
}

describe('PolymarketRealtime', () => {
  it('removes unsubscribed ids and restarts socket when open', () => {
    const realtime = createRealtime();
    const wsMock = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn()
    };

    (realtime as unknown as { ws: unknown }).ws = wsMock;
    realtime.subscribeMarkets(['token-a', 'token-b']);
    realtime.unsubscribeMarkets(['token-a']);

    expect(realtime.getSubscribedAssetIds()).toEqual(['token-b']);
    expect(wsMock.close).toHaveBeenCalledTimes(1);
    expect(wsMock.terminate).not.toHaveBeenCalled();
  });

  it('does nothing when socket is absent', () => {
    const realtime = createRealtime();

    realtime.subscribeMarkets(['token-a']);
    realtime.unsubscribeMarkets(['token-a']);

    expect(realtime.getSubscribedAssetIds()).toEqual([]);
  });

  it('does not call close while socket is already closing/closed', () => {
    const realtime = createRealtime();
    const wsClosingMock = {
      readyState: WebSocket.CLOSING,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn()
    };

    (realtime as unknown as { ws: unknown }).ws = wsClosingMock;
    realtime.subscribeMarkets(['token-a']);
    realtime.unsubscribeMarkets(['token-a']);
    expect(wsClosingMock.close).not.toHaveBeenCalled();

    const wsClosedMock = {
      readyState: WebSocket.CLOSED,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn()
    };
    (realtime as unknown as { ws: unknown }).ws = wsClosedMock;
    realtime.subscribeMarkets(['token-b']);
    realtime.unsubscribeMarkets(['token-b']);
    expect(wsClosedMock.close).not.toHaveBeenCalled();
  });

  it('falls back to terminate when close throws', () => {
    const realtime = createRealtime();
    const wsMock = {
      readyState: WebSocket.OPEN,
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
      terminate: vi.fn(),
      send: vi.fn()
    };

    (realtime as unknown as { ws: unknown }).ws = wsMock;
    realtime.subscribeMarkets(['token-a']);
    realtime.unsubscribeMarkets(['token-a']);

    expect(wsMock.close).toHaveBeenCalledTimes(1);
    expect(wsMock.terminate).toHaveBeenCalledTimes(1);
  });
});
