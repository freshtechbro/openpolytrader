import { describe, it, expect } from 'vitest';

import { DEFAULT_CAPITAL_CONFIG } from '../../src/config/capital.js';

describe('capital config', () => {
  it('exports sane defaults', () => {
    expect(DEFAULT_CAPITAL_CONFIG.source).toBe('rpc_usdc');
    expect(DEFAULT_CAPITAL_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
  });
});

