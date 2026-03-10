import { afterEach, describe, expect, it, vi } from 'vitest';

const { call, logLLMDecision } = vi.hoisted(() => ({
  call: vi.fn(async (_agent: string, request: { endpoint: string; model: string }) => ({
    status: 'ok',
    providerId: 'mock-provider',
    endpoint: request.endpoint,
    model: request.model,
    outputText: '{"ok":true}'
  })),
  logLLMDecision: vi.fn()
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({ EVENT_STORE_PATH: 'data/test.db', METRICS_MAX_EVENTS: 100 })
}));
vi.mock('../../src/config/llm.js', () => ({
  loadLLMConfig: () => ({
    enabled: true,
    providers: {
      mock: { baseUrl: 'https://llm.example.com' }
    },
    agents: {
      ExecutionAgent: { model: 'ExecutionAgent-model', provider: 'mock', mode: 'required' },
      RiskAgent: { model: 'RiskAgent-model', provider: 'mock', mode: 'required' },
      ScannerAgent: { model: 'ScannerAgent-model', provider: 'mock', mode: 'required' },
      LearningAgent: { model: 'LearningAgent-model', provider: 'mock', mode: 'required' },
      PortfolioAgent: { model: 'PortfolioAgent-model', provider: 'mock', mode: 'required' },
      MarketDataAgent: { model: 'MarketDataAgent-model', provider: 'mock', mode: 'required' },
      OpsAgent: { model: 'OpsAgent-model', provider: 'mock', mode: 'required' }
    }
  })
}));
vi.mock('../../src/services/llm/LLMClient.js', () => ({
  LLMClient: class {
    call = call;
  }
}));
vi.mock('../../src/services/llm/LLMDecisionLogger.js', () => ({
  logLLMDecision
}));

import { main } from '../../scripts/llmSmokeTest.ts';

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('llmSmokeTest script', () => {
  it('runs the LLM smoke test across every configured agent and logs the summary', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    const expectedAgents = [
      'ExecutionAgent',
      'RiskAgent',
      'ScannerAgent',
      'LearningAgent',
      'PortfolioAgent',
      'MarketDataAgent',
      'OpsAgent'
    ];

    expect(call).toHaveBeenCalledTimes(7);
    expect(logLLMDecision).toHaveBeenCalledTimes(7);
    expect(call.mock.calls.map(([agent]) => agent)).toEqual(expectedAgents);
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      endpoint: 'chat.completions',
      model: 'ExecutionAgent-model'
    });
    expect(call.mock.calls[3]?.[1]).toMatchObject({
      endpoint: 'messages',
      model: 'LearningAgent-model'
    });
    expect(logLLMDecision.mock.calls[0]?.[0]).toMatchObject({
      agent: 'ExecutionAgent',
      mode: 'required',
      task: 'smoke_test',
      baseline: { endpoint: 'chat.completions', model: 'ExecutionAgent-model' },
      providerFallback: {
        providerId: 'mock',
        baseUrl: 'https://llm.example.com',
        endpoint: 'chat.completions',
        model: 'ExecutionAgent-model'
      },
      output: { ok: true },
      confidence: 1,
      applied: false,
      call: expect.objectContaining({
        status: 'ok',
        providerId: 'mock-provider',
        endpoint: 'chat.completions',
        model: 'ExecutionAgent-model'
      })
    });
    expect(logLLMDecision.mock.calls[3]?.[0]).toMatchObject({
      agent: 'LearningAgent',
      baseline: { endpoint: 'messages', model: 'LearningAgent-model' },
      providerFallback: {
        providerId: 'mock',
        endpoint: 'messages',
        model: 'LearningAgent-model'
      }
    });
    expect(consoleLog).toHaveBeenCalledWith(
      'LLM smoke ok',
      expect.objectContaining({
        enabled: true,
        results: expect.arrayContaining([
          expect.objectContaining({ agent: 'ExecutionAgent', status: 'ok' }),
          expect.objectContaining({ agent: 'OpsAgent', status: 'ok' })
        ])
      })
    );
    expect(consoleLog.mock.calls[0]?.[1]).toMatchObject({
      enabled: true,
      results: expect.arrayContaining([
        expect.objectContaining({
          agent: 'LearningAgent',
          endpoint: 'messages',
          model: 'LearningAgent-model',
          providerId: 'mock-provider',
          status: 'ok'
        })
      ])
    });
    expect(process.exitCode).toBeUndefined();
  });
});
