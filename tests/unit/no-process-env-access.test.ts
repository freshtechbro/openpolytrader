import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './sourceFileWalker.js';

describe('env access centralization', () => {
  it('does not access process.env outside src/config/env.ts', { timeout: 30_000 }, () => {
    const root = process.cwd();
    const srcRoot = path.join(root, 'src');
    const files = collectSourceFiles(srcRoot, /\.ts$/);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const normalized = path.normalize(file);
      if (
        normalized.endsWith(path.normalize('src/config/env.ts')) ||
        normalized.includes(path.normalize('src/config/env/'))
      ) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      if (!source.includes('process.env')) continue;

      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.includes('process.env')) continue;
        offenders.push({
          file: path.relative(root, file),
          line: index + 1,
          text: line.trim()
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
