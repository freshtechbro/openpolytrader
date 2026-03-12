import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { RiskAdvisor } from '../../src/agents/risk/RiskAdvisor.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import { EventStore } from '../../src/core/EventStore.js';
import { createMessageBus } from '../../src/core/MessageBus.js';
import type { LLMCallResult } from '../../src/services/llm/types.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

let messageBus = createMessageBus();

describe('RiskAdvisor', () => {
  const paths: string[] = [];

  beforeEach(() => {
    messageBus = createMessageBus();
  });

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('returns deterministic size when disabled', async () => {
    const env = loadEnv({});
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      messageBus,
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-disabled',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(result.reason).toBe('disabled');
    expect(result.call).toBeNull();
    expect(result.clampedSize).toBe(50);
    expect(result.recommendedSizeRaw).toBeNull();
  });

  it('throws when required LLM advisor context fields are missing', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    const input = {
      opportunityId: 'opp-missing',
      marketId: 'm1',
      minSize: 1,
      deterministicSize: 5,
      constraints: {}
    };

    type PrivateRiskAdvisor = {
      resolveLlmConfig: () => unknown;
      resolveLlmClient: () => unknown;
      resolvePromptVersion: () => string;
      resolvePolicyHashes: () => unknown;
      recommendSize: (args: typeof input) => Promise<unknown>;
    };

    await expect(
      (new RiskAdvisor({
        llmClient,
        promptVersion: 'test-v1',
        messageBus,
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }) as unknown as PrivateRiskAdvisor).recommendSize(input)
    ).rejects.toThrow('RiskAdvisor requires config');

    expect(() =>
      (new RiskAdvisor({
        llmConfig,
        promptVersion: 'test-v1',
        messageBus,
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }) as unknown as PrivateRiskAdvisor).resolveLlmClient()
    ).toThrow('RiskAdvisor requires client');

    expect(() =>
      (new RiskAdvisor({
        llmConfig,
        llmClient,
        messageBus,
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }) as unknown as PrivateRiskAdvisor).resolvePromptVersion()
    ).toThrow('RiskAdvisor requires promptVersion');

    expect(() =>
      (new RiskAdvisor({
        llmConfig,
        llmClient,
        promptVersion: 'test-v1',
        messageBus
      }) as unknown as PrivateRiskAdvisor).resolvePolicyHashes()
    ).toThrow('RiskAdvisor requires policyHashes');
  });

  it('clamps non-finite and negative inputs to 0', async () => {
    const env = loadEnv({});
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      messageBus,
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-bad-inputs',
      marketId: 'm1',
      minSize: -10,
      deterministicSize: Number.NaN,
      constraints: { binding: 'depth' }
    });

    expect(result.clampedSize).toBe(0);
  });

  it('clamps recommended size to [minSize, deterministicSize]', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/risk-recommend-size.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    llmClient.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: JSON.stringify({ ...fixture, recommended_size: 999, reason: 'too big' })
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      messageBus,
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-1',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(result.clampedSize).toBe(50);
    expect(result.recommendedSizeRaw).toBe(999);
  });

  it('falls back to deterministic size when LLM output is invalid JSON', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    llmClient.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: '{'
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      messageBus,
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-invalid-json',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(result.recommendedSizeRaw).toBeNull();
    expect(result.clampedSize).toBe(50);
    expect(result.reason).toBe('invalid_output');
  });

  it('falls back to deterministic size when LLM returns null output', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    llmClient.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: null
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-null-output',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(result.recommendedSizeRaw).toBeNull();
    expect(result.clampedSize).toBe(50);
    expect(result.reason).toBe('missing_output_text');
  });

  it('sends structured JSON request format with explicit token cap', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    let capturedRequest: unknown = null;
    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient: {
        call: async (_agent: 'RiskAgent', request) => {
          capturedRequest = request;
          return {
            status: 'success',
            providerId: 'opencode-zen',
            baseUrl: llmConfig.providers['opencode-zen'].baseUrl,
            endpoint: 'chat.completions',
            model: llmConfig.agents.RiskAgent.model,
            outputText: '{"recommended_size":25,"reason":"ok","confidence":0.7}',
            startedAtMs: Date.now(),
            latencyMs: 1,
            timeoutMs: llmConfig.agents.RiskAgent.timeoutMs,
            maxRetries: llmConfig.retry.maxRetries,
            attempt: 1
          };
        }
      },
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    await advisor.recommendSize({
      opportunityId: 'opp-request-shape',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(capturedRequest).toMatchObject({
      endpoint: 'chat.completions',
      max_tokens: 300,
      response_format: { type: 'json_object' }
    });
  });

  it('persists decisions when EventStore is provided', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);
    const store = new EventStore({ dbPath: path });

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/risk-recommend-size.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    llmClient.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: JSON.stringify({ ...fixture, recommended_size: 25, reason: 'ok' })
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' },
      messageBus,
      eventStore: store
    });

    await advisor.recommendSize({
      opportunityId: 'opp-persist',
      marketId: 'm1',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    const rows = store.listDecisions({ subjectId: 'opp-persist' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe('RiskAgent');

    store.close();
  });

  it('records shadow decisions but keeps the deterministic size in shadow mode', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'shadow',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const metrics = new MetricsStore(10);
    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/risk-recommend-size.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });
    llmClient.enqueue('RiskAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: JSON.stringify({ ...fixture, recommended_size: 12, reason: 'shadow-ok', confidence: 0.8 })
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      metrics,
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const result = await advisor.recommendSize({
      opportunityId: 'opp-shadow',
      marketId: 'm-shadow',
      minSize: 10,
      deterministicSize: 50,
      constraints: { binding: 'depth' }
    });

    expect(result.recommendedSizeRaw).toBe(12);
    expect(result.clampedSize).toBe(50);
    expect(result.reason).toBe('shadow-ok');
    expect(metrics.recent('shadow_decision', 1)[0]?.data).toMatchObject({
      agent: 'RiskAgent',
      opportunityId: 'opp-shadow',
      marketId: 'm-shadow',
      deterministicSize: 50,
      recommendedSizeRaw: 12,
      clampedSize: 12,
      confidence: 0.8
    });
  });

  it('emits llm:decision with mapped status and usage', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);
    const store = new EventStore({ dbPath: path });

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/risk-recommend-size.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });

    llmClient.enqueue('RiskAgent', {
      status: 'fallback',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, recommended_size: 25, reason: 'fallback' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });
    llmClient.enqueue('RiskAgent', {
      status: 'timeout',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, recommended_size: 25, reason: 'timeout' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });
    llmClient.enqueue('RiskAgent', {
      status: 'error',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, recommended_size: 25, reason: 'error' }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      error: { type: 'unit_test', message: 'unit_test' }
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' },
      messageBus,
      eventStore: store
    });

    const statuses: string[] = [];
    const handler = (payload: unknown) => {
      statuses.push((payload as { reasoning: { result: { status: string } } }).reasoning.result.status);
    };
    messageBus.on('llm:decision', handler);

    await advisor.recommendSize(
      { opportunityId: 'opp-status-1', marketId: 'm1', minSize: 10, deterministicSize: 50, constraints: {} },
      1000
    );
    await advisor.recommendSize(
      { opportunityId: 'opp-status-2', marketId: 'm1', minSize: 10, deterministicSize: 50, constraints: {} },
      1001
    );
    await advisor.recommendSize(
      { opportunityId: 'opp-status-3', marketId: 'm1', minSize: 10, deterministicSize: 50, constraints: {} },
      1002
    );

    messageBus.off('llm:decision', handler);

    expect(statuses).toEqual(['fallback', 'timeout', 'error']);
    expect(store.listDecisions({ agent: 'RiskAgent' })).toHaveLength(3);

    store.close();
  });

  it('drops invalid decision payloads and clamps non-finite confidence', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'test-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
    });

    const call = {
      status: 'success',
      providerId: null,
      baseUrl: null,
      endpoint: null,
      model: null,
      outputText: '{}',
      startedAtMs: 0,
      latencyMs: 0,
      timeoutMs: 1,
      maxRetries: 0,
      attempt: 1
    } satisfies LLMCallResult;

    let emitted = 0;
    const handler = () => {
      emitted += 1;
    };
    messageBus.on('llm:decision', handler);

    const privateAdvisor = advisor as unknown as {
      persistDecision: (args: {
        opportunityId: string;
        mode: 'disabled' | 'shadow' | 'advisory';
        baseline: unknown;
        output: { recommended_size: number; reason: string; confidence: number };
        call: LLMCallResult;
        promptEnvelope: unknown;
        promptVersion: string;
        policyHashes: { tradePolicyHash: string; riskConfigHash: string };
        nowMs: number;
      }) => void;
    };

    privateAdvisor.persistDecision({
      opportunityId: 'opp-invalid-decision',
      mode: 'advisory',
      baseline: {},
      output: { recommended_size: 10, reason: 'ok', confidence: Number.NaN },
      call,
      promptEnvelope: {},
      promptVersion: '',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' },
      nowMs: 1
    });

    messageBus.off('llm:decision', handler);

    expect(emitted).toBe(0);
  });

  it('falls back to advisor prompt metadata when persistDecision is called without an LLM context', () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_RISK_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);
    const llmClient = new MockLLMClient({
      defaultProviderId: 'opencode-zen',
      defaultBaseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      defaultTimeoutMs: llmConfig.agents.RiskAgent.timeoutMs
    });

    const advisor = new RiskAdvisor({
      llmConfig,
      llmClient,
      promptVersion: 'fallback-v1',
      policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' },
      messageBus
    });

    const call = {
      status: 'success',
      providerId: 'opencode-zen',
      baseUrl: llmConfig.providers['opencode-zen'].baseUrl,
      endpoint: 'chat.completions',
      model: llmConfig.agents.RiskAgent.model,
      outputText: '{"recommended_size":10,"reason":"ok","confidence":0.5}',
      startedAtMs: 0,
      latencyMs: 1,
      timeoutMs: 1,
      maxRetries: 0,
      attempt: 1
    } satisfies LLMCallResult;

    let emitted = 0;
    const handler = () => {
      emitted += 1;
    };
    messageBus.on('llm:decision', handler);

    (
      advisor as unknown as {
        persistDecision: (args: {
          opportunityId: string;
          mode: 'disabled' | 'shadow' | 'advisory';
          baseline: unknown;
          output: { recommended_size: number; reason: string; confidence: number };
          call: LLMCallResult;
          promptEnvelope: unknown;
          nowMs: number;
        }) => void;
      }
    ).persistDecision({
      opportunityId: 'opp-fallback-metadata',
      mode: 'advisory',
      baseline: { deterministic_size: 10 },
      output: { recommended_size: 10, reason: 'ok', confidence: 0.5 },
      call,
      promptEnvelope: { task: 'recommend_size' },
      nowMs: 2
    });

    messageBus.off('llm:decision', handler);

    expect(emitted).toBe(1);
  });
});
