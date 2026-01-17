import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { EventStore } from '../../src/core/EventStore.js';
import { messageBus } from '../../src/core/MessageBus.js';
import { logLLMDecision } from '../../src/services/llm/LLMDecisionLogger.js';

describe('LLMDecisionLogger', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('persists decisions and uses ttl + provider fallback when needed', () => {
    const dbPath = `data/test-${randomUUID()}.db`;
    paths.push(dbPath);

    const store = new EventStore({ dbPath });
    const nowMs = Date.now();

    let emitted: unknown = null;
    messageBus.once('llm:decision', (payload) => {
      emitted = payload;
    });

    logLLMDecision({
      agent: 'OpsAgent',
      mode: 'advisory',
      task: 'unit:llm_decision_logger',
      subject: 'subject:test',
      baseline: { baseline: true },
      output: { output: true },
      confidence: 0.7,
      applied: false,
      clamp: {},
      ttlMs: 60_000,
      nowMs,
      call: {
        status: 'success',
        providerId: null,
        baseUrl: null,
        endpoint: null,
        model: null,
        outputText: '{"ok":true}',
        startedAtMs: nowMs - 10,
        latencyMs: 10,
        timeoutMs: 1000,
        maxRetries: 0,
        attempt: 0,
        requestIdHeader: 'req-header-1',
        requestIdBody: 'req-body-1',
        responseId: 'resp-1',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
      },
      request: {
        endpoint: 'responses',
        model: 'gpt-5-nano',
        input: 'hello',
        temperature: 0,
        max_output_tokens: 5
      },
      promptEnvelopeForHash: { prompt: 'v' },
      contextForHash: { context: 'v' },
      promptVersion: 'v1',
      policyHashes: { tradePolicyHash: 'trade-hash', riskConfigHash: 'risk-hash' },
      providerFallback: {
        providerId: 'opencode-zen',
        baseUrl: 'https://example.com',
        endpoint: 'responses',
        model: 'gpt-5-nano'
      },
      store
    });

    const emittedPayload = emitted as
      | {
          decision?: { ttl_ms?: number };
          reasoning?: { provider?: { provider_id?: string } };
        }
      | null
      | undefined;

    expect(emittedPayload?.decision?.ttl_ms).toBe(60_000);
    expect(emittedPayload?.reasoning?.provider?.provider_id).toBe('opencode-zen');

    const rows = store.listDecisions({ subjectId: 'subject:test' });
    expect(rows).toHaveLength(1);
    const decision = rows[0]?.decision as { ttl_ms?: number } | undefined;
    const reasoning = rows[0]?.reasoning as { provider?: { provider_id?: string } } | undefined;
    expect(decision?.ttl_ms).toBe(60_000);
    expect(reasoning?.provider?.provider_id).toBe('opencode-zen');

    store.close();
  });

  it('maps disabled status to error and emits at_ms', () => {
    const nowMs = Date.now();
    let emitted: unknown = null;

    messageBus.once('llm:decision', (payload) => {
      emitted = payload;
    });

    logLLMDecision({
      agent: 'OpsAgent',
      mode: 'disabled',
      task: 'unit:llm_decision_disabled',
      subject: 'subject:disabled',
      baseline: {},
      output: { error: 'disabled' },
      confidence: 0,
      applied: false,
      clamp: {},
      nowMs,
      call: {
        status: 'disabled',
        providerId: null,
        baseUrl: null,
        endpoint: null,
        model: null,
        outputText: null,
        startedAtMs: nowMs,
        latencyMs: 0,
        timeoutMs: 1000,
        maxRetries: 0,
        attempt: 0
      },
      request: {
        endpoint: 'chat.completions',
        model: 'gpt-5-nano',
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      },
      promptEnvelopeForHash: { prompt: 'v' },
      contextForHash: { context: 'v' },
      promptVersion: 'v1',
      policyHashes: { tradePolicyHash: 'trade-hash', riskConfigHash: 'risk-hash' },
      providerFallback: {
        providerId: 'opencode-zen',
        baseUrl: 'https://example.com',
        endpoint: 'chat.completions',
        model: 'gpt-5-nano'
      }
    });

    const payload = emitted as
      | {
          at_ms?: number;
          reasoning?: { result?: { status?: string; error?: { type?: string } } };
        }
      | null
      | undefined;

    expect(payload?.at_ms).toBe(nowMs);
    expect(payload?.reasoning?.result?.status).toBe('error');
    expect(payload?.reasoning?.result?.error?.type).toBe('disabled');
  });
});
