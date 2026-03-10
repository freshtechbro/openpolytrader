import { createHmac } from 'node:crypto';

import type { AuthHeadersProvider } from './PolymarketClob.js';

interface PolymarketApiCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
  address: string;
}

function decodeBase64Secret(secret: string): Buffer {
  const trimmed = secret.trim();
  const normalized = trimmed
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

export function createPolymarketHmacAuthProvider(creds: PolymarketApiCreds): AuthHeadersProvider {
  const apiKey = creds.apiKey.trim();
  const passphrase = creds.passphrase.trim();
  const address = creds.address.trim();
  const secretKey = decodeBase64Secret(creds.secret.trim());

  return {
    getHeaders: ({ method, path, body }) => {
      const timestampSeconds = Math.floor(Date.now() / 1000).toString();
      const normalizedMethod = method.trim().toUpperCase();
      const payload =
        body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const prehash = `${timestampSeconds}${normalizedMethod}${path}${payload ?? ''}`;
      const signature = createHmac('sha256', secretKey).update(prehash).digest('base64');
      const signatureUrlSafe = signature.replace(/\+/g, '-').replace(/\//g, '_');

      return {
        POLY_ADDRESS: address,
        POLY_SIGNATURE: signatureUrlSafe,
        POLY_TIMESTAMP: timestampSeconds,
        POLY_API_KEY: apiKey,
        POLY_PASSPHRASE: passphrase
      };
    }
  };
}
