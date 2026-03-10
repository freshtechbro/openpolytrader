import { describe, expect, it, vi } from 'vitest';

import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';
import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { RiskAgent } from '../../src/agents/risk/RiskAgent.js';
import { ScannerAgent } from '../../src/agents/scanner/ScannerAgent.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import type { SupervisorDeps } from '../../src/core/Supervisor.js';
import {
  buildRuntimeSupervisorAssembly,
  buildSupervisorRuntimeConfig
} from '../../src/core/supervisorAssembly.js';
import { IncidentTracker } from '../../src/services/IncidentTracker.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

describe('supervisor assembly helpers', () => {
  it('derives the runtime-facing Supervisor config from boot state', () => {
    expect(
      buildSupervisorRuntimeConfig({
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
        policy: { ...DEFAULT_TRADE_POLICY },
        riskConfig: { ...DEFAULT_RISK_CONFIG },
        capital: 2500,
        tradingEnabled: true,
        tradingMode: 'paper',
        maxConcurrentMarkets: 7,
        maxCapitalInFlight: 500,
        bookRefresh: {
          intervalMs: 1500,
          maxStalenessMs: 9000
        },
        reconciliation: {
          intervalMs: 3000,
          afterIncidentDelayMs: 4000,
          positionSizeTolerance: 0.25,
          positionsUser: '0xabc',
          positionsSizeThreshold: 2,
          positionsLimit: 50,
          positionsOffset: 1
        }
      })
    ).toEqual({
      marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
      policy: { ...DEFAULT_TRADE_POLICY },
      riskConfig: { ...DEFAULT_RISK_CONFIG },
      capital: 2500,
      tradingEnabled: true,
      tradingMode: 'paper',
      maxConcurrentMarkets: 7,
      maxCapitalInFlight: 500,
      bookRefresh: {
        intervalMs: 1500,
        maxStalenessMs: 9000
      },
      reconciliation: {
        intervalMs: 3000,
        afterIncidentDelayMs: 4000,
        positionSizeTolerance: 0.25,
        positionsUser: '0xabc',
        positionsSizeThreshold: 2,
        positionsLimit: 50,
        positionsOffset: 1
      }
    });
  });

  it('builds runtime actors and shares the market circuit-breaker registry', () => {
    const metrics = new MetricsStore(100);
    const allowlist = new MarketAllowlist({ autoResume: false });
    const incidentTracker = new IncidentTracker(allowlist, metrics, {
      cooldownMs: 1000,
      maxIncidents: 10
    });
    const portfolio = new PortfolioAgent(1000);
    const clob = {} as unknown as PolymarketClob;
    const realtime = {
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      subscribeMarkets: vi.fn()
    } as unknown as PolymarketRealtime;

    const config = buildSupervisorRuntimeConfig({
      marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }],
      policy: { ...DEFAULT_TRADE_POLICY },
      riskConfig: { ...DEFAULT_RISK_CONFIG },
      capital: 1000,
      tradingEnabled: true,
      tradingMode: 'paper',
      maxConcurrentMarkets: 0,
      maxCapitalInFlight: 0,
      bookRefresh: {
        intervalMs: 1000,
        maxStalenessMs: 5000
      },
      reconciliation: {
        intervalMs: 0,
        afterIncidentDelayMs: 0,
        positionSizeTolerance: 0,
        positionsUser: '0xabc',
        positionsSizeThreshold: 0,
        positionsLimit: 100,
        positionsOffset: 0
      }
    });
    const deps: SupervisorDeps = {
      messageBus: createMessageBus(),
      clob,
      realtime,
      allowlist,
      metrics,
      incidentTracker,
      portfolio
    };

    const assembly = buildRuntimeSupervisorAssembly(config, deps);

    expect(assembly.marketData).toBeInstanceOf(MarketDataAgent);
    expect(assembly.scanner).toBeInstanceOf(ScannerAgent);
    expect(assembly.risk).toBeInstanceOf(RiskAgent);
    expect(assembly.execution).toBeInstanceOf(ExecutionAgent);
    expect(
      (assembly.execution as unknown as { circuitBreakers?: unknown }).circuitBreakers
    ).toBe(assembly.marketCircuitBreakers);
  });
});
