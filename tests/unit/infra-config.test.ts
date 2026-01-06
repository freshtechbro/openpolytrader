import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { getInfraConfigSnapshot } from '../../src/config/infra.js';

describe('infra config snapshot', () => {
  it('builds a safe env-only snapshot without secrets', () => {
    const env = loadEnv({
      ALCHEMY_API_KEY: 'alchemy-key',
      OPS_API_TOKEN: 'secret-token',
      POLYMARKET_API_KEY: 'secret-key',
      POLYMARKET_API_SECRET: 'secret-secret',
      POLYMARKET_PASSPHRASE: 'secret-phrase'
    });

    const snapshot = getInfraConfigSnapshot(env);
    expect(snapshot.ops.streamHeartbeatMs).toBeGreaterThan(0);
    expect(snapshot.polymarket.wsHeartbeatMs).toBeGreaterThan(0);
    expect(typeof snapshot.rpc.providers.alchemy.apiKeyConfigured).toBe('boolean');

    expect((snapshot as unknown as Record<string, unknown>).OPS_API_TOKEN).toBeUndefined();
    expect(snapshot.rpc.providers.alchemy.apiKeyConfigured).toBe(true);
  });
});
