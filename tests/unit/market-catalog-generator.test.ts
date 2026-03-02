import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cursorForOffset,
  findFirstOrderbookEnabledOffset,
  generateMarketCatalog,
  parseGeneratorArgs,
  readPairsFromFile,
  main as generatorMain,
  marketToPair,
  mergePairs
} from '../../src/tools/marketCatalogGenerator.js';
import { runMarketCatalogPrestart } from '../../src/tools/marketCatalogPrestart.js';
import { loadEnvWithOverrides } from '../../src/config/env.js';

describe('market catalog generator', () => {
  it('encodes offsets as base64 cursors', () => {
    expect(cursorForOffset(0)).toBe(Buffer.from('0').toString('base64'));
    expect(cursorForOffset(1000)).toBe(Buffer.from('1000').toString('base64'));
    expect(() => cursorForOffset(-1)).toThrow();
    expect(() => cursorForOffset(0.5 as unknown as number)).toThrow();
  });

  it('filters markets for near-zero mode', () => {
    const base = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: '1', outcome: 'Yes' },
        { token_id: '2', outcome: 'No' }
      ]
    };

    expect(marketToPair({ ...base, enable_order_book: false }, { mode: 'near-zero', yesnoOnly: false })).toBeNull();
    expect(marketToPair({ ...base, accepting_orders: false }, { mode: 'near-zero', yesnoOnly: false })).toBeNull();
    expect(marketToPair({ ...base, tokens: [] }, { mode: 'near-zero', yesnoOnly: false })).toBeNull();
    expect(marketToPair(base, { mode: 'near-zero', yesnoOnly: false })).toEqual({
      marketId: '0xabc',
      yesTokenId: '1',
      noTokenId: '2',
      category: undefined
    });
  });

  it('orders YES/NO tokens correctly when outcomes are swapped', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: 'NO', outcome: 'No' },
        { token_id: 'YES', outcome: 'Yes' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })).toEqual({
      marketId: '0xabc',
      yesTokenId: 'YES',
      noTokenId: 'NO',
      category: undefined
    });
  });

  it('supports yes/no-only mode', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: '1', outcome: 'Team A' },
        { token_id: '2', outcome: 'Team B' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: true })).toBeNull();
    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })?.marketId).toBe('0xabc');
  });

  it('accepts Yes/No outcomes in yesnoOnly mode', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: true })).toEqual({
      marketId: '0xabc',
      yesTokenId: 'YES',
      noTokenId: 'NO',
      category: undefined
    });
  });

  it('merges without removing existing pairs', () => {
    const existing = [
      { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
      { marketId: 'b', yesTokenId: '3', noTokenId: '4' }
    ];
    const incoming = [
      { marketId: 'b', yesTokenId: 'x', noTokenId: 'y' }, // duplicate
      { marketId: 'c', yesTokenId: '5', noTokenId: '6' }
    ];

    expect(mergePairs(existing, incoming)).toEqual([
      { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
      { marketId: 'b', yesTokenId: '3', noTokenId: '4' },
      { marketId: 'c', yesTokenId: '5', noTokenId: '6' }
    ]);

    expect(mergePairs(existing, incoming, 2)).toEqual(existing);
  });

  it('deduplicates repeated market ids already present in existing pairs', () => {
    const existing = [
      { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
      { marketId: 'a', yesTokenId: 'x', noTokenId: 'y' }
    ];
    const incoming = [{ marketId: 'b', yesTokenId: '3', noTokenId: '4' }];

    expect(mergePairs(existing, incoming)).toEqual([
      { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
      { marketId: 'b', yesTokenId: '3', noTokenId: '4' }
    ]);
  });

  it('hydrates missing metadata from incoming duplicates during merge', () => {
    const existing = [
      { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
      { marketId: 'b', yesTokenId: '3', noTokenId: '4', question: 'keep existing question' }
    ];
    const incoming = [
      {
        marketId: 'a',
        yesTokenId: 'x',
        noTokenId: 'y',
        question: 'incoming question',
        category: 'Politics',
        tags: ['us-election', 'debate']
      },
      {
        marketId: 'b',
        yesTokenId: '9',
        noTokenId: '8',
        category: 'Sports',
        tags: ['nhl']
      }
    ];

    expect(mergePairs(existing, incoming)).toEqual([
      {
        marketId: 'a',
        yesTokenId: '1',
        noTokenId: '2',
        question: 'incoming question',
        category: 'Politics',
        tags: ['us-election', 'debate']
      },
      {
        marketId: 'b',
        yesTokenId: '3',
        noTokenId: '4',
        question: 'keep existing question',
        category: 'Sports',
        tags: ['nhl']
      }
    ]);
  });

  it('finds the first page offset containing orderbook-enabled markets', async () => {
    const pageSize = 1000;
    const total = 5000;
    const baseUrl = 'https://example.test';

    const decodeCursor = (url: string): number => {
      const u = new URL(url);
      const cursor = u.searchParams.get('next_cursor');
      if (!cursor) return 0;
      return Number(Buffer.from(cursor, 'base64').toString('utf8'));
    };

    const makePage = (offset: number) => ({
      data: [{ enable_order_book: offset >= 2000 }],
      next_cursor: offset + pageSize < total ? Buffer.from(String(offset + pageSize)).toString('base64') : null,
      count: total
    });

    const fetchMock = vi.fn(async (url: string) => {
      const offset = decodeCursor(url);
      const json = makePage(offset);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
        json: async () => json
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(findFirstOrderbookEnabledOffset(baseUrl, pageSize)).resolves.toBe(2000);

    vi.unstubAllGlobals();
  });

  it('returns 0 when the first page already contains orderbook-enabled markets', async () => {
    const baseUrl = 'https://example.test';
    const fetchMock = vi.fn(async () => {
      const json = { data: [{ enable_order_book: true }], next_cursor: null, count: 1000 };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
        json: async () => json
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(findFirstOrderbookEnabledOffset(baseUrl, 1000)).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('returns null when total count is missing', async () => {
    const baseUrl = 'https://example.test';
    const fetchMock = vi.fn(async () => {
      const json = { data: [{ enable_order_book: false }], next_cursor: null };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
        json: async () => json
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(findFirstOrderbookEnabledOffset(baseUrl, 1000)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('returns null when no orderbook-enabled markets exist within total', async () => {
    const baseUrl = 'https://example.test';
    const pageSize = 1000;
    const total = 1500;

    const decodeCursor = (url: string): number => {
      const u = new URL(url);
      const cursor = u.searchParams.get('next_cursor');
      if (!cursor) return 0;
      return Number(Buffer.from(cursor, 'base64').toString('utf8'));
    };

    const fetchMock = vi.fn(async (url: string) => {
      const offset = decodeCursor(url);
      const json = {
        data: [{ enable_order_book: false }],
        next_cursor: null,
        count: offset === 0 ? total : undefined
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
        json: async () => json
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(findFirstOrderbookEnabledOffset(baseUrl, pageSize)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('uses binary search to find the first orderbook-enabled offset', async () => {
    const baseUrl = 'https://example.test';
    const pageSize = 1000;
    const total = 20000;
    const firstEnabledOffset = 7000;

    const decodeCursor = (url: string): number => {
      const u = new URL(url);
      const cursor = u.searchParams.get('next_cursor');
      if (!cursor) return 0;
      return Number(Buffer.from(cursor, 'base64').toString('utf8'));
    };

    const makePage = (offset: number) => ({
      data: [{ enable_order_book: offset >= firstEnabledOffset }],
      next_cursor: offset + pageSize < total ? Buffer.from(String(offset + pageSize)).toString('base64') : null,
      count: total
    });

    const fetchMock = vi.fn(async (url: string) => {
      const offset = decodeCursor(url);
      const json = makePage(offset);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
        json: async () => json
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(findFirstOrderbookEnabledOffset(baseUrl, pageSize)).resolves.toBe(firstEnabledOffset);

    vi.unstubAllGlobals();
  });

  it('parses generator args and rejects unknown flags', () => {
    const parsed = parseGeneratorArgs([
      'node',
      'script',
      '--out',
      'data/catalog.json',
      '--max',
      '10',
      '--tag',
      'politics',
      '--yesno-only',
      '--mode',
      'binary',
      '--merge',
      '--verify-books',
      '--require-metadata'
    ]);

    expect(parsed).toEqual({
      outPath: 'data/catalog.json',
      maxPairs: 10,
      tag: 'politics',
      yesnoOnly: true,
      mode: 'binary',
      merge: true,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(() => parseGeneratorArgs(['node', 'script', '--nope'])).toThrow();
  });

  it('validates generator args for missing/invalid values', () => {
    expect(() => parseGeneratorArgs(['node', 'script', '--out'])).toThrow('Missing value for --out');
    expect(() => parseGeneratorArgs(['node', 'script', '--max'])).toThrow('Missing value for --max');
    expect(() => parseGeneratorArgs(['node', 'script', '--tag'])).toThrow('Missing value for --tag');
    expect(() => parseGeneratorArgs(['node', 'script', '--max', '0'])).toThrow('--max must be a positive number');
    expect(() => parseGeneratorArgs(['node', 'script', '--mode', 'nope'])).toThrow('--mode must be one of');

    expect(
      parseGeneratorArgs([
        'node',
        'script',
        '--overwrite',
        '--no-verify-books',
        '--allow-fallback-metadata',
        '-h'
      ])
    ).toEqual({ merge: false, verifyBooks: false, requireMetadata: false, help: true });
  });

  it('reads pairs from a file and ignores invalid entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-test-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(
      file,
      JSON.stringify([
        { marketId: 'a', yesTokenId: '1', noTokenId: '2' },
        { marketId: '', yesTokenId: 'x', noTokenId: 'y' },
        { nope: true }
      ]),
      'utf8'
    );

    expect(readPairsFromFile(file)).toEqual([{ marketId: 'a', yesTokenId: '1', noTokenId: '2' }]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for invalid catalog files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-bad-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(readPairsFromFile(file)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the catalog file contains a non-array JSON payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-nonarray-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(file, JSON.stringify({ nope: true }), 'utf8');
    expect(readPairsFromFile(file)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-object entries when reading pairs from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-nonobject-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(
      file,
      JSON.stringify([null, 'nope', { marketId: 'a', yesTokenId: '1', noTokenId: '2' }]),
      'utf8'
    );

    expect(readPairsFromFile(file)).toEqual([{ marketId: 'a', yesTokenId: '1', noTokenId: '2' }]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes tags and skips the "all" category', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tags: [' All ', 'Politics', 'Sports'],
      tokens: [
        { token_id: '1', outcome: 'Yes' },
        { token_id: '2', outcome: 'No' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })?.category).toBe('Politics');
  });

  it('returns undefined category when tags contain only "all" or blanks', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tags: ['All', ' all ', '   '],
      tokens: [
        { token_id: '1', outcome: 'Yes' },
        { token_id: '2', outcome: 'No' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })?.category).toBeUndefined();
  });

  it('allows mode=any to include markets that are not active', () => {
    const market = {
      condition_id: '0xabc',
      active: false,
      closed: true,
      archived: true,
      accepting_orders: false,
      enable_order_book: false,
      tokens: [
        { token_id: '1', outcome: 'A' },
        { token_id: '2', outcome: 'B' }
      ]
    };

    expect(marketToPair(market, { mode: 'any', yesnoOnly: false })?.marketId).toBe('0xabc');
  });

  it('enforces non-any market status checks', () => {
    const base = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: '1', outcome: 'Yes' },
        { token_id: '2', outcome: 'No' }
      ]
    };

    expect(marketToPair({ ...base, active: false }, { mode: 'binary', yesnoOnly: false })).toBeNull();
    expect(marketToPair({ ...base, closed: true }, { mode: 'binary', yesnoOnly: false })).toBeNull();
    expect(marketToPair({ ...base, archived: true }, { mode: 'binary', yesnoOnly: false })).toBeNull();
  });

  it('rejects marketToPair entries missing condition or token ids', () => {
    expect(
      marketToPair(
        {
          condition_id: '',
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          enable_order_book: true,
          tokens: [
            { token_id: '1', outcome: 'Yes' },
            { token_id: '2', outcome: 'No' }
          ]
        },
        { mode: 'near-zero', yesnoOnly: false }
      )
    ).toBeNull();

    expect(
      marketToPair(
        {
          condition_id: '0xabc',
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          enable_order_book: true,
          tokens: [{ token_id: '1', outcome: 1 }, { token_id: '', outcome: 2 }] as unknown as Array<{ token_id: string; outcome: string }>
        },
        { mode: 'near-zero', yesnoOnly: false }
      )
    ).toBeNull();
  });

  it('orders non-Yes/No outcomes deterministically when yesnoOnly=false', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: 'B', outcome: 'Bravo' },
        { token_id: 'A', outcome: 'Alpha' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })).toEqual({
      marketId: '0xabc',
      yesTokenId: 'A',
      noTokenId: 'B',
      category: undefined
    });
  });

  it('breaks ties on token_id when outcomes compare equal (case-insensitive)', () => {
    const market = {
      condition_id: '0xabc',
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      enable_order_book: true,
      tokens: [
        { token_id: 'B', outcome: 'Alpha' },
        { token_id: 'A', outcome: 'alpha' }
      ]
    };

    expect(marketToPair(market, { mode: 'near-zero', yesnoOnly: false })).toEqual({
      marketId: '0xabc',
      yesTokenId: 'A',
      noTokenId: 'B',
      category: undefined
    });
  });

  it('creates the output directory when needed', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-mkdir-'));
    const nested = join(dir, 'nested', 'market-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [], next_cursor: null, count: 0 }),
        json: async () => ({ data: [], next_cursor: null, count: 0 })
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({ outPath: nested, mode: 'any', merge: false, verifyBooks: false, maxPairs: 1 });
    expect(result.pairs).toEqual([]);
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('preserves question and normalized tags in generated catalog entries', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-metadata-'));
    const file = join(dir, 'market-catalog.json');
    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xmeta',
      question: 'Will turnout exceed 60%?',
      tags: ['All', { label: 'Politics' }, { slug: 'us-election' }, '  '],
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [market], next_cursor: null, count: 1 }),
        json: async () => ({ data: [market], next_cursor: null, count: 1 })
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'any',
      merge: false,
      verifyBooks: false,
      maxPairs: 1
    });

    expect(result.pairs).toEqual([
      {
        marketId: '0xmeta',
        yesTokenId: 'YES',
        noTokenId: 'NO',
        category: 'Politics',
        question: 'Will turnout exceed 60%?',
        tags: ['Politics', 'us-election']
      }
    ]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('uses the default output path when neither --out nor MARKET_CATALOG_PATH is set', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    const savedCatalogPath = process.env.MARKET_CATALOG_PATH;
    const savedCwd = process.cwd();

    const dir = mkdtempSync(join(tmpdir(), 'catalog-default-out-'));
    process.chdir(dir);

    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';
    delete process.env.MARKET_CATALOG_PATH;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [], next_cursor: null, count: 0 }),
        json: async () => ({ data: [], next_cursor: null, count: 0 })
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({ mode: 'any', merge: false, verifyBooks: false, maxPairs: 1 });
    expect(result.outPath).toBe(join(process.cwd(), 'data', 'market-catalog.json'));
    expect(JSON.parse(readFileSync(result.outPath, 'utf8'))).toEqual([]);

    vi.unstubAllGlobals();
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
    if (typeof savedCatalogPath === 'string') process.env.MARKET_CATALOG_PATH = savedCatalogPath;
  });

  it('filters tag entries with blanks/non-strings and skips when no match', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-tag-blanks-'));
    const file = join(dir, 'market-catalog.json');

    const marketsPage = {
      data: [
        {
          enable_order_book: true,
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          condition_id: '0xabc',
          tags: ['   ', 123, null],
          tokens: [
            { token_id: 'YES', outcome: 'Yes' },
            { token_id: 'NO', outcome: 'No' }
          ]
        }
      ],
      next_cursor: null,
      count: 1000
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(marketsPage),
        json: async () => marketsPage
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 10,
      merge: false,
      verifyBooks: false,
      tag: 'politics'
    });
    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('throws when /markets fetch fails', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-fail-'));
    const file = join(dir, 'market-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'boom',
        json: async () => ({ error: 'boom' })
      })) as unknown as typeof fetch
    );

    await expect(generateMarketCatalog({ outPath: file, mode: 'any', merge: false, verifyBooks: false, maxPairs: 1 })).rejects.toThrow(
      'CLOB markets fetch failed (500)'
    );

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('throws when /markets response is missing data[]', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-badresp-'));
    const file = join(dir, 'market-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ nope: true }),
        json: async () => ({ nope: true })
      })) as unknown as typeof fetch
    );

    await expect(generateMarketCatalog({ outPath: file, mode: 'any', merge: false, verifyBooks: false, maxPairs: 1 })).rejects.toThrow(
      'Unexpected CLOB /markets response: missing data[]'
    );

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('generates a catalog and writes JSON (near-zero + verify)', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-gen-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tags: ['Politics'],
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = {
      data: [market],
      next_cursor: null,
      count: 1000
    };

    const book = {
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.41', size: '10' }],
      tick_size: '0.01',
      min_order_size: '1'
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://clob.test/markets')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(marketsPage),
          json: async () => marketsPage
        } as unknown as Response;
      }
      if (url.startsWith('https://clob.test/book?token_id=')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(book),
          json: async () => book
        } as unknown as Response;
      }

      return {
        ok: false,
        status: 404,
        text: async () => 'not found',
        json: async () => ({})
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 1,
      merge: false,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(result.pairs).toEqual([
      { marketId: '0xabc', yesTokenId: 'YES', noTokenId: 'NO', category: 'Politics' }
    ]);

    const raw = readFileSync(file, 'utf8');
    expect(JSON.parse(raw)).toEqual(result.pairs);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('starts scanning from the first orderbook-enabled offset in near-zero mode', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-start-offset-'));
    const file = join(dir, 'market-catalog.json');

    const total = 5000;
    const pageSize = 1000;

    const decodeOffset = (url: string): number => {
      const u = new URL(url);
      const cursor = u.searchParams.get('next_cursor');
      if (!cursor) return 0;
      return Number(Buffer.from(cursor, 'base64').toString('utf8'));
    };

    const marketAt2000 = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const fetchMock = vi.fn(async (url: string) => {
      const offset = decodeOffset(url);
      const enabled = offset >= 2000;
      const page =
        offset === 2000
          ? { data: [marketAt2000], next_cursor: null, count: total }
          : { data: [{ enable_order_book: enabled }], next_cursor: Buffer.from(String(offset + pageSize)).toString('base64'), count: total };

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page),
        json: async () => page
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 1,
      merge: false,
      verifyBooks: false
    });

    expect(result.pairs).toEqual([{ marketId: '0xabc', yesTokenId: 'YES', noTokenId: 'NO', category: undefined }]);
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('generates a catalog in near-zero mode and stops when maxPairs reached (next_cursor present)', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-gen2-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = {
      data: [market],
      next_cursor: 'NEXT',
      count: 1000
    };

    const book = {
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.41', size: '10' }],
      tick_size: 0.01,
      min_order_size: 1
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(book),
            json: async () => book
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 1,
      merge: false,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(result.pairs).toHaveLength(1);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('applies tag filtering and deduplicates by marketId', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-tag-'));
    const file = join(dir, 'market-catalog.json');

    const marketPolitics = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tags: ['Politics'],
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = {
      data: [
        {
          enable_order_book: true,
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          condition_id: '0xskip',
          tags: ['Sports'],
          tokens: [
            { token_id: 'YES', outcome: 'Yes' },
            { token_id: 'NO', outcome: 'No' }
          ]
        },
        marketPolitics,
        marketPolitics
      ],
      next_cursor: null,
      count: 1000
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(marketsPage),
        json: async () => marketsPage
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 10,
      merge: false,
      verifyBooks: false,
      tag: 'politics'
    });

    expect(result.pairs).toEqual([{ marketId: '0xabc', yesTokenId: 'YES', noTokenId: 'NO', category: 'Politics' }]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('skips markets when orderbook verification throws (catch)', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-book-throw-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = { data: [market], next_cursor: null, count: 1000 };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'boom',
            json: async () => ({ error: 'boom' })
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({ outPath: file, mode: 'near-zero', maxPairs: 1, merge: false });
    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('skips invalid markets and rejects books with empty asks during verification', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-empty-asks-'));
    const file = join(dir, 'market-catalog.json');

    const marketsPage = {
      data: [
        {
          enable_order_book: true,
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          condition_id: '0xinvalid',
          tokens: [] // invalid -> marketToPair returns null
        },
        {
          enable_order_book: true,
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          condition_id: '0xabc',
          tokens: [
            { token_id: 'YES', outcome: 'Yes' },
            { token_id: 'NO', outcome: 'No' }
          ]
        }
      ],
      next_cursor: null,
      count: 1000
    };

    const yesBook = { bids: [], asks: [], tick_size: '0.01', min_order_size: '1' };
    const noBook = { bids: [], asks: [{ price: '0.51', size: '1' }], tick_size: '0.01', min_order_size: '1' };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=YES')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(yesBook),
            json: async () => yesBook
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=NO')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(noBook),
            json: async () => noBook
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({ outPath: file, mode: 'near-zero', maxPairs: 10, merge: false });
    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('uses MARKET_CATALOG_PATH env when --out is omitted', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    const savedCatalogPath = process.env.MARKET_CATALOG_PATH;

    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-env-out-'));
    const file = join(dir, 'market-catalog.json');
    process.env.MARKET_CATALOG_PATH = file;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [], next_cursor: null, count: 0 }),
        json: async () => ({ data: [], next_cursor: null, count: 0 })
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({ mode: 'any', merge: false, verifyBooks: false, maxPairs: 1 });
    expect(result.outPath).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
    process.env.MARKET_CATALOG_PATH = savedCatalogPath;
  });

  it('defaults maxPairs to 200 when merge=true and no existing file', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-merge-default-max-'));
    const file = join(dir, 'market-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [], next_cursor: null, count: 0 }),
        json: async () => ({ data: [], next_cursor: null, count: 0 })
      })) as unknown as typeof fetch
    );

    const result = await generateMarketCatalog({ outPath: file, mode: 'any', merge: true, verifyBooks: false });
    expect(result.maxPairs).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('supports allow-fallback-metadata when requireMetadata=false', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-fallback-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'A', outcome: 'Team A' },
        { token_id: 'B', outcome: 'Team B' }
      ]
    };

    const marketsPage = {
      data: [market],
      next_cursor: null,
      count: 1000
    };

    const bookMissingMeta = {
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.41', size: '10' }]
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(bookMissingMeta),
            json: async () => bookMissingMeta
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 1,
      merge: false,
      verifyBooks: true,
      requireMetadata: false
    });

    expect(result.pairs).toHaveLength(1);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('prints help and exits via main when requested', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await generatorMain(['node', 'script', '--help']);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('runs main and prints JSON output', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-main-'));
    const file = join(dir, 'market-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [], next_cursor: null, count: 0 }),
        json: async () => ({ data: [], next_cursor: null, count: 0 })
      })) as unknown as typeof fetch
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await generatorMain(['node', 'script', '--out', file, '--mode', 'any', '--max', '1', '--no-verify-books', '--overwrite']);
    expect(log).toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.outPath).toBe(file);
    expect(payload.pairs).toBe(0);
    log.mockRestore();

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('short-circuits in merge mode when existing count meets max', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-merge-'));
    const file = join(dir, 'market-catalog.json');
    writeFileSync(
      file,
      JSON.stringify([
        { marketId: 'a', yesTokenId: '1', noTokenId: '2', question: 'Will A happen?' },
        { marketId: 'b', yesTokenId: '3', noTokenId: '4', question: 'Will B happen?' }
      ]),
      'utf8'
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMarketCatalog({ outPath: file, merge: true });
    expect(result.pagesScanned).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips pairs when requireMetadata=true and /book is missing metadata', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-meta-skip-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = { data: [market], next_cursor: null, count: 1000 };
    const bookMissingMeta = { bids: [], asks: [{ price: '0.5', size: '1' }] };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(bookMissingMeta),
            json: async () => bookMissingMeta
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 5,
      merge: false,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('skips pairs when requireMetadata=true and tick_size is invalid', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-invalid-tick-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = { data: [market], next_cursor: null, count: 1000 };
    const badTickBook = { bids: [], asks: [{ price: '0.5', size: '1' }], tick_size: 'nope', min_order_size: '1' };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(badTickBook),
            json: async () => badTickBook
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 5,
      merge: false,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('skips pairs when requireMetadata=true and numeric metadata is non-positive', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-invalid-meta-number-'));
    const file = join(dir, 'market-catalog.json');

    const market = {
      enable_order_book: true,
      active: true,
      closed: false,
      archived: false,
      accepting_orders: true,
      condition_id: '0xabc',
      tokens: [
        { token_id: 'YES', outcome: 'Yes' },
        { token_id: 'NO', outcome: 'No' }
      ]
    };

    const marketsPage = { data: [market], next_cursor: null, count: 1000 };
    const badMetaBook = { bids: [], asks: [{ price: '0.5', size: '1' }], tick_size: 0, min_order_size: 1 };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://clob.test/markets')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(marketsPage),
            json: async () => marketsPage
          } as unknown as Response;
        }
        if (url.startsWith('https://clob.test/book?token_id=')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(badMetaBook),
            json: async () => badMetaBook
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({
      outPath: file,
      mode: 'near-zero',
      maxPairs: 5,
      merge: false,
      verifyBooks: true,
      requireMetadata: true
    });

    expect(result.pairs).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('stops when next_cursor repeats (cursor loop safety)', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-cursor-loop-'));
    const file = join(dir, 'market-catalog.json');

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        const page = { data: [], next_cursor: 'SAME', count: 1000 };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(page),
          json: async () => page
        } as unknown as Response;
      })
    );

    const result = await generateMarketCatalog({ outPath: file, mode: 'any', merge: false, verifyBooks: false, maxPairs: 10 });
    expect(result.pagesScanned).toBe(2);
    expect(call).toBe(2);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });

  it('aborts when too many pages are scanned (possible cursor loop)', async () => {
    const savedBaseUrl = process.env.POLYMARKET_CLOB_BASE_URL;
    process.env.POLYMARKET_CLOB_BASE_URL = 'https://clob.test';

    const dir = mkdtempSync(join(tmpdir(), 'catalog-too-many-pages-'));
    const file = join(dir, 'market-catalog.json');

    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        i += 1;
        const page = { data: [], next_cursor: `CURSOR_${i}`, count: 1000000 };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(page),
          json: async () => page
        } as unknown as Response;
      })
    );

    await expect(generateMarketCatalog({ outPath: file, mode: 'any', merge: false, verifyBooks: false, maxPairs: 999999 })).rejects.toThrow(
      'Aborting: too many pages'
    );

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.POLYMARKET_CLOB_BASE_URL = savedBaseUrl;
  });
});

describe('market catalog prestart', () => {
  it('skips when MARKET_CATALOG_PATH is not set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({ MARKET_CATALOG_PATH: undefined });
    const generateStub = vi.fn();

    await runMarketCatalogPrestart({ loadEnv: loadEnvStub, generateMarketCatalog: generateStub });

    expect(generateStub).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('runs overwrite refresh when catalog is stale by age gate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({
      MARKET_CATALOG_PATH: 'data/catalog.json',
      MARKET_CATALOG_PRESTART_MAX_AGE_MS: 1000
    });
    const generateStub = vi.fn(async () => ({
      outPath: 'data/catalog.json',
      pairs: [{ marketId: 'a', yesTokenId: '1', noTokenId: '2' }],
      pagesScanned: 0,
      mode: 'near-zero',
      merged: false,
      maxPairs: 80
    }));

    await runMarketCatalogPrestart({
      loadEnv: loadEnvStub,
      generateMarketCatalog: generateStub,
      pathExists: () => true,
      readMtimeMs: () => 0,
      nowMs: () => 5000
    });

    expect(generateStub).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath: 'data/catalog.json',
        mode: 'near-zero',
        merge: false,
        maxPairs: 80,
        yesnoOnly: true,
        verifyBooks: true,
        requireMetadata: true
      })
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('bootstraps overwrite refresh when the catalog file does not exist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({ MARKET_CATALOG_PATH: 'data/catalog.json', MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS: 12 });
    const generateStub = vi.fn(async () => ({
      outPath: 'data/catalog.json',
      pairs: [{ marketId: 'a', yesTokenId: '1', noTokenId: '2' }],
      pagesScanned: 1,
      mode: 'near-zero',
      merged: false,
      maxPairs: 12
    }));

    await runMarketCatalogPrestart({
      loadEnv: loadEnvStub,
      generateMarketCatalog: generateStub,
      pathExists: () => false
    });

    expect(generateStub).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath: 'data/catalog.json',
        mode: 'near-zero',
        merge: false,
        maxPairs: 12,
        yesnoOnly: true,
        verifyBooks: true,
        requireMetadata: true
      })
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('skips refresh when catalog is fresh within the age gate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({
      MARKET_CATALOG_PATH: 'data/catalog.json',
      MARKET_CATALOG_PRESTART_MAX_AGE_MS: 1000
    });
    const generateStub = vi.fn();

    await runMarketCatalogPrestart({
      loadEnv: loadEnvStub,
      generateMarketCatalog: generateStub,
      pathExists: () => true,
      readMtimeMs: () => 4500,
      nowMs: () => 5000
    });

    expect(generateStub).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('forces overwrite refresh when prestart max age is zero', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({
      MARKET_CATALOG_PATH: 'data/catalog.json',
      MARKET_CATALOG_PRESTART_MAX_AGE_MS: 0
    });
    const generateStub = vi.fn(async () => ({
      outPath: 'data/catalog.json',
      pairs: [],
      pagesScanned: 0,
      mode: 'near-zero',
      merged: false,
      maxPairs: 80
    }));

    await runMarketCatalogPrestart({
      loadEnv: loadEnvStub,
      generateMarketCatalog: generateStub,
      pathExists: () => true,
      readMtimeMs: () => 5000,
      nowMs: () => 5000
    });

    expect(generateStub).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: false,
        maxPairs: 80
      })
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('treats unreadable mtime as stale and refreshes catalog', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loadEnvStub = () => ({
      MARKET_CATALOG_PATH: 'data/catalog.json',
      MARKET_CATALOG_PRESTART_MAX_AGE_MS: 1000
    });
    const generateStub = vi.fn(async () => ({
      outPath: 'data/catalog.json',
      pairs: [],
      pagesScanned: 0,
      mode: 'near-zero',
      merged: false,
      maxPairs: 80
    }));

    await runMarketCatalogPrestart({
      loadEnv: loadEnvStub,
      generateMarketCatalog: generateStub,
      pathExists: () => true,
      readMtimeMs: () => {
        throw new Error('stat failed');
      },
      nowMs: () => 5000
    });

    expect(generateStub).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: false,
        maxPairs: 80
      })
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('env overrides helper', () => {
  it('loads env with overrides applied', () => {
    const env = loadEnvWithOverrides({
      NODE_ENV: 'test',
      TRADING_ENABLED: 'false',
      TRADING_MODE: 'off',
      PORT: '3001'
    });
    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(3001);
  });
});
