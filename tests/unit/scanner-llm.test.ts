import { describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';

import { ScannerAgent } from '../../src/agents/scanner/ScannerAgent.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import type { ArbitrageOpportunity } from '../../src/domain/opportunity.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';

describe('ScannerAgent LLM prioritization', () => {
  it('reorders opportunities in advisory mode by LLM score', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/scanner-score.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.ScannerAgent.timeoutMs
    });
    llmClient.enqueue('ScannerAgent', { status: 'success', endpoint: 'chat.completions', outputText: JSON.stringify({ ...fixture, priority_score: 0.2 }) });
    llmClient.enqueue('ScannerAgent', { status: 'success', endpoint: 'chat.completions', outputText: JSON.stringify({ ...fixture, priority_score: 0.9 }) });

    const allowlist = new MarketAllowlist({ autoResume: true });
    const agent = new ScannerAgent(DEFAULT_TRADE_POLICY, allowlist, {
      tradingMode: 'paper',
      metrics,
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    const opportunities: ArbitrageOpportunity[] = [
      {
        id: 'opp-1',
        marketId: 'm1',
        yesTokenId: 'y1',
        noTokenId: 'n1',
        yesPrice: 0.4,
        noPrice: 0.55,
        costPerSet: 0.95,
        edge: 0.05,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: Date.now(),
        gateReasons: [],
        pair: { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }
      },
      {
        id: 'opp-2',
        marketId: 'm2',
        yesTokenId: 'y2',
        noTokenId: 'n2',
        yesPrice: 0.3,
        noPrice: 0.65,
        costPerSet: 0.95,
        edge: 0.05,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: Date.now(),
        gateReasons: [],
        pair: { marketId: 'm2', yesTokenId: 'y2', noTokenId: 'n2' }
      }
    ];

    const ordered = await agent.prioritizeOpportunities(opportunities);
    expect(ordered.map((o) => o.id)).toEqual(['opp-2', 'opp-1']);

    agent.stop();
  });

  it('does not block the deterministic pipeline in shadow mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'shadow',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/scanner-score.json', 'utf8'));
    let calls = 0;
    const client = {
      call: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          status: 'success' as const,
          providerId: 'opencode-zen' as const,
          baseUrl: llmConfig.providers['opencode-zen'].baseUrl,
          endpoint: 'chat.completions' as const,
          model: llmConfig.agents.ScannerAgent.model,
          outputText: JSON.stringify(fixture),
          startedAtMs: Date.now(),
          latencyMs: 0,
          timeoutMs: llmConfig.agents.ScannerAgent.timeoutMs,
          maxRetries: 0,
          attempt: 0
        };
      }
    };

    const allowlist = new MarketAllowlist({ autoResume: true });
    const agent = new ScannerAgent(DEFAULT_TRADE_POLICY, allowlist, {
      tradingMode: 'paper',
      metrics,
      llm: {
        config: llmConfig,
        client,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    const now = Date.now();
    const opportunities: ArbitrageOpportunity[] = [
      {
        id: 'opp-1',
        marketId: 'm1',
        yesTokenId: 'y1',
        noTokenId: 'n1',
        yesPrice: 0.4,
        noPrice: 0.55,
        costPerSet: 0.95,
        edge: 0.06,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: now,
        gateReasons: [],
        pair: { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }
      },
      {
        id: 'opp-2',
        marketId: 'm2',
        yesTokenId: 'y2',
        noTokenId: 'n2',
        yesPrice: 0.3,
        noPrice: 0.65,
        costPerSet: 0.95,
        edge: 0.05,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: now,
        gateReasons: [],
        pair: { marketId: 'm2', yesTokenId: 'y2', noTokenId: 'n2' }
      }
    ];

    const promise = agent.prioritizeOpportunities(opportunities, now);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.runAllTicks();
    expect(settled).toBe(true);

    const ordered = await promise;
    expect(ordered).toBe(opportunities);

    expect(calls).toBeGreaterThan(0);

    agent.stop();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });
});
