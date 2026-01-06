import { afterEach, describe, expect, it, vi } from 'vitest';

import { Supervisor } from '../../src/core/Supervisor.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { IncidentTracker } from '../../src/services/IncidentTracker.js';
import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketDataApi } from '../../src/services/PolymarketDataApi.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Supervisor reconciliation', () => {
  it('runs reconciliation on startup', async () => {
    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const reconcileSpy = vi.spyOn(portfolio, 'reconcileWithVenue');

    const clob = {
      getActiveOrders: vi.fn().mockResolvedValue([
        { orderId: 'orphan-1', marketId: 'market-1', tokenId: 'yes-1', status: 'LIVE' }
      ]),
      cancelOrder: vi.fn().mockResolvedValue({})
    } as unknown as PolymarketClob;
    const dataApi = {
      getPositions: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketDataApi;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off',
        reconciliation: {
          intervalMs: 0,
          afterIncidentDelayMs: 0,
          positionSizeTolerance: 0,
          positionsUser: '0xabc',
          positionsSizeThreshold: 0,
          positionsLimit: 100,
          positionsOffset: 0
        }
      },
      {
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      }
    );

    await supervisor.start();

    expect(clob.getActiveOrders).toHaveBeenCalledTimes(1);
    expect(clob.cancelOrder).toHaveBeenCalledTimes(1);
    expect(dataApi.getPositions).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it('runs reconciliation after incidents', async () => {
    vi.useFakeTimers();

    const metrics = new MetricsStore(1000);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000, incidentTracker);
    const reconcileSpy = vi.spyOn(portfolio, 'reconcileWithVenue');

    const clob = {
      getActiveOrders: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketClob;
    const dataApi = {
      getPositions: vi.fn().mockResolvedValue([])
    } as unknown as PolymarketDataApi;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 1000,
        tradingEnabled: false,
        tradingMode: 'off',
        reconciliation: {
          intervalMs: 0,
          afterIncidentDelayMs: 0,
          positionSizeTolerance: 0,
          positionsUser: '0xabc',
          positionsSizeThreshold: 0,
          positionsLimit: 100,
          positionsOffset: 0
        }
      },
      {
        clob,
        dataApi,
        realtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio
      }
    );

    await supervisor.start();
    reconcileSpy.mockClear();

    metrics.record({ type: 'incident', timestamp: Date.now(), data: { marketId: 'market-1', reason: 'order_failed' } });

    await vi.runAllTimersAsync();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });
});
