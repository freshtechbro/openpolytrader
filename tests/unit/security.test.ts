import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { readOpsToken, tokensMatch, isAuthorized, queryFlag } from '../../src/security/Auth.js';
import { hasSecret, redactSecret } from '../../src/security/Secrets.js';

function makeRequest(
  headers: Record<string, string> = {},
  query: Record<string, unknown> = {}
): FastifyRequest {
  return { headers, query } as unknown as FastifyRequest;
}

describe('security auth helpers', () => {
  it('reads ops tokens from headers and query', () => {
    expect(
      readOpsToken(makeRequest({ authorization: 'Bearer token-1' }))
    ).toBe('token-1');

    expect(
      readOpsToken(makeRequest({ 'x-ops-token': 'token-2' }))
    ).toBe('token-2');

    expect(
      readOpsToken(makeRequest({}, { token: 'token-3' }))
    ).toBe('token-3');

    expect(readOpsToken(makeRequest({ authorization: 'Basic abc' }))).toBeUndefined();
    expect(readOpsToken(makeRequest({ authorization: 'Bearer' }))).toBeUndefined();
  });

  it('compares tokens safely', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('short', 'longer')).toBe(false);
  });

  it('authorizes requests based on expected tokens', () => {
    expect(isAuthorized(makeRequest())).toBe(true);
    expect(
      isAuthorized(
        makeRequest({ authorization: 'Bearer ok' }),
        'ok'
      )
    ).toBe(true);
    expect(
      isAuthorized(
        makeRequest({ authorization: 'Bearer nope' }),
        'ok'
      )
    ).toBe(false);
  });

  it('parses query flags', () => {
    expect(queryFlag(makeRequest({}, { once: '1' }), 'once')).toBe(true);
    expect(queryFlag(makeRequest({}, { once: 'true' }), 'once')).toBe(true);
    expect(queryFlag(makeRequest({}, { once: 'false' }), 'once')).toBe(false);
  });
});

describe('security secrets helpers', () => {
  it('redacts secrets and validates presence', () => {
    expect(redactSecret(undefined)).toBe('');
    expect(redactSecret('abcd', 4)).toBe('****');
    expect(redactSecret('abcdef', 2)).toBe('****ef');

    expect(hasSecret('  value ')).toBe(true);
    expect(hasSecret('   ')).toBe(false);
  });
});
