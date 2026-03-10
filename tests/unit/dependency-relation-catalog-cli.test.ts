import { beforeEach, describe, expect, it, vi } from 'vitest';

const mainMock = vi.fn();

vi.mock('../../src/tools/dependencyRelationCatalog.js', () => ({
  main: mainMock
}));

const flushMicrotasks = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('dependency relation catalog CLI wrapper', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    mainMock.mockReset();
    vi.resetModules();
  });

  it('sets exit code on main error', async () => {
    mainMock.mockRejectedValueOnce(new Error('boom'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/dependencyRelationCatalogCli.js');
    await flushMicrotasks();

    expect(mainMock).toHaveBeenCalledWith(process.argv);
    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('leaves exit code unset on success', async () => {
    mainMock.mockResolvedValueOnce(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/dependencyRelationCatalogCli.js');
    await flushMicrotasks();

    expect(mainMock).toHaveBeenCalledWith(process.argv);
    expect(process.exitCode).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });
});
