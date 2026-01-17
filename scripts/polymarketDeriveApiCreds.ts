import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from '../src/config/env.js';
import { derivePolymarketL2Creds } from '../src/services/PolymarketApiCreds.js';

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new Error(`Missing required ${label}`);
  }
  return trimmed;
}

function upsertEnvVar(contents: string, key: string, value: string): string {
  const lineRe = new RegExp(`^${key}=.*$`, 'm');
  const nextLine = `${key}=${value}`;
  if (lineRe.test(contents)) {
    return contents.replace(lineRe, nextLine);
  }
  const suffix = contents.endsWith('\n') ? '' : '\n';
  return `${contents}${suffix}${nextLine}\n`;
}

async function main(): Promise<void> {
  const env = loadEnv();

  const privateKey = requireNonEmpty(
    process.env.POLYMARKET_L1_PRIVATE_KEY,
    'POLYMARKET_L1_PRIVATE_KEY'
  );
  const nonce = Number(process.env.POLYMARKET_L1_NONCE ?? '0');
  if (!Number.isFinite(nonce) || nonce < 0) {
    throw new Error('Invalid POLYMARKET_L1_NONCE; expected a non-negative integer');
  }

  const creds = await derivePolymarketL2Creds({
    baseUrl: env.POLYMARKET_CLOB_BASE_URL,
    l1PrivateKey: privateKey,
    nonce
  });

  const envPath = path.resolve(process.cwd(), '.env');
  const original = fs.readFileSync(envPath, 'utf8');
  let next = original;
  next = upsertEnvVar(next, 'POLYMARKET_API_KEY', creds.apiKey);
  next = upsertEnvVar(next, 'POLYMARKET_API_SECRET', creds.secret);
  next = upsertEnvVar(next, 'POLYMARKET_PASSPHRASE', creds.passphrase);
  next = upsertEnvVar(next, 'POLYMARKET_POSITIONS_USER', creds.address);

  fs.writeFileSync(envPath, next, 'utf8');

  console.log('[polymarket] derived api creds and updated .env', {
    address: creds.address,
    updated: ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_PASSPHRASE', 'POLYMARKET_POSITIONS_USER']
  });
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[polymarket] derive creds failed: ${message}`);
  process.exitCode = 1;
});
