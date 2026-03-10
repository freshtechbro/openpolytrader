import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { attachLLMDecisionStream } from '../../src/telemetry/llmDecisionStream.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import { EventStore } from '../../src/core/EventStore.js';

let messageBus = createMessageBus();

const createAgent = (
  config: ConstructorParameters<typeof OpsAgent>[0],
  metrics?: ConstructorParameters<typeof OpsAgent>[1]
) => new OpsAgent({ messageBus, ...config }, metrics);

describe('OpsAgent LLM health summary', () => {
  const paths: string[] = [];

  beforeEach(() => {
    messageBus = createMessageBus();
  });

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('emits ops:health_summary when enabled', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/ops-health-summary.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });
    llmClient.enqueue('OpsAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: JSON.stringify({ ...fixture, summary: 'ok' })
    });

    const summaryPromise = new Promise((resolve) =>
      messageBus.once('ops:health_summary', (payload) => resolve(payload))
    );

    const agent = createAgent(
      {
        intervalMs: 1000,
        checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      metrics
    );

    const detach = attachLLMDecisionStream(metrics, messageBus);
    await agent.runOnce();
    detach();

    const summary = await summaryPromise;
    expect(summary).toMatchObject({ risk_level: 'low', summary: 'ok' });
    expect(metrics.snapshot().counts.llm_decision).toBe(1);
  });

  it('skips emitting ops:health_summary when LLM returns invalid JSON', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });
    llmClient.enqueue('OpsAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: '{'
    });

    let received: unknown = null;
    const summaryHandler = (payload: unknown) => {
      received = payload;
    };
    let decision: unknown = null;
    const decisionHandler = (payload: unknown) => {
      decision = payload;
    };
    messageBus.on('ops:health_summary', summaryHandler);
    messageBus.on('llm:decision', decisionHandler);

    const agent = createAgent(
      {
        intervalMs: 1000,
        checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      metrics
    );

    await agent.runOnce();

    messageBus.off('ops:health_summary', summaryHandler);
    messageBus.off('llm:decision', decisionHandler);

    expect(received).toBeNull();
    expect(metrics.snapshot().counts.llm_decision).toBe(0);
    expect(decision).toMatchObject({
      decision: {
        agent: 'OpsAgent',
        output: { error: 'invalid_output' },
        applied: false
      }
    });
  });

  it('persists LLM decisions and maps status across fallback/timeout/error', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);
    const store = new EventStore({ dbPath: path });

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/ops-health-summary.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });

    llmClient.enqueue('OpsAgent', {
      status: 'fallback',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, summary: 'fallback' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });
    llmClient.enqueue('OpsAgent', {
      status: 'timeout',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, summary: 'timeout' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });
    llmClient.enqueue('OpsAgent', {
      status: 'error',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, summary: 'error' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      error: { type: 'unit_test', message: 'unit_test' }
    });

    const decisions: Array<{ reasoning: { result: { status: string } } }> = [];
    const decisionEventHandler = (payload: unknown) => {
      decisions.push(payload as { reasoning: { result: { status: string } } });
    };
    messageBus.on('llm:decision', decisionEventHandler);

    const agent = createAgent(
      {
        intervalMs: 1000,
        checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' },
          eventStore: store
        }
      },
      metrics
    );

    await agent.runOnce();
    await agent.runOnce();
    await agent.runOnce();

    messageBus.off('llm:decision', decisionEventHandler);

    expect(decisions.map((d) => d.reasoning.result.status)).toEqual(['fallback', 'timeout', 'error']);
    expect(store.listDecisions({ subjectId: 'system:ops-health' })).toHaveLength(3);

    store.close();
  });

  it('skips emitting llm:decision when reasoning schema fails', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/ops-health-summary.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });
    llmClient.enqueue('OpsAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: JSON.stringify({ ...fixture, summary: 'ok' })
    });

    let emitted = 0;
    const noDecisionHandler = () => {
      emitted += 1;
    };
    messageBus.on('llm:decision', noDecisionHandler);

    const agent = createAgent(
      {
        intervalMs: 1000,
        checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: '',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      },
      metrics
    );

    await agent.runOnce();

    messageBus.off('llm:decision', noDecisionHandler);

    expect(emitted).toBe(0);
  });

  it('does not call LLM when config disabled or agent mode disabled', async () => {
    const baseFixture = JSON.parse(readFileSync('tests/fixtures/llm/ops-health-summary.json', 'utf8'));

    const cases = [
      { env: loadEnv({}), expectedEnabled: false },
      {
        env: loadEnv({
          LLM_ENABLED: 'true',
          LLM_PRIMARY_API_KEY: 'zen',
          LLM_FALLBACK_API_KEY: 'or',
          LLM_RISK_MODE: 'advisory',
          LLM_OPS_MODE: 'disabled'
        }),
        expectedEnabled: true
      }
    ];

    for (const { env, expectedEnabled } of cases) {
      const llmConfig = loadLLMConfig(env);
      expect(llmConfig.enabled).toBe(expectedEnabled);

      const llmClient = new MockLLMClient({
        defaultProviderId: 'openrouter',
        defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
        defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
      });
      llmClient.enqueue('OpsAgent', {
        status: 'success',
        endpoint: 'chat.completions',
        model: llmConfig.agents.OpsAgent.model,
        outputText: JSON.stringify({ ...baseFixture, summary: 'should_not_emit' })
      });

      let summaryReceived: unknown = null;
      const disabledSummaryHandler = (payload: unknown) => {
        summaryReceived = payload;
      };
      messageBus.on('ops:health_summary', disabledSummaryHandler);

      const agent = createAgent({
        intervalMs: 1000,
        checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test-v1',
          policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
        }
      });

      await agent.runOnce();

      messageBus.off('ops:health_summary', disabledSummaryHandler);

      expect(summaryReceived).toBeNull();
    }
  });

  it('logs missing_output_text when LLM call has no output text', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });
    llmClient.enqueue('OpsAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: null
    });

    let summaryReceived: unknown = null;
    const missingOutputSummaryHandler = (payload: unknown) => {
      summaryReceived = payload;
    };
    let decision: unknown = null;
    const decisionHandler = (payload: unknown) => {
      decision = payload;
    };
    messageBus.on('ops:health_summary', missingOutputSummaryHandler);
    messageBus.on('llm:decision', decisionHandler);

    const agent = createAgent({
      intervalMs: 1000,
      checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.runOnce();
    messageBus.off('ops:health_summary', missingOutputSummaryHandler);
    messageBus.off('llm:decision', decisionHandler);
    expect(summaryReceived).toBeNull();
    expect(decision).toMatchObject({
      decision: {
        agent: 'OpsAgent',
        output: { error: 'missing_output_text' },
        applied: false
      }
    });
  });

  it('emits llm:error when invalid output includes call error metadata', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.OpsAgent.timeoutMs
    });
    llmClient.enqueue('OpsAgent', {
      status: 'error',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: '{',
      error: { type: 'provider_error', message: 'bad_json' }
    });

    let llmErrorPayload: unknown = null;
    const errorHandler = (payload: unknown) => {
      llmErrorPayload = payload;
    };
    messageBus.on('llm:error', errorHandler);

    const agent = createAgent({
      intervalMs: 1000,
      checks: [{ name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }],
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.runOnce();
    messageBus.off('llm:error', errorHandler);

    expect(llmErrorPayload).toMatchObject({
      agent: 'OpsAgent',
      provider_id: 'openrouter',
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      error: { type: 'provider_error', message: 'bad_json' }
    });
  });

  it('preserves explicit check latency in health summary prompts', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_OPS_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const call = vi.fn().mockResolvedValue({
      status: 'success',
      providerId: 'openrouter',
      baseUrl: llmConfig.providers.openrouter.baseUrl,
      endpoint: 'chat.completions',
      model: llmConfig.agents.OpsAgent.model,
      outputText: null,
      startedAtMs: Date.now(),
      latencyMs: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      attempt: 1
    });

    const agent = createAgent({
      intervalMs: 1000,
      checks: [{ name: 'ok', check: async () => ({ ok: true, latencyMs: 12 }) }],
      llm: {
        config: llmConfig,
        client: { call },
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.runOnce();

    expect(call).toHaveBeenCalledTimes(1);
    const request = call.mock.calls[0][1] as {
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
      response_format?: { type?: string };
    };
    const userMessage = request.messages.find((message) => message.role === 'user');
    const prompt = JSON.parse(userMessage?.content ?? '{}') as {
      inputs?: { metrics?: { checks?: Record<string, { latencyMs: number | null }> } };
    };
    expect(prompt.inputs?.metrics?.checks?.ok?.latencyMs).toBe(12);
    expect(request.max_tokens).toBe(350);
    expect(request.response_format).toEqual({ type: 'json_object' });
  });
});
