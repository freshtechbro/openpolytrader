import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { RiskAdvisor } from '../../src/agents/risk/RiskAdvisor.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import { EventStore } from '../../src/core/EventStore.js';
import { messageBus } from '../../src/core/MessageBus.js';
import type { LLMCallResult } from '../../src/services/llm/types.js';

describe('RiskAdvisor', () => {
  const paths: string[] = [];

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
});
