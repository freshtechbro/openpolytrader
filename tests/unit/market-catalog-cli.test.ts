import { beforeEach, describe, expect, it, vi } from 'vitest';

const mainMock = vi.fn();
const prestartMock = vi.fn();

vi.mock('../../src/tools/marketCatalogGenerator.js', () => ({
  main: mainMock
}));

vi.mock('../../src/tools/marketCatalogPrestart.js', () => ({
  runMarketCatalogPrestart: prestartMock
}));

const flushMicrotasks = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('market catalog CLI wrappers', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    mainMock.mockReset();
    prestartMock.mockReset();
    vi.resetModules();
  });

  it('marketCatalogGeneratorCli sets exit code on error', async () => {
    mainMock.mockRejectedValueOnce(new Error('boom'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/marketCatalogGeneratorCli.js');
    await flushMicrotasks();

    expect(mainMock).toHaveBeenCalledWith(process.argv);
    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('marketCatalogGeneratorCli leaves exit code on success', async () => {
    mainMock.mockResolvedValueOnce(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/marketCatalogGeneratorCli.js');
    await flushMicrotasks();

    expect(mainMock).toHaveBeenCalledWith(process.argv);
    expect(process.exitCode).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('marketCatalogPrestartCli sets exit code on error', async () => {
    prestartMock.mockRejectedValueOnce(new Error('boom'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/marketCatalogPrestartCli.js');
    await flushMicrotasks();

    expect(prestartMock).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('marketCatalogPrestartCli leaves exit code on success', async () => {
    prestartMock.mockResolvedValueOnce(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('../../src/tools/marketCatalogPrestartCli.js');
    await flushMicrotasks();

    expect(prestartMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });
});
