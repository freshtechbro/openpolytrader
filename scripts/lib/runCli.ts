import { pathToFileURL } from 'node:url';

function isEntrypoint(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && importMetaUrl === pathToFileURL(entry).href;
}

export function runCliMain(
  importMetaUrl: string,
  main: () => Promise<void>,
  handleError: (error: unknown) => void
): void {
  if (!isEntrypoint(importMetaUrl)) {
    return;
  }
  void main().catch(handleError);
}
