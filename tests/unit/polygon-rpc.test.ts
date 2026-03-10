import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRpcProvider } from 'ethers';

import { loadEnv } from '../../src/config/env.js';
import { createRpcProvider, type RpcProvider } from '../../src/config/rpc.js';
import { PolygonRpc } from '../../src/services/PolygonRpc.js';

type ProviderWithConnection = JsonRpcProvider & {
  _getConnection(): { url: string };
};

describe('PolygonRpc runtime ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates through the injected rpc provider', async () => {
    const waitForTransaction = vi.fn().mockResolvedValue({ status: 1 });
    const provider = { waitForTransaction } as unknown as JsonRpcProvider;
    const rpcProvider: Pick<RpcProvider, 'execute' | 'getProvider'> = {
      execute: vi.fn().mockResolvedValue('0x89'),
      getProvider: vi.fn().mockReturnValue(provider)
    };

    const client = new PolygonRpc({ waitConfirmations: 2, waitTimeoutMs: 3000 }, rpcProvider as RpcProvider);

    await expect(client.send('eth_chainId')).resolves.toBe('0x89');
    await expect(client.waitForTransaction('0xfeed')).resolves.toEqual({ status: 1 });

    expect(rpcProvider.execute).toHaveBeenCalledWith('eth_chainId', undefined);
    expect(waitForTransaction).toHaveBeenCalledWith('0xfeed', 2, 3000);
  });

  it('builds providers from the supplied env snapshot rather than ambient globals', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = loadEnv({
      ALCHEMY_RPC_URL: 'https://alchemy.invalid',
      ALCHEMY_WS_URL: 'wss://alchemy.invalid',
      CHAINSTACK_RPC_URL: 'https://chainstack.invalid',
      CHAINSTACK_WS_URL: 'wss://chainstack.invalid',
      PRIVATE_RPC_URL: 'https://private.invalid',
      PRIVATE_WS_URL: 'wss://private.invalid'
    });

    const phase1Provider = createRpcProvider({ ...env, TOTAL_CAPITAL: 1000 }, 1000);
    const phase2Provider = createRpcProvider({ ...env, TOTAL_CAPITAL: 3000 }, 3000);

    expect(phase1Provider.getCurrentProvider()).toBe('Alchemy');
    expect(phase2Provider.getCurrentProvider()).toBe('Chainstack Pro');
  });

  it('creates a runtime client from the supplied env snapshot', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = loadEnv({
      ALCHEMY_RPC_URL: 'https://alchemy.invalid',
      ALCHEMY_WS_URL: 'wss://alchemy.invalid'
    });

    const client = PolygonRpc.fromEnv(
      { ...env, TOTAL_CAPITAL: 1000 },
      { waitConfirmations: 2, waitTimeoutMs: 3000 }
    );

    expect(client.getProvider()).toBeDefined();
  });

  it('derives canonical provider URLs when env overrides are omitted', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = loadEnv({});

    const phase1 = createRpcProvider({ ...env, TOTAL_CAPITAL: 1000 }, 1000);
    expect((phase1.getProvider() as ProviderWithConnection)._getConnection().url).toBe(
      'https://polygon-mainnet.g.alchemy.com/v2'
    );
    expect(phase1.getHealthStatus()).toMatchObject({
      Alchemy: { isCurrent: true },
      Ankr: { isCurrent: false }
    });

    const phase2 = createRpcProvider({ ...env, TOTAL_CAPITAL: 3000 }, 3000);
    expect((phase2.getProvider() as ProviderWithConnection)._getConnection().url).toBe(
      'https://polygon-mainnet.chainstacklabs.com'
    );
    expect(phase2.getHealthStatus()).toMatchObject({
      'Chainstack Pro': { isCurrent: true },
      'Alchemy Growth': { isCurrent: false },
      Ankr: { isCurrent: false }
    });

    const phase3 = createRpcProvider({ ...env, TOTAL_CAPITAL: 6000 }, 6000);
    expect((phase3.getProvider() as ProviderWithConnection)._getConnection().url).toBe(
      'http://localhost:8545'
    );
    expect(phase3.getHealthStatus()).toMatchObject({
      'Private Node': { isCurrent: true },
      'Chainstack Pro': { isCurrent: false }
    });
  });

  it('keeps the current provider when a fallback attempt also fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = loadEnv({});
    const rpc = createRpcProvider({ ...env, TOTAL_CAPITAL: 1000 }, 1000);
    const internals = rpc as unknown as {
      providers: Map<string, { provider: { send: ReturnType<typeof vi.fn> }; circuitBreaker: { execute: <T>(fn: () => Promise<T>) => Promise<T>; refreshAndGetState: () => string; getFailureCount: () => number } }>;
      rateLimiters: Map<string, { acquire: ReturnType<typeof vi.fn> }>;
      currentProviderName: string;
    };

    internals.providers = new Map([
      [
        'Alchemy',
        {
          provider: { send: vi.fn().mockRejectedValue(new Error('primary failure')) },
          circuitBreaker: {
            execute: async <T,>(fn: () => Promise<T>) => fn(),
            refreshAndGetState: () => 'closed',
            getFailureCount: () => 0
          }
        }
      ],
      [
        'Ankr',
        {
          provider: { send: vi.fn().mockRejectedValue(new Error('fallback failure')) },
          circuitBreaker: {
            execute: async <T,>(fn: () => Promise<T>) => fn(),
            refreshAndGetState: () => 'closed',
            getFailureCount: () => 0
          }
        }
      ]
    ]);
    internals.rateLimiters = new Map([
      ['Alchemy', { acquire: vi.fn().mockResolvedValue(undefined) }],
      ['Ankr', { acquire: vi.fn().mockResolvedValue(undefined) }]
    ]);
    internals.currentProviderName = 'Alchemy';

    await expect(rpc.execute('eth_chainId')).rejects.toThrow('All RPC providers failed for eth_chainId');
    expect(rpc.getCurrentProvider()).toBe('Alchemy');
  });

  it('switches providers only after a fallback succeeds', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = loadEnv({});
    const rpc = createRpcProvider({ ...env, TOTAL_CAPITAL: 1000 }, 1000);
    const internals = rpc as unknown as {
      providers: Map<string, { provider: { send: ReturnType<typeof vi.fn> }; circuitBreaker: { execute: <T>(fn: () => Promise<T>) => Promise<T>; refreshAndGetState: () => string; getFailureCount: () => number } }>;
      rateLimiters: Map<string, { acquire: ReturnType<typeof vi.fn> }>;
      currentProviderName: string;
    };

    internals.providers = new Map([
      [
        'Alchemy',
        {
          provider: { send: vi.fn().mockRejectedValue(new Error('primary failure')) },
          circuitBreaker: {
            execute: async <T,>(fn: () => Promise<T>) => fn(),
            refreshAndGetState: () => 'closed',
            getFailureCount: () => 0
          }
        }
      ],
      [
        'Ankr',
        {
          provider: { send: vi.fn().mockResolvedValue('0x89') },
          circuitBreaker: {
            execute: async <T,>(fn: () => Promise<T>) => fn(),
            refreshAndGetState: () => 'closed',
            getFailureCount: () => 0
          }
        }
      ]
    ]);
    internals.rateLimiters = new Map([
      ['Alchemy', { acquire: vi.fn().mockResolvedValue(undefined) }],
      ['Ankr', { acquire: vi.fn().mockResolvedValue(undefined) }]
    ]);
    internals.currentProviderName = 'Alchemy';

    await expect(rpc.execute('eth_chainId')).resolves.toBe('0x89');
    expect(rpc.getCurrentProvider()).toBe('Ankr');
  });
});
