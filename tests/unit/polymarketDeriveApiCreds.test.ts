import { afterEach, describe, expect, it, vi } from 'vitest';

const { derivePolymarketL2Creds, readFileSync, writeFileSync } = vi.hoisted(() => ({
  derivePolymarketL2Creds: vi.fn(async () => ({
    apiKey: 'key',
    secret: 'secret',
    passphrase: 'pass',
    address: '0xabc'
  })),
  readFileSync: vi.fn(() => 'EXISTING=value\n'),
  writeFileSync: vi.fn()
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({ POLYMARKET_CLOB_BASE_URL: 'https://clob.example.com' })
}));
vi.mock('node:fs', () => ({
  default: { readFileSync, writeFileSync },
  readFileSync,
  writeFileSync
}));
vi.mock('../../src/services/PolymarketApiCreds.js', () => ({
  derivePolymarketL2Creds
}));

import { main } from '../../scripts/polymarketDeriveApiCreds.ts';

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  delete process.env.POLYMARKET_L1_PRIVATE_KEY;
  delete process.env.POLYMARKET_L1_NONCE;
});

describe('polymarketDeriveApiCreds script', () => {
  it('derives Polymarket API credentials and updates the env file contents', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    process.env.POLYMARKET_L1_PRIVATE_KEY = '0xprivate';
    process.env.POLYMARKET_L1_NONCE = '3';

    await main();

    expect(derivePolymarketL2Creds).toHaveBeenCalledWith({
      baseUrl: 'https://clob.example.com',
      l1PrivateKey: '0xprivate',
      nonce: 3
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
      expect.stringContaining('POLYMARKET_API_KEY=key'),
      'utf8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
      expect.stringContaining('POLYMARKET_POSITIONS_USER=0xabc'),
      'utf8'
    );
    expect(consoleLog).toHaveBeenCalledWith(
      'Polymarket API creds derived and .env updated',
      expect.objectContaining({ address: '0xabc' })
    );
  });
});
