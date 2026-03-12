import 'dotenv/config';

import { loadEnv } from '../src/config/env.js';
import { ApiError } from '../src/services/PolymarketClob.js';
import { createPolymarketHmacAuthProvider } from '../src/services/PolymarketAuth.js';
import { resolvePolymarketL2Creds } from '../src/services/PolymarketApiCreds.js';
import { writeCliFailure, writeCliFailureDetail } from '../src/utils/cliFailure.js';
import { createPolymarketClobFromEnv, requireNonEmpty } from './lib/polymarket.js';
import { runCliMain } from './lib/runCli.js';

export async function main(): Promise<void> {
  const env = loadEnv();

  const resolved = await resolvePolymarketL2Creds(env);
  if (!resolved) {
    requireNonEmpty(env.POLYMARKET_API_KEY, 'POLYMARKET_API_KEY');
    requireNonEmpty(env.POLYMARKET_API_SECRET, 'POLYMARKET_API_SECRET');
    requireNonEmpty(env.POLYMARKET_PASSPHRASE, 'POLYMARKET_PASSPHRASE');
    requireNonEmpty(env.POLYMARKET_POSITIONS_USER, 'POLYMARKET_POSITIONS_USER');
    throw new Error('Missing Polymarket credentials (set API key + secret + passphrase + address or L1 private key)');
  }

  console.log('Polymarket creds resolved', {
    derived: resolved.derived,
    address: resolved.address
  });

  const authProvider = createPolymarketHmacAuthProvider({
    apiKey: resolved.apiKey,
    secret: resolved.secret,
    passphrase: resolved.passphrase,
    address: resolved.address
  });

  const clob = createPolymarketClobFromEnv(env, authProvider);

  const orders = await clob.getActiveOrders();
  console.log('Polymarket auth ok', {
    activeOrders: orders.length
  });
}

runCliMain(import.meta.url, main, (error) => {
  if (error instanceof ApiError) {
    writeCliFailureDetail('Polymarket auth check failed', {
      status: error.status,
      body: error.body ?? null
    });
    process.exitCode = 1;
    return;
  }
  writeCliFailure('Polymarket auth check failed', error);
  process.exitCode = 1;
  return;
});
