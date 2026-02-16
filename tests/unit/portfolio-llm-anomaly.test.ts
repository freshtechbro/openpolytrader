import { afterEach, describe, expect, it, vi } from 'vitest';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

import { PortfolioAgent } from '../../src/agents/portfolio/PortfolioAgent.js';
import { messageBus } from '../../src/core/MessageBus.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import { MockLLMClient } from '../../src/services/llm/MockLLMClient.js';
import { EventStore } from '../../src/core/EventStore.js';

describe('PortfolioAgent LLM anomaly detection', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('emits ops:alert when anomaly detected', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/portfolio-anomaly.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.PortfolioAgent.model,
      outputText: JSON.stringify({ ...fixture, anomaly: true, severity: 'high', reason: 'drift' })
    });

    const alertPromise = new Promise((resolve) =>
      messageBus.once('ops:alert', (payload) => resolve(payload))
    );

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({ venueIssues: [], nowMs: Date.now() });

    const alert = await alertPromise;
    expect(alert).toMatchObject({ type: 'llm_portfolio_anomaly', severity: 'high' });
  });

  it('does not emit ops:alert when anomaly=false but persists a decision', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);
    const store = new EventStore({ dbPath: path });

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/portfolio-anomaly.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'fallback',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, anomaly: false, reason: null, confidence: 0.5 }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });

    let alertReceived: unknown = null;
    const alertHandler = (payload: unknown) => {
      alertReceived = payload;
    };
    messageBus.on('ops:alert', alertHandler);

    const decisions: Array<{ decision: { applied: boolean } }> = [];
    const decisionHandler = (payload: unknown) => {
      decisions.push(payload as { decision: { applied: boolean } });
    };
    messageBus.on('llm:decision', decisionHandler);

    const agent = new PortfolioAgent(1000, undefined, {
      eventStore: store,
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies();

    messageBus.off('ops:alert', alertHandler);
    messageBus.off('llm:decision', decisionHandler);

    expect(alertReceived).toBeNull();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision.applied).toBe(false);
    expect(store.listDecisions({ subjectId: 'system:portfolio' })).toHaveLength(1);

    store.close();
  });

  it('maps timeout status in llm:decision reasoning', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);
    const store = new EventStore({ dbPath: path });

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/portfolio-anomaly.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'timeout',
      endpoint: null,
      model: null,
      providerId: null,
      baseUrl: null,
      outputText: JSON.stringify({ ...fixture, anomaly: false, reason: null, confidence: 0.5 }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });

    const statuses: string[] = [];
    const handler = (payload: unknown) => {
      statuses.push((payload as { reasoning: { result: { status: string } } }).reasoning.result.status);
    };
    messageBus.on('llm:decision', handler);

    const agent = new PortfolioAgent(1000, undefined, {
      eventStore: store,
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies();

    messageBus.off('llm:decision', handler);

    expect(statuses).toEqual(['timeout']);
    expect(store.listDecisions({ subjectId: 'system:portfolio' })).toHaveLength(1);

    store.close();
  });

  it('defaults severity to low when omitted', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const fixture = JSON.parse(readFileSync('tests/fixtures/llm/portfolio-anomaly.json', 'utf8'));
    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.PortfolioAgent.model,
      outputText: JSON.stringify({ ...fixture, anomaly: true, severity: undefined, reason: 'drift', confidence: 0.9 })
    });

    const alertPromise = new Promise((resolve) =>
      messageBus.once('ops:alert', (payload) => resolve(payload))
    );

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({ venueIssues: [], nowMs: 123 });

    const alert = await alertPromise;
    expect(alert).toMatchObject({ severity: 'low' });
  });

  it('does not emit ops:alert when LLM returns invalid JSON', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.PortfolioAgent.model,
      outputText: '{'
    });

    let received: unknown = null;
    const handler = (payload: unknown) => {
      received = payload;
    };
    messageBus.on('ops:alert', handler);

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({ venueIssues: [], nowMs: Date.now() });

    messageBus.off('ops:alert', handler);

    expect(received).toBeNull();
  });

  it('logs a decision when LLM output text is null', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const llmClient = new MockLLMClient({
      defaultProviderId: 'openrouter',
      defaultBaseUrl: llmConfig.providers.openrouter.baseUrl,
      defaultTimeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs
    });
    llmClient.enqueue('PortfolioAgent', {
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.PortfolioAgent.model,
      outputText: null
    });

    let decisionReceived: unknown = null;
    const handler = (payload: unknown) => {
      decisionReceived = payload;
    };
    messageBus.on('llm:decision', handler);

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client: llmClient,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({ venueIssues: [], nowMs: 123 });

    messageBus.off('llm:decision', handler);

    expect(decisionReceived).toMatchObject({
      decision: {
        agent: 'PortfolioAgent',
        applied: false,
        output: {
          anomaly: false,
          reason: 'missing_output_text'
        }
      }
    });
  });

  it('skips anomaly analysis when portfolio LLM mode is disabled', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'disabled',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    const call = vi.fn().mockResolvedValue({
      status: 'success',
      endpoint: 'chat.completions',
      model: llmConfig.agents.PortfolioAgent.model,
      outputText: '{"anomaly":false,"severity":"low","reason":null,"confidence":0.5}'
    });

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client: { call },
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({ venueIssues: [{ type: 'missing_open_order' } as never], nowMs: 10 });

    expect(call).not.toHaveBeenCalled();
  });

  it('includes venue issue count in the anomaly prompt envelope', async () => {
    const env = loadEnv({
      LLM_ENABLED: 'true',
      LLM_PORTFOLIO_MODE: 'advisory',
      LLM_PRIMARY_API_KEY: 'zen-key',
      LLM_FALLBACK_API_KEY: 'or-key'
    });
    const llmConfig = loadLLMConfig(env);

    let capturedRequest: unknown = null;
    const client = {
      call: async (_agent: 'PortfolioAgent', request: unknown) => {
        capturedRequest = request;
        return {
          status: 'success',
          providerId: 'openrouter',
          baseUrl: llmConfig.providers.openrouter.baseUrl,
          endpoint: 'chat.completions',
          model: llmConfig.agents.PortfolioAgent.model,
          outputText: '{"anomaly":false,"severity":"low","reason":null,"confidence":0.5}',
          startedAtMs: 0,
          latencyMs: 0,
          timeoutMs: llmConfig.agents.PortfolioAgent.timeoutMs,
          maxRetries: llmConfig.retry.maxRetries,
          attempt: 1
        };
      }
    };

    const agent = new PortfolioAgent(1000, undefined, {
      llm: {
        config: llmConfig,
        client,
        promptVersion: 'test-v1',
        policyHashes: { tradePolicyHash: 'policy-hash', riskConfigHash: 'risk-hash' }
      }
    });

    await agent.analyzeAnomalies({
      venueIssues: [{ type: 'missing_open_order' } as never, { type: 'extra_open_order' } as never],
      nowMs: 42
    });

    const request = capturedRequest as {
      messages?: Array<{ role: string; content: string }>;
      max_tokens?: number;
      response_format?: { type?: string };
    };
    const payload = JSON.parse(request.messages?.find((msg) => msg.role === 'user')?.content ?? '{}') as {
      inputs?: { snapshot?: { venue_issues_count?: number } };
    };
    expect(payload.inputs?.snapshot?.venue_issues_count).toBe(2);
    expect(request.max_tokens).toBe(300);
    expect(request.response_format).toEqual({ type: 'json_object' });
  });
});
