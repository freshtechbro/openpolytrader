import { describe, it, expect } from 'vitest';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { createOpsServer } from '../../src/api/server.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_ALLOWLIST_CONFIG = { autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME };
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;

describe('OpsAgent integration', () => {
  it('records health events into metrics', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const agent = new OpsAgent(
      {
        intervalMs: 1000,
        checks: [
          {
            name: 'ping',
            check: async () => ({ ok: true, info: 'ok' })
          }
        ]
      },
      metrics
    );

    const eventPromise = new Promise((resolve) =>
      metrics.once('event', (event) => resolve(event))
    );

    agent.start();
    const event = (await eventPromise) as { type: string };
    agent.stop();

    expect(event.type).toBe('health');
  });
});

describe('Ops API auth', () => {
  const token = 'test-ops-token';
  const incidentsLimit = 100;
  const streamHeartbeatMs = 15000;

  function buildServer() {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    return createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: token, incidentsLimit, streamHeartbeatMs }
    );
  }

  it('rejects requests without a token', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts bearer auth tokens', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('accepts x-ops-token headers', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-ops-token': token }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('accepts token query parameters', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: `/health?token=${token}`
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('rejects stream requests without a token', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/stream' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts stream requests with token query parameters', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: `/stream?token=${token}&once=1`
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('stream_connected');
    await app.close();
  });

  it('resumes quarantined markets via allowlist endpoint', async () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    const app = createOpsServer(
      { metrics, allowlist, opsAgent },
      { authToken: token, incidentsLimit, streamHeartbeatMs }
    );

    allowlist.quarantine('market-1', 60000, 'test');

    const response = await app.inject({
      method: 'POST',
      url: '/allowlist/market-1/resume',
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(allowlist.getStatus('market-1')?.status).toBe('allowed');

    await app.close();
  });
});
