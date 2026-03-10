import { afterEach, describe, expect, it, vi } from 'vitest';

const { MockApiError, createAuthProvider, getActiveOrders, resolvePolymarketL2Creds, constructorSpy } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly body?: unknown
    ) {
      super('api error');
    }
  }

  return {
    MockApiError,
    createAuthProvider: vi.fn(() => 'auth-provider'),
    getActiveOrders: vi.fn(async () => [{ id: '1' }, { id: '2' }]),
    constructorSpy: vi.fn(),
    resolvePolymarketL2Creds: vi.fn(async () => ({
      derived: true,
      address: '0xabc',
      apiKey: 'key',
      secret: 'secret',
      passphrase: 'passphrase'
    }))
  };
});

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({
    POLYMARKET_API_KEY: '',
    POLYMARKET_API_SECRET: '',
    POLYMARKET_PASSPHRASE: '',
    POLYMARKET_POSITIONS_USER: ''
  })
}));
vi.mock('../../src/services/PolymarketClob.js', () => ({
  ApiError: MockApiError,
  PolymarketClob: class {
    constructor(options: unknown) {
      constructorSpy(options);
    }

    getActiveOrders = getActiveOrders;
  }
}));
vi.mock('../../src/services/PolymarketAuth.js', () => ({
  createPolymarketHmacAuthProvider: createAuthProvider
}));
vi.mock('../../src/services/PolymarketApiCreds.js', () => ({
  resolvePolymarketL2Creds
}));

import { main } from '../../scripts/polymarketAuthCheck.ts';

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('polymarketAuthCheck script', () => {
  it('runs the auth check with resolved credentials and active orders', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(resolvePolymarketL2Creds).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('Polymarket creds resolved', {
      derived: true,
      address: '0xabc'
    });
    expect(createAuthProvider).toHaveBeenCalledWith({
      apiKey: 'key',
      secret: 'secret',
      passphrase: 'passphrase',
      address: '0xabc'
    });
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        authProvider: 'auth-provider'
      })
    );
    expect(getActiveOrders).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('Polymarket auth ok', { activeOrders: 2 });
  });
});
