import { describe, it, expect, vi } from 'vitest';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { messageBus } from '../../src/core/MessageBus.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;

describe('OpsAgent runChecks', () => {
  it('records healthy reports', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          { name: 'ok', check: async () => ({ ok: true, info: 'ok' }) }
        ]
      },
      metrics
    );

    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();
    const report = agent.getReport();

    expect(report.status).toBe('healthy');
    expect(metrics.snapshot().counts.health).toBe(1);
  });

  it('emits alerts when degraded', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          { name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }
        ]
      },
      metrics
    );

    const alertPromise = new Promise((resolve) =>
      messageBus.once('ops:alert', (payload) => resolve(payload))
    );

    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();

    const alert = await alertPromise;
    expect(alert).toMatchObject({ check: 'fail' });
    expect(metrics.snapshot().counts.incident).toBe(1);
  });

  it('posts webhook alerts when configured', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const agent = new OpsAgent(
        {
          intervalMs: 1000,
          alertWebhookUrl: 'https://example.invalid/webhook',
          checks: [{ name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }]
        },
        metrics
      );

      await agent.runOnce();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records webhook failures as error metrics', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const agent = new OpsAgent(
        {
          intervalMs: 1000,
          alertWebhookUrl: 'https://example.invalid/webhook',
          checks: [{ name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }]
        },
        metrics
      );

      await agent.runOnce();

      expect(metrics.snapshot().counts.error).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records webhook exceptions as error metrics', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network_down'));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const agent = new OpsAgent(
        {
          intervalMs: 1000,
          alertWebhookUrl: 'https://example.invalid/webhook',
          checks: [{ name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }]
        },
        metrics
      );

      await agent.runOnce();

      expect(metrics.snapshot().counts.error).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records non-error webhook exceptions as error metrics', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const fetchMock = vi.fn().mockRejectedValue('network_down');
    const originalFetch = globalThis.fetch;

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const agent = new OpsAgent(
        {
          intervalMs: 1000,
          alertWebhookUrl: 'https://example.invalid/webhook',
          checks: [{ name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }]
        },
        metrics
      );

      await agent.runOnce();

      expect(metrics.snapshot().counts.error).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps healthy checks when degraded', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          { name: 'ok', check: async () => ({ ok: true, info: 'ok' }) },
          { name: 'fail', check: async () => ({ ok: false, error: 'boom' }) }
        ]
      },
      metrics
    );

    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();
    const report = agent.getReport();

    expect(report.status).toBe('degraded');
    expect(report.checks.ok?.ok).toBe(true);
    expect(report.checks.fail?.ok).toBe(false);
  });

  it('captures thrown check errors', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          {
            name: 'boom',
            check: async () => {
              throw new Error('boom');
            }
          }
        ]
      },
      metrics
    );

    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();
    const report = agent.getReport();

    expect(report.status).toBe('degraded');
    expect(report.checks.boom?.error).toBe('boom');
  });

  it('handles non-error throws as unknown', async () => {
    const agent = new OpsAgent({
      intervalMs: 1000,
      checks: [
        {
          name: 'unknown',
          check: async () => {
            throw 'boom';
          }
        }
      ]
    });

    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();
    const report = agent.getReport();

    expect(report.checks.unknown?.error).toBe('unknown_error');
  });

  it('start and stop are idempotent', () => {
    const agent = new OpsAgent({ intervalMs: 1000, checks: [] });

    agent.stop();
    agent.start();
    agent.start();
    agent.stop();
    agent.stop();

    expect(agent.getReport().status).toBe('healthy');
  });

  it('reuses an existing outlier handler when already set', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const existingHandler = vi.fn();

    messageBus.on('marketdata:outlier', existingHandler);
    try {
      (agent as unknown as { outlierHandler: typeof existingHandler }).outlierHandler = existingHandler;
      agent.start();
      messageBus.emit('marketdata:outlier', { tokenId: 't1' });
      expect(existingHandler).toHaveBeenCalledTimes(1);
      agent.stop();
      messageBus.emit('marketdata:outlier', { tokenId: 't1' });
      expect(existingHandler).toHaveBeenCalledTimes(1);
    } finally {
      messageBus.off('marketdata:outlier', existingHandler);
    }
  });

  it('records outlier telemetry with the default outlier handler', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    try {
      agent.start();
      messageBus.emit('marketdata:outlier', { tokenId: 't1', score: 0.99 });
      const events = metrics.recent('info', 5);
      expect(events.some((event) => (event.data as { message?: string }).message === 'marketdata_outlier')).toBe(
        true
      );
    } finally {
      agent.stop();
    }
  });

  it('supports updating checks at runtime', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    agent.setChecks([{ name: 'ok', check: async () => ({ ok: true }) }]);
    await (agent as unknown as { runChecks: () => Promise<void> }).runChecks();

    expect(agent.getReport().checks.ok?.ok).toBe(true);
  });
});
