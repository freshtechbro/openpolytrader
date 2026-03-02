import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDependencyRelationCatalog,
  main,
  parseDependencyRelationCatalogArgs,
  printDependencyRelationCatalogHelp
} from '../../src/tools/dependencyRelationCatalog.js';

function writeCatalog(tmpRoot: string): string {
  const catalogPath = path.join(tmpRoot, 'market-catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify(
      [
        {
          marketId: 'catalog-market-a1',
          yesTokenId: 'yes-a',
          noTokenId: 'no-a',
          question: 'team alpha win final',
          category: 'sports',
          tags: ['sports', 'team-alpha', 'league-a']
        },
        {
          marketId: 'catalog-market-a2',
          yesTokenId: 'yes-b',
          noTokenId: 'no-b',
          question: 'team alpha win title',
          category: 'sports',
          tags: ['sports', 'team-alpha', 'league-a']
        },
        {
          marketId: 'catalog-market-b1',
          yesTokenId: 'yes-c',
          noTokenId: 'no-c',
          question: 'team beta wins',
          category: 'politics',
          tags: ['politics', 'team-beta', 'election']
        },
        {
          marketId: 'catalog-market-b2',
          yesTokenId: 'yes-d',
          noTokenId: 'no-d',
          question: 'team beta clinch',
          category: 'politics',
          tags: ['politics', 'team-beta', 'election']
        }
      ],
      null,
      2
    ),
    'utf8'
  );
  return catalogPath;
}

describe('dependencyRelationCatalog tool', () => {
  const tempDirs: string[] = [];
  const originalCatalogPath = process.env.MARKET_CATALOG_PATH;

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (originalCatalogPath === undefined) {
      delete process.env.MARKET_CATALOG_PATH;
    } else {
      process.env.MARKET_CATALOG_PATH = originalCatalogPath;
    }
    vi.restoreAllMocks();
  });

  it('parses supported arguments and help flags', () => {
    const parsed = parseDependencyRelationCatalogArgs([
      'node',
      'dependencyRelationCatalogCli.js',
      '--out',
      'tmp/out.json',
      '--catalog',
      'tmp/catalog.json',
      '--semantic'
    ]);
    expect(parsed).toEqual({
      outPath: 'tmp/out.json',
      marketCatalogPath: 'tmp/catalog.json',
      semantic: true
    });

    const parsedNoSemantic = parseDependencyRelationCatalogArgs([
      'node',
      'dependencyRelationCatalogCli.js',
      '--no-semantic',
      '--help'
    ]);
    expect(parsedNoSemantic).toEqual({ semantic: false, help: true });
  });

  it('rejects unknown args and missing option values', () => {
    expect(() =>
      parseDependencyRelationCatalogArgs(['node', 'dependencyRelationCatalogCli.js', '--unknown'])
    ).toThrow('Unknown arg: --unknown');
    expect(() =>
      parseDependencyRelationCatalogArgs(['node', 'dependencyRelationCatalogCli.js', '--out'])
    ).toThrow('Missing value for --out');
    expect(() =>
      parseDependencyRelationCatalogArgs(['node', 'dependencyRelationCatalogCli.js', '--catalog'])
    ).toThrow('Missing value for --catalog');
  });

  it('prints help text with expected usage details', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printDependencyRelationCatalogHelp();
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('dependency-relation-catalog');
    expect(output).toContain('--semantic');
    expect(output).toContain('--catalog');
  });

  it('builds deterministic catalog output and writes JSON atomically', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dependency-catalog-tool-'));
    tempDirs.push(tmpRoot);
    const catalogPath = writeCatalog(tmpRoot);
    const outPath = path.join(tmpRoot, 'nested', 'deep', 'dependency-relations.json');

    const result = await buildDependencyRelationCatalog({
      outPath,
      marketCatalogPath: catalogPath,
      semantic: false
    });

    expect(result.outPath).toBe(outPath);
    expect(result.marketCatalogPath).toBe(catalogPath);
    expect(result.semanticRelations).toBe(0);
    expect(result.relations).toBeGreaterThan(0);
    expect(existsSync(outPath)).toBe(true);

    const entries = JSON.parse(readFileSync(outPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(entries.length).toBe(result.relations);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        marketA: expect.any(String),
        marketB: expect.any(String),
        relationType: expect.any(String),
        confidence: expect.any(Number),
        eventKey: expect.any(String),
        asOfMs: expect.any(Number)
      })
    );
  });

  it('enables semantic augmentation and supports env fallback for catalog path', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dependency-catalog-tool-'));
    tempDirs.push(tmpRoot);
    const catalogPath = writeCatalog(tmpRoot);
    const outPath = path.join(tmpRoot, 'dependency-relations-semantic.json');
    process.env.MARKET_CATALOG_PATH = catalogPath;

    const noSemantic = await buildDependencyRelationCatalog({
      outPath: path.join(tmpRoot, 'no-semantic.json'),
      marketCatalogPath: catalogPath,
      semantic: false
    });
    const semantic = await buildDependencyRelationCatalog({
      outPath,
      semantic: true
    });

    expect(semantic.marketCatalogPath).toBe(catalogPath);
    expect(semantic.semanticRelations).toBeGreaterThan(0);
    expect(semantic.relations).toBeGreaterThanOrEqual(noSemantic.relations);
  });

  it('main prints help and normal build result', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dependency-catalog-main-'));
    tempDirs.push(tmpRoot);
    const catalogPath = writeCatalog(tmpRoot);
    const outPath = path.join(tmpRoot, 'main-relations.json');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(['node', 'dependencyRelationCatalogCli.js', '--help']);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockClear();
    await main([
      'node',
      'dependencyRelationCatalogCli.js',
      '--out',
      outPath,
      '--catalog',
      catalogPath,
      '--semantic'
    ]);

    expect(consoleSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(consoleSpy.mock.calls[0]?.[0])) as {
      outPath: string;
      relations: number;
      semanticRelations: number;
    };
    expect(payload.outPath).toBe(outPath);
    expect(payload.relations).toBeGreaterThan(0);
    expect(payload.semanticRelations).toBeGreaterThan(0);
  });
});
