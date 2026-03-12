import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMessageBus } from '../../src/core/MessageBus.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('../../src/services/llm/LLMDecisionLogger.js');
});

describe('AgentLlm', () => {
  it('attaches the agent, parses JSON responses, and logs decisions with provider fallback metadata', async () => {
    const logLLMDecision = vi.fn();
    vi.doMock('../../src/services/llm/LLMDecisionLogger.js', () => ({
      logLLMDecision
    }));

    const { callAgentJson, logAgentDecision, withAgent } = await import('../../src/services/llm/AgentLlm.js');
    const llm = withAgent('ScannerAgent', {
      config: {
        providers: { mock: { baseUrl: 'https://llm.example.com' } },
        agents: { ScannerAgent: { model: 'scanner-model', provider: 'mock', mode: 'advisory' } }
      },
      client: {
        call: vi.fn(async () => ({
          status: 'ok',
          providerId: 'mock',
          endpoint: 'chat.completions',
          model: 'scanner-model',
          outputText: '{"priority_score":0.9}'
        }))
      },
      promptVersion: 'scanner-v1',
      policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' }
    });

    const result = await callAgentJson(
      llm,
      { endpoint: 'chat.completions', model: 'scanner-model', messages: [] },
      {
        safeParse(input: unknown) {
          if (input && typeof input === 'object' && 'priority_score' in input) {
            return { success: true as const, data: input as { priority_score: number } };
          }
          return { success: false as const };
        }
      },
      1_700_000_000_100
    );

    expect(result.missingOutput).toBe(false);
    expect(result.validated).toEqual({
      success: true,
      data: { priority_score: 0.9 }
    });

    logAgentDecision(llm, {
      mode: 'advisory',
      task: 'score_market',
      subject: 'opp-1',
      baseline: { deterministic_priority: 0.1 },
      output: { priority_score: 0.9 },
      confidence: 0.8,
      applied: true,
      clamp: { raw: result.parsed, final: { priority_score: 0.9 }, violations: [] },
      nowMs: 1_700_000_000_100,
      call: result.call,
      request: { endpoint: 'chat.completions', model: 'scanner-model', messages: [] },
      promptEnvelopeForHash: { task: 'score_market' },
      contextForHash: { deterministic_priority: 0.1 },
      messageBus: createMessageBus()
    });

    expect(logLLMDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'ScannerAgent',
        promptVersion: 'scanner-v1',
        policyHashes: { tradePolicyHash: 'trade', riskConfigHash: 'risk' },
        providerFallback: {
          providerId: 'mock',
          baseUrl: 'https://llm.example.com',
          endpoint: 'chat.completions',
          model: 'scanner-model'
        }
      })
    );
  });
});
