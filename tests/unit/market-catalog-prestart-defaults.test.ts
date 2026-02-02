import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const envState: { MARKET_CATALOG_PATH?: string; MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS?: number } = {};

const generateMarketCatalogMock = vi.fn(async (args: { outPath: string; maxPairs?: number }) => ({
  outPath: args.outPath,
  pairs: [],
  pagesScanned: 0,
  mode: 'near-zero',
  merged: true,
  maxPairs: args.maxPairs ?? 0
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnvWithOverrides: () => ({ ...envState })
}));

vi.mock('../../src/tools/marketCatalogGenerator.js', () => ({
  generateMarketCatalog: generateMarketCatalogMock
}));

describe('market catalog prestart (default deps)', () => {
  it('uses default deps and bootstraps with maxPairs=80 when the file does not exist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'catalog-prestart-defaults-'));
    const outPath = join(dir, 'missing', 'catalog.json');
    envState.MARKET_CATALOG_PATH = outPath;
    delete envState.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS;

    vi.resetModules();
    const { runMarketCatalogPrestart } = await import('../../src/tools/marketCatalogPrestart.js');

    await runMarketCatalogPrestart();

    expect(generateMarketCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath,
        maxPairs: 80,
        yesnoOnly: true,
        merge: true,
        verifyBooks: true,
        requireMetadata: true
      })
    );
    expect(log).toHaveBeenCalled();

    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});
