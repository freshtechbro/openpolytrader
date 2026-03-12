export type GeneratorMode = 'near-zero' | 'binary' | 'any';

export type GeneratorArgs = {
  outPath?: string;
  maxPairs?: number;
  tag?: string;
  yesnoOnly?: boolean;
  mode?: GeneratorMode;
  merge?: boolean;
  verifyBooks?: boolean;
  requireMetadata?: boolean;
};

export function parseGeneratorArgs(argv: string[]): GeneratorArgs & { help?: boolean } {
  const args = argv.slice(2);
  const result: GeneratorArgs & { help?: boolean } = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out' || arg === '-o') {
      const value = args[++index];
      if (!value) throw new Error('Missing value for --out');
      result.outPath = value;
      continue;
    }
    if (arg === '--max') {
      const value = args[++index];
      if (!value) throw new Error('Missing value for --max');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--max must be a positive number');
      result.maxPairs = Math.floor(parsed);
      continue;
    }
    if (arg === '--tag') {
      const value = args[++index];
      if (!value) throw new Error('Missing value for --tag');
      result.tag = value;
      continue;
    }
    if (arg === '--yesno-only') {
      result.yesnoOnly = true;
      continue;
    }
    if (arg === '--mode') {
      const value = args[++index];
      if (value !== 'near-zero' && value !== 'binary' && value !== 'any') {
        throw new Error('--mode must be one of: near-zero | binary | any');
      }
      result.mode = value;
      continue;
    }
    if (arg === '--merge') {
      result.merge = true;
      continue;
    }
    if (arg === '--overwrite') {
      result.merge = false;
      continue;
    }
    if (arg === '--verify-books') {
      result.verifyBooks = true;
      continue;
    }
    if (arg === '--no-verify-books') {
      result.verifyBooks = false;
      continue;
    }
    if (arg === '--require-metadata') {
      result.requireMetadata = true;
      continue;
    }
    if (arg === '--allow-fallback-metadata') {
      result.requireMetadata = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return result;
}

export function printGeneratorHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`market-catalog-generator

Generates a MarketPair JSON catalog for MARKET_CATALOG_PATH by scanning Polymarket CLOB markets.

Usage:
  npx tsx src/tools/marketCatalogGeneratorCli.ts [options]
  node dist/tools/marketCatalogGeneratorCli.js [options]

Options:
  --out, -o          Output JSON path (default: env MARKET_CATALOG_PATH or data/market-catalog.json)
  --max              Stop after N pairs are collected (default: existing file size when --merge, else 200)
  --tag              Only include markets whose tags include this string (case-insensitive)
  --yesno-only       Only include markets whose outcomes are exactly Yes/No (more conservative)
  --mode             near-zero | binary | any (default: near-zero)
  --merge            Merge new pairs into existing file (never removes)
  --overwrite        Replace the output file (default)
  --verify-books     Verify both token orderbooks exist + have asks (default for near-zero)
  --no-verify-books  Skip orderbook verification
  --require-metadata           Require tick_size + min_order_size from /book (default for near-zero)
  --allow-fallback-metadata    Allow missing metadata (fallbacks may be used at runtime)
`);
}
