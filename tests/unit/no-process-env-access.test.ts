import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('env access centralization', () => {
  it('does not access process.env outside src/config/env.ts', () => {
    const root = process.cwd();
    const srcRoot = path.join(root, 'src');
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!fullPath.endsWith('.ts')) continue;
        files.push(fullPath);
      }
    };

    walk(srcRoot);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (path.normalize(file).endsWith(path.normalize('src/config/env.ts'))) continue;
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

