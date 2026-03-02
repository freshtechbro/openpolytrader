import { describe, expect, it, vi } from 'vitest';

import { createDependencyLLMExtractor } from '../../src/agents/dependency/DependencyLLMExtractor.js';
import { loadEnv } from '../../src/config/env.js';
import { loadLLMConfig } from '../../src/config/llm.js';
import type { DependencyMarketInput } from '../../src/domain/dependency.js';
import type { LLMCallResult, LLMRequest } from '../../src/services/llm/types.js';

const MARKETS: DependencyMarketInput[] = [
  {
    marketId: 'm-1',
    question: 'Will candidate A win?',
    category: 'politics',
    tags: ['election', 'usa']
  },
  {
    marketId: 'm-2',
    question: 'Will not candidate A win?',
    category: 'politics',
    tags: ['election', 'usa']
  },
  {
    marketId: 'm-3',
    question: 'Will turnout exceed 65%?',
    category: 'politics',
    tags: ['turnout', 'usa']
  }
];

describe('DependencyLLMExtractor', () => {
  it('sanitizes and deduplicates LLM edges', async () => {
    const llmConfig = createLlmConfig();
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) => {
      return makeCallResult(
        JSON.stringify({
          edges: [
            {
              marketA: 'm-2',
              marketB: 'm-1',
              relationType: 'mutual_exclusive',
              confidence: 0.6,
              evidence: 'first'
            },
            {
              marketA: 'm-1',
              marketB: 'm-2',
              relationType: 'mutual_exclusive',
              confidence: 0.9,
              evidence: 'better'
            },
            {
              marketA: 'm-1',
              marketB: 'unknown',
              relationType: 'complementary',
              confidence: 0.8,
              evidence: 'unknown_market'
            },
            {
              marketA: 'm-3',
              marketB: 'm-3',
              relationType: 'partition',
              confidence: 1,
              evidence: 'self_edge'
            }
          ]
        }),
        request.model
      );
    });
    const metricsRecord = vi.fn();
    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' },
      metrics: { record: metricsRecord }
    });

    const nowMs = 100_000;
    const extraction = await extractor(MARKETS, nowMs);
    const edges = extraction.edges;

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(extraction.reason).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      marketA: 'm-1',
      marketB: 'm-2',
      relationType: 'mutual_exclusive',
      confidence: 0.9,
      source: 'llm',
      extractedAtMs: nowMs
    });
    expect(metricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({ event: 'llm_extraction', reason: 'ok', edgeCount: 1 })
      })
    );
    expect(llmCall.mock.calls[0]?.[1]).toMatchObject({
      endpoint: 'chat.completions',
      model: llmConfig.agents.ScannerAgent.model
    });
  });

  it('runs extraction in shadow mode so FW hybrid can use LLM edges', async () => {
    const llmConfig = createLlmConfig({ LLM_SCANNER_MODE: 'shadow' });
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) => {
      return makeCallResult(
        JSON.stringify({
          edges: [
            {
              marketA: 'm-1',
              marketB: 'm-2',
              relationType: 'mutual_exclusive',
              confidence: 0.81,
              evidence: 'shadow_mode_edge'
            }
          ]
        }),
        request.model
      );
    });

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' }
    });

    const extraction = await extractor(MARKETS, 200_000);
    const edges = extraction.edges;
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(extraction.reason).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      marketA: 'm-1',
      marketB: 'm-2',
      relationType: 'mutual_exclusive',
      confidence: 0.81
    });
  });

  it('returns no edges when scanner LLM mode is disabled', async () => {
    const llmConfig = createLlmConfig({ LLM_SCANNER_MODE: 'disabled' });
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) =>
      makeCallResult('{"edges":[]}', request.model)
    );

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' }
    });

    const extraction = await extractor(MARKETS, 200_100);
    expect(extraction.edges).toEqual([]);
    expect(extraction.reason).toBe('llm_disabled');
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('returns no edges for insufficient market input and when LLM is disabled', async () => {
    const advisoryConfig = createLlmConfig();
    const callSpy = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) =>
      makeCallResult('{"edges":[]}', request.model)
    );
    const extractor = createDependencyLLMExtractor({
      llmConfig: advisoryConfig,
      llmClient: { call: callSpy },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' }
    });

    expect(await extractor([MARKETS[0]], 210_000)).toEqual({
      edges: [],
      reason: 'insufficient_markets'
    });
    expect(callSpy).not.toHaveBeenCalled();

    const disabledConfig = createLlmConfig({ LLM_ENABLED: 'false' });
    const disabledCallSpy = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) =>
      makeCallResult('{"edges":[]}', request.model)
    );
    const disabledExtractor = createDependencyLLMExtractor({
      llmConfig: disabledConfig,
      llmClient: { call: disabledCallSpy },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' }
    });

    expect(await disabledExtractor(MARKETS, 220_000)).toEqual({
      edges: [],
      reason: 'llm_disabled'
    });
    expect(disabledCallSpy).not.toHaveBeenCalled();
  });

  it('handles missing output text and root-array payloads', async () => {
    const llmConfig = createLlmConfig();
    const metricsRecord = vi.fn();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce(makeCallResult(null, llmConfig.agents.ScannerAgent.model))
      .mockResolvedValueOnce(
        makeCallResult(
          JSON.stringify([
            {
              marketA: 'm-1',
              marketB: 'm-3',
              relationType: 'complementary',
              confidence: 2
            }
          ]),
          llmConfig.agents.ScannerAgent.model
        )
      );

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' },
      metrics: { record: metricsRecord }
    });

    const first = await extractor(MARKETS, 230_000);
    expect(first.edges).toEqual([]);
    expect(first.reason).toBe('missing_output_text');
    expect(metricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({ reason: 'missing_output_text', edgeCount: 0 })
      })
    );

    const second = await extractor(MARKETS, 231_000);
    const edges = second.edges;
    expect(second.reason).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      marketA: 'm-1',
      marketB: 'm-3',
      relationType: 'complementary',
      confidence: 1,
      evidence: 'llm_dependency_extraction',
      extractedAtMs: 231_000
    });
  });

  it('normalizes missing market metadata fields in prompt payload', async () => {
    const llmConfig = createLlmConfig();
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) =>
      makeCallResult('{"edges":[]}', request.model)
    );
    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' }
    });

    await extractor([{ marketId: 'x' }, { marketId: 'y' }], 232_000);

    const request = llmCall.mock.calls[0]?.[1];
    expect(request?.endpoint).toBe('chat.completions');
    if (!request || request.endpoint !== 'chat.completions') {
      throw new Error('expected_chat_completions_request');
    }

    const userMessage = request.messages.find((message) => message.role === 'user');
    const payload = JSON.parse(userMessage?.content ?? '{}') as {
      inputs?: { markets?: Array<{ question: string | null; category: string | null; tags: unknown[] }> };
    };
    expect(payload.inputs?.markets?.[0]).toMatchObject({
      question: null,
      category: null,
      tags: []
    });
  });

  it('falls back to empty output on invalid json payloads', async () => {
    const llmConfig = createLlmConfig();
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) =>
      makeCallResult('{"not_edges":[1,2,3]}', request.model)
    );
    const metricsRecord = vi.fn();

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' },
      metrics: { record: metricsRecord }
    });

    const extraction = await extractor(MARKETS, 300_000);
    expect(extraction.edges).toEqual([]);
    expect(extraction.reason).toBe('invalid_output');
    expect(metricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({ event: 'llm_extraction', reason: 'invalid_output', edgeCount: 0 })
      })
    );
  });

  it('records structured error reason when llm call fails without output text', async () => {
    const llmConfig = createLlmConfig();
    const llmCall = vi.fn(async (_agent: 'ScannerAgent', request: LLMRequest, _nowMs?: number) => ({
      ...makeCallResult(null, request.model),
      status: 'error' as const,
      error: { type: 'circuit_open', message: 'circuit_open:opencode-zen' }
    }));
    const metricsRecord = vi.fn();

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' },
      metrics: { record: metricsRecord }
    });

    const extraction = await extractor(MARKETS, 301_000);
    expect(extraction.edges).toEqual([]);
    expect(extraction.reason).toBe('llm_error_circuit_open');
    expect(metricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({
          event: 'llm_extraction',
          reason: 'llm_error_circuit_open',
          edgeCount: 0
        })
      })
    );
  });

  it('backs off dependency extraction while scanner llm circuit is open', async () => {
    const llmConfig = createLlmConfig({ LLM_CB_COOLDOWN_MS: '30000' });
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({
        ...makeCallResult(null, llmConfig.agents.ScannerAgent.model),
        status: 'error' as const,
        error: { type: 'circuit_open', message: 'circuit_open:opencode-zen' }
      })
      .mockResolvedValueOnce(makeCallResult('{"edges":[]}', llmConfig.agents.ScannerAgent.model));
    const metricsRecord = vi.fn();

    const extractor = createDependencyLLMExtractor({
      llmConfig,
      llmClient: { call: llmCall },
      promptVersion: 'llm-v1',
      policyHashes: { tradePolicyHash: 'tp', riskConfigHash: 'rk' },
      metrics: { record: metricsRecord }
    });

    const first = await extractor(MARKETS, 310_000);
    expect(first.edges).toEqual([]);
    expect(first.reason).toBe('llm_error_circuit_open');
    expect(llmCall).toHaveBeenCalledTimes(1);

    const second = await extractor(MARKETS, 311_000);
    expect(second.edges).toEqual([]);
    expect(second.reason).toBe('llm_circuit_backoff');
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(metricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fw_dependency',
        data: expect.objectContaining({
          event: 'llm_extraction',
          reason: 'llm_circuit_backoff',
          edgeCount: 0
        })
      })
    );

    const third = await extractor(MARKETS, 341_100);
    expect(third.edges).toEqual([]);
    expect(third.reason).toBe('ok');
    expect(llmCall).toHaveBeenCalledTimes(2);
  });
});

function createLlmConfig(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    LLM_PRIMARY_API_KEY: 'test-key',
    ...overrides
  });
  return loadLLMConfig(env);
}

function makeCallResult(outputText: string | null, model: string): LLMCallResult {
  return {
    status: 'success',
    providerId: 'opencode-zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    endpoint: 'chat.completions',
    model,
    outputText,
    startedAtMs: 0,
    latencyMs: 1,
    timeoutMs: 1000,
    maxRetries: 0,
    attempt: 1
  };
}
