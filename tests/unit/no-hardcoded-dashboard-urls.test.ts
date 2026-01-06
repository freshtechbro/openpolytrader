import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const URL_LITERAL = /\bhttps?:\/\/|\bwss?:\/\//;

describe('no hard-coded URL literals in dashboard runtime code', () => {
  it('uses VITE env or relative paths', () => {
    const root = process.cwd();
    const srcRoot = path.join(root, 'dashboard', 'src');
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(fullPath)) continue;
        files.push(fullPath);
      }
    };

    walk(srcRoot);

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
