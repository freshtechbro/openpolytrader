import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const envState: {
  MARKET_CATALOG_PATH?: string;
  MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS?: number;
  MARKET_CATALOG_PRESTART_MAX_AGE_MS?: number;
} = {};

const generateMarketCatalogMock = vi.fn(async (args: { outPath: string; maxPairs?: number }) => ({
  outPath: args.outPath,
  pairs: [],
  pagesScanned: 0,
  mode: 'near-zero',
  merged: false,
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
    generateMarketCatalogMock.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'catalog-prestart-defaults-'));
    const outPath = join(dir, 'missing', 'catalog.json');
    envState.MARKET_CATALOG_PATH = outPath;
    delete envState.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS;
    delete envState.MARKET_CATALOG_PRESTART_MAX_AGE_MS;

    vi.resetModules();
    const { runMarketCatalogPrestart } = await import('../../src/tools/marketCatalogPrestart.js');

    await runMarketCatalogPrestart();

    expect(generateMarketCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath,
        maxPairs: 80,
        yesnoOnly: true,
        merge: false,
        verifyBooks: true,
        requireMetadata: true
      })
    );
    expect(log).toHaveBeenCalled();

    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses default staleness readers when an existing file is stale', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    generateMarketCatalogMock.mockClear();

    const dir = mkdtempSync(join(tmpdir(), 'catalog-prestart-defaults-stale-'));
    const outPath = join(dir, 'catalog.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, '[]', 'utf8');
    utimesSync(outPath, new Date(0), new Date(0));

    envState.MARKET_CATALOG_PATH = outPath;
    delete envState.MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS;
    envState.MARKET_CATALOG_PRESTART_MAX_AGE_MS = 1;

    vi.resetModules();
    const { runMarketCatalogPrestart } = await import('../../src/tools/marketCatalogPrestart.js');
    await runMarketCatalogPrestart();

    expect(generateMarketCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath,
        maxPairs: 80,
        merge: false
      })
    );
    expect(log).toHaveBeenCalled();

    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});
