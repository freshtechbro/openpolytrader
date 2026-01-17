import { describe, expect, it, vi } from 'vitest';

import { createHmac } from 'node:crypto';

import { createPolymarketHmacAuthProvider } from '../../src/services/PolymarketAuth.js';

function expectedSignature(args: { secret: Buffer; timestampSeconds: string; method: string; path: string; body?: unknown }): string {
  const payload = args.body === undefined ? '' : JSON.stringify(args.body);
  const prehash = `${args.timestampSeconds}${args.method.toUpperCase()}${args.path}${payload}`;
  return createHmac('sha256', args.secret).update(prehash).digest('base64');
}

describe('PolymarketAuth', () => {
  it('treats non-base64 secrets as UTF-8', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: 'secret',
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

  it('accepts base64 secrets and produces the same signature as the decoded bytes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('base64'),
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
        body
      })
    );
  });

  it('accepts base64url secrets and produces the same signature as the decoded bytes', async () => {
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

  it('treats secrets with invalid base64 characters as UTF-8', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: 'invalid@#$chars',
      passphrase: 'p',
      address: '0xabc'
    });

    const headers = await provider.getHeaders({ method: 'GET', path: '/data/orders' });
    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('invalid@#$chars', 'utf8'),
        timestampSeconds,
        method: 'GET',
        path: '/data/orders'
      })
    );
  });

  it('treats single character strings as UTF-8', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: 'a',
      passphrase: 'p',
      address: '0xabc'
    });

    const headers = await provider.getHeaders({ method: 'GET', path: '/data/orders' });
    expect(headers.POLY_SIGNATURE).toBe(
      expectedSignature({
        secret: Buffer.from('a', 'utf8'),
        timestampSeconds,
        method: 'GET',
        path: '/data/orders'
      })
    );
  });

  it('accepts hex secrets (bytes encoded as hex)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const timestampSeconds = '1700000000';

    const provider = createPolymarketHmacAuthProvider({
      apiKey: 'k',
      secret: Buffer.from('secret', 'utf8').toString('hex'),
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
});
