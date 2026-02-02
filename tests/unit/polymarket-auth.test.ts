import { describe, expect, it, vi } from 'vitest';

import { createHmac } from 'node:crypto';

import { createPolymarketHmacAuthProvider } from '../../src/services/PolymarketAuth.js';

function expectedSignature(args: { secret: Buffer; timestampSeconds: string; method: string; path: string; body?: string }): string {
  const payload = args.body ?? '';
  const prehash = `${args.timestampSeconds}${args.method.toUpperCase()}${args.path}${payload}`;
  const signature = createHmac('sha256', args.secret).update(prehash).digest('base64');
  return signature.replace(/\+/g, '-').replace(/\//g, '_');
}

describe('PolymarketAuth', () => {
  it('accepts base64 secrets and signs GET requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('base64'),
      passphrase: 'p',
      address: '0xabc'
    });

    const headers = await provider.getHeaders({ method: 'GET', path: '/data/orders' });
    expect(headers.POLY_TIMESTAMP).toBe(timestampSeconds);
    expect(headers.POLY_API_KEY).toBe('k');
    expect(headers.POLY_PASSPHRASE).toBe('p');
    expect(headers.POLY_ADDRESS).toBe('0xabc');

    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('secret', 'utf8'),
        timestampSeconds,
        method: 'GET',
        path: '/data/orders'
      })
    );
  });

  it('accepts base64url secrets', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const base64 = Buffer.from('secret', 'utf8').toString('base64');
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: base64url,
      passphrase: 'p',
      address: '0xabc'
    });

    const headers = await provider.getHeaders({ method: 'GET', path: '/data/orders' });
    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('secret', 'utf8'),
        timestampSeconds,
        method: 'GET',
        path: '/data/orders'
      })
    );
  });

  it('includes request body in the signature when provided', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('base64'),
      passphrase: 'p',
      address: '0xabc'
    });

    const body = { orderId: '123', side: 'yes' };
    const headers = await provider.getHeaders({ method: 'POST', path: '/orders', body });
    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('secret', 'utf8'),
        timestampSeconds,
        method: 'POST',
        path: '/orders',
        body: JSON.stringify(body)
      })
    );
  });

  it('uses raw string bodies without JSON encoding', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('base64'),
      passphrase: 'p',
      address: '0xabc'
    });

    const body = '{"hash":"0x123"}';
    const headers = await provider.getHeaders({ method: 'POST', path: '/orders', body });
    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('secret', 'utf8'),
        timestampSeconds,
        method: 'POST',
        path: '/orders',
        body
      })
    );
  });

  it('emits url-safe base64 signatures', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('base64'),
      passphrase: 'p',
      address: '0xabc'
    });

    const headers = await provider.getHeaders({ method: 'GET', path: '/data/orders' });
    expect(headers.POLY_SIGNATURE).not.toMatch(/[+/]/);
  });
});
