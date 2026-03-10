import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './sourceFileWalker.js';

const URL_LITERAL = /\bhttps?:\/\/|\bwss?:\/\//;

describe('no hard-coded URL literals in dashboard runtime code', () => {
  it('uses VITE env or relative paths', { timeout: 30_000 }, () => {
    const root = process.cwd();
    const srcRoot = path.join(root, 'dashboard', 'src');
    const files = collectSourceFiles(srcRoot, /\.(ts|tsx)$/);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!URL_LITERAL.test(source)) continue;

      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!URL_LITERAL.test(line)) continue;
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
