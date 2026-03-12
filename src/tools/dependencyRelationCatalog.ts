import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { DependencyMarketInput, DependencyRelation } from '../domain/dependency.js';
import { buildDependencyRelationCatalogEntries } from '../agents/dependency/DependencyRelationCatalog.js';
import { loadEnv } from '../config/env.js';
import { MarketCatalog } from '../services/MarketCatalog.js';

interface DependencyRelationCatalogArgs {
  outPath?: string;
  marketCatalogPath?: string;
  semantic?: boolean;
}

export function parseDependencyRelationCatalogArgs(
  argv: string[]
): DependencyRelationCatalogArgs & { help?: boolean } {
  const args = argv.slice(2);
  const parsed: DependencyRelationCatalogArgs & { help?: boolean } = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --out');
      parsed.outPath = value;
      i += 1;
      continue;
    }
    if (arg === '--catalog' || arg === '-c') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --catalog');
      parsed.marketCatalogPath = value;
      i += 1;
      continue;
    }
    if (arg === '--semantic') {
      parsed.semantic = true;
      continue;
    }
    if (arg === '--no-semantic') {
      parsed.semantic = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return parsed;
}

export function printDependencyRelationCatalogHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`dependency-relation-catalog

Builds an offline dependency relation catalog for FW enrichment.

Usage:
  npx tsx src/tools/dependencyRelationCatalogCli.ts [options]
  node dist/tools/dependencyRelationCatalogCli.js [options]

Options:
  --out, -o       Output JSON path (default: data/dependency-relations.json)
  --catalog, -c   Market catalog path (default: MARKET_CATALOG_PATH env or data/market-catalog.json)
  --semantic      Enable batch semantic augmentation (default: off)
  --no-semantic   Disable semantic augmentation
`);
}

interface DependencyRelationCatalogBuildResult {
  outPath: string;
  marketCatalogPath: string;
  relations: number;
  deterministicRelations: number;
  semanticRelations: number;
  relationTypeCounts: Record<DependencyRelation, number>;
}

export function buildDependencyRelationCatalog(
  args: DependencyRelationCatalogArgs = {}
): Promise<DependencyRelationCatalogBuildResult> {
  const env = loadEnv();
  const outPath = resolve(args.outPath ?? 'data/dependency-relations.json');
  const marketCatalogPath = resolve(
    args.marketCatalogPath ?? env.MARKET_CATALOG_PATH ?? 'data/market-catalog.json'
  );
  const semanticEnabled = Boolean(args.semantic);
  const nowMs = Date.now();

  const marketCatalog = new MarketCatalog({
    filePath: existsSync(marketCatalogPath) ? marketCatalogPath : undefined
  });
  const marketUniverse: DependencyMarketInput[] = marketCatalog.loadPairs().map((pair) => ({
    marketId: pair.marketId,
    yesTokenId: pair.yesTokenId,
    noTokenId: pair.noTokenId,
    question: pair.question,
    category: pair.category,
    tags: pair.tags
  }));

  const built = buildDependencyRelationCatalogEntries(marketUniverse, {
    nowMs,
    semanticEnabled
  });
  const relations = built.entries;

  ensureParentDirExists(outPath);
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(relations, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, outPath);

  return Promise.resolve({
    outPath,
    marketCatalogPath,
    relations: relations.length,
    deterministicRelations: built.deterministicRelations,
    semanticRelations: built.semanticRelations,
    relationTypeCounts: built.relationTypeCounts
  });
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = parseDependencyRelationCatalogArgs(argv);
  if (parsed.help) {
    printDependencyRelationCatalogHelp();
    return;
  }
  const result = await buildDependencyRelationCatalog(parsed);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

function ensureParentDirExists(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
