import { describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { LLMConfig } from '../../src/config/llm.js';
import type { LLMCallResult, LLMRequest } from '../../src/services/llm/types.js';
import { MarketDataAgent } from '../../src/agents/market-data/MarketDataAgent.js';

class FakeRealtime extends EventEmitter {
  async connect(): Promise<void> {
    return;
  }

  subscribeMarkets(_tokenIds: string[]): void {
    return;
  }
}

describe('MarketDataAgent LLM request selection', () => {
  it('uses chat.completions in the agent request for gpt-5 models', async () => {
    const realtime = new FakeRealtime();

    let captured: LLMRequest | null = null;

    const llmConfig: LLMConfig = {
      enabled: true,
      dataExportEnabled: false,
      fallbackEnabled: false,
      primaryRetryCount: 1,
      primaryProvider: 'opencode-zen',
      fallbackProvider: 'openrouter',
      providers: {
        'opencode-zen': { id: 'opencode-zen', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'k', defaultHeaders: {} },
        openrouter: {
          id: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'k',
          defaultHeaders: {},
          openrouter: { sort: 'latency', allowFallbacks: true }
        }
      },
      retry: { timeoutMs: 1000, maxRetries: 0 },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenSuccesses: 1 },
      agents: {
        ExecutionAgent: {
          provider: 'opencode-zen',
          model: 'kimi-k2.5',
          backupModel: 'glm-4.7',
          mode: 'disabled',
          timeoutMs: 1000
        },
        RiskAgent: {
          provider: 'opencode-zen',
          model: 'minimax-m2.1',
          backupModel: 'glm-4.7',
          mode: 'disabled',
          timeoutMs: 1000
        },
        ScannerAgent: {
          provider: 'opencode-zen',
          model: 'glm-4.7',
          backupModel: 'minimax-m2.1',
          mode: 'disabled',
          timeoutMs: 1000,
          scoreTopN: 20,
          scoreConcurrency: 3,
          shadowMinIntervalMs: 500
        },
        LearningAgent: {
          provider: 'opencode-zen',
          model: 'qwen3-coder',
          backupModel: 'glm-4.7',
          mode: 'disabled',
          timeoutMs: 1000
        },
        PortfolioAgent: {
          provider: 'opencode-zen',
          model: 'minimax-m2.1',
          backupModel: 'glm-4.7',
          mode: 'disabled',
          timeoutMs: 1000
        },
        MarketDataAgent: {
          provider: 'opencode-zen',
          model: 'gpt-5-nano',
          backupModel: 'minimax-m2.1',
          mode: 'advisory',
          timeoutMs: 1000
        },
        OpsAgent: {
          provider: 'opencode-zen',
          model: 'glm-4.7',
          backupModel: 'minimax-m2.1',
          mode: 'disabled',
          timeoutMs: 1000
        }
      }
    };

    const llmClient = {
      call: vi.fn(async (_agent: 'MarketDataAgent', request: LLMRequest): Promise<LLMCallResult> => {
        captured = request;
        return {
          status: 'success',
          providerId: 'opencode-zen',
          baseUrl: llmConfig.providers['opencode-zen'].baseUrl,
          endpoint: request.endpoint,
          model: request.model,
          outputText: null,
          startedAtMs: Date.now(),
          latencyMs: 0,
          timeoutMs: 1000,
          maxRetries: 0,
          attempt: 1
        };
      })
    };

    const agent = new MarketDataAgent(
      {
        tokenIds: ['token-1'],
        policy: DEFAULT_TRADE_POLICY,
        llm: {
          config: llmConfig,
          client: llmClient,
          promptVersion: 'test',
          policyHashes: { tradePolicyHash: 't', riskConfigHash: 'r' }
        }
      },
      {} as never,
      realtime as never
    );

    await agent.start();

    realtime.emit('message', {
      event_type: 'book',
      token_id: 'token-1',
      bids: [{ price: '0.4', size: '100' }],
      asks: [{ price: '0.6', size: '100' }],
      timestamp: '1'
    });

    await vi.waitFor(() => {
      expect(captured).not.toBeNull();
    });

    expect(captured?.endpoint).toBe('chat.completions');
    expect(captured).toMatchObject({
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });
  });
});
