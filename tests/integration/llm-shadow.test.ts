import { describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { Supervisor } from '../../src/core/Supervisor.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { DEFAULT_RISK_CONFIG } from '../../src/config/risk.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { MetricsStore, type MetricEvent } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';
import type { PolymarketRealtime } from '../../src/services/PolymarketRealtime.js';
import type { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import type { IncidentTracker } from '../../src/services/IncidentTracker.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import { RiskAdvisor } from '../../src/agents/risk/RiskAdvisor.js';
import { ExecutionAdvisor } from '../../src/agents/execution/ExecutionAdvisor.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;

class FakeRealtime extends EventEmitter {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribeMarkets(_tokenIds: string[]): void {}
}

function makeMockClob(responses: { yes: unknown; no: unknown }): PolymarketClob {
  let callCount = 0;
  let nextNonce = 1000;

  return {
    reserveNonce: vi.fn().mockImplementation(() => String(nextNonce++)),
    createOrder: vi.fn().mockImplementation(() => {
      const response = callCount === 0 ? responses.yes : responses.no;
      callCount++;
      return Promise.resolve(response);
    }),
    cancelOrder: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
    cancelOrders: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
    cancelAll: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
    cancelMarketOrders: vi.fn().mockResolvedValue({ canceled: [], not_canceled: {} }),
    getActiveOrders: vi.fn().mockResolvedValue([])
  } as unknown as PolymarketClob;
}

function makePortfolio(): PortfolioAgent {
  return {
    snapshot: vi.fn().mockReturnValue({
      totalCapital: 100,
      availableCapital: 100,
      dailyPnL: 0,
      marketExposure: {},
      openInventoryAgeMs: 0
    }),
    expectFill: vi.fn(),
    applyFillWithReconciliation: vi.fn(),
    applyUnwind: vi.fn(),
    reconcileWithVenue: vi.fn(),
    analyzeAnomalies: vi.fn()
  } as unknown as PortfolioAgent;
}

function makeIncidentTracker(): IncidentTracker {
  return { record: vi.fn() } as unknown as IncidentTracker;
}

describe('LLM shadow mode integration', () => {
  it('keeps deterministic trading behavior unchanged', async () => {
    const realtime = new FakeRealtime();
    const userRealtime = new FakeRealtime();
    const clob = makeMockClob({
      yes: { orderId: 'order-yes', status: 'LIVE' },
      no: { orderId: 'order-no', status: 'LIVE' }
    });

    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist({ autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME });
    const portfolio = makePortfolio();
    const incidentTracker = makeIncidentTracker();
    allowlist.allow('market-1');

    const llmEnv = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'shadow',
      LLM_RISK_MODE: 'shadow',
      LLM_EXECUTION_MODE: 'shadow',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(llmEnv);
    const primaryProvider = llmConfig.primaryProvider;
    const llm = new MockLLMClient({
      defaultProviderId: primaryProvider,
      defaultBaseUrl: llmConfig.providers[primaryProvider].baseUrl,
      defaultTimeoutMs: 500
    });
    const scannerScore = JSON.parse(readFileSync('tests/fixtures/llm/scanner-score.json', 'utf8'));
    const riskSize = JSON.parse(readFileSync('tests/fixtures/llm/risk-recommend-size.json', 'utf8'));
    llm.enqueue('ScannerAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.ScannerAgent.model,
      outputText: JSON.stringify(scannerScore)
    });
    llm.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: JSON.stringify(riskSize)
    });

    const policyHashes = { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' };
    const riskAdvisor = new RiskAdvisor({
      llmConfig,
      llmClient: { call: (agent, request) => llm.call(agent, request) },
      promptVersion: 'test-v1',
      policyHashes,
      metrics
    });
    const executionAdvisor = new ExecutionAdvisor({ enabled: true });

    const policy = {
      ...DEFAULT_TRADE_POLICY,
      topOfBookStabilityMs: 0,
      maxLegSkewMs: 0,
      fillTimeoutMs: 0
    };

    const supervisor = new Supervisor(
      {
        marketPairs: [{ marketId: 'market-1', yesTokenId: 'yes-token', noTokenId: 'no-token' }],
        policy,
        riskConfig: DEFAULT_RISK_CONFIG,
        capital: 100,
        tradingEnabled: true,
        tradingMode: 'live'
      },
      {
        clob,
        realtime: realtime as unknown as PolymarketRealtime,
        userRealtime: userRealtime as unknown as PolymarketRealtime,
        allowlist,
        metrics,
        incidentTracker,
        portfolio,
        llm: {
          config: llmConfig,
          client: { call: (agent, request) => llm.call(agent, request) },
          promptVersion: 'test-v1',
          policyHashes
        },
        executionAdvisor,
        riskAdvisor
      }
    );

    await supervisor.start();

    const opportunityPromise = waitForMetric(metrics, 'opportunity', 2000);
    const riskPromise = waitForMetric(metrics, 'risk', 2000);
    const orderPromise = waitForMetric(metrics, 'order', 10000);

    realtime.emit('message', {
      type: 'book',
      asset_id: 'yes-token',
      bids: [{ price: '0.47', size: '100' }],
      asks: [{ price: '0.48', size: '100' }],
      timestamp: new Date().toISOString()
    });

    realtime.emit('message', {
      type: 'book',
      asset_id: 'no-token',
      bids: [{ price: '0.48', size: '100' }],
      asks: [{ price: '0.49', size: '100' }],
      timestamp: new Date().toISOString()
    });

    await opportunityPromise;
    await riskPromise;
    const orderEvent = await orderPromise;

    expect(clob.createOrder).toHaveBeenCalledTimes(2);
    expect((orderEvent.data as { status?: string }).status).toBe('submitted');
    expect(incidentTracker.record).not.toHaveBeenCalled();

    supervisor.stop();
    executionAdvisor.stop();
    await realtime.disconnect();
    await userRealtime.disconnect();
  }, 15000);
});

function waitForMetric(metrics: MetricsStore, type: MetricEvent['type'], timeoutMs: number): Promise<MetricEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed_out_waiting_for_metric:${type}`)), timeoutMs);
    const handler = (event: MetricEvent) => {
      if (event.type !== type) return;
      clearTimeout(timeout);
      metrics.off('event', handler);
      resolve(event);
    };
    metrics.on('event', handler);
  });
}
