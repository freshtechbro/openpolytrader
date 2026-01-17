import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRiskProfile } from '../../src/config/riskProfile.js';

describe('risk profile override directory', () => {
  it('loads the profile JSON when override path is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-profile-'));
    const file = join(dir, 'extra_high.json');
    writeFileSync(file, JSON.stringify({ policy: { maxOrdersPerMinute: 42 } }));

    try {
      const loaded = loadRiskProfile('extra_high', dir);
      expect(loaded?.source).toBe(file);
      expect(loaded?.policy).toMatchObject({ maxOrdersPerMinute: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
