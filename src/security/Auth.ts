import { timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

export function readOpsToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
  }

  const headerToken = request.headers['x-ops-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}

export function tokensMatch(token: string, expected: string): boolean {
  if (token.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function isAuthorized(request: FastifyRequest, expectedToken?: string): boolean {
  const expected = expectedToken?.trim();
  if (!expected) return true;

  const token = readOpsToken(request);
  if (!token) return false;

  return tokensMatch(token, expected);
}

export function queryFlag(request: FastifyRequest, key: string): boolean {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true';
}
