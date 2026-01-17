import { describe, expect, it, vi } from 'vitest';

import { MetricsStore } from '../../src/telemetry/metrics.js';
import { attachLLMDecisionStream } from '../../src/telemetry/llmDecisionStream.js';
import { messageBus } from '../../src/core/MessageBus.js';

const BASE_DECISION = {
  schema_version: 1,
  agent: 'OpsAgent',
  mode: 'advisory',
  task: 'unit:stream',
  subject: 'system:test',
  baseline: {},
  output: {},
  confidence: 0,
  applied: false,
  clamp: {}
};

const BASE_REASONING = {
  provider: {
    provider_id: 'opencode-zen',
    base_url: 'https://example.com',
    endpoint: 'responses',
    model: 'gpt-5-nano'
  },
  request_identity: {
    attempt: 0
  },
  timing: {
    started_at_ms: 0,
    latency_ms: 0,
    timeout_ms: 1,
    max_retries: 0
  },
  params: {},
  hashes: {
    prompt_hash: 'prompt-hash',
    context_hash: 'context-hash',
    prompt_version: 'v1'
  },
  result: {
    status: 'success'
  },
  policy_snapshots: {
    trade_policy_hash: 'trade-hash',
    risk_config_hash: 'risk-hash'
  },
  data_export: {
    included_trade_details: false,
    redaction_applied: true
  }
};

describe('LLM decision stream bridge', () => {
  it('emits llm_decision metric using at_ms when provided', () => {
    const metrics = new MetricsStore(10);
    const events: Array<{ type: string; timestamp: number }> = [];
    const handler = (event: { type: string; timestamp: number }) => {
      events.push(event);
    };

    metrics.on('event', handler);
    const detach = attachLLMDecisionStream(metrics);

    messageBus.emit('llm:decision', {
      decision: BASE_DECISION,
      reasoning: BASE_REASONING,
      at_ms: 123
    });

    detach();
    metrics.off('event', handler);

    expect(events[0]).toMatchObject({ type: 'llm_decision', timestamp: 123 });
  });

  it('falls back to Date.now when at_ms is missing', () => {
    const metrics = new MetricsStore(10);
    const events: Array<{ type: string; timestamp: number }> = [];
    const handler = (event: { type: string; timestamp: number }) => {
      events.push(event);
    };

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(456);

    metrics.on('event', handler);
    const detach = attachLLMDecisionStream(metrics);

    messageBus.emit('llm:decision', {
      decision: BASE_DECISION,
      reasoning: BASE_REASONING
    });

    detach();
    metrics.off('event', handler);
    nowSpy.mockRestore();

    expect(events[0]).toMatchObject({ type: 'llm_decision', timestamp: 456 });
  });
});
