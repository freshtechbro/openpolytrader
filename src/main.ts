import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import { startRuntime } from './boot/runtime.js';
import { writeCliFailure } from './utils/cliFailure.js';

export { startRuntime } from './boot/runtime.js';

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  void startRuntime().catch((error) => {
    writeCliFailure('Startup failed', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
    return;
  });
}
