import { describe, it, expect } from 'vitest';

import { MarketAllowlist } from '../../src/domain/allowlist.js';
import { loadEnv } from '../../src/config/env.js';

const DEFAULT_ENV = loadEnv({});
const DEFAULT_ALLOWLIST_CONFIG = { autoResume: DEFAULT_ENV.ALLOWLIST_AUTO_RESUME };

describe('MarketAllowlist', () => {
  it('quarantines and re-allows after cooldown', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    allowlist.allow('m1');
    allowlist.quarantine('m1', 1000, 'test');

    const now = Date.now();
    expect(allowlist.isAllowed('m1', now)).toBe(false);
    expect(allowlist.isAllowed('m1', now + 1001)).toBe(true);
    expect(allowlist.getStatus('m1', now + 1001)?.status).toBe('allowed');
  });

  it('keeps quarantined markets when auto-resume is disabled', () => {
    const allowlist = new MarketAllowlist({ autoResume: false });
    allowlist.allow('m1');
    allowlist.quarantine('m1', 1000, 'test');

    const now = Date.now();
    expect(allowlist.isAllowed('m1', now + 1001)).toBe(false);
    expect(allowlist.getStatus('m1', now + 1001)?.status).toBe('quarantined');
  });

  it('blocks markets explicitly', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    allowlist.allow('m1');
    allowlist.block('m1', 'risk');

    expect(allowlist.isAllowed('m1')).toBe(false);
    expect(allowlist.getStatus('m1')?.status).toBe('blocked');
  });

  it('returns allowed entries', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    allowlist.allow('m1');

    expect(allowlist.isAllowed('m1')).toBe(true);
    expect(allowlist.getStatus('m1')?.status).toBe('allowed');
  });

  it('seeds allowlist entries', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    allowlist.seed(['m1', 'm2']);

    const entries = allowlist.list();
    expect(entries.length).toBe(2);
  });

  it('handles unknown entry states safely', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    (allowlist as unknown as { entries: Map<string, unknown> }).entries.set('m1', {
      status: 'unknown'
    });

    expect(allowlist.isAllowed('m1')).toBe(false);
  });

  it('auto-resumes quarantined entries when configured', () => {
    const allowlist = new MarketAllowlist({ autoResume: true });
    (allowlist as unknown as { entries: Map<string, unknown> }).entries.set('m1', {
      status: 'quarantined',
      until: Date.now() - 1
    });

    expect(allowlist.getStatus('m1')?.status).toBe('allowed');
  });

  it('auto-resumes via getStatus after cooldown', () => {
    const allowlist = new MarketAllowlist({ autoResume: true });
    allowlist.allow('m1');
    const start = Date.now();
    allowlist.quarantine('m1', 5, 'test');

    const status = allowlist.getStatus('m1', start + 1000);
    expect(status?.status).toBe('allowed');
  });

  it('returns null when auto-resume cannot restore an entry', () => {
    const allowlist = new MarketAllowlist({ autoResume: true });
    (allowlist as unknown as { entries: Map<string, unknown> }).entries.set('m1', {
      status: 'quarantined',
      until: Date.now() - 1
    });
    (allowlist as unknown as { allow: (key: string) => void }).allow = () => {
      (allowlist as unknown as { entries: Map<string, unknown> }).entries.delete('m1');
    };

    expect(allowlist.getStatus('m1')).toBeNull();
  });

  it('returns null for unknown entries', () => {
    const allowlist = new MarketAllowlist(DEFAULT_ALLOWLIST_CONFIG);
    expect(allowlist.getStatus('missing')).toBeNull();
    expect(allowlist.isAllowed('missing')).toBe(false);
  });
});
