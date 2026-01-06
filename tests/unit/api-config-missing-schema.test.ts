import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/schema.js', () => ({
  getConfigSection: () => undefined,
  buildUpdateSchema: () => {
    throw new Error('should not be called');
  },
  CONFIG_SCHEMA: { version: 'test', sections: [] }
}));

import { createOpsServer } from '../../src/api/server.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';
import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { OpsAgent } from '../../src/agents/ops/OpsAgent.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_METRICS_MAX_EVENTS = DEFAULT_ENV.METRICS_MAX_EVENTS;
const DEFAULT_ALLOWLIST_CONFIG = { autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME };

describe('ops server schema guard', () => {
  it('throws when schema sections are missing', () => {
    const metrics = new MetricsStore(DEFAULT_METRICS_MAX_EVENTS);
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    const opsAgent = new OpsAgent({ intervalMs: 1000, checks: [] }, metrics);

    expect(() =>
      createOpsServer(
        { metrics, allowlist, opsAgent },
        { incidentsLimit: 100, streamHeartbeatMs: 15000 }
      )
    ).toThrow(/schema missing/);
  });
});
