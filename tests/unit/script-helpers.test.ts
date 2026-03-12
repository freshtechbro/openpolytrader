import { afterEach, describe, expect, it, vi } from 'vitest';

describe('scripts/lib/runCli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the main callback when the module is the entrypoint', async () => {
    const { runCliMain } = await import('../../scripts/lib/runCli.ts');
    const main = vi.fn().mockResolvedValue(undefined);
    const handleError = vi.fn();
    const argv = vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      '/tmp/run-cli-entry.ts'
    ] as unknown as string[]);

    runCliMain('file:///tmp/run-cli-entry.ts', main, handleError);
    await Promise.resolve();

    expect(argv).toHaveBeenCalled();
    expect(main).toHaveBeenCalledTimes(1);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('ignores non-entrypoint imports and forwards async failures', async () => {
    const { runCliMain } = await import('../../scripts/lib/runCli.ts');
    const main = vi.fn().mockRejectedValue(new Error('boom'));
    const handleError = vi.fn();
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/tmp/other-script.ts'] as unknown as string[]);

    runCliMain('file:///tmp/run-cli-entry.ts', main, handleError);
    await Promise.resolve();
    expect(main).not.toHaveBeenCalled();

    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/tmp/run-cli-entry.ts'] as unknown as string[]);
    runCliMain('file:///tmp/run-cli-entry.ts', main, handleError);
    await Promise.resolve();
    await Promise.resolve();

    expect(main).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });
});

describe('scripts/lib/polymarket', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('../../scripts/lib/polymarket.js');
    vi.unmock('../../src/services/PolymarketClob.js');
  });

  it('requires non-empty values after trimming whitespace', async () => {
    const { requireNonEmpty } = await import('../../scripts/lib/polymarket.js');

    expect(requireNonEmpty('  value  ', 'TEST_KEY')).toBe('value');
    expect(() => requireNonEmpty('   ', 'TEST_KEY')).toThrow('Missing required TEST_KEY');
    expect(() => requireNonEmpty(undefined, 'TEST_KEY')).toThrow('Missing required TEST_KEY');
  });

  it('builds a Polymarket CLOB client from env fields', async () => {
    const constructorSpy = vi.fn();
    class FakePolymarketClob {
      constructor(readonly options: unknown) {
        constructorSpy(options);
      }
    }

    vi.doMock('../../src/services/PolymarketClob.js', () => ({
      PolymarketClob: FakePolymarketClob
    }));

    const { createPolymarketClobFromEnv } = await import('../../scripts/lib/polymarket.js');
    const authProvider = vi.fn();
    const env = {
      POLYMARKET_CLOB_BASE_URL: 'https://clob.example.com',
      POLYMARKET_CLOB_TIMEOUT_MS: 1000,
      POLYMARKET_CLOB_RATE_LIMIT_PER_SEC: 10,
      POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS: 1000,
      POLYMARKET_CLOB_ORDER_PATH: '/order',
      POLYMARKET_CLOB_BATCH_ORDER_PATH: '/orders',
      POLYMARKET_CLOB_CANCEL_ORDER_PATH: '/cancel',
      POLYMARKET_CLOB_CANCEL_ORDERS_PATH: '/cancel-orders',
      POLYMARKET_CLOB_CANCEL_ALL_PATH: '/cancel-all',
      POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH: '/cancel-market',
      POLYMARKET_CLOB_ACTIVE_ORDERS_PATH: '/active',
      POLYMARKET_CLOB_RETRY_MAX_RETRIES: 3,
      POLYMARKET_CLOB_RETRY_BASE_DELAY_MS: 50,
      POLYMARKET_CLOB_RETRY_MAX_DELAY_MS: 500
    } as unknown as Parameters<typeof createPolymarketClobFromEnv>[0];

    const client = createPolymarketClobFromEnv(env, authProvider);

    expect(constructorSpy).toHaveBeenCalledWith({
      baseUrl: 'https://clob.example.com',
      requestTimeoutMs: 1000,
      rateLimitPerSecond: 10,
      rateLimitWindowMs: 1000,
      authProvider,
      orderPath: '/order',
      batchOrderPath: '/orders',
      cancelOrderPath: '/cancel',
      cancelOrdersPath: '/cancel-orders',
      cancelAllPath: '/cancel-all',
      cancelMarketOrdersPath: '/cancel-market',
      activeOrdersPath: '/active',
      retryMaxRetries: 3,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 500
    });
    expect(client).toEqual({
      options: expect.objectContaining({
        baseUrl: 'https://clob.example.com',
        authProvider
      })
    });
  });
});

describe('cli failure helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes error messages to stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { writeCliFailure } = await import('../../src/utils/cliFailure.js');

    writeCliFailure('prefix', new Error('boom'));
    writeCliFailure('prefix', 'plain');

    expect(stderrSpy).toHaveBeenNthCalledWith(1, 'prefix: boom\n');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, 'prefix: plain\n');
  });

  it('writes string and structured details to stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { writeCliFailureDetail } = await import('../../src/utils/cliFailure.js');

    writeCliFailureDetail('detail', 'plain');
    writeCliFailureDetail('detail', { ok: false });

    expect(stderrSpy).toHaveBeenNthCalledWith(1, 'detail: plain\n');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, 'detail: {\n  "ok": false\n}\n');
  });
});
