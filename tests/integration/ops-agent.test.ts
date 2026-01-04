import { describe, it, expect } from 'vitest';

import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { createOpsServer } from '../../src/api/server.js';

describe('OpsAgent integration', () => {
  it('records health events into metrics', async () => {
    const metrics = new MetricsStore();
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

  function buildServer() {
    const metrics = new MetricsStore();
    const allowlist = new MarketAllowlist();
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);
    return createOpsServer({ metrics, allowlist, opsAgent }, { authToken: token });
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
});
