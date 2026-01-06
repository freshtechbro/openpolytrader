import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_SCHEMA_KEYS } from '../../src/config/env.js';

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

describe('.env.example coverage', () => {
  it('includes all env schema keys', () => {
    const filePath = path.resolve(process.cwd(), '.env.example');
    const example = readFileSync(filePath, 'utf8');
    const keys = parseEnvExampleKeys(example);

    const missing = ENV_SCHEMA_KEYS.filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it('does not include unknown keys', () => {
    const filePath = path.resolve(process.cwd(), '.env.example');
    const example = readFileSync(filePath, 'utf8');
    const keys = [...parseEnvExampleKeys(example)].sort();

    const known = new Set(ENV_SCHEMA_KEYS);
    const unknown = keys.filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });
});
