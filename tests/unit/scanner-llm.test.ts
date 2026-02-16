import { describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';

import { ScannerAgent } from '../../src/agents/scanner/ScannerAgent.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { messageBus } from '../../src/core/MessageBus.js';
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

  it('sends structured JSON request format with explicit token cap', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_SCANNER_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    let capturedRequest: unknown = null;
    const client = {
      call: async (_agent: 'ScannerAgent', request: unknown) => {
        capturedRequest = request;
        return {
          status: 'success' as const,
          providerId: 'opencode-zen' as const,
          baseUrl: llmConfig.providers['opencode-zen'].baseUrl,
          endpoint: 'chat.completions' as const,
          model: llmConfig.agents.ScannerAgent.model,
          outputText: '{"priority_score":0.7,"rationale":"ok","confidence":0.7}',
          startedAtMs: Date.now(),
          latencyMs: 0,
          timeoutMs: llmConfig.agents.ScannerAgent.timeoutMs,
          maxRetries: llmConfig.retry.maxRetries,
          attempt: 1
        };
      }
    };

    const allowlist = new MarketAllowlist({ autoResume: true });
    const agent = new ScannerAgent(DEFAULT_TRADE_POLICY, allowlist, {
      tradingMode: 'paper',
      llm: {
        config: llmConfig,
        client,
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
      }
    ];

    await agent.prioritizeOpportunities(opportunities);
    expect(capturedRequest).toMatchObject({
      endpoint: 'chat.completions',
      max_tokens: 300,
      response_format: { type: 'json_object' }
    });
    agent.stop();
  });

  it('records missing_output_text decision when scanner output is empty', async () => {
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
      outputText: null
    });

    const decisions: Array<{ decision?: { output?: { rationale?: string }; clamp?: { violations?: string[] } } }> =
      [];
    const handler = (payload: unknown) => {
      decisions.push(payload as { decision?: { output?: { rationale?: string }; clamp?: { violations?: string[] } } });
    };
    messageBus.on('llm:decision', handler);

    const agent = new ScannerAgent(DEFAULT_TRADE_POLICY, new MarketAllowlist({ autoResume: true }), {
      tradingMode: 'paper',
      llm: {
        config: llmConfig,
        client: llmClient,
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
        edge: 0.05,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: now,
        gateReasons: [],
        pair: { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }
      }
    ];

    await agent.prioritizeOpportunities(opportunities, now);
    messageBus.off('llm:decision', handler);

    expect(decisions[0]?.decision?.output?.rationale).toBe('missing_output_text');
    expect(decisions[0]?.decision?.clamp?.violations).toEqual(['missing_output_text']);
    agent.stop();
  });

  it('records invalid_output decision when scanner output is malformed JSON', async () => {
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
      outputText: '{'
    });

    const decisions: Array<{ decision?: { output?: { rationale?: string }; clamp?: { violations?: string[] } } }> =
      [];
    const handler = (payload: unknown) => {
      decisions.push(payload as { decision?: { output?: { rationale?: string }; clamp?: { violations?: string[] } } });
    };
    messageBus.on('llm:decision', handler);

    const agent = new ScannerAgent(DEFAULT_TRADE_POLICY, new MarketAllowlist({ autoResume: true }), {
      tradingMode: 'paper',
      llm: {
        config: llmConfig,
        client: llmClient,
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
        edge: 0.05,
        tickSize: 0.01,
        maxSizeByDepth: 100,
        minOrderSize: 1,
        detectedAt: now,
        gateReasons: [],
        pair: { marketId: 'm1', yesTokenId: 'y1', noTokenId: 'n1' }
      }
    ];

    await agent.prioritizeOpportunities(opportunities, now);
    messageBus.off('llm:decision', handler);

    expect(decisions[0]?.decision?.output?.rationale).toBe('invalid_output');
    expect(decisions[0]?.decision?.clamp?.violations).toEqual(['invalid_output']);
    agent.stop();
  });
});

describe('ScannerAgent fee-aware near-zero gating', () => {
  function createBook(tokenId: string, bestBid: number, bestAsk: number, nowMs: number) {
    return {
      tokenId,
      bids: [{ price: bestBid, size: 100 }],
      asks: [{ price: bestAsk, size: 100 }],
      tickSize: 0.01,
      minOrderSize: 1,
      lastUpdateMs: nowMs,
      stableSinceMs: nowMs - 1000,
      bestBid: { price: bestBid, size: 100 },
      bestAsk: { price: bestAsk, size: 100 }
    };
  }

  it('rejects near-zero opportunities when fees reduce edge below threshold', () => {
    const nowMs = Date.now();
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'near_zero' as const,
      nearZeroFeeBps: 100,
      minDepthLevels: 1,
      depthHeadroomFraction: 1,
      depthBufferMultiplier: 0,
      minEdgeTicks: 0,
      entrySlippageToleranceBps: 1000
    };
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.seed(['market-1']);
    const metrics = new MetricsStore(100);
    const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });

    const opportunity = agent.scanPair(
      { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
      new Map([
        ['yes-1', createBook('yes-1', 0.47, 0.48, nowMs)],
        ['no-1', createBook('no-1', 0.48, 0.49, nowMs)]
      ]),
      nowMs
    );

    expect(opportunity).toBeNull();
    const rejection = metrics.recent('gate_rejection', 1)[0];
    expect(rejection?.data?.reasons).toContain('edge_below_threshold_after_fees');

    agent.stop();
  });

  it('preserves existing behavior when nearZeroFeeBps is zero', () => {
    const nowMs = Date.now();
    const policy = {
      ...DEFAULT_TRADE_POLICY,
      signalMode: 'near_zero' as const,
      nearZeroFeeBps: 0,
      minDepthLevels: 1,
      depthHeadroomFraction: 1,
      depthBufferMultiplier: 0,
      minEdgeTicks: 0,
      entrySlippageToleranceBps: 1000
    };
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.seed(['market-1']);
    const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper' });

    const opportunity = agent.scanPair(
      { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
      new Map([
        ['yes-1', createBook('yes-1', 0.47, 0.48, nowMs)],
        ['no-1', createBook('no-1', 0.48, 0.49, nowMs)]
      ]),
      nowMs
    );

    expect(opportunity).not.toBeNull();
    expect(opportunity?.edge).toBeCloseTo(0.03, 6);

    agent.stop();
  });
});

describe('ScannerAgent telemetry dedupe', () => {
  function createBook(tokenId: string, bestBid: number, bestAsk: number, nowMs: number) {
    return {
      tokenId,
      bids: [{ price: bestBid, size: 100 }],
      asks: [{ price: bestAsk, size: 100 }],
      tickSize: 0.01,
      minOrderSize: 1,
      lastUpdateMs: nowMs,
      stableSinceMs: nowMs - 1000,
      bestBid: { price: bestBid, size: 100 },
      bestAsk: { price: bestAsk, size: 100 }
    };
  }

  it('suppresses repeated near-zero gate rejections within cooldown and emits again after cooldown', () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.now();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'near_zero' as const,
        nearZeroFeeBps: 100,
        minDepthLevels: 1,
        depthHeadroomFraction: 1,
        depthBufferMultiplier: 0,
        minEdgeTicks: 0,
        entrySlippageToleranceBps: 1000
      };
      const allowlist = new MarketAllowlist({ autoResume: true });
      allowlist.seed(['market-1']);
      const metrics = new MetricsStore(100);
      const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });
      const books = new Map([
        ['yes-1', createBook('yes-1', 0.47, 0.48, nowMs)],
        ['no-1', createBook('no-1', 0.48, 0.49, nowMs)]
      ]);

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs);
      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs + 1000);
      expect(metrics.recent('gate_rejection', 10)).toHaveLength(1);

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs + 3500);
      expect(metrics.recent('gate_rejection', 10)).toHaveLength(2);

      agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses near-zero rejections when only transient reasons change within cooldown', () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.now();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'near_zero' as const,
        nearZeroFeeBps: 0,
        minDepthLevels: 1,
        depthHeadroomFraction: 1,
        depthBufferMultiplier: 0,
        minEdgeTicks: 0,
        entrySlippageToleranceBps: 1000
      };
      const allowlist = new MarketAllowlist({ autoResume: true });
      allowlist.seed(['market-1']);
      const metrics = new MetricsStore(100);
      const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });
      const stableBooks = new Map([
        ['yes-1', createBook('yes-1', 0.54, 0.55, nowMs)],
        ['no-1', createBook('no-1', 0.46, 0.47, nowMs)]
      ]);
      const unstableBooks = new Map([
        ['yes-1', { ...createBook('yes-1', 0.54, 0.55, nowMs + 1000), stableSinceMs: nowMs + 990 }],
        ['no-1', { ...createBook('no-1', 0.46, 0.47, nowMs + 1000), stableSinceMs: nowMs + 990 }]
      ]);

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, stableBooks, nowMs);
      agent.scanPair(
        { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        unstableBooks,
        nowMs + 1000
      );

      const events = metrics.recent('gate_rejection', 10);
      expect(events).toHaveLength(1);
      expect((events[0].data as { reasons: string[] }).reasons).toContain('edge_below_threshold');

      agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits near-zero gate rejections immediately when rejection reason changes', () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.now();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'near_zero' as const,
        nearZeroFeeBps: 100,
        minDepthLevels: 1,
        depthHeadroomFraction: 1,
        depthBufferMultiplier: 0,
        minEdgeTicks: 0,
        entrySlippageToleranceBps: 1000
      };
      const allowlist = new MarketAllowlist({ autoResume: true });
      allowlist.seed(['market-1']);
      const metrics = new MetricsStore(100);
      const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });
      const lowEdgeBooks = new Map([
        ['yes-1', createBook('yes-1', 0.47, 0.48, nowMs)],
        ['no-1', createBook('no-1', 0.48, 0.49, nowMs)]
      ]);
      const invalidAskBooks = new Map([
        ['yes-1', createBook('yes-1', 0.47, 0, nowMs + 1000)],
        ['no-1', createBook('no-1', 0.48, 0.49, nowMs + 1000)]
      ]);

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, lowEdgeBooks, nowMs);
      agent.scanPair(
        { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        invalidAskBooks,
        nowMs + 1000
      );

      const events = metrics.recent('gate_rejection', 10);
      expect(events).toHaveLength(2);
      expect((events[0].data as { reasons: string[] }).reasons).toContain('edge_below_threshold_after_fees');
      expect((events[1].data as { reasons: string[] }).reasons).toContain('yes_best_ask_invalid');

      agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses repeated ev_missing_signal events within cooldown', () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.now();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'ev' as const,
        evModelMode: 'llm_only' as const,
        minDepthLevels: 1,
        depthHeadroomFraction: 1,
        depthBufferMultiplier: 0,
        minEdgeTicks: 0,
        entrySlippageToleranceBps: 0
      };
      const allowlist = new MarketAllowlist({ autoResume: true });
      allowlist.seed(['market-1']);
      const metrics = new MetricsStore(100);
      const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });
      const books = new Map([
        ['yes-1', createBook('yes-1', 0.44, 0.45, nowMs)],
        ['no-1', createBook('no-1', 0.44, 0.45, nowMs)]
      ]);

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs);
      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs + 1000);

      const missingSignalEvents = metrics.recent('ev_signal', 10).filter((event) => {
        const data = event.data as { reason?: unknown };
        return data.reason === 'ev_missing_signal';
      });
      expect(missingSignalEvents).toHaveLength(1);

      agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses repeated ev_cooldown events within cooldown window', () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.now();
      const policy = {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'ev' as const,
        evModelMode: 'baseline' as const,
        evEdgeRequired: 0,
        evConfidenceMin: 0,
        evCooldownSeconds: 120,
        minDepthLevels: 1,
        depthHeadroomFraction: 1,
        depthBufferMultiplier: 0,
        minEdgeTicks: 0,
        entrySlippageToleranceBps: 0
      };
      const allowlist = new MarketAllowlist({ autoResume: true });
      allowlist.seed(['market-1']);
      const metrics = new MetricsStore(100);
      const agent = new ScannerAgent(policy, allowlist, { tradingMode: 'paper', metrics });
      const books = new Map([
        ['yes-1', createBook('yes-1', 0.44, 0.45, nowMs)],
        ['no-1', createBook('no-1', 0.44, 0.45, nowMs)]
      ]);

      const selected = agent.scanPair(
        { marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' },
        books,
        nowMs
      );
      expect(selected?.type).toBe('ev');

      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs + 1000);
      agent.scanPair({ marketId: 'market-1', yesTokenId: 'yes-1', noTokenId: 'no-1' }, books, nowMs + 2000);

      const cooldownEvents = metrics.recent('ev_signal', 10).filter((event) => {
        const data = event.data as { reason?: unknown };
        return data.reason === 'ev_cooldown';
      });
      expect(cooldownEvents).toHaveLength(1);

      agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
