import { createHmac } from 'node:crypto';

import type { AuthHeadersProvider } from './PolymarketClob.js';

export interface PolymarketApiCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
  address: string;
}

function decodeBase64Secret(secret: string): Buffer {
  const trimmed = secret.trim();
  const looksLikeHex = trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed);
  if (looksLikeHex) {
    const decoded = Buffer.from(trimmed, 'hex');
    if (decoded.length > 0) return decoded;
  }

  const normalized = trimmed.replace(/=+$/, '');
  const lengthIsValid = normalized.length > 0 && normalized.length % 4 !== 1;
  const looksLikeBase64 = /^[A-Za-z0-9+/]+$/.test(normalized);
  const looksLikeBase64Url = /^[A-Za-z0-9_-]+$/.test(normalized);

  if (!lengthIsValid || (!looksLikeBase64 && !looksLikeBase64Url)) {
    return Buffer.from(trimmed, 'utf8');
  }

  const normalizedBase64 = looksLikeBase64Url && !looksLikeBase64
    ? normalized.replace(/-/g, '+').replace(/_/g, '/')
    : normalized;
  const padded = normalizedBase64.padEnd(Math.ceil(normalizedBase64.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length === 0) {
    return Buffer.from(trimmed, 'utf8');
  }

  const roundTrip = decoded.toString('base64').replace(/=+$/, '');
  if (roundTrip !== normalizedBase64.replace(/=+$/, '')) {
    return Buffer.from(trimmed, 'utf8');
  }

  return decoded;
}

export function createPolymarketHmacAuthProvider(creds: PolymarketApiCreds): AuthHeadersProvider {
  const apiKey = creds.apiKey.trim();
  const passphrase = creds.passphrase.trim();
  const address = creds.address.trim();
  const secretKey = decodeBase64Secret(creds.secret.trim());

  return {
    getHeaders: ({ method, path, body }) => {
      const timestampSeconds = Math.floor(Date.now() / 1000).toString();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const prehash = `${timestampSeconds}${method.toUpperCase()}${path}${payload}`;
      const signature = createHmac('sha256', secretKey).update(prehash).digest('base64');

      return {
        POLY_ADDRESS: address,
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: timestampSeconds,
        POLY_API_KEY: apiKey,
        POLY_PASSPHRASE: passphrase
      };
    }
  };
}
