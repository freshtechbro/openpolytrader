import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScannerAgent } from '../../src/agents/scanner/ScannerAgent.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import { messageBus } from '../../src/core/MessageBus.js';
import type { OrderBookState } from '../../src/domain/orderbook.js';
import type { MarketPair } from '../../src/domain/market.js';

const DEFAULT_ENV = loadEnv({});

const basePolicy = {
  ...DEFAULT_TRADE_POLICY,
  signalMode: 'ev' as const,
  evEdgeRequired: 0,
  evConfidenceMin: 0.4,
  evModelConfidenceFloor: 0.4,
  evModelMode: 'hybrid' as const,
  entrySlippageToleranceBps: 0,
  evCooldownSeconds: 0,
  evFeeBps: 0,
  maxEdge: 1,
  minEdgeTicks: 0
};

const makeBook = (
  tokenId: string,
  askPrice: number,
  bidPrice: number,
  nowMs: number
): OrderBookState => ({
  tokenId,
  bids: [{ price: bidPrice, size: 100 }],
  asks: [{ price: askPrice, size: 100 }],
  tickSize: 0.01,
  minOrderSize: 1,
  lastUpdateMs: nowMs,
  stableSinceMs: nowMs - 1000,
  bestBid: { price: bidPrice, size: 100 },
  bestAsk: { price: askPrice, size: 100 }
});

const emitInsight = (marketId: string, value: number, confidence: number, ttlMs = 60000) => {
  messageBus.emit('learning:insight', {
    insights: [
      {
        market_id: marketId,
        signal: 'web',
        value,
        ttl_ms: ttlMs,
        confidence
      }
    ],
    generatedAtMs: Date.now()
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('EV signal path', () => {
  it('selects EV opportunity with high-confidence signal', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(DEFAULT_ENV.METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.allow('m1');

    const agent = new ScannerAgent(basePolicy, allowlist, { tradingMode: 'paper', metrics });

    const pair: MarketPair = { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' };
    const yesBook = makeBook('y1', 0.4, 0.39, now);
    const noBook = makeBook('n1', 0.6, 0.59, now);
    const orderbooks = new Map<string, OrderBookState>([
      ['y1', yesBook],
      ['n1', noBook]
    ]);

    emitInsight('m1', 0.8, 0.9);

    const opportunity = agent.scanPair(pair, orderbooks, now);
    expect(opportunity?.type).toBe('ev');
    expect(opportunity?.side).toBe('yes');
    expect((opportunity?.evNet ?? 0)).toBeGreaterThan(0);
    expect((opportunity?.pFinal ?? 0)).toBeGreaterThan(0.5);

    agent.stop();
  });

  it('rejects when confidence below evConfidenceMin', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(DEFAULT_ENV.METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.allow('m2');

    const policy = { ...basePolicy, evConfidenceMin: 0.8 };
    const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });

    const pair: MarketPair = { marketId: 'm2', yesTokenId: 'y2', noTokenId: 'n2' };
    const yesBook = makeBook('y2', 0.45, 0.44, now);
    const noBook = makeBook('n2', 0.55, 0.54, now);
    const orderbooks = new Map<string, OrderBookState>([
      ['y2', yesBook],
      ['n2', noBook]
    ]);

    emitInsight('m2', 0.6, 0.2);

    const opportunity = agent.scanPair(pair, orderbooks, now);
    expect(opportunity).toBeNull();

    const event = metrics.recent('ev_signal', 1)[0];
    const reason = (event.data as { reason?: string[] }).reason ?? [];
    expect(reason).toContain('ev_confidence_below_min');

    agent.stop();
  });

  it('applies evFeeBps to evNet', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(DEFAULT_ENV.METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.allow('m4');

    const policy = {
      ...basePolicy,
      evFeeBps: 100,
      evModelMode: 'llm_only' as const,
      evCalibrationMethod: 'isotonic' as const
    };
    const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });

    const pair: MarketPair = { marketId: 'm4', yesTokenId: 'y4', noTokenId: 'n4' };
    const yesBook = makeBook('y4', 0.5, 0.49, now);
    const noBook = makeBook('n4', 0.6, 0.59, now);
    const orderbooks = new Map<string, OrderBookState>([
      ['y4', yesBook],
      ['n4', noBook]
    ]);

    emitInsight('m4', 0.8, 0.9);

    const opportunity = agent.scanPair(pair, orderbooks, now);
    expect(opportunity?.type).toBe('ev');
    expect(opportunity?.side).toBe('yes');
    expect(opportunity?.evRaw).toBeCloseTo(0.3, 5);
    expect(opportunity?.evNet).toBeCloseTo(0.29, 5);

    agent.stop();
  });

  it('enforces evCooldownSeconds between opportunities', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const metrics = new MetricsStore(DEFAULT_ENV.METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.allow('m3');

    const policy = { ...basePolicy, evCooldownSeconds: 60 };
    const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });

    const pair: MarketPair = { marketId: 'm3', yesTokenId: 'y3', noTokenId: 'n3' };
    const yesBook = makeBook('y3', 0.42, 0.41, now);
    const noBook = makeBook('n3', 0.58, 0.57, now);
    const orderbooks = new Map<string, OrderBookState>([
      ['y3', yesBook],
      ['n3', noBook]
    ]);

    emitInsight('m3', 0.7, 0.9);

    const first = agent.scanPair(pair, orderbooks, now);
    expect(first?.type).toBe('ev');

    const later = now + 1000;
    vi.setSystemTime(later);
    const second = agent.scanPair(pair, orderbooks, later);
    expect(second).toBeNull();

    const event = metrics.recent('ev_signal', 1)[0];
    expect((event.data as { reason?: string }).reason).toBe('ev_cooldown');

    agent.stop();
  });
});
