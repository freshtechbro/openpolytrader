import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './sourceFileWalker.js';

describe('dashboard env access centralization', () => {
  it('does not access import.meta.env outside dashboardConfig.ts', { timeout: 30_000 }, () => {
    const root = process.cwd();
    const srcRoot = path.join(root, 'dashboard', 'src');
    const files = collectSourceFiles(srcRoot, /\.(ts|tsx)$/);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (path.normalize(file).endsWith(path.normalize('dashboard/src/lib/dashboardConfig.ts'))) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      if (!source.includes('import.meta.env')) continue;

      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.includes('import.meta.env')) continue;
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
