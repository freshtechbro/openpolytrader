import { describe, it, expect } from 'vitest';

import { MarketAllowlist } from '../../src/domain/allowlist.js';

describe('MarketAllowlist', () => {
  it('quarantines and re-allows after cooldown', () => {
    const allowlist = new MarketAllowlist();
    allowlist.allow('m1');
    allowlist.quarantine('m1', 1000, 'test');

    const now = Date.now();
    expect(allowlist.isAllowed('m1', now)).toBe(false);
    expect(allowlist.isAllowed('m1', now + 1001)).toBe(true);
  });
});
