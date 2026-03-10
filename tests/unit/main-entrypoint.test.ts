import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startRuntime = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/boot/runtime.js', () => ({
  startRuntime
}));

describe('main entrypoint wrapper', () => {
  const originalArgv1 = process.argv[1];

  beforeEach(() => {
    startRuntime.mockReset();
    startRuntime.mockResolvedValue(undefined);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalArgv1 === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalArgv1;
    }
  });

  it('re-exports startRuntime without booting when imported as a module', async () => {
    process.argv[1] = '/tmp/vitest-runner.js';

    const module = await import('../../src/main.js?import-safe');

    expect(module.startRuntime).toBe(startRuntime);
    expect(startRuntime).not.toHaveBeenCalled();
  });
});
