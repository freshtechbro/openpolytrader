import { Wallet } from 'ethers';

import type { Env } from '../config/env.js';
import { requireNonEmpty } from './PolymarketEnvHelpers.js';
import { resolvePolymarketClobBaseUrl } from './PolymarketUrls.js';

type PolymarketL2Creds = {
  apiKey: string;
  secret: string;
  passphrase: string;
  address: string;
  derived: boolean;
};

type DerivedCreds = {
  apiKey: string;
  secret: string;
  passphrase: string;
};

function signL1Auth(wallet: Wallet, nowSeconds: string, nonce: number): Promise<string> {
  const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: 137
  } as const;

  const types: Record<string, { name: string; type: string }[]> = {
    ClobAuth: [
      { name: 'address', type: 'address' },
      { name: 'timestamp', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'message', type: 'string' }
    ]
  };

  const value = {
    address: wallet.address,
    timestamp: nowSeconds,
    nonce,
    message: 'This message attests that I control the given wallet'
  } as const;

  return wallet.signTypedData(domain, types, value);
}

async function fetchDerivedCreds(args: {
  baseUrl: string;
  wallet: Wallet;
  nonce: number;
}): Promise<DerivedCreds> {
  const nowSeconds = Math.floor(Date.now() / 1000).toString();
  const signature = await signL1Auth(args.wallet, nowSeconds, args.nonce);

  const headers: Record<string, string> = {
    POLY_ADDRESS: args.wallet.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: nowSeconds,
    POLY_NONCE: String(args.nonce)
  };

  const deriveUrl = new URL('/auth/derive-api-key', args.baseUrl).toString();
  const deriveResponse = await fetch(deriveUrl, { method: 'GET', headers });
  if (deriveResponse.ok) {
    const parsed = (await deriveResponse.json()) as Partial<DerivedCreds>;
    const apiKey = requireNonEmpty(parsed.apiKey, 'derived apiKey');
    const secret = requireNonEmpty(parsed.secret, 'derived secret');
    const passphrase = requireNonEmpty(parsed.passphrase, 'derived passphrase');
    return { apiKey, secret, passphrase };
  }

  const createUrl = new URL('/auth/api-key', args.baseUrl).toString();
  const createResponse = await fetch(createUrl, { method: 'POST', headers });
  if (!createResponse.ok) {
    const bodyText = await createResponse.text();
    throw new Error(
      `Failed to derive/create Polymarket API creds: derive=${deriveResponse.status} create=${createResponse.status} body=${bodyText.slice(0, 200)}`
    );
  }

  const created = (await createResponse.json()) as Partial<DerivedCreds>;
  const apiKey = requireNonEmpty(created.apiKey, 'created apiKey');
  const secret = requireNonEmpty(created.secret, 'created secret');
  const passphrase = requireNonEmpty(created.passphrase, 'created passphrase');
  return { apiKey, secret, passphrase };
}

export function derivePolymarketL2Creds(args: {
  baseUrl: string;
  l1PrivateKey: string;
  nonce: number;
}): Promise<PolymarketL2Creds> {
  const wallet = new Wallet(args.l1PrivateKey);

  return fetchDerivedCreds({
    baseUrl: args.baseUrl,
    wallet,
    nonce: args.nonce
  }).then((creds) => ({
    ...creds,
    address: wallet.address,
    derived: true
  }));
}

export function resolvePolymarketL2Creds(env: Env): Promise<PolymarketL2Creds | null> {
  const l1PrivateKey = env.POLYMARKET_L1_PRIVATE_KEY?.trim();
  if (l1PrivateKey) {
    const nonce = Number(env.POLYMARKET_L1_NONCE ?? 0);
    if (!Number.isFinite(nonce) || nonce < 0) {
      return Promise.reject(new Error('Invalid POLYMARKET_L1_NONCE; expected a non-negative integer'));
    }
    return derivePolymarketL2Creds({
      baseUrl: resolvePolymarketClobBaseUrl(env.POLYMARKET_CLOB_BASE_URL),
      l1PrivateKey,
      nonce
    });
  }

  const apiKey = env.POLYMARKET_API_KEY?.trim();
  const secret = env.POLYMARKET_API_SECRET?.trim();
  const passphrase = env.POLYMARKET_PASSPHRASE?.trim();
  const address = env.POLYMARKET_POSITIONS_USER?.trim();
  if (!apiKey || !secret || !passphrase || !address) {
    return Promise.resolve(null);
  }

  return Promise.resolve({
    apiKey,
    secret,
    passphrase,
    address,
    derived: false
  });
}
