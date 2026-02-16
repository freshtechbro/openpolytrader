import { afterEach, describe, expect, it, vi } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import { LearningAgent } from '../../src/agents/learning/LearningAgent.js';
import { EventStore } from '../../src/core/EventStore.js';
import { messageBus } from '../../src/core/MessageBus.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';

describe('LearningAgent online loop', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('publishes and caches insights from LLM', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_LEARNING_MODE: 'active',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const insights = JSON.parse(
      readFileSync('tests/fixtures/llm/learning-insights.json', 'utf8')
    );
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.LearningAgent.timeoutMs
    });
    llmClient.enqueue('LearningAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.LearningAgent.model,
      outputText: JSON.stringify(insights)
    });

    const agent = new LearningAgent(
      {
        enabled: true,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          windowMs: 300000,
          minEventsPerRun: 1,
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      store
    );

    agent.start();

    const insightPromise = new Promise((resolve) =>
      messageBus.once('learning:insight', (payload) => resolve(payload))
    );

    messageBus.emit('opportunity:detected', {
      opportunity: { id: 'opp-1', marketId: 'market_123', edge: 0.05 }
    });

    await (agent as unknown as { synthesizeNow: () => Promise<void> }).synthesizeNow();

    const payload = await insightPromise;
    expect(payload).toMatchObject({
      insights: [{ market_id: 'market_123', signal: 'high_confidence' }]
    });

    const cached = agent.getInsight('market_123');
    expect(cached?.market_id).toBe('market_123');

    const decisions = store.listDecisions({ agent: 'LearningAgent' });
    expect(decisions.length).toBe(1);

    agent.stop();
  });

  it('logs a decision when output text is missing', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_LEARNING_MODE: 'active',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.LearningAgent.timeoutMs
    });
    llmClient.enqueue('LearningAgent', {
      status: 'error',
      endpoint: 'chat.completions',
      model: llmConfig.agents.LearningAgent.model,
      outputText: null
    });

    const agent = new LearningAgent(
      {
        enabled: true,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          windowMs: 300000,
          minEventsPerRun: 1,
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      store
    );

    await (agent as unknown as { synthesizeNow: () => Promise<void> }).synthesizeNow();

    const decisions = store.listDecisions({ agent: 'LearningAgent' });
    expect(decisions.length).toBe(1);
    const decision = decisions[0]?.decision as {
      output?: { error?: string };
      applied?: boolean;
      clamp?: { violations?: string[] };
    };
    expect(decision?.output).toMatchObject({ error: 'missing_output_text' });
    expect(decision?.applied).toBe(false);
    expect(decision?.clamp?.violations).toEqual(['missing_output_text']);

    agent.stop();
  });

  it('requests structured JSON format for non-claude learning models', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_LEARNING_MODE: 'active',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key',
      LLM_LEARNING_MODEL: 'kimi-k2.5'
    });
    const llmConfig = loadLLMConfig(env);

    let capturedRequest: unknown = null;
    const agent = new LearningAgent(
      {
        enabled: true,
        llm: {
          config: llmConfig,
          client: {
            call: async (_agent: 'LearningAgent', request) => {
              capturedRequest = request;
              return {
                status: 'success',
                providerId: 'openrouter',
                baseUrl: llmConfig.providers.openrouter.baseUrl,
                endpoint: 'chat.completions',
                model: llmConfig.agents.LearningAgent.model,
                outputText:
                  '{"insights":[{"market_id":"market_123","signal":"high_confidence","value":0.8,"ttl_ms":60000,"confidence":0.9}]}',
                startedAtMs: Date.now(),
                latencyMs: 1,
                timeoutMs: llmConfig.agents.LearningAgent.timeoutMs,
                maxRetries: llmConfig.retry.maxRetries,
                attempt: 1
              };
            }
          },
          promptVersion: 'test-v1',
          windowMs: 300000,
          minEventsPerRun: 1,
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      store
    );

    messageBus.emit('opportunity:detected', {
      opportunity: { id: 'opp-1', marketId: 'market_123', edge: 0.05 }
    });
    await (agent as unknown as { synthesizeNow: () => Promise<void> }).synthesizeNow();

    expect(capturedRequest).toMatchObject({
      endpoint: 'chat.completions',
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    agent.stop();
    store.close();
  });

  it('persists market stats snapshots across restarts', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });

    const agent1 = new LearningAgent({ enabled: true }, store);
    agent1.start();
    messageBus.emit('opportunity:detected', {
      opportunity: { id: 'opp-1', marketId: 'market_123', edge: 0.1 }
    });
    agent1.stop();

    const agent2 = new LearningAgent({ enabled: true }, store);
    agent2.start();
    messageBus.emit('opportunity:detected', {
      opportunity: { id: 'opp-2', marketId: 'market_123', edge: 0.3 }
    });
    agent2.stop();

    const snapshot = store.getLatestEventByType('learning:market_stats_snapshot');
    expect(snapshot?.type).toBe('learning:market_stats_snapshot');
    const payload = snapshot?.payload as { stats_by_market?: Record<string, unknown> } | undefined;
    const stats = payload?.stats_by_market?.['market_123'] as { opportunities?: number; avg_edge?: number } | undefined;
    expect(stats?.opportunities).toBe(2);
    expect(stats?.avg_edge).toBeCloseTo(0.2, 6);

    store.close();
  });

  it('rebuilds market stats from persisted events when snapshot is missing', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const base = Date.now();

    store.append({
      id: 'evt-opp-1',
      timestamp: base,
      type: 'opportunity:detected',
      payload: { opportunity: { id: 'opp-1', marketId: 'market_123', edge: 0.1 } },
      metadata: { agent: 'ScannerAgent' }
    });

    store.append({
      id: 'evt-risk-1',
      timestamp: base + 1,
      type: 'risk:approved',
      payload: { opportunity: { id: 'opp-1', marketId: 'market_123' } },
      metadata: { agent: 'RiskAgent' }
    });

    store.append({
      id: 'evt-opp-2',
      timestamp: base + 2,
      type: 'opportunity:detected',
      payload: { opportunity: { id: 'opp-2', marketId: 'market_123', edge: 0.3 } },
      metadata: { agent: 'ScannerAgent' }
    });

    store.append({
      id: 'evt-fill-1',
      timestamp: base + 3,
      type: 'execution:fill',
      payload: { marketId: 'market_123', slippage: 0.02 },
      metadata: { agent: 'ExecutionAgent' }
    });

    store.append({
      id: 'evt-outcome-1',
      timestamp: base + 4,
      type: 'execution:outcome',
      payload: { marketId: 'market_123', status: 'timeout' },
      metadata: { agent: 'ExecutionAgent' }
    });

    const agent = new LearningAgent({ enabled: true }, store);
    agent.start();
    agent.stop();

    const snapshot = store.getLatestEventByType('learning:market_stats_snapshot');
    expect(snapshot?.type).toBe('learning:market_stats_snapshot');

    const payload = snapshot?.payload as { stats_by_market?: Record<string, unknown> } | undefined;
    const stats = payload?.stats_by_market?.['market_123'] as
      | { opportunities?: number; approvals?: number; avg_edge?: number; timeouts?: number }
      | undefined;

    expect(stats?.opportunities).toBe(2);
    expect(stats?.approvals).toBe(1);
    expect(stats?.avg_edge).toBeCloseTo(0.2, 6);
    expect(stats?.timeouts).toBe(1);

    store.close();
  });

  it('prunes inactive markets from stats snapshots', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    store.append({
      id: 'snapshot-1',
      timestamp: now - 1,
      type: 'learning:market_stats_snapshot',
      payload: {
        schema_version: 2,
        at_ms: now - 1,
        applied_through_ms: now - 1,
        stats_by_market: {
          stale_market: {
            opportunities: 1,
            approvals: 0,
            avg_edge: 0.1,
            slippage_samples: 0,
            avg_slippage: 0,
            timeouts: 0,
            last_updated_ms: now - 2 * 60 * 60 * 1000
          },
          fresh_market: {
            opportunities: 1,
            approvals: 0,
            avg_edge: 0.2,
            slippage_samples: 0,
            avg_slippage: 0,
            timeouts: 0,
            last_updated_ms: now - 1000
          }
        }
      },
      metadata: { agent: 'LearningAgent' }
    });

    const agent = new LearningAgent({ enabled: true, statsRetentionMs: 60 * 60 * 1000 }, store);
    agent.start();
    agent.stop();

    const snapshot = store.getLatestEventByType('learning:market_stats_snapshot');
    const payload = snapshot?.payload as { stats_by_market?: Record<string, unknown> } | undefined;
    expect(payload?.stats_by_market && 'fresh_market' in payload.stats_by_market).toBe(true);
    expect(payload?.stats_by_market && 'stale_market' in payload.stats_by_market).toBe(false);

    store.close();
    vi.useRealTimers();
  });

  it('limits synthesis prompt to top N markets', async () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_LEARNING_MODE: 'active',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const insights = JSON.parse(readFileSync('tests/fixtures/llm/learning-insights.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.LearningAgent.timeoutMs
    });
    llmClient.enqueue('LearningAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.LearningAgent.model,
      outputText: JSON.stringify(insights)
    });

    const agent = new LearningAgent(
      {
        enabled: true,
        promptTopNMarkets: 2,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          windowMs: 300000,
          minEventsPerRun: 1,
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      store
    );

    agent.start();
    messageBus.emit('opportunity:detected', { opportunity: { id: 'opp-a', marketId: 'market_a', edge: 0.01 } });
    messageBus.emit('risk:approved', { opportunity: { id: 'opp-a', marketId: 'market_a' } });

    for (let i = 0; i < 10; i += 1) {
      messageBus.emit('opportunity:detected', { opportunity: { id: `opp-b-${i}`, marketId: 'market_b', edge: 0.02 } });
    }
    for (let i = 0; i < 9; i += 1) {
      messageBus.emit('opportunity:detected', { opportunity: { id: `opp-c-${i}`, marketId: 'market_c', edge: 0.03 } });
    }

    await (agent as unknown as { synthesizeNow: () => Promise<void> }).synthesizeNow();
    agent.stop();

    const decisions = store.listDecisions({ agent: 'LearningAgent' });
    expect(decisions.length).toBe(1);

    const decision = decisions[0]?.decision as { baseline?: unknown } | undefined;
    const baseline = decision?.baseline as { stats_by_market?: Record<string, unknown> } | undefined;
    const stats = baseline?.stats_by_market;
    expect(stats && Object.keys(stats)).toHaveLength(2);
    expect(stats && 'market_a' in stats).toBe(true);
    expect(stats && 'market_b' in stats).toBe(true);
    expect(stats && 'market_c' in stats).toBe(false);

    store.close();
  });
});
