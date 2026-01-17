import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { derivePolymarketL2Creds, resolvePolymarketL2Creds } from '../../src/services/PolymarketApiCreds.js';
import { loadEnv } from '../../src/config/env.js';

type ResponseLike = {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const privateKey = `0x${'1'.repeat(64)}`;

function mockResponse(response: ResponseLike): Response {
  return response as Response;
}

describe('PolymarketApiCreds', () => {
  const baseEnv = loadEnv({});
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn<Promise<Response>, Parameters<typeof fetch>>>;

  beforeEach(() => {
    fetchMock = vi.fn<Promise<Response>, Parameters<typeof fetch>>();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('returns manual creds when configured', async () => {
    const env = {
      ...baseEnv,
      POLYMARKET_API_KEY: 'key',
      POLYMARKET_API_SECRET: 'secret',
      POLYMARKET_PASSPHRASE: 'pass',
      POLYMARKET_POSITIONS_USER: '0xabc'
    };

    const result = await resolvePolymarketL2Creds(env);
    expect(result).toEqual({
      apiKey: 'key',
      secret: 'secret',
      passphrase: 'pass',
      address: '0xabc',
      derived: false
    });
  });

  it('returns null when required manual creds are missing', async () => {
    const env = {
      ...baseEnv,
      POLYMARKET_API_KEY: 'key',
      POLYMARKET_API_SECRET: '',
      POLYMARKET_PASSPHRASE: 'pass',
      POLYMARKET_POSITIONS_USER: '0xabc'
    };

    const result = await resolvePolymarketL2Creds(env);
    expect(result).toBeNull();
  });

  it('throws when L1 nonce is invalid', async () => {
    const env = {
      ...baseEnv,
      POLYMARKET_L1_PRIVATE_KEY: privateKey,
      POLYMARKET_L1_NONCE: -1
    };

    await expect(resolvePolymarketL2Creds(env)).rejects.toThrow('Invalid POLYMARKET_L1_NONCE');
  });

  it('derives creds when L1 env is configured without an explicit nonce', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ apiKey: 'env-a', secret: 'env-b', passphrase: 'env-c' })
      })
    );

    const env = {
      ...baseEnv,
      POLYMARKET_L1_PRIVATE_KEY: privateKey
    };

    const result = await resolvePolymarketL2Creds(env);

    expect(result).toMatchObject({
      apiKey: 'env-a',
      secret: 'env-b',
      passphrase: 'env-c',
      derived: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('derives creds when L1 auth succeeds', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ apiKey: 'a', secret: 'b', passphrase: 'c' })
      })
    );

    const result = await derivePolymarketL2Creds({
      baseUrl: 'https://clob.example.com',
      l1PrivateKey: privateKey,
      nonce: 1
    });

    expect(result).toMatchObject({
      apiKey: 'a',
      secret: 'b',
      passphrase: 'c',
      derived: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when derived creds are missing fields', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ secret: 'b', passphrase: 'c' })
      })
    );

    await expect(
      derivePolymarketL2Creds({
        baseUrl: 'https://clob.example.com',
        l1PrivateKey: privateKey,
        nonce: 5
      })
    ).rejects.toThrow('Missing required derived apiKey');
  });

  it('falls back to create creds when derive fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 500,
          text: () => Promise.resolve('derive failed')
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          json: () => Promise.resolve({ apiKey: 'x', secret: 'y', passphrase: 'z' })
        })
      );

    const result = await derivePolymarketL2Creds({
      baseUrl: 'https://clob.example.com',
      l1PrivateKey: privateKey,
      nonce: 2
    });

    expect(result).toMatchObject({
      apiKey: 'x',
      secret: 'y',
      passphrase: 'z',
      derived: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when derive and create both fail', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 403,
          text: () => Promise.resolve('forbidden')
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 500,
          text: () => Promise.resolve('create failed')
        })
      );

    await expect(
      derivePolymarketL2Creds({
        baseUrl: 'https://clob.example.com',
        l1PrivateKey: privateKey,
        nonce: 3
      })
    ).rejects.toThrow('Failed to derive/create Polymarket API creds');
  });
});
