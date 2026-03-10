import { readdirSync } from 'node:fs';
import path from 'node:path';

export function collectSourceFiles(rootDir: string, matcher: RegExp): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && matcher.test(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}
