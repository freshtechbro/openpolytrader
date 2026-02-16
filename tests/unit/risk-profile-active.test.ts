import { describe, it, expect, vi } from 'vitest';

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadActiveRiskProfile,
  persistActiveRiskProfile,
  resolveActiveRiskProfilePath,
  loadRiskProfile,
  resolveRiskProfilePath,
  resolveRiskProfilePathCandidates,
  isRiskProfileId
} from '../../src/config/riskProfile.js';

const repoRoot = process.cwd();

function withTempCwd<T>(fn: (cwd: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'risk-profile-'));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  try {
    return fn(tempDir);
  } finally {
    cwdSpy.mockRestore();
  }
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

function withArgv<T>(argv: string[], fn: () => T): T {
  const original = process.argv;
  process.argv = argv;
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

describe('risk profile active persistence', () => {
  it('persists and loads active profile selection', () =>
    withTempCwd(() => {
      const selection = persistActiveRiskProfile({
        id: 'moderate',
        source: '/tmp/moderate.json'
      });
      const path = resolveActiveRiskProfilePath();
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { id?: string; source?: string; updatedAt?: string };

      expect(parsed.id).toBe('moderate');
      expect(parsed.source).toBe('/tmp/moderate.json');
      expect(typeof parsed.updatedAt).toBe('string');
      expect(selection.updatedAt).toBe(parsed.updatedAt);

      const loaded = loadActiveRiskProfile();
      expect(loaded?.id).toBe('moderate');
      expect(loaded?.source).toBe('/tmp/moderate.json');
      expect(loaded?.updatedAt).toBe(parsed.updatedAt);
    }));

  it('persists active profile to override path when provided', () =>
    withTempCwd((cwd) =>
      withArgv(['node', 'script'], () => {
        const overridePath = resolve(cwd, 'data', 'risk-gates', 'active.json');
        persistActiveRiskProfile(
          { id: 'moderate', source: '/tmp/moderate.json' },
          overridePath
        );

        const raw = readFileSync(overridePath, 'utf8');
        const parsed = JSON.parse(raw) as { id?: string; source?: string };
        expect(parsed.id).toBe('moderate');
        expect(parsed.source).toBe('/tmp/moderate.json');
      })));

  it('loads active profile from override path ahead of defaults', () =>
    withTempCwd((cwd) =>
      withArgv(['node', 'script'], () => {
        const overridePath = resolve(cwd, 'data', 'risk-gates', 'active.json');
        const defaultPath = resolve(cwd, 'settings', 'risk-gates', 'active.json');
        writeJson(defaultPath, { id: 'near_zero' });
        writeJson(overridePath, { id: 'high', source: '/tmp/high.json' });

        const loaded = loadActiveRiskProfile(overridePath);
        expect(loaded?.id).toBe('high');
        expect(loaded?.source).toBe('/tmp/high.json');
      })));

  it('returns null when override path is missing', () =>
    withTempCwd(() => {
      const loaded = loadActiveRiskProfile('missing/active.json');
      expect(loaded).toBeNull();
    }));

  it('resolves active profile override paths from cwd when the relative file exists', () =>
    withTempCwd((cwd) => {
      const relativePath = 'custom/active.json';
      const absolutePath = resolve(cwd, relativePath);
      writeJson(absolutePath, { id: 'high' });
      const resolved = resolveActiveRiskProfilePath(relativePath);
      expect(resolved).toBe(absolutePath);
      expect(loadActiveRiskProfile(relativePath)?.id).toBe('high');
    }));

  it('loads active profile override from repo root when cwd is missing', () =>
    withTempCwd(() => {
      const relativePath = 'tmp/risk-profile-active-test.json';
      const repoPath = resolve(repoRoot, relativePath);
      writeJson(repoPath, { id: 'moderate', source: '/tmp/moderate.json' });

      try {
        const loaded = loadActiveRiskProfile(relativePath);
        expect(loaded?.id).toBe('moderate');
        expect(loaded?.source).toBe('/tmp/moderate.json');
      } finally {
        rmSync(repoPath, { force: true });
      }
    }));

  it('normalizes persisted source to repo-relative when under project root', () =>
    withTempCwd(() => {
      const source = resolve(repoRoot, 'settings', 'risk-gates', 'near_zero.json');
      const selection = persistActiveRiskProfile({
        id: 'near_zero',
        source
      });

      expect(selection.source).toBe('settings/risk-gates/near_zero.json');

      const path = resolveActiveRiskProfilePath();
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { source?: string };
      expect(parsed.source).toBe('settings/risk-gates/near_zero.json');
    }));

  it('persists active profile without source', () =>
    withTempCwd(() => {
      const selection = persistActiveRiskProfile({ id: 'near_zero' });
      const path = resolveActiveRiskProfilePath();
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { source?: string };
      expect(selection.source).toBeUndefined();
      expect(parsed.source).toBeUndefined();
    }));

  it('keeps relative source when not under project root', () =>
    withTempCwd(() => {
      const selection = persistActiveRiskProfile({ id: 'near_zero', source: 'custom/relative.json' });
      const path = resolveActiveRiskProfilePath();
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { source?: string };
      expect(selection.source).toBe('custom/relative.json');
      expect(parsed.source).toBe('custom/relative.json');
    }));

  it('throws on invalid active profile JSON', () =>
    withTempCwd(() => {
      const path = resolveActiveRiskProfilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{bad json', 'utf8');
      expect(() => loadActiveRiskProfile()).toThrow(/Invalid active risk profile JSON/);
    }));

  it('throws on invalid active profile id', () =>
    withTempCwd(() => {
      const path = resolveActiveRiskProfilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ id: 'unknown' }), 'utf8');
      expect(() => loadActiveRiskProfile()).toThrow(/unknown id/);
    }));

  it('throws when active profile is not an object', () =>
    withTempCwd(() => {
      const path = resolveActiveRiskProfilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(['near_zero']), 'utf8');
      expect(() => loadActiveRiskProfile()).toThrow(/expected object/);
    }));

  it('throws when active profile source is invalid', () =>
    withTempCwd(() => {
      const path = resolveActiveRiskProfilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ id: 'near_zero', source: 123 }), 'utf8');
      expect(() => loadActiveRiskProfile()).toThrow(/source must be a string/);
    }));

  it('throws when active profile updatedAt is invalid', () =>
    withTempCwd(() => {
      const path = resolveActiveRiskProfilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ id: 'near_zero', updatedAt: 123 }), 'utf8');
      expect(() => loadActiveRiskProfile()).toThrow(/updatedAt must be a string/);
    }));

  it('resolves active profile path to repo root when not in test runtime', () =>
    withArgv(['node', 'script'], () => {
      const path = resolveActiveRiskProfilePath();
      expect(path.endsWith('/settings/risk-gates/active.json')).toBe(true);
    }));

  it('loads active profile from cwd when not in test runtime', () =>
    withTempCwd((cwd) =>
      withArgv(['node', 'script'], () => {
        const path = join(cwd, 'settings', 'risk-gates', 'active.json');
        writeJson(path, { id: 'moderate', source: '/tmp/moderate.json' });
        const loaded = loadActiveRiskProfile();
        expect(loaded?.id).toBe('moderate');
        expect(loaded?.source).toBe('/tmp/moderate.json');
        expect(path.startsWith(cwd)).toBe(true);
      })));

  it('returns null for missing active profile when cwd matches module root', () =>
    withArgv(['node', 'script'], () => {
      const moduleActivePath = resolveActiveRiskProfilePath();
      const repoRoot = dirname(dirname(dirname(moduleActivePath)));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
      let restorePath: string | null = null;

      if (existsSync(moduleActivePath)) {
        restorePath = `${moduleActivePath}.bak-${Date.now()}`;
        renameSync(moduleActivePath, restorePath);
      }

      try {
        const loaded = loadActiveRiskProfile();
        expect(loaded).toBeNull();
      } finally {
        cwdSpy.mockRestore();
        if (restorePath) {
          renameSync(restorePath, moduleActivePath);
        }
      }
    }));
});

describe('risk profile loading', () => {
  it('identifies valid risk profile ids', () => {
    expect(isRiskProfileId('near_zero')).toBe(true);
    expect(isRiskProfileId('bogus')).toBe(false);
  });

  it('loads profile from override path', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'custom.json');
      writeJson(path, { policy: { edgeRequired: 0.01 }, risk: { maxUnwindLossTicks: 4 } });
      const loaded = loadRiskProfile('high', path);
      expect(loaded?.id).toBe('high');
      expect(loaded?.source).toBe(path);
      expect(loaded?.policy.edgeRequired).toBe(0.01);
      expect(loaded?.risk.maxUnwindLossTicks).toBe(4);
    }));

  it('resolves relative override path from cwd when present', () =>
    withTempCwd((cwd) => {
      const relativePath = 'custom-relative.json';
      const absolutePath = join(cwd, relativePath);
      writeJson(absolutePath, { policy: { edgeRequired: 0.03 } });
      const resolved = resolveRiskProfilePath('near_zero', relativePath);
      expect(resolved).toBe(resolve(absolutePath));
    }));

  it('resolves relative override path from repo root when cwd missing', () =>
    withTempCwd(() => {
      const relativePath = 'settings/risk-gates/near_zero.json';
      const resolved = resolveRiskProfilePath('near_zero', relativePath);
      expect(resolved).toBe(resolve(repoRoot, relativePath));
    }));

  it('falls back to cwd candidate when override path is missing', () =>
    withTempCwd((cwd) => {
      const relativePath = 'missing-profile.json';
      const resolved = resolveRiskProfilePath('near_zero', relativePath);
      expect(resolved).toBe(resolve(cwd, relativePath));
    }));

  it('defaults missing policy to empty object', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'risk-only.json');
      writeJson(path, { risk: { maxUnwindLossTicks: 2 } });
      const loaded = loadRiskProfile('near_zero', path);
      expect(loaded?.risk.maxUnwindLossTicks).toBe(2);
      expect(loaded?.policy).toEqual({});
    }));

  it('defaults missing risk to empty object', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'policy-only.json');
      writeJson(path, { policy: { edgeRequired: 0.02 } });
      const loaded = loadRiskProfile('near_zero', path);
      expect(loaded?.policy.edgeRequired).toBe(0.02);
      expect(loaded?.risk).toEqual({});
    }));

  it('resolves module root risk profile path when not in test runtime', () =>
    withTempCwd((cwd) =>
      withArgv(['node', 'script'], () => {
        const resolved = resolveRiskProfilePath('moderate');
        expect(resolved.endsWith('/settings/risk-gates/moderate.json')).toBe(true);
        expect(resolved.startsWith(cwd)).toBe(false);
      })));

  it('exposes candidate paths for risk profiles', () =>
    withArgv(['node', 'script'], () => {
      const candidates = resolveRiskProfilePathCandidates('extra_high');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some((candidate) => candidate.endsWith('/settings/risk-gates/extra_high.json'))).toBe(
        true
      );
    }));

  it('returns absolute candidate when override path is absolute', () =>
    withTempCwd((cwd) => {
      const absolutePath = resolve(cwd, 'override.json');
      writeJson(absolutePath, { policy: { edgeRequired: 0.01 } });
      const candidates = resolveRiskProfilePathCandidates('near_zero', absolutePath);
      expect(candidates).toEqual([resolve(absolutePath)]);
    }));

  it('returns a single override candidate when cwd and repo root resolve identically', () =>
    withArgv(['node', 'script'], () => {
      const moduleActivePath = resolveActiveRiskProfilePath();
      const moduleRoot = dirname(dirname(dirname(moduleActivePath)));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(moduleRoot);
      try {
        const candidates = resolveRiskProfilePathCandidates('near_zero', 'settings/risk-gates/near_zero.json');
        expect(candidates).toEqual([resolve(moduleRoot, 'settings/risk-gates/near_zero.json')]);
      } finally {
        cwdSpy.mockRestore();
      }
    }));

  it('uses single risk profile candidate when cwd matches module root', () =>
    withArgv(['node', 'script'], () => {
      const moduleActivePath = resolveActiveRiskProfilePath();
      const repoRoot = dirname(dirname(dirname(moduleActivePath)));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
      try {
        const resolved = resolveRiskProfilePath('near_zero');
        expect(resolved).toBe(resolve(repoRoot, 'settings', 'risk-gates', 'near_zero.json'));
      } finally {
        cwdSpy.mockRestore();
      }
    }));

  it('returns null when default profile is missing', () =>
    withTempCwd(() => {
      const loaded = loadRiskProfile('near_zero');
      expect(loaded).toBeNull();
    }));

  it('throws when default profile path resolves to a directory', () =>
    withTempCwd((cwd) => {
      const profileDir = join(cwd, 'settings', 'risk-gates', 'near_zero.json');
      mkdirSync(profileDir, { recursive: true });
      expect(() => loadRiskProfile('near_zero')).toThrow(/Risk profile path is a directory/);
    }));

  it('throws when override path is missing', () =>
    withTempCwd((cwd) => {
      const missing = join(cwd, 'missing.json');
      expect(() => loadRiskProfile('near_zero', missing)).toThrow(/Risk profile path not found/);
    }));

  it('throws on invalid profile JSON', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'bad.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{oops', 'utf8');
      expect(() => loadRiskProfile('near_zero', path)).toThrow(/Invalid risk profile JSON/);
    }));

  it('throws when profile is not an object', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'array.json');
      writeJson(path, []);
      expect(() => loadRiskProfile('near_zero', path)).toThrow(/expected object/);
    }));

  it('throws when policy is invalid', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'bad-policy.json');
      writeJson(path, { policy: 'nope' });
      expect(() => loadRiskProfile('near_zero', path)).toThrow(/policy must be an object/);
    }));

  it('throws when risk is invalid', () =>
    withTempCwd((cwd) => {
      const path = join(cwd, 'bad-risk.json');
      writeJson(path, { risk: 'nope' });
      expect(() => loadRiskProfile('near_zero', path)).toThrow(/risk must be an object/);
    }));

  it('resolves default risk profile path', () =>
    withTempCwd(() => {
      const path = resolveRiskProfilePath('moderate');
      expect(path.endsWith('/settings/risk-gates/moderate.json')).toBe(true);
    }));
});
