import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { ExecutionAgent } from '../../src/agents/execution/ExecutionAgent.js';
import { ExecutionAdvisor } from '../../src/agents/execution/ExecutionAdvisor.js';
import { messageBus } from '../../src/core/MessageBus.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { loadEnv } from '../../src/config/env.js';
import type { PolymarketClob } from '../../src/services/PolymarketClob.js';

describe('ExecutionAgent advisory hints', () => {
  it('does not subscribe when disabled', () => {
    const advisor = new ExecutionAdvisor({ enabled: false });

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm1', signal: 'high_confidence', value: 1, ttl_ms: 60000, confidence: 0.9 }],
      generatedAtMs: Date.now()
    });

    expect(advisor.getHint('m1')).toBeNull();

    advisor.stop();
  });

  it('applies conservative timeout multiplier in advisory mode', () => {
    const env = loadEnv({});
    const metrics = new MetricsStore(env.METRICS_MAX_EVENTS);
    const advisor = new ExecutionAdvisor({ enabled: true });

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm1', signal: 'high_confidence', value: 1, ttl_ms: 60000, confidence: 0.9 }],
      generatedAtMs: Date.now()
    });

    const clob = {} as unknown as PolymarketClob;

    const agent = new ExecutionAgent(DEFAULT_TRADE_POLICY, clob, undefined, metrics, {
      tradingEnabled: false,
      tradingMode: 'paper',
      executionAdvisor: advisor,
      executionAdvisorMode: 'advisory'
    });

    const timeouts = (agent as unknown as { getEffectiveTimeouts: (marketId: string, opportunityId: string, nowMs: number) => { submitTimeoutMs: number; ackTimeoutMs: number } }).getEffectiveTimeouts(
      'm1',
      'opp-1',
      Date.now()
    );
    expect(timeouts.submitTimeoutMs).toBeLessThanOrEqual(DEFAULT_TRADE_POLICY.submitTimeoutMs);
    expect(timeouts.ackTimeoutMs).toBeLessThanOrEqual(DEFAULT_TRADE_POLICY.ackTimeoutMs);
    expect(metrics.snapshot().counts.shadow_decision).toBeGreaterThan(0);

    advisor.stop();
  });

  it('expires cached hints after ttl', () => {
    const advisor = new ExecutionAdvisor({ enabled: true });

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm1', signal: 'high_confidence', value: 0.5, ttl_ms: 10_000, confidence: 0.9 }],
      generatedAtMs: Date.now()
    });

    expect(advisor.getHint('m1')).not.toBeNull();
    expect(advisor.getHint('m1', Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(advisor.getHint('m1')).toBeNull();

    advisor.stop();
  });

  it('ignores malformed insight payloads and handles all value tiers', () => {
    const advisor = new ExecutionAdvisor({ enabled: true });

    messageBus.emit('learning:insight', { generatedAtMs: Date.now() });

    messageBus.emit('learning:insight', {
      insights: [{ signal: 'high_confidence', value: 0.9, ttl_ms: 10, confidence: 0.9 }],
      generatedAtMs: Date.now()
    });
    expect(advisor.getHint('')).toBeNull();

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm-hi', signal: 'high_confidence', value: 0.9, ttl_ms: 10000, confidence: 0.9 }],
      generatedAtMs: Date.now()
    });
    expect(advisor.getHint('m-hi')?.unwindHint).toBe('aggressive');

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm-mid', signal: 'medium_confidence', value: 0.5, ttl_ms: 10000, confidence: 0.5 }],
      generatedAtMs: Date.now()
    });
    expect(advisor.getHint('m-mid')?.unwindHint).toBe('neutral');

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm-low', signal: 'low_confidence', value: 0.1, ttl_ms: 10000, confidence: 0.1 }],
      generatedAtMs: Date.now()
    });
    expect(advisor.getHint('m-low')?.unwindHint).toBe('conservative');

    messageBus.emit('learning:insight', {
      insights: [{ market_id: 'm-defaults', signal: 'neutral', value: Number.NaN, ttl_ms: Number.NaN, confidence: Number.NaN }],
      generatedAtMs: Date.now()
    });
    const hint = advisor.getHint('m-defaults', 0);
    expect(hint).not.toBeNull();
    expect(hint?.confidence).toBe(0);

    advisor.stop();
  });
});
