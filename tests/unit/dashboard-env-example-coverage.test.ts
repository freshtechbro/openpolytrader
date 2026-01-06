import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function parseEnvExampleKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

describe('dashboard/.env.example coverage', () => {
  it('includes all VITE_* keys referenced by dashboard config', () => {
    const configPath = path.resolve(process.cwd(), 'dashboard/src/lib/dashboardConfig.ts');
    const configSource = readFileSync(configPath, 'utf8');
    const viteKeys = [...new Set(configSource.match(/VITE_[A-Z0-9_]+/g) ?? [])].sort();

    const envPath = path.resolve(process.cwd(), 'dashboard/.env.example');
    const envSource = readFileSync(envPath, 'utf8');
    const envKeys = parseEnvExampleKeys(envSource);

    const missing = viteKeys.filter((key) => !envKeys.has(key));
    expect(missing).toEqual([]);
  });
});
