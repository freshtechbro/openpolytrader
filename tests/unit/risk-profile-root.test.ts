import { describe, it, expect, vi } from 'vitest';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function withArgv<T>(argv: string[], fn: () => T): T {
  const original = process.argv;
  process.argv = argv;
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

describe('risk profile root fallback', () => {
  it('falls back to module root when settings are missing', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      mkdirSync: () => undefined,
      readFileSync: () => '',
      writeFileSync: () => undefined
    }));

    const mod = await import('../../src/config/riskProfile.js');

    const moduleDir = dirname(
      fileURLToPath(new URL('../../src/config/riskProfile.js', import.meta.url))
    );
    const expected = resolve(moduleDir, '..', '..', 'settings', 'risk-gates', 'near_zero.json');

    withArgv(['node', 'script'], () => {
      const candidates = mod.resolveRiskProfilePathCandidates('near_zero');
      expect(candidates).toContain(expected);
    });

    vi.resetModules();
    vi.unmock('node:fs');
  });
});
